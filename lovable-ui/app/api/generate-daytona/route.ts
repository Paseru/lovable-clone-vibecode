import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();
    
    if (!prompt) {
      return new Response(
        JSON.stringify({ error: "Prompt is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    
    if (!process.env.DAYTONA_API_KEY || !process.env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Missing API keys" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    
    console.log("[API] Starting Daytona generation for prompt:", prompt);
    
    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    
    // Track connection state
    let isConnectionClosed = false;
    let childProcess: any = null;
    
    // Helper function to safely write to stream
    const safeWrite = async (data: string) => {
      try {
        if (isConnectionClosed) {
          return;
        }
        await writer.write(encoder.encode(data));
      } catch (error: any) {
        if (error.name === 'TypeError' && error.message.includes('WritableStream is closed')) {
          isConnectionClosed = true;
          console.log("[API] Connection closed by client");
          // Kill child process if connection is closed
          if (childProcess) {
            childProcess.kill('SIGTERM');
          }
        } else {
          console.error("[API] Write error:", error);
        }
      }
    };
    
    // Start the async generation
    (async () => {
      try {
        // Use the generate-in-daytona.ts script
        const scriptPath = path.join(process.cwd(), "scripts", "generate-in-daytona.ts");
        childProcess = spawn("npx", ["tsx", scriptPath, prompt], {
          env: {
            ...process.env,
            DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          },
        });
        
        let sandboxId = "";
        let previewUrl = "";
        let buffer = "";
        
        // Capture stdout
        childProcess.stdout.on("data", async (data: Buffer) => {
          try {
            if (isConnectionClosed) return;
            
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ""; // Keep incomplete line in buffer
            
            for (const line of lines) {
              if (!line.trim() || isConnectionClosed) continue;
              
              // Parse Claude messages
              if (line.includes('__CLAUDE_MESSAGE__')) {
                const jsonStart = line.indexOf('__CLAUDE_MESSAGE__') + '__CLAUDE_MESSAGE__'.length;
                try {
                  const message = JSON.parse(line.substring(jsonStart).trim());
                  await safeWrite(`data: ${JSON.stringify({ 
                    type: "claude_message", 
                    content: message.content 
                  })}\n\n`);
                } catch (e) {
                  // Ignore parse errors
                }
              }
              // Parse tool uses
              else if (line.includes('__TOOL_USE__')) {
                const jsonStart = line.indexOf('__TOOL_USE__') + '__TOOL_USE__'.length;
                try {
                  const toolUse = JSON.parse(line.substring(jsonStart).trim());
                  await safeWrite(`data: ${JSON.stringify({ 
                    type: "tool_use", 
                    name: toolUse.name,
                    input: toolUse.input 
                  })}\n\n`);
                } catch (e) {
                  // Ignore parse errors
                }
              }
              // Parse tool results
              else if (line.includes('__TOOL_RESULT__')) {
                // Skip tool results for now to reduce noise
                continue;
              }
              // Regular progress messages
              else {
                const output = line.trim();
                
                // Filter out internal logs
                if (output && 
                    !output.includes('[Claude]:') && 
                    !output.includes('[Tool]:') &&
                    !output.includes('__')) {
                  
                  // Send as progress
                  await safeWrite(`data: ${JSON.stringify({ 
                    type: "progress", 
                    message: output 
                  })}\n\n`);
                  
                  // Extract sandbox ID
                  const sandboxMatch = output.match(/Sandbox created: ([a-f0-9-]+)/);
                  if (sandboxMatch) {
                    sandboxId = sandboxMatch[1];
                  }
                  
                  // Extract preview URL
                  const previewMatch = output.match(/Preview URL: (https:\/\/[^\s]+)/);
                  if (previewMatch) {
                    previewUrl = previewMatch[1];
                  }
                }
              }
            }
          } catch (error: any) {
            console.error("[API] Error processing stdout:", error);
          }
        });
        
        // Capture stderr
        childProcess.stderr.on("data", async (data: Buffer) => {
          try {
            if (isConnectionClosed) return;
            
            const error = data.toString();
            console.error("[Daytona Error]:", error);
            
            // Only send actual errors, not debug info
            if (error.includes("Error") || error.includes("Failed")) {
              await safeWrite(`data: ${JSON.stringify({ 
                type: "error", 
                message: error.trim() 
              })}\n\n`);
            }
          } catch (error: any) {
            console.error("[API] Error processing stderr:", error);
          }
        });
        
        // Wait for process to complete
        await new Promise((resolve, reject) => {
          childProcess.on("exit", (code: number | null) => {
            if (code === 0) {
              resolve(code);
            } else {
              reject(new Error(`Process exited with code ${code}`));
            }
          });
          
          childProcess.on("error", (error: Error) => {
            console.error("[API] Child process error:", error);
            reject(error);
          });
        });
        
        // Send completion with preview URL
        if (!isConnectionClosed) {
          if (previewUrl) {
            await safeWrite(`data: ${JSON.stringify({ 
              type: "complete", 
              sandboxId,
              previewUrl 
            })}\n\n`);
            console.log(`[API] Generation complete. Preview URL: ${previewUrl}`);
          } else {
            console.log("[API] Warning: No preview URL found, but generation completed");
            await safeWrite(`data: ${JSON.stringify({ 
              type: "complete", 
              sandboxId,
              previewUrl: null,
              warning: "No preview URL found"
            })}\n\n`);
          }
          
          // Send done signal
          await safeWrite("data: [DONE]\n\n");
        }
        
      } catch (error: any) {
        console.error("[API] Error during generation:", error);
        if (!isConnectionClosed) {
          await safeWrite(`data: ${JSON.stringify({ 
            type: "error", 
            message: error.message 
          })}\n\n`);
          await safeWrite("data: [DONE]\n\n");
        }
      } finally {
        // Clean up
        if (childProcess) {
          childProcess.removeAllListeners();
          if (!childProcess.killed) {
            childProcess.kill('SIGTERM');
          }
        }
        
        // Close writer safely
        try {
          if (!isConnectionClosed) {
            await writer.close();
          }
        } catch (error: any) {
          console.log("[API] Writer already closed:", error.message);
        }
      }
    })();
    
    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
    
  } catch (error: any) {
    console.error("[API] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}