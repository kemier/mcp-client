import * as http from 'node:http';
import * as readline from 'node:readline';
import { McpServerManager } from "../services/McpServerManager.js";
import { LogManager } from "../utils/LogManager.js";

// --- Interfaces ---

// Represents a tool definition usable by the client/LLM
export interface SimpleTool {
  name: string;
  description: string;
  inputSchema: any; // Use 'any' for flexibility for now
}

// Represents a request from the LLM to call a specific tool
export interface ToolCallRequest {
  tool: string; // Name of the tool
  parameters: Record<string, any>; // Parameters for the tool
}

// Represents the result of executing a tool call
export interface ToolCallResult {
  toolName: string;
  result: any; // Result from the MCP server
  error?: string; // Optional error message
}

// Define a type for the tool info received from the SDK's listTools (replace 'any' if specific type is known)
// Linter indicated ToolInfo wasn't exported, so defining a basic structure based on usage
type SdkToolInfo = {
  name: string;
  description?: string;
  inputSchema?: any;
}

// --- MCP Client Class (Manual HTTP Implementation) ---
export class MCPClient {
  private serverIp: string | null = null;
  private serverPort: number | null = null;
  private serverRpcUrl: string | null = null;
  private inferenceServerTools: SimpleTool[] = [];
  private managedServerTools: SimpleTool[] = [];
  private allToolsForLLM: SimpleTool[] = [];
  private conversationHistory: any[] | null = null;
  private rl: readline.Interface | null = null;
  private isProcessing: boolean = false;
  private isConnected: boolean = false;
  private componentName = "MCPClient(ManualHTTP)";
  private mcpServerManager: McpServerManager;

  constructor(manager: McpServerManager) {
    this.mcpServerManager = manager;
    LogManager.info(this.componentName, "MCPClient instance created (using manual HTTP).");
  }

  /**
   * Configures the client to connect to the inference server via HTTP.
   * @param ip The IP address of the server.
   * @param port The port number of the server.
   */
  async connectToServer(ip: string, port: number): Promise<void> {
    if (!ip || !port) {
      throw new Error("Server IP address and Port must be provided.");
    }
    this.serverIp = ip;
    this.serverPort = port;
    // Assuming the Python server has the endpoint at /rpc
    this.serverRpcUrl = `http://${ip}:${port}/rpc`;
    LogManager.info(this.componentName, `Configured to send requests to: ${this.serverRpcUrl}`);

    // Connection is now stateless (HTTP), but we can do a quick check
    // to see if the server seems reachable and maybe list tools.
    try {
      LogManager.debug(this.componentName, `Performing initial check and listing tools from ${this.serverRpcUrl}`);
      await this.listToolsInternal(); // Attempt to list tools on connect
      // If listToolsInternal succeeds (doesn't throw), we consider it 'connected'
      this.isConnected = true;
       // Fetch managed tools after successful initial check
      this.updateToolList();
      LogManager.info(this.componentName, `Initial check/tool list successful. Ready to send requests.`);

    } catch (err: any) {
      this.isConnected = false;
      LogManager.error(this.componentName, `Initial check or tool list failed for ${this.serverRpcUrl}`, err);
       // Still update managed tools, but LLM won't have inference server tools
      this.updateToolList();
      // Rethrow the error so the activation in extension.ts knows connection failed
      throw new Error(`Failed initial connection/tool list: ${err.message}`);
    }
  }

  private sendRequest(method: string, params: any = {}): Promise<any> {
    // We only need to know if the configuration (IP/Port/URL) is present to attempt a request.
    // The state of 'isConnected' is determined by the *success* of requests, not a prerequisite to send one.
    if (!this.serverRpcUrl || !this.serverIp || !this.serverPort) {
      return Promise.reject(new Error("HTTP client not configured (missing IP/Port/URL).")); // Adjusted error message slightly
    }

    const requestId = Date.now(); // Simple request ID for logging HTTP requests
    const jsonRpcPayload = {
      jsonrpc: "2.0",
      // Use method and params directly if server expects that in body,
      // or nest them if server expects a full JSON-RPC request object in the body.
      // Assuming server expects full JSON-RPC object based on inference_server.py
      id: requestId,
      method: method,
      params: params
    };
    const payloadString = JSON.stringify(jsonRpcPayload);

    LogManager.debug(this.componentName, `Sending HTTP POST to ${this.serverRpcUrl}`, { id: requestId, method: method, params: params });

    const options: http.RequestOptions = {
      // Use stored ip/port
      hostname: this.serverIp,
      port: this.serverPort,
      path: '/rpc', // Standard path from inference_server.py
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadString),
        'Accept': 'application/json' // Indicate we expect JSON back
      },
      timeout: 120000 // 120 seconds (previously 60000)
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          LogManager.debug(this.componentName, `Received HTTP response for ${requestId} (${method})`, { statusCode: res.statusCode, body: responseBody });
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const jsonRpcResponse = JSON.parse(responseBody);
              // Check for JSON-RPC level error
              if (jsonRpcResponse.error) {
                LogManager.error(this.componentName, `JSON-RPC error for ${requestId} (${method})`, jsonRpcResponse.error);
                reject(new Error(jsonRpcResponse.error.message || JSON.stringify(jsonRpcResponse.error)));
              } else {
                // Success - resolve with the result part
                resolve(jsonRpcResponse.result);
              }
            } catch (e: any) {
              LogManager.error(this.componentName, `Failed to parse JSON response for ${requestId} (${method})`, { body: responseBody, error: e });
              reject(new Error(`Failed to parse JSON response: ${e.message}`));
            }
          } else {
            // Handle HTTP level errors
            LogManager.error(this.componentName, `HTTP error for ${requestId} (${method})`, { statusCode: res.statusCode, statusMessage: res.statusMessage, body: responseBody });
            reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}. Body: ${responseBody}`));
          }
        });
      });

      req.on('error', (e) => {
        LogManager.error(this.componentName, `HTTP request error for ${requestId} (${method})`, e);
        this.isConnected = false; // Mark as disconnected on network error
        reject(new Error(`HTTP request error: ${e.message}`));
      });

      req.on('timeout', () => {
        req.destroy(); // Important to destroy the request on timeout
        LogManager.error(this.componentName, `HTTP request timed out for ${requestId} (${method})`);
         this.isConnected = false; // Mark as disconnected on timeout
        reject(new Error('HTTP request timed out'));
      });

      // Write the JSON-RPC payload to the request body
      req.write(payloadString);
      req.end(); // Send the request
    });
  }

  /** Internal method to fetch tools from the connected inference server */
  private async listToolsInternal(): Promise<void> {
    try {
      LogManager.debug(this.componentName, "Listing tools from inference server (manual HTTP)...");
       // Use the JSON-RPC method name defined in inference_server.py
      const result = await this.sendRequest('tool_list'); // Changed from 'tools/list' to match python server
      // The python server returns { "tools": [...] } in the result field
      this.inferenceServerTools = (result?.tools || []).map((tool: any) => ({
        name: tool.name,
        description: tool.description || `Tool ${tool.name}`,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      }));
      LogManager.info(this.componentName, `Found ${this.inferenceServerTools.length} tools on inference server:`, { names: this.inferenceServerTools.map(t => t.name) });
    } catch (err) {
      LogManager.error(this.componentName, `Failed to list tools from inference server (manual HTTP)`, err);
      this.inferenceServerTools = [];
      throw err; // Re-throw error so connectToServer knows it failed
    }
  }

  /** Fetches tools from McpServerManager and updates the combined list */
  private updateToolList() {
    LogManager.debug(this.componentName, "Updating tool list from McpServerManager...");
    this.managedServerTools = [];
    const managedServers = this.mcpServerManager.getConnectedServerIdsAndCapabilities();

    LogManager.debug(this.componentName, `Found ${managedServers.length} connected managed servers.`);

    managedServers.forEach(({ serverId, capabilities }) => {
      if (capabilities && capabilities.capabilities) {
        LogManager.debug(this.componentName, `Processing ${capabilities.capabilities.length} capabilities for server: ${serverId}`);
        capabilities.capabilities.forEach(cap => {
          const prefixedName = `${serverId}@${cap.name}`;
          this.managedServerTools.push({
            name: prefixedName,
            description: cap.description || `Tool ${cap.name} on server ${serverId}`,
            inputSchema: cap.inputSchema || { type: 'object', properties: {} },
          });
        });
      } else {
         LogManager.debug(this.componentName, `Server ${serverId} reported no capabilities.`);
      }
    });

    this.allToolsForLLM = [...this.inferenceServerTools, ...this.managedServerTools];
    LogManager.info(this.componentName, `Total tools available for LLM: ${this.allToolsForLLM.length}`, { names: this.allToolsForLLM.map(t => t.name) });
  }

  // --- Placeholder for Local LLM Interaction ---
  private async callLocalLLM(prompt: string, tools?: SimpleTool[]): Promise<string> {
    LogManager.debug(this.componentName, "callLocalLLM - Tools Provided:", { names: tools?.map(t => t.name) });
    LogManager.debug(this.componentName, "callLocalLLM - Prompt:", { prompt });
    console.log("\n--- Calling Local LLM (Placeholder) ---");
    console.log("Tools Provided:", tools?.map(t => t.name));
    console.log("Prompt:", prompt);
    console.log("---------------------------------------\n");

    // Simulate LLM deciding whether to use a tool based on the prompt
    if (prompt.toLowerCase().includes("what time") && tools?.some(t => t.name.includes("time"))) {
        return JSON.stringify([{ tool: "time@get_current_time", parameters: { timezone: "Asia/Shanghai"} }]); // Example managed call
    } else if (prompt.toLowerCase().includes("list files") && tools?.some(t => t.name.includes("filesystem"))) {
        return JSON.stringify([{ tool: "filesystem@list_files", parameters: { path: "." } }]);
    } else if (prompt.toLowerCase().includes("add") && tools?.some(t => t.name === "add")) { // Assuming 'add' is on inference server
        // ** IMPORTANT: Change "add" to the ACTUAL tool name returned by your inference server **
        // ** based on the `tool_list` response from the server. **
        // ** If the inference server has no tools, this condition won't be met. **
        return JSON.stringify([{ tool: "add", parameters: { a: 5, b: 3 } }]); // Placeholder tool name
    } else {
       const userRequestMatch = prompt.match(/User request:\s*(.*)/s);
       const userRequest = userRequestMatch ? userRequestMatch[1].trim() : "your request";
       // If no tools match, generate a text response using the inference server
       try {
            const createMessageResult = await this.sendRequest('create_message', { message: userRequest });
            // Assuming createMessageResult is { type: "final_text", content: "..." }
            if (createMessageResult?.type === 'final_text') {
                return createMessageResult.content;
            } else {
                 LogManager.warn(this.componentName, "LLM (via create_message) did not return final_text", createMessageResult);
                 return "Sorry, I encountered an unexpected response format.";
            }
        } catch (llmError: any) {
            LogManager.error(this.componentName, "Error calling create_message on inference server", llmError);
            return `Sorry, I couldn't process that: ${llmError.message}`;
        }
    }
  }
  // --- End Placeholder ---

  private generateInitialPrompt(userQuery: string): string {
    const toolsString = JSON.stringify(this.allToolsForLLM.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
    })), null, 2);

    const prompt = `You are a helpful assistant with access to the following tools:
<tools>
${toolsString}
</tools>

If you need to use a tool to answer the user's request, respond ONLY with a JSON array containing the tool calls, like this:
[{"tool": "tool_name", "parameters": {"param1": "value1", ...}}]

If you do not need to use a tool, respond directly to the user.

User request: ${userQuery}`;
    LogManager.debug(this.componentName, "Generated Initial Prompt:", { prompt });
    return prompt;
  }

  private parseLLMResponseForToolCalls(responseText: string): ToolCallRequest[] {
      try {
          if (responseText.trim().startsWith('[') && responseText.trim().endsWith(']')) {
              const potentialCalls = JSON.parse(responseText);
              if (Array.isArray(potentialCalls) && potentialCalls.every(c => typeof c.tool === 'string')) {
                   console.log("Parsed tool calls from LLM:", potentialCalls);
                  return potentialCalls;
              }
          }
      } catch (e) {
          console.log("LLM response was not valid JSON for tool calls, treating as text.");
      }
      return [];
  }

  private generateFollowUpPrompt(originalQuery: string, toolResults: ToolCallResult[]): string {
      const resultsString = JSON.stringify(toolResults, null, 2);
      return `You previously received the request: "${originalQuery}"
You decided to use tools, and here are the results:
<tool_results>
${resultsString}
</tool_results>

Based on these results, please provide the final response to the user.`;
  }

  /**
   * Processes a user query using the local LLM and MCP tools.
   * @param query The user's input query.
   */
  async processQuery(query: string): Promise<string> {
    if (this.isProcessing) {
      LogManager.warn(this.componentName, "Attempted to start a new query while already processing.");
      return "[Error: Already processing a query. Please wait.]";
    }
    if (!this.isConnected) {
      return "[Error: Not connected to inference server]";
    }

    this.isProcessing = true;
    LogManager.info(this.componentName, `Processing query:`, { query });

    try {
      // Refresh tool list before each query
      await this.listToolsInternal();
      this.updateToolList();

      let finalResponseHistory: any[] | null = null; // To store history from the last successful LLM response in the loop
      // Construct the history for this specific request
      const historyForThisRequest = this.conversationHistory ? [...this.conversationHistory] : [];
      historyForThisRequest.push({ role: 'user', content: query });

      let currentIteration = 0;
      const maxIterations = 10; // Limit loops to prevent infinite execution

      // Initial request to LLM
      LogManager.debug(this.componentName, "Asking inference server (create_message) to process initial query and decide on tools...");
      let llmResponse = await this.sendRequest('create_message', {
        message: query, // Keep sending message for servers that might use it
        tools: this.allToolsForLLM,
        history: historyForThisRequest // Pass the history *including* the current user query
      });

      while (currentIteration < maxIterations) {
        currentIteration++;
        LogManager.debug(this.componentName, `Processing LLM response (Iteration ${currentIteration}):`, llmResponse);

        // Store the history from this response, as it might be the last one
        if (llmResponse?.history) {
            finalResponseHistory = llmResponse.history;
        }

        if (llmResponse?.type === 'tool_calls') {
          const toolCalls = llmResponse.content as ToolCallRequest[];
          // currentHistory = llmResponse.history; // Capture history from the response - Use llmResponse.history directly below

          if (!toolCalls || toolCalls.length === 0) {
             LogManager.warn(this.componentName, "LLM responded with 'tool_calls' but content was empty or invalid.", llmResponse);
             throw new Error("LLM indicated tool calls but provided none.");
          }

          LogManager.info(this.componentName, `Inference server requested ${toolCalls.length} tool call(s) (Iteration ${currentIteration}).`);

          // --- Execute requested tool calls ---
          const toolResults: ToolCallResult[] = [];
          for (const call of toolCalls) {
            LogManager.debug(this.componentName, "Processing tool call request:", call);
            const toolIdentifier = call.tool;
            const parameters = call.parameters;

            if (toolIdentifier.includes('@')) {
                // Managed server tool
                const [serverId, toolName] = toolIdentifier.split('@');
                if (!serverId || !toolName) {
                   LogManager.warn(this.componentName, `Invalid managed tool identifier format: ${toolIdentifier}`);
                   toolResults.push({ toolName: toolIdentifier, result: null, error: "Invalid tool identifier format" });
                   continue;
                }
                LogManager.info(this.componentName, `Dispatching tool call to managed server: ${serverId}, Tool: ${toolName}`);
                try {
                    const result = await this.mcpServerManager.callServerMethod(
                        serverId,
                        toolName,
                        parameters || {} // Pass the parameters received from LLM directly
                    );
                    toolResults.push({ toolName: toolIdentifier, result: result });
                } catch (error: any) {
                    LogManager.error(this.componentName, `Error calling managed tool ${toolIdentifier}`, error);
                    toolResults.push({ toolName: toolIdentifier, result: null, error: error.message || String(error) });
                }
            } else {
                 // Inference server tool (currently not supported for execution)
                 LogManager.warn(this.componentName, `Execution of inference server tool '${toolIdentifier}' requested, but not implemented.`);
                 toolResults.push({ toolName: toolIdentifier, result: null, error: `Execution of tool '${toolIdentifier}' on inference server not implemented.` });
            }
          }

          // --- Process results before sending back to LLM ---
          const processedToolResults = toolResults.map(item => {
              if (item.result === undefined || item.result === null) {
                  return item; // Keep as is if no result or explicit null
              }

              const MAX_RESULT_LENGTH = 2000; // Max characters for stringified result
              let resultString: string;
              try {
                  resultString = JSON.stringify(item.result);
              } catch (e) {
                   LogManager.warn(this.componentName, `Failed to stringify tool result for ${item.toolName}`, e);
                  return { ...item, result: `[Error stringifying result: ${(e as Error).message}]` };
              }

              if (resultString.length > MAX_RESULT_LENGTH) {
                  LogManager.warn(this.componentName, `Tool result for ${item.toolName} exceeds ${MAX_RESULT_LENGTH} chars, truncating.`);
                  // Try to provide a more structured truncation for arrays
                  if (Array.isArray(item.result)) {
                      const truncatedArray = item.result.slice(0, 5); // Take first 5 elements
                      return {
                          ...item,
                          result: {
                             summary: `[Truncated array - showing first ${truncatedArray.length} of ${item.result.length} items]`,
                             items: truncatedArray
                          }
                      };
                  } else {
                      // General truncation for large objects/strings
                      return {
                          ...item,
                           result: resultString.substring(0, MAX_RESULT_LENGTH) + '... [result truncated]'
                      };
                  }
              } else {
                  return item; // Result is within size limits
              }
          });

          // --- Send processed results back to LLM ---
          LogManager.debug(this.componentName, "Asking inference server (create_message) to process truncated tool results...");
          llmResponse = await this.sendRequest('create_message', {
            tool_results: processedToolResults, // Use the processed results
            history: llmResponse.history, // Send history from the *previous* LLM response
            tools: this.allToolsForLLM
          });
          // Loop continues with the new llmResponse

        } else if (llmResponse?.type === 'final_text') {
          LogManager.info(this.componentName, `Received final_text response from inference server (Iteration ${currentIteration}).`);
          this.conversationHistory = finalResponseHistory; // Update persistent history HERE
          this.isProcessing = false;
          return llmResponse.content; // End of processing loop

        } else {
          // Handle unexpected response format
           this.conversationHistory = finalResponseHistory; // Update history even if format is wrong
          LogManager.warn(this.componentName, "Received unexpected response format from create_message", llmResponse);
          throw new Error("Unexpected response format from inference server during loop.");
        }
      }

      // If loop finishes due to max iterations
      if (currentIteration >= maxIterations) {
          this.conversationHistory = finalResponseHistory; // Update history before throwing
          LogManager.warn(this.componentName, `Exceeded maximum iteration count (${maxIterations}).`);
          throw new Error("Maximum processing iterations exceeded.");
      }

      // Should not be reached if loop logic is correct, but acts as a fallback.
      this.conversationHistory = finalResponseHistory; // Update history before throwing
      LogManager.error(this.componentName, "Processing loop ended unexpectedly.");
      throw new Error("Query processing failed unexpectedly.");

    } catch (error: any) {
      // DO NOT update history here, as finalResponseHistory might be from before the error occurred
      // Or potentially update with the history *before* the failing call if needed?
      // For now, we'll let the history be potentially stale if a network error happens.
      LogManager.error(this.componentName, "Error during query processing loop", error);
      this.isProcessing = false;
      return `[An error occurred during processing: ${error.message || String(error)}]`;
    } finally {
        // Ensure isProcessing is always reset, even if an unexpected error occurs before the main catch block
        this.isProcessing = false;
    }
  }

  /**
   * Clears the current conversation history to start a new chat context.
   */
  public startNewChat(): void {
      LogManager.info(this.componentName, "Starting new chat, clearing conversation history.");
      this.conversationHistory = null;
      // Optionally, you might want to notify the UI to clear its display here
      // For example, if the ChatViewProvider has a reference:
      // this.mcpServerManager.getChatViewProvider()?.clearChatDisplay();
  }

  /**
   * Starts the interactive command-line chat loop.
   */
  async startChatLoop() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Enter query (or "exit")> '
    });

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const query = line.trim();
      if (query.toLowerCase() === 'exit') {
        this.rl?.close();
        return;
      }

      if (!query || this.isProcessing) {
        if (this.isProcessing) console.log("Please wait for the current query to finish...");
         this.rl?.prompt();
        return;
      }

      try {
        console.log("Processing...");
        const result = await this.processQuery(query);
        console.log("\nAssistant:", result);
      } catch (error) {
        console.error("\nError processing query:", error);
      } finally {
        if (this.rl) {
            this.rl.prompt();
        }
      }
    });

    return new Promise<void>((resolve) => {
        this.rl?.on('close', () => {
          console.log('\nExiting chat loop.');
          resolve();
        });
    });
  }

  /**
   * Cleans up resources. (No persistent connection to close for HTTP)
   */
  async cleanup() {
    LogManager.info(this.componentName, "MCP Client cleaning up (manual HTTP)...");
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    // No persistent socket to close
    this.serverIp = null;
    this.serverPort = null;
    this.serverRpcUrl = null;
    this.isConnected = false;
    LogManager.info(this.componentName, "Cleanup finished.");
  }
}