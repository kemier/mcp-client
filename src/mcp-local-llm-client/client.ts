import * as http from 'node:http';
import * as readline from 'node:readline';
import WebSocket from 'ws';
import { JSONRPCClient, JSONRPCRequest, JSONRPCResponse } from 'json-rpc-2.0';
import { McpServerManager } from "../services/McpServerManager.js";
import { LogManager } from "../utils/LogManager.js";
import { ChatViewProvider } from '../panels/ChatViewProvider.js';
import * as vscode from 'vscode'; // Import vscode for ExtensionContext
import { 
    ServerStatus, ServerConfig, ChatSession, SimpleTool, FunctionCallRequest, ToolResult, SessionResponse, ChatMessage, ChatSessionMetadata,
    // Import the new notification param types
    TextChunkNotificationParams, FinalTextNotificationParams, FunctionCallRequestNotificationParams,
    StatusNotificationParams, ErrorNotificationParams, EndNotificationParams,
    ServerStatusEvent
} from '../models/Types.js';

// Local interface for generate RPC parameters
interface GenerateParams {
    history: Array<{
        role: string;
        content?: string;
        tool_calls?: any[];
        tool_call_id?: string;
        tool_name?: string; 
    }>;
    tools: any[];
}

// --- Constants for storage (kept from original) ---
const SESSION_STORAGE_KEY = 'mcpChatSessions';
const ACTIVE_SESSION_ID_KEY = 'mcpActiveSessionId';
const MAX_SESSIONS = 5; // Keep session limit

// --- Utility Function ---
/** Removes <think> tags from LLM output */
function cleanLLMOutput(text: string): string {
    return (text || '').replace(/<\/?think>/g, '');
}

/** Helper function to format tools for the LLM server */
function mapToolsForLLM(tools: SimpleTool[]): any[] {
    return tools.map(tool => {
        const baseName = tool.name.includes('@') ? tool.name.split('@')[1] : tool.name;
        return {
            // Assuming LLM expects structure like OpenAI: { type: 'function', function: { name: ..., description: ..., parameters: ... } }
            // Adjust if your LLM server expects a different format
            type: 'function', 
            function: {
                name: baseName,
                description: tool.description,
                parameters: tool.inputSchema // Assuming inputSchema matches LLM's parameter schema needs
            }
        };
    });
}

// --- Refactored MCP Client Class (WebSocket + JSON-RPC) ---
export class MCPClient {
  private serverIp: string | null = null;
  private serverPort: number | null = null;
  private wsUrl: string | null = null;
  private ws: WebSocket | null = null;
  private jsonRpcClient: JSONRPCClient | null = null;
  private allToolsForLLM: SimpleTool[] = [];
  private componentName = "MCPClient(WebSocket)";
  private mcpServerManager: McpServerManager;
  private _context: vscode.ExtensionContext;

  // Session Management State
  private sessions: ChatSession[] = [];
  private activeSessionId: string | null = null;
  private activeServerSessionId: string | null = null;

  // State for managing JSON-RPC requests and correlating notifications
  private requestMap = new Map<string | number, { resolve: (result: any) => void, reject: (error: any) => void }>();
  private notificationHandlers = new Map<string, (params: any) => void>(); 
  private isConnecting: boolean = false;
  // Store connection promises mapped by local session ID to prevent duplicate attempts
  private connectionPromises = new Map<string, Promise<void>>(); 
  // State for active tasks (Simplified: assuming one task per active connection)
  private currentTaskState: {
    localSessionId: string;
    accumulatedText: string;
    pendingToolCalls: FunctionCallRequest[];
    finalTextFromServer: string | null;
  } | null = null;

  constructor(manager: McpServerManager, context: vscode.ExtensionContext) {
    this.mcpServerManager = manager;
    this._context = context;
    LogManager.info(this.componentName, "MCPClient instance created (using WebSocket).");
    this.loadSessionsFromStorage();
    this._setupNotificationHandlers();
  }

  /**
   * Sets the IP address and Port for the inference server.
   * This must be called before processQuery is used.
   */
  public setConfig(ip: string, port: number): void {
    this.serverIp = ip;
    this.serverPort = port;
    // Construct the base wsUrl here as well, maybe? Or leave it to connectToServer
    // this.wsUrl = `ws://${this.serverIp}:${this.serverPort}`; // Example
    LogManager.info(this.componentName, `Server configuration set: IP='${this.serverIp}', Port=${this.serverPort}`); // Log assigned values
  }

  // --- Session Persistence Methods (kept mostly from original) ---
  private loadSessionsFromStorage(): void {
    try {
      const savedSessions = this._context.globalState.get<ChatSession[]>(SESSION_STORAGE_KEY);
      const savedActiveId = this._context.globalState.get<string>(ACTIVE_SESSION_ID_KEY);

      if (Array.isArray(savedSessions) && savedSessions.length > 0) {
        this.sessions = savedSessions;
        LogManager.info(this.componentName, `Loaded ${this.sessions.length} chat sessions from persistent storage.`);

        if (savedActiveId && this.sessions.some(s => s.id === savedActiveId)) {
            this.activeSessionId = savedActiveId;
             LogManager.info(this.componentName, `Restored active session ID: ${this.activeSessionId}`);
        } else if (this.sessions.length > 0) {
            this.activeSessionId = this.sessions[0].id; // Default to most recent
            LogManager.info(this.componentName, `No valid active session ID found, defaulting to most recent: ${this.activeSessionId}`);
             this._context.globalState.update(ACTIVE_SESSION_ID_KEY, this.activeSessionId);
        } else {
             // Should not happen if savedSessions has length > 0, but handles edge case
             this.activeSessionId = null;
        }
      } else {
        LogManager.info(this.componentName, 'No chat sessions found in storage. Will create on first message.');
        this.sessions = [];
        this.activeSessionId = null;
      }
    } catch (error: any) {
        LogManager.error(this.componentName, 'Failed to load chat sessions from globalState', error);
        this.sessions = [];
        this.activeSessionId = null;
    }
  }

  private saveSessionsToStorage(): void {
      try {
          this._context.globalState.update(SESSION_STORAGE_KEY, this.sessions);
          this._context.globalState.update(ACTIVE_SESSION_ID_KEY, this.activeSessionId);
          LogManager.debug(this.componentName, `Saved ${this.sessions.length} sessions and active ID ${this.activeSessionId} to persistent storage.`);
      } catch (error: any) {
           LogManager.error(this.componentName, 'Failed to save chat sessions to globalState', error);
      }
  }

  // Method to get list of sessions for UI (kept from original)
  public getSessionList(): { id: string; title: string }[] {
      // Sort sessions by ID (timestamp) descending to show newest first
      return [...this.sessions] // Create shallow copy before sorting
          .sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10))
          .map(session => ({ id: session.id, title: session.title }));
  }

  // Method to switch the active session (kept from original)
  public switchActiveSession(sessionId: string): boolean {
      const sessionExists = this.sessions.some(s => s.id === sessionId);
      if (sessionExists) {
          this.activeSessionId = sessionId;
          this._context.globalState.update(ACTIVE_SESSION_ID_KEY, this.activeSessionId); // Save change
          LogManager.info(this.componentName, `Switched active session to: ${sessionId}`);
          return true;
      } else {
          LogManager.warn(this.componentName, `Attempted to switch to non-existent session ID: ${sessionId}`);
          return false;
      }
  }

  // Get the history of the *currently active* session (kept from original)
  public getHistory(): any[] {
    if (!this.activeSessionId) {
        LogManager.warn(this.componentName, "getHistory called with no active session.");
        return [];
    }
    const activeSession = this.sessions.find(s => s.id === this.activeSessionId);
    return activeSession ? [...activeSession.history] : []; // Return copy
  }

  // Get the active session ID (kept from original)
   public getActiveSessionId(): string | null {
        return this.activeSessionId;
   }

  /** Creates a new chat session state locally and saves */
  public startNewChat(): void {
      // This method now primarily manages the *client-side* session state.
      // The actual server session is created implicitly on the first message.
      // We generate a temporary ID or use a placeholder until the server provides one.
      // However, to integrate with the existing structure, we'll keep creating
      // client-side sessions with timestamp IDs, and potentially update the ID
      // later if the server provides one differently. For now, stick to the old way.

      const newSessionId = Date.now().toString(); // Use timestamp as client-side ID
      const newSession: ChatSession = {
          id: newSessionId,
          title: 'New Chat', // Initial title
          history: []
      };

      LogManager.info(this.componentName, `Creating new client-side chat session state: ${newSessionId}`);
      this.sessions.unshift(newSession); // Add to beginning
      if (this.sessions.length > MAX_SESSIONS) {
          const removedSession = this.sessions.pop();
          LogManager.info(this.componentName, `Session limit (${MAX_SESSIONS}) reached. Removed oldest session: ${removedSession?.id}`);
      }
      this.activeSessionId = newSessionId; // Set new one as active
      this.saveSessionsToStorage();
  }

  // --- End Session Persistence ---

  /**
   * Helper function for making fetch requests and handling JSON responses/errors.
   */
  private async _fetchJSON<T>(endpoint: string, options: RequestInit = {}, attempt = 1): Promise<T> {
    if (!this.serverIp || !this.serverPort) {
        throw new Error("Client not configured. Call connectToServer first.");
    }
    const baseUrl = `http://${this.serverIp}:${this.serverPort}`;
    const url = `${baseUrl}${endpoint}`;
    const method = options.method || 'GET';
    LogManager.debug(this.componentName, `Fetching (${attempt}): ${method} ${url}`, { body: options.body ? String(options.body).substring(0,100)+'...' : 'N/A' });

    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(options.headers || {}),
            },
            // Consider adding timeout support if using node-fetch or similar
        });

        if (!response.ok) {
            let errorBody = 'Unknown error';
            try {
                errorBody = await response.text();
                LogManager.error(this.componentName, `HTTP Error Body for ${method} ${url}: ${errorBody}`);
            } catch (e) { /* ignore */ }
            throw new Error(`HTTP error ${response.status} ${response.statusText} for ${method} ${url}.`);
        }

        // Handle cases where response might be empty (e.g., successful POST with 204 No Content)
        const contentType = response.headers.get("content-type");
        if (response.status === 204 || !contentType || !contentType.includes("application/json")) {
             LogManager.debug(this.componentName, `Fetch successful (No JSON Body) for ${method} ${url}. Status: ${response.status}`);
             return {} as T; // Return empty object or appropriate type
        }

        const data = await response.json();
        LogManager.debug(this.componentName, `Fetch successful for ${method} ${url}. Response:`, data);
        return data as T;
    } catch (error: any) {
        LogManager.error(this.componentName, `Fetch failed for ${method} ${url}: ${error.message}`, { stack: error.stack });
        throw error; // Re-throw after logging
    }
  }

  /**
   * Configures the client and establishes WebSocket connection for a specific server session ID.
   */
  private async connectToServer(ip: string, port: number, serverSessionId: string): Promise<void> {
    // Use serverSessionId for managing connection attempts
    if (this.connectionPromises.has(serverSessionId)) {
        LogManager.info(this.componentName, `Connection attempt already in progress for session ${serverSessionId}. Reusing promise.`);
        return this.connectionPromises.get(serverSessionId);
    }
    // Check if already connected for this session (e.g., if ws exists and url matches)
    const targetWsUrl = `ws://${ip}:${port}/ws/${serverSessionId}`;
    if (this.ws && this.wsUrl === targetWsUrl && this.ws.readyState === WebSocket.OPEN) {
        LogManager.info(this.componentName, `Already connected for session ${serverSessionId}.`);
        return Promise.resolve();
    }
    // Close any existing connection if trying to connect for a *different* session
    if (this.ws && this.wsUrl !== targetWsUrl) {
         LogManager.warn(this.componentName, `Closing existing WS connection to ${this.wsUrl} before opening new one for ${serverSessionId}.`);
         await this.cleanup(); // Ensure previous connection is fully closed
    }

    LogManager.info(this.componentName, `Attempting WebSocket connection for session ${serverSessionId} to: ${targetWsUrl}`);
    this.serverIp = ip;
    this.serverPort = port;
    this.wsUrl = targetWsUrl; // Store the target URL
    this.activeServerSessionId = serverSessionId; // Track the currently connected server session

    const promise = new Promise<void>((resolve, reject) => {
        try {
            this.ws = new WebSocket(this.wsUrl!); // Assert non-null as checked above

            this.ws.on('open', () => {
                LogManager.info(this.componentName, `WebSocket connection established for session ${serverSessionId}`);
                this.connectionPromises.delete(serverSessionId); // Remove promise on success
                this._initializeJsonRpcClient();
                this.updateToolList(); // Maybe update tools based on session?
                resolve();
            });

            // --- Keep existing message, error, close handlers --- 
            this.ws.on('message', this._handleWsMessage); 
            this.ws.on('error', (error) => this._handleWsError(error, serverSessionId, reject)); // Pass reject
            this.ws.on('close', (code, reason) => this._handleWsClose(code, reason, serverSessionId)); 

        } catch (error: any) {
             LogManager.error(this.componentName, `Failed to initiate WebSocket connection for session ${serverSessionId}: ${error.message}`, error);
             this.connectionPromises.delete(serverSessionId); // Remove promise on failure
             this.ws = null;
             this.wsUrl = null;
             this.activeServerSessionId = null;
             reject(error);
        }
    });

    this.connectionPromises.set(serverSessionId, promise); // Store the promise
    return promise;
  }

  // --- WebSocket Event Handlers (extracted for clarity) ---
  private _handleWsMessage = (data: WebSocket.RawData) => {
        // --- Log raw message first ---
        const rawDataString = data.toString();
        LogManager.debug(this.componentName, `<<< Raw WS Message Received:`, rawDataString.substring(0, 500) + (rawDataString.length > 500 ? '...' : ''));
        // ---------------------------
        try {
            const parsedMessage = JSON.parse(rawDataString);
            // --- Existing JSON-RPC client handling ---
            if (this.jsonRpcClient) {
                this.jsonRpcClient.receive(parsedMessage);
            }
            // --- Existing Notification handling ---
            if (parsedMessage && typeof parsedMessage === 'object' && 'method' in parsedMessage && !('id' in parsedMessage)) {
                const notification = parsedMessage as { method: string, params: any };
                 LogManager.debug(this.componentName, `Identified notification: ${notification.method}`);
                const handler = this.notificationHandlers.get(notification.method);
                if (handler) {
                    try { 
                         LogManager.debug(this.componentName, `Attempting to call handler for: ${notification.method}`);
                         handler(notification.params); 
                         LogManager.debug(this.componentName, `Successfully called handler for: ${notification.method}`);
                    }
                    catch (handlerError: any) { 
                        LogManager.error(this.componentName, `Error executing handler for ${notification.method}: ${handlerError.message}`, handlerError);
                    }
                } else { 
                    LogManager.warn(this.componentName, `No handler found for notification method: ${notification.method}`);
                }
            } else {
                 LogManager.debug(this.componentName, `Message received was not a notification (likely a JSON-RPC response).`);
            }
        } catch (parseError: any) { 
            LogManager.error(this.componentName, `Failed to parse incoming WebSocket message: ${parseError.message}`, { rawMessage: rawDataString.substring(0, 200) });
        }
  }

  private _handleWsError = (error: Error, sessionId: string, reject?: (reason?: any) => void) => {
        LogManager.error(this.componentName, `WebSocket error for session ${sessionId}: ${error.message}`, error);
        this.connectionPromises.delete(sessionId);
        if (this.activeServerSessionId === sessionId) { // Only clear active state if it's the one that errored
             this.ws = null;
             this.wsUrl = null;
             this.jsonRpcClient = null;
             this.activeServerSessionId = null;
        }
        reject?.(new Error(`WebSocket connection error: ${error.message}`)); // Reject the connection promise if provided
   }

   private _handleWsClose = (code: number, reason: Buffer, sessionId: string) => {
        LogManager.info(this.componentName, `WebSocket connection closed for session ${sessionId}. Code: ${code}, Reason: ${reason.toString()}`);
        this.connectionPromises.delete(sessionId);
         if (this.activeServerSessionId === sessionId) { // Only clear active state if it's the one that closed
             this.ws = null;
             this.wsUrl = null;
             this.jsonRpcClient = null;
             this.activeServerSessionId = null;
        }
        // Potentially trigger reconnection logic here
   }

  /** Initializes the JSON-RPC client */
  private _initializeJsonRpcClient() {
      if (!this.ws) {
          LogManager.error(this.componentName, "Cannot initialize JSON-RPC: WebSocket is not connected.");
          return;
      }
      LogManager.debug(this.componentName, "Initializing JSON-RPC Client..."); 
      
      this.jsonRpcClient = new JSONRPCClient((jsonRPCRequest) => {
          try {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                  const message = JSON.stringify(jsonRPCRequest);
                  LogManager.debug(this.componentName, `Sending JSON-RPC request:`, message.substring(0, 200));
                  this.ws.send(message);
                  return Promise.resolve();
              } else {
                  LogManager.error(this.componentName, "Cannot send JSON-RPC request: WebSocket is not open.");
                  return Promise.reject(new Error("WebSocket is not open."));
              }
          } catch (error) {              
              LogManager.error(this.componentName, "Failed to stringify/send JSON-RPC request", error);          
              return Promise.reject(error);
          }
      });
      
      LogManager.debug(this.componentName, "JSON-RPC Client initialized.");
  }

  /** Sets up handlers for expected server notifications */
  private _setupNotificationHandlers() {
     LogManager.debug(this.componentName, "Setting up notification handlers...");
     // REMOVED: Don't capture potentially stale provider here
     // const chatProvider = ChatViewProvider.instance; 
     // if (!chatProvider) {
     //     LogManager.warn(this.componentName, "ChatViewProvider instance not available during handler setup! UI updates will fail.");
     // }

     this.notificationHandlers.set('text_chunk', (params: TextChunkNotificationParams) => {
         LogManager.debug(this.componentName, "--- ENTERING text_chunk handler ---"); // Add entry log
         const chatProvider = ChatViewProvider.instance; // Get current instance
         // Add checks for params and task_id
         if (!params || typeof params.task_id === 'undefined') {
             LogManager.warn(this.componentName, `Received invalid 'text_chunk' params (missing task_id?):`, params);
             // Cannot associate chunk with a task, so we can't reliably update UI
             return; 
         }
         LogManager.debug(this.componentName, `Handling 'text_chunk' for task ${params.task_id}`);
         const taskState = this.currentTaskState;
         const currentLocalId = this.activeSessionId;
         // Check provider *inside* the handler
         if (taskState && chatProvider && currentLocalId) {
             const text = params.content ?? ''; // Use content based on logs
 
             // --- Client-Side Filter Heuristic --- 
             // REMOVED: Client-side filter heuristic was potentially hiding valid post-tool-call chunks.
             // State management fix should be sufficient.
             // --- End Filter --- 

             taskState.accumulatedText += text; // Accumulate locally
             // Send *only the new chunk* to the webview
             // chatProvider.appendChatChunk(taskState.accumulatedText, currentLocalId);
             chatProvider.appendChatChunk(text, currentLocalId); // <-- Send delta
         } else {
            // Log specific reason for failure
            if (!taskState) {
                LogManager.warn(this.componentName, `Received text_chunk for task ${params.task_id} but no active task state.`);
            }
            if (!chatProvider) {
                LogManager.warn(this.componentName, `Received text_chunk for task ${params.task_id} but ChatViewProvider instance is missing.`);
            }
            // Don't log if currentLocalId is missing, as that's less likely/critical here
         }
     });
     this.notificationHandlers.set('final_text', (params: FinalTextNotificationParams) => {
         LogManager.debug(this.componentName, "--- ENTERING final_text handler ---"); // Add entry log
         const chatProvider = ChatViewProvider.instance; // Get current instance
         // Add checks for params and task_id
         if (!params || typeof params.task_id === 'undefined') {
             LogManager.warn(this.componentName, `Received invalid 'final_text' params (missing task_id?):`, params);
             // Cannot associate final text with a task
             return; 
         }
         LogManager.debug(this.componentName, `Handling 'final_text' for task ${params.task_id}`);
         const taskState = this.currentTaskState;
         if (taskState) {
            // Store the final text in the dedicated field
            taskState.finalTextFromServer = params.final_text;
            LogManager.debug(this.componentName, `Stored final_text content from server.`);
            // We no longer overwrite accumulatedText here, it's just for streaming display
            // taskState.accumulatedText = params.final_text; 
         } else {
            LogManager.warn(this.componentName, `Received final_text but no active task state.`);
         }
     });
     this.notificationHandlers.set('function_call_request', (params: any) => {
         LogManager.debug(this.componentName, "--- ENTERING function_call_request handler ---"); // Add entry log
         // Server sends: { session_id: ..., task_id: ..., tool_call: { id: ..., tool: ..., parameters: ...} }
         // ---- MODIFICATION START: Adjust expected type and access ----
         const toolCallInfo = params.tool_call as { id: string, tool: string, parameters: any }; // Expect 'tool' key
         LogManager.info(this.componentName, `Handling 'function_call_request' for tool: ${toolCallInfo?.tool}, ID: ${toolCallInfo?.id}`); // Log 'tool'
         // Log the received structure for verification
         LogManager.debug(this.componentName, 'Received tool_call structure:', toolCallInfo);
         // ---- MODIFICATION END ----

         const taskState = this.currentTaskState;
         if (taskState) {
             const chatProvider = ChatViewProvider.instance; // Get current instance
             // ---- MODIFICATION START: Check for id, tool ----
             if (toolCallInfo && toolCallInfo.id && toolCallInfo.tool) { // Check 'tool' key
                // Construct the object matching FunctionCallRequest, ensuring ID is stored
                const pendingCall: FunctionCallRequest = {
                    id: toolCallInfo.id, // Store the ID from the server
                    tool_name: toolCallInfo.tool, // Store name under tool_name internally
                    parameters: toolCallInfo.parameters
                    // function: { name: toolCallInfo.tool, arguments: JSON.stringify(toolCallInfo.parameters || {}) } 
                };
                taskState.pendingToolCalls.push(pendingCall); 
                LogManager.debug(this.componentName, `Added pending tool call with ID: ${pendingCall.id}`);
             // ---- MODIFICATION END ----
                chatProvider?.updateStatus(`Requesting tool: ${toolCallInfo.tool}...`); // Use 'tool' for status message
             } else {
                 LogManager.warn(this.componentName, `Received function_call_request notification without valid tool_call structure (missing id or tool?).`, params.tool_call);
             }
         } else {
            LogManager.warn(this.componentName, `Received function_call_request but no active task state.`);
         }
     });
      this.notificationHandlers.set('status', (params: StatusNotificationParams) => {
         LogManager.debug(this.componentName, "--- ENTERING status handler ---"); // Add entry log
         const chatProvider = ChatViewProvider.instance; // Get current instance
         LogManager.debug(this.componentName, `Handling 'status' notification: ${params.status}`);
         chatProvider?.updateStatus(params.status ?? 'processing...');
     });
     this.notificationHandlers.set('error', (params: ErrorNotificationParams) => {
         LogManager.debug(this.componentName, "--- ENTERING error handler ---"); // Add entry log
         LogManager.error(this.componentName, `Handling 'error' notification from server: ${params.error_details}`);
         const chatProvider = ChatViewProvider.instance; // Get current instance
         const displaySessionId = this.activeSessionId ?? 'global'; 
         chatProvider?.updateChat(`[Error from server: ${params.error_details}]`, displaySessionId);
         // --- BEGIN ADDED LOG ---
         LogManager.debug(this.componentName, `[error] Setting this.currentTaskState to null. Old value: ${this.currentTaskState ? JSON.stringify(this.currentTaskState).substring(0,100)+'...' : 'null'}`);
         // --- END ADDED LOG ---
         this.currentTaskState = null;
     });
     this.notificationHandlers.set('end', async (params: EndNotificationParams) => {
         LogManager.debug(this.componentName, "--- ENTERING end handler ---"); // Add entry log
         LogManager.debug(this.componentName, "Entering 'end' handler. Raw params:", params); // Log raw params
         const chatProvider = ChatViewProvider.instance; // Get current instance
         // Add checks for params and required fields
         if (!params || typeof params.task_id === 'undefined' || typeof params.session_id === 'undefined') {
            LogManager.error(this.componentName, `Received invalid 'end' notification params:`, params);
            // Potentially reset task state or show error?
            // this.currentTaskState = null; // <<<< COMMENTED OUT
            chatProvider?.updateStatus("Error processing end notification");
            return;
         }
         
         // Now safe to access properties
         LogManager.info(this.componentName, `Handling 'end' notification for task ${params.task_id}`);
         const taskState = this.currentTaskState;
         const currentLocalId = this.activeSessionId;
         const serverSessionId = params.session_id;

         if (!taskState || !currentLocalId) {
             LogManager.warn(this.componentName, `Received 'end' but no active task state or local session ID.`);
             // this.currentTaskState = null; // <<<< COMMENTED OUT
             chatProvider?.updateStatus("");
             return;
         }

         const turnCompletedSuccessfully = !params.error_occurred;
         LogManager.info(this.componentName, `Task ${params.task_id} ended. Success: ${turnCompletedSuccessfully}`);

         const sessionIndex = this.sessions.findIndex(s => s.id === currentLocalId);

         if (sessionIndex === -1) {
             LogManager.error(this.componentName, `Cannot finalize history: Local session ${currentLocalId} not found.`);
             // this.currentTaskState = null; // <<<< COMMENTED OUT
             chatProvider?.updateStatus("");
             return;
         }
        
         // --- Determine final content - Only relevant if this is the *actual* end of the turn --- 
         let finalContentForHistory = '';
         let assistantMessageCreated = false;
         let assistantTurn: ChatMessage | null = null;

         // Create the potential assistant message structure *regardless* of whether it's the final turn
         if (taskState.finalTextFromServer !== null && taskState.finalTextFromServer !== undefined) {
             finalContentForHistory = cleanLLMOutput(taskState.finalTextFromServer);
             LogManager.debug(this.componentName, `Using final_text from server for potential history add.`);
         } else {
             finalContentForHistory = cleanLLMOutput(taskState.accumulatedText);
             LogManager.debug(this.componentName, `Falling back to accumulated text for potential history add.`);
         }

         if (finalContentForHistory || taskState.pendingToolCalls.length > 0) {
             assistantTurn = {
                 role: 'assistant',
                 content: finalContentForHistory,
                 // ---- MODIFICATION START: Transform pending calls for history ----
                 ...(taskState.pendingToolCalls.length > 0 && {
                     tool_calls: taskState.pendingToolCalls.map(call => ({
                         id: call.id || call.tool_call_id || 'missing_id', // Ensure ID is present, use placeholder if missing
                         type: 'function', 
                         function: {
                             name: call.tool_name || call.function?.name || 'missing_name', // Get name
                             arguments: JSON.stringify(call.parameters || {}), // Stringify parameters for arguments field
                         }
                     }))
                 })
                 // ---- MODIFICATION END ----
             };
             assistantMessageCreated = true;
         } else {
              LogManager.debug(this.componentName, `No final content or pending tool calls, skipping potential assistant message creation.`);
         }
         // -----------------------------------------------------------------------------

         // --- Tool Call Execution Block --- 
         if (turnCompletedSuccessfully && taskState.pendingToolCalls.length > 0) {
             LogManager.info(this.componentName, `Executing ${taskState.pendingToolCalls.length} tool calls...`);
             chatProvider?.updateStatus(`Executing tools...`);
             
             // --- IMPORTANT: Add the assistant message *with the tool call* to the history ONLY when executing tools --- 
             // This ensures the next turn starts with the correct context
             if (assistantTurn && this.sessions[sessionIndex].history[this.sessions[sessionIndex].history.length - 1]?.role === 'user') {
                 // FIX: Always add assistant message with tool_calls if tools are pending
                 this.sessions[sessionIndex].history.push(assistantTurn); 
                 LogManager.debug(this.componentName, `Added assistant message with tool_calls to history.`);
             } else {
                 // Ensure it's added even if the last message wasn't 'user' (e.g., if prior turn also used tools)
                 if(assistantTurn) {
                     this.sessions[sessionIndex].history.push(assistantTurn);
                     LogManager.warn(this.componentName, `Added assistant message with tool_calls (last item was not user).`);
                 } else {
                    LogManager.error(this.componentName, `Failed to create assistantTurn even though tool calls were pending!`);
                 }
             }
             // ------------------------------------------------------------------------------------------------------

             try {
                 const toolResults = await this.executeToolCalls(taskState.pendingToolCalls);
                 LogManager.debug(this.componentName, `Tool execution finished. Results:`, toolResults);
                 
                 await this._sendToolResults(serverSessionId, params.task_id, toolResults);
                 
                 // --- FIX: Add individual tool result messages to history ---
                 for (const toolResult of toolResults) {
                     const toolMessage: ChatMessage = {
                         role: 'tool',
                         tool_call_id: toolResult.tool_call_id,
                         name: toolResult.tool_name,
                         // Ensure content is a string, as expected by the Pydantic model for ToolMessage content
                         content: toolResult.error 
                             ? JSON.stringify({ error: toolResult.error }) 
                             : (toolResult.result !== undefined ? JSON.stringify(toolResult.result) : "null"), // Send "null" if result is undefined
                         // 'name' is not part of the 'tool' role message sent to the LLM according to OpenAI spec,
                         // but tool_name from ToolResult was used by the server-side ToolMessage model indirectly.
                         // The server Pydantic model for ToolMessage is: role, content, tool_call_id.
                         // The name of the tool is implicit via the tool_call_id linking to the assistant's tool_call.
                     };
                     this.sessions[sessionIndex].history.push(toolMessage);
                     LogManager.debug(this.componentName, `Added tool message to history for tool_call_id: ${toolResult.tool_call_id}`);
                 }
                 // -----------------------------------------------------------

                 chatProvider?.syncHistory(this.sessions[sessionIndex].history, currentLocalId); // Sync UI
                 this.updateSessionTitleIfNeeded(sessionIndex);
                 this.saveSessionsToStorage(); // Save the final history
                 // --- BEGIN ADDED LOG ---
                 // LogManager.debug(this.componentName, `[end - tool success] Setting this.currentTaskState to null. Old value: ${this.currentTaskState ? JSON.stringify(this.currentTaskState).substring(0,100)+'...' : 'null'}`);
                 // --- END ADDED LOG ---
                 // this.currentTaskState = null; // <<<--- INCORRECT: State should persist until final response after tool result
                 chatProvider?.updateStatus(""); // Clear status

                 // --- FIX: Clear accumulated text after processing tool results --- 
                 if (taskState) {
                     taskState.accumulatedText = '';
                     taskState.finalTextFromServer = null;
                     taskState.pendingToolCalls = []; // Also clear pending calls now
                     LogManager.debug(this.componentName, `Cleared accumulated text/final text/pending calls after tool execution.`);
                 }
                 // ------------------------------------------------------------
             } catch (toolError: any) {
                 LogManager.error(this.componentName, `Error executing tools`, toolError);
                 chatProvider?.updateChat(`[Error executing tools: ${toolError.message}]`, currentLocalId);
                 // Clear state on tool execution error
                 // this.currentTaskState = null; // <<<< COMMENTED OUT
                 chatProvider?.updateStatus("");
             }
         // --- Final Turn Completion Block --- 
         } else if (turnCompletedSuccessfully) {
             LogManager.info(this.componentName, `Turn completed successfully (no more tools). Saving history.`);
             
             // --- Add the final assistant message (without tool calls) to history here --- 
             LogManager.debug(this.componentName, `[Final Turn] Checking final content. Has finalTextFromServer: ${taskState.finalTextFromServer !== null}, Accumulated: ${taskState.accumulatedText.substring(0,50)}...`); // LOG
             const lastHistoryRole = this.sessions[sessionIndex].history[this.sessions[sessionIndex].history.length - 1]?.role; // LOG
             LogManager.debug(this.componentName, `[Final Turn] Last history item role: ${lastHistoryRole}`); // LOG
             
             if (assistantTurn && 
                 (this.sessions[sessionIndex].history[this.sessions[sessionIndex].history.length - 1]?.role === 'user' || 
                  this.sessions[sessionIndex].history[this.sessions[sessionIndex].history.length - 1]?.role === 'tool')) {
                  // Ensure we don't accidentally save tool calls if they somehow existed here
                  delete assistantTurn.tool_calls; 
                  this.sessions[sessionIndex].history.push(assistantTurn);
                  LogManager.debug(this.componentName, `[Final Turn] Added final assistant message (no tools) to history. Content: ${assistantTurn.content?.substring(0,50)}...`); // LOG
              } else if (assistantMessageCreated) { // Log if we created a message but couldn't add it
                  LogManager.warn(this.componentName, `[Final Turn] Could not add final assistant message. Assistant message was created: ${assistantMessageCreated}, Last history role: ${lastHistoryRole}`); // LOG
              }
              // --------------------------------------------------------------------------

              chatProvider?.syncHistory(this.sessions[sessionIndex].history, currentLocalId); // Sync UI
              LogManager.debug(this.componentName, `[Final Turn] Called syncHistory with ${this.sessions[sessionIndex].history.length} messages.`); // LOG
              this.updateSessionTitleIfNeeded(sessionIndex);
              this.saveSessionsToStorage(); // Save the final history
              // --- BEGIN ADDED LOG ---
              // LogManager.debug(this.componentName, `[end - final turn] Setting this.currentTaskState to null. Old value: ${this.currentTaskState ? JSON.stringify(this.currentTaskState).substring(0,100)+'...' : 'null'}`);
              // --- END ADDED LOG ---
              // this.currentTaskState = null; // <<<--- INCORRECT: State should persist until final response after tool result
              chatProvider?.updateStatus(""); // Clear status
         } else {
             // --- Turn Failed Block --- 
             LogManager.warn(this.componentName, `Turn failed according to 'end' notification. History not saved.`);
             // No need to pop history here as we are adding it conditionally now
             // if (assistantMessageAdded) {
             //     this.sessions[sessionIndex].history.pop(); 
             //     chatProvider?.syncHistory(this.sessions[sessionIndex].history, currentLocalId);
             // }
             // this.currentTaskState = null; // <<<< COMMENTED OUT
             chatProvider?.updateStatus(""); // Clear status
         }
     });
     LogManager.debug(this.componentName, `Notification handlers set up.`);
  }

  /** Helper to update session title */
  private updateSessionTitleIfNeeded(sessionIndex: number): void {
    if (sessionIndex < 0 || sessionIndex >= this.sessions.length) return;
    const session = this.sessions[sessionIndex];
    if ((session.history.length === 2 || session.title === 'New Chat') && session.history.length > 0) {
        const firstUserMsg = session.history.find(m => m.role === 'user' && typeof m.content === 'string');
        if (firstUserMsg && typeof firstUserMsg.content === 'string'){
            session.title = firstUserMsg.content.substring(0, 30) + (firstUserMsg.content.length > 30 ? '...' : '');
            LogManager.debug(this.componentName, `Updated local session title for ${session.id} to: ${session.title}`);
            ChatViewProvider.instance?.sendSessionListToWebview(this); // Update UI
        }
    }
  }

  /** Helper to send tool results back */
  private async _sendToolResults(serverSessionId: string, taskId: string, results: ToolResult[]): Promise<void> {
      if (!this.jsonRpcClient) {
          LogManager.error(this.componentName, "Cannot send tool results: JSON-RPC client not available.");
          ChatViewProvider.instance?.updateChat(`[Error: Cannot send tool results - connection lost?]`, this.activeSessionId ?? 'global');
          return;
      }
      if (serverSessionId !== this.activeServerSessionId) {
           LogManager.warn(this.componentName, `Attempting to send tool results for inactive server session ${serverSessionId} (active: ${this.activeServerSessionId}). Aborting.`);
           return;
      }
      try {
          LogManager.info(this.componentName, `Sending tool_result request for task ${taskId}`);
          const rpcId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
          this.requestMap.set(rpcId, { resolve: () => {}, reject: () => {} });

          const rpcRequest: JSONRPCRequest = {
            jsonrpc: "2.0",
            method: "tool_result",
            id: rpcId,
            params: {
              session_id: serverSessionId,
              task_id: taskId,
              results: results
            }
          };
          this.jsonRpcClient.requestAdvanced(rpcRequest); // Pass the full request object

          // Remove the state clearing for now - let the *next* 'end' handle it
          // this.currentTaskState = null; // <<< ENSURE THIS IS REMOVED OR COMMENTED

           LogManager.debug(this.componentName, `Finished _sendToolResults for task ${taskId}. State preserved until next 'end' notification.`); // <-- Corrected log message

      } catch (error: any) {
           LogManager.error(this.componentName, `Failed to send tool results for task ${taskId}: ${error.message}`, error);
           ChatViewProvider.instance?.updateChat(`[Error sending tool results back to server: ${error.message}]`, this.activeSessionId ?? 'global');
      }
  }

  /** Fetches tools from McpServerManager and updates the combined list */
  private updateToolList() {
    LogManager.debug(this.componentName, "Updating tool list from McpServerManager...");
    let managedServerTools: SimpleTool[] = [];
    const managedServers = this.mcpServerManager.getConnectedServerIdsAndCapabilities();
    LogManager.debug(this.componentName, `Found ${managedServers.length} connected managed servers.`);
    managedServers.forEach(({ serverId, capabilities }) => {
      // --- IMPORTANT: Exclude the embedding server itself from the list of tools sent to the LLM ---
      if (serverId === 'tools-matcher') { // Use the actual ID of your embedding server
          LogManager.debug(this.componentName, `Skipping tools from embedding server '${serverId}'.`);
          return; 
      }
      // ------------------------------------------------------------------------------------------
      if (capabilities?.capabilities) {
        capabilities.capabilities.forEach((cap: any) => {
          managedServerTools.push({
            name: `${serverId}@${cap.name}`,
            description: cap.description || `Tool ${cap.name} on server ${serverId}`,
            inputSchema: cap.inputSchema || { type: 'object', properties: {} },
          });
        });
      }
    });
    this.allToolsForLLM = [...managedServerTools];
    LogManager.info(this.componentName, `Total *managed* tools available (excluding embedding server): ${this.allToolsForLLM.length}`, { names: this.allToolsForLLM.map((t: SimpleTool) => t.name) });
    
    // REMOVE: Initialization of this.toolFilter = new ToolFilter(...);
  }

  /**
   * Processes a user query using WebSocket/JSON-RPC
   */
  async processQuery(query: string, chatProvider: ChatViewProvider): Promise<void> {
    LogManager.info(this.componentName, "processQuery called (WebSocket/JSON-RPC)");

    // --- Update tool list to ensure it's fresh BEFORE filtering ---
    this.updateToolList();
    // ------------------------------------------------------------

    let localSessionId = this.getActiveSessionId();
    let serverSessionId = this.activeServerSessionId; // Get current server ID if any
    
    // --- Ensure local session exists ---
    if (!localSessionId) { 
        LogManager.info(this.componentName, "No active local session, creating new one.");
        this.startNewChat();
        localSessionId = this.getActiveSessionId()!;
        serverSessionId = null; // No server session for a new local one yet
        chatProvider.sendSessionListToWebview(this);
     }
    const sessionIndex = this.sessions.findIndex(s => s.id === localSessionId);
    if (sessionIndex === -1) { 
        LogManager.error(this.componentName, `Session ${localSessionId} not found.`);
        chatProvider.updateChat(`[Error: Session data missing]`, localSessionId);
        return; 
    }

    // --- Ensure connection to LLM Server --- 
    try {
        // Check if we have a server session ID AND a matching open connection
        const targetWsUrl = `ws://${this.serverIp}:${this.serverPort}/ws/${serverSessionId}`;
        if (!serverSessionId || !this.ws || this.wsUrl !== targetWsUrl || this.ws.readyState !== WebSocket.OPEN) {
            LogManager.info(this.componentName, `No valid connection for session ${localSessionId}. Establishing...`);
            
            // 1. Get Server Session ID via HTTP /create_session
            LogManager.debug(this.componentName, `[processQuery Check] Current values: this.serverIp='${this.serverIp}', this.serverPort=${this.serverPort}`); // Log before check
            if (!this.serverIp || !this.serverPort) {
                 throw new Error("Server IP/Port not configured.");
            }
            LogManager.debug(this.componentName, "Requesting new server session via HTTP /create_session");
            const sessionResponse = await this._fetchJSON<SessionResponse>('/create_session', {
                method: 'POST',
                body: JSON.stringify({ tools: mapToolsForLLM(this.allToolsForLLM) }) 
            });
            serverSessionId = sessionResponse.session_id;
            this.activeServerSessionId = serverSessionId; // Store the new active server ID
            // TODO: Associate serverSessionId with localSessionId if needed
            LogManager.info(this.componentName, `Received server session ID: ${serverSessionId} for local session ${localSessionId}`);

            // 2. Establish WebSocket connection using the new serverSessionId
            await this.connectToServer(this.serverIp!, this.serverPort!, serverSessionId);
            LogManager.info(this.componentName, `WebSocket connection established for session ${serverSessionId}.`);
        } else {
             LogManager.debug(this.componentName, `Using existing WebSocket connection for session ${serverSessionId}.`);
        }

        // --- Connection should be ready now --- 
        if (!this.jsonRpcClient) { 
             throw new Error("JSON-RPC Client not initialized after connection attempt.");
        }

        LogManager.info(this.componentName, `Sending generate request for session ${serverSessionId}`);
        // Add user query to history (optimistically, might be popped on error)
        const currentSession = this.sessions[sessionIndex];
        
        // --- Add user message to local history if not a retry ---
        // Check if the last message is already this user query (e.g. from a previous failed attempt)
        const lastMessage = currentSession.history[currentSession.history.length - 1];
        if (!(lastMessage && lastMessage.role === 'user' && lastMessage.content === query)) {
            currentSession.history.push({ role: 'user', content: query });
            LogManager.debug(this.componentName, "Added user message to local history.");
        } else {
            LogManager.debug(this.componentName, "User message already in history, not adding again.");
        }
        // -------------------------------------------------------

        chatProvider.syncHistory(currentSession.history, localSessionId); // Update UI with user message

        // Filter tools based on the query and current history
        // Note: currentHistoryForFilter should ideally be the history *before* adding the current user query if the filter needs that.
        // For now, using the full currentSession.history.
        const currentHistoryForFilter = [...currentSession.history]; 
        const toolsForRequest = await this.filterTools(query, currentHistoryForFilter, this.allToolsForLLM);
        LogManager.info(this.componentName, `Sending ${toolsForRequest.length} tools to LLM: ${JSON.stringify(toolsForRequest.map(t=>t.name))}`);
        
        // --- Prepare history for the server (map to server-expected format) ---
        const historyForGenerate = currentSession.history.map(msg => {
            const serverMsg: any = { role: msg.role };
            if (msg.role === 'user') {
                serverMsg.content = msg.content || '';
            } else if (msg.role === 'assistant') {
                serverMsg.content = msg.content === undefined ? '' : msg.content; // Default content to empty string
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    serverMsg.tool_calls = msg.tool_calls;
                }
            } else if (msg.role === 'tool') {
                serverMsg.tool_call_id = msg.tool_call_id;
                serverMsg.tool_name = msg.name; // Map client 'name' to server 'tool_name'
                serverMsg.content = msg.content || '';
            }
            // Filter out any messages not conforming to user, assistant, or tool roles, or if they became undefined.
            // This shouldn't happen if currentSession.history is well-formed with only these roles.
            return (['user', 'assistant', 'tool'].includes(serverMsg.role)) ? serverMsg : null;
        }).filter(Boolean) as any[]; // Filter out nulls and cast
        // --------------------------------------------------------------------

        const generateParams: GenerateParams = {
            history: historyForGenerate, // Use the mapped history
            tools: toolsForRequest.map(tool => mapToolsForLLM([tool])[0]), // Ensure tools are in OpenAI format
            // TODO: Add other parameters like model, temperature, max_tokens if supported
        };

        // Store current task details
        // If there's an existing task state for this session, use it, otherwise create new
        if (!this.currentTaskState || this.currentTaskState.localSessionId !== localSessionId) {
            LogManager.debug(this.componentName, `Creating new task state for session ${localSessionId}. Previous task state session: ${this.currentTaskState?.localSessionId}`);
            this.currentTaskState = { 
                localSessionId: localSessionId,
                accumulatedText: '',
                pendingToolCalls: [],
                finalTextFromServer: null,
            };
        } else {
            LogManager.debug(this.componentName, `Reusing existing task state for session ${localSessionId}. Clearing previous tool calls/text.`);
            this.currentTaskState.accumulatedText = '';
            this.currentTaskState.pendingToolCalls = [];
            this.currentTaskState.finalTextFromServer = null;
        }


        LogManager.debug(this.componentName, `Final history length: ${generateParams.history.length} messages`);
        LogManager.debug(this.componentName, `Final tool list length: ${generateParams.tools.length} tools`);

        // --- Log the history being sent for diagnosis ---
        LogManager.debug(this.componentName, "History being sent to LLM:", JSON.stringify(generateParams.history, null, 2));
        // ----------------------------------------------

        const ack = await this.jsonRpcClient.request("generate", generateParams);
        LogManager.info(this.componentName, `'generate' request sent. Ack received:`, ack); 
        chatProvider.updateStatus("Assistant is thinking...");

    } catch (error: any) {
         LogManager.error(this.componentName, `Failed to process query: ${error.message}`, error);
         
         // Ensure session still exists before modifying history
         const sessionIndex = this.sessions.findIndex(s => s.id === localSessionId);
         if (sessionIndex !== -1) {
             // Revert optimistic user message from internal history
             const lastMsgIndex = this.sessions[sessionIndex].history.length - 1;
             if(this.sessions[sessionIndex].history?.[lastMsgIndex]?.role === 'user') {
                 LogManager.debug(this.componentName, `Popping optimistic user message due to error.`);
                 this.sessions[sessionIndex].history.pop(); 
             }

             // --- Add Error Message to Internal History --- 
             const errorText = `[Error: ${error.message}]`;
             const errorMessage: ChatMessage = { role: 'assistant', content: errorText };
             this.sessions[sessionIndex].history.push(errorMessage);
             LogManager.debug(this.componentName, `Added error message to internal history for session ${localSessionId}.`);
             // -------------------------------------------

             // --- Save the updated history (with error, without failed user msg) ---
             this.saveSessionsToStorage(); 
             LogManager.debug(this.componentName, `Saved history with error message.`);
             // -----------------------------------------------------------------------

             // --- Send error directly to UI (NO syncHistory) ---
             chatProvider.updateChat(errorText, localSessionId);
             LogManager.debug(this.componentName, `Sent error message directly to webview via updateChat.`);
             // --------------------------------------------------

         } else {
             LogManager.error(this.componentName, `Cannot add error to history or revert user message: Session ${localSessionId} not found in catch block.`);
             // Fallback: Still try to show error in UI directly if session context is lost
             chatProvider.updateChat(`[Error: ${error.message}]`, localSessionId ?? 'unknown_session');
         }

         // --- Notify UI that processing stopped ---
         chatProvider.updateStatus("");
    }
  } // End processQuery

  /** Executes tool calls (called from 'end' notification handler) */
  private async executeToolCalls(toolCalls: FunctionCallRequest[]): Promise<ToolResult[]> {
       LogManager.debug(this.componentName, `Executing ${toolCalls.length} tool calls...`);
       const toolResults: ToolResult[] = [];
       
       // Create a quick lookup map from base tool name to full tool name
       const toolNameMap = new Map<string, string>();
       this.allToolsForLLM.forEach(tool => {
           const baseName = tool.name.includes('@') ? tool.name.split('@')[1] : tool.name;
           toolNameMap.set(baseName, tool.name);
       });

       for (const call of toolCalls) {
           // The LLM should now send the *base* tool name (e.g., "search_users")
           // Adjust to read from call.function.name based on typical OpenAI structure
           const baseToolName = (call as any).function?.name || (call as any).tool || call.tool_name; 
           const parameters = (call as any).function?.arguments ? JSON.parse((call as any).function.arguments) : call.parameters; // Handle OpenAI's arguments structure
           // Ensure tool_call_id exists - use call.id from OpenAI structure if present
           const toolCallId = call.id || (call as any).tool_call_id || 'temp-' + Math.random().toString(36).substring(2, 9); // Generate temporary ID if missing

           LogManager.debug(this.componentName, `Processing tool call:`, { baseToolName, parameters, toolCallId }); // Log details

           // Find the full internal tool identifier (serverId@toolName) using the map
           const fullToolIdentifier = toolNameMap.get(baseToolName);

           let result: ToolResult = {
               tool_call_id: toolCallId, // Use the ID received from the LLM
               tool_name: baseToolName // Report the base name back? Or full name? Let's stick to base for now. Check server reqs.
               // tool_name: fullToolIdentifier || baseToolName // Option: report full name if found
           };

           if (!baseToolName) {
                LogManager.error(this.componentName, 'Tool name is missing in tool call:', call);
                result.error = "Tool name missing in request.";
           } else if (!fullToolIdentifier) {
                LogManager.error(this.componentName, `Could not find server for tool '${baseToolName}' in internal map.`);
                result.error = `Tool '${baseToolName}' not found or server unavailable.`;
           } else if (fullToolIdentifier.includes('@')) {
               const [serverId, actualToolName] = fullToolIdentifier.split('@'); // Use 'actualToolName' from the split
               if (!serverId || !actualToolName) {
                   result.error = "Invalid internal tool identifier format found in map";
                   LogManager.error(this.componentName, `Invalid format for mapped tool identifier: ${fullToolIdentifier}`);
               } else {
                   try {
                       // Call using the mapped serverId and the actual tool name part
                       LogManager.debug(this.componentName, `Routing call for '${baseToolName}' to server '${serverId}', method '${actualToolName}'`);
                       const rawResult = await this.mcpServerManager.callServerMethod(serverId, actualToolName, parameters || {});
                       
                       // --- Start: Special handling for github@search_repositories ---
                       // Check using the full identifier now
                       if (fullToolIdentifier === 'github@search_repositories') {
                           LogManager.debug(this.componentName, `Processing result specifically for ${fullToolIdentifier}...`);
                           try {
                               // Assuming rawResult follows the structure seen in logs: { content: [{ type: 'text', text: 'JSON_STRING' }] }
                               if (rawResult && Array.isArray(rawResult.content) && rawResult.content.length > 0 && rawResult.content[0].type === 'text') {
                                   const resultJsonString = rawResult.content[0].text;
                                   const githubData = JSON.parse(resultJsonString);
                                   
                                   if (githubData && Array.isArray(githubData.items)) {
                                       const topItems = githubData.items.slice(0, 5).map((item: any) => ({
                                           name: item.name,
                                           description: item.description,
                                           html_url: item.html_url
                                       }));
                                       
                                       // Reconstruct the result payload with summarized data
                                       result.result = { 
                                           content: [{ 
                                               type: 'text', 
                                               // Stringify the summarized list 
                                               text: JSON.stringify({ repositories: topItems }, null, 2) 
                                           }] 
                                       };
                                       LogManager.debug(this.componentName, `Successfully summarized ${topItems.length} GitHub repositories.`);
                                   } else {
                                        LogManager.warn(this.componentName, `Unexpected structure in github@search_repositories result (items array missing or not array):`, githubData);
                                        result.error = "Failed to parse GitHub repository items from result.";
                                        // Optionally send back the raw result if parsing failed but structure was somewhat valid
                                        // result.result = rawResult; // Decide if this fallback is desired
                                   }
                               } else {
                                   LogManager.warn(this.componentName, `Unexpected content structure in github@search_repositories result:`, rawResult);
                                   result.error = "Unexpected content structure from GitHub tool.";
                                   // Optionally send back raw result
                                   // result.result = rawResult; 
                               }
                           } catch (parseError: any) {
                                LogManager.error(this.componentName, `Error parsing/processing github@search_repositories result: ${parseError.message}`, parseError);
                                result.error = `Error processing GitHub result: ${parseError.message}`;
                                // Optionally send back raw result on error
                                // result.result = rawResult; 
                           }
                       } else {
                           // For other tools, assign the raw result directly
                           result.result = rawResult;
                       }
                       // --- End: Special handling ---
                       
                   } catch (error: any) {
                        LogManager.error(this.componentName, `Error executing tool ${fullToolIdentifier}: ${error.message}`, error);
                       result.error = error.message || String(error);
                   }
               }
           } else {
                // This case should ideally not happen if the map is built correctly
               result.error = `Tool '${baseToolName}' (mapped to '${fullToolIdentifier}') is not a managed tool format.`;
                LogManager.error(this.componentName, `Mapped tool identifier '${fullToolIdentifier}' lacks '@' separator.`);
           }
           LogManager.debug(this.componentName, `Tool call result for ${baseToolName}:`, result);
           toolResults.push(result);
       }
       return toolResults;
  }

  /**
   * Filters tools by calling the dedicated embedding MCP server.
   */
  private async filterTools(query: string, history: ChatMessage[], allTools: SimpleTool[]): Promise<SimpleTool[]> {
      const embeddingServerId = 'tools-matcher'; // <<<--- Make sure this matches your server config ID
      let rankedToolNames: string[] = [];
      LogManager.debug(this.componentName, `Entering filterTools. Query: ${query.substring(0,50)}..., History items: ${history.length}, All tools count: ${allTools.length}, Names: ${allTools.map(t=>t.name).join(', ')}`);

      // Wait for the embedding server to be connected
      const isEmbeddingServerConnected = await this.waitForServerToConnect(embeddingServerId, 10000); // Wait up to 10 seconds

      if (!isEmbeddingServerConnected) {
          LogManager.warn(this.componentName, `Embedding server '${embeddingServerId}' did not connect in time or is not configured. Skipping tool filtering via embedding server.`);
          // Proceed without calling the server, default tools will be added later if applicable
      } else if (allTools.length === 0) {
            LogManager.debug(this.componentName, "FilterTools: No tools available to filter (excluding embedding server).");
            // Skip calling the embedding server if there are no tools to rank
      } else {
          // Embedding server is connected, proceed with calling it
          const toolInfoForServer = allTools.map(t => ({
              name: t.name,
              description: typeof t.description === 'string' ? t.description : t.name 
          }));
  
          try {
              LogManager.debug(this.componentName, `Calling embedding server '${embeddingServerId}' capability 'get-relevant-tools'`);
  
              // Call the embedding server
              const result = await this.mcpServerManager.callServerMethod(
                  embeddingServerId,
                  'get-relevant-tools', // Matches the capability method name in Python
                  {
                      prompt: query,
                      history: history, // Pass the history
                      tools: toolInfoForServer,
                  }
              ); 
  
              // --- Process JSON Result --- 
              if (result?.content?.[0]?.type === 'text' && typeof result.content[0].text === 'string') {
                  const resultJsonString = result.content[0].text;
                  try {
                      const parsedResult = JSON.parse(resultJsonString); 
                      if (Array.isArray(parsedResult) && parsedResult.every(item => typeof item === 'string')) {
                          rankedToolNames = parsedResult as string[];
                          LogManager.info(this.componentName, `Embedding server returned tools (parsed): [${rankedToolNames.join(", ")}]`);
                      } else {
                          LogManager.warn(this.componentName, `Parsed result from embedding server is not an array of strings:`, parsedResult);
                          rankedToolNames = []; // Treat as no result if format is wrong
                      }
                  } catch (parseError: any) {
                       LogManager.error(this.componentName, `Failed to parse JSON result from embedding server: ${parseError.message}`, { rawString: resultJsonString });
                       rankedToolNames = []; // Treat as no result on parse error
                  }
              } else {
                   LogManager.warn(this.componentName, `Embedding server returned unexpected data structure:`, result);
                   rankedToolNames = []; // Treat as no result if structure is wrong
              }
              // -------------------------
  
          } catch (error: any) {
              LogManager.error(this.componentName, `Error calling embedding server '${embeddingServerId}': ${error.message}`, error);
              rankedToolNames = []; // Treat as no result on call error
          }
      }
  
      // --- Logic to ALWAYS ensure specific tools are included --- 
      const defaultToolsToEnsure = ['fetch@fetch']; // Add any other tool names here if needed
      // Example: const defaultToolsToEnsure = ['fetch@fetch', 'memory@search_nodes'];

      for (const toolNameToEnsure of defaultToolsToEnsure) {
        const toolExists = allTools.some(t => t.name === toolNameToEnsure);
        if (toolExists && !rankedToolNames.includes(toolNameToEnsure)) {
            LogManager.debug(this.componentName, `Ensuring default tool is included: ${toolNameToEnsure}`);
            rankedToolNames.push(toolNameToEnsure);
        }
      }
      // ----------------------------------------------------------
  
      // Map the final list of names back to SimpleTool objects, preserving server order
      const finalFilteredTools = rankedToolNames
           .map(name => allTools.find(tool => tool.name === name))
           .filter((tool): tool is SimpleTool => tool !== undefined);
  
      LogManager.info(this.componentName, `FilterTools: Final list contains ${finalFilteredTools.length} tools.`);
      return finalFilteredTools;
  }

  /**
   * Helper function to wait for a server to be connected using McpServerManager.onServerStatusChanged, with a timeout and UI status updates.
   */
  private async waitForServerToConnect(serverId: string, timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    LogManager.info(this.componentName, `Waiting for server '${serverId}' to connect (timeout: ${timeoutMs}ms)...`);
    ChatViewProvider.instance?.updateStatus(`Initializing ${serverId} service...`);

    let serverStatusInfo = this.mcpServerManager.getServerStatus(serverId);
    if (serverStatusInfo && serverStatusInfo.status === ServerStatus.Connected) {
        LogManager.info(this.componentName, `Server '${serverId}' is already connected.`);
        ChatViewProvider.instance?.updateStatus("");
        return true;
    }

    return new Promise<boolean>((resolve) => {
        let timeoutId: NodeJS.Timeout | null = null;
        let pollIntervalId: NodeJS.Timeout | null = null;

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            if (pollIntervalId) clearInterval(pollIntervalId);
            this.mcpServerManager.removeListener('serverStatusChanged', statusChangeHandler);
        };

        const statusChangeHandler = (event: ServerStatusEvent) => {
            if (event.serverId === serverId && event.status === ServerStatus.Connected) {
                LogManager.info(this.componentName, `Server '${serverId}' connected via event.`);
                cleanup();
                ChatViewProvider.instance?.updateStatus("");
                resolve(true);
            }
        };

        timeoutId = setTimeout(() => {
            LogManager.warn(this.componentName, `Timeout waiting for server '${serverId}' to connect.`);
            cleanup();
            ChatViewProvider.instance?.updateStatus(`Timeout initializing ${serverId}. Proceeding without it.`);
            setTimeout(() => ChatViewProvider.instance?.updateStatus(""), 2000);
            resolve(false);
        }, timeoutMs);

        this.mcpServerManager.on('serverStatusChanged', statusChangeHandler);

        pollIntervalId = setInterval(() => {
            if (Date.now() - startTime > timeoutMs) { // Should be cleared by main timeout
                // cleanup(); // Already handled by main timeout
                // resolve(false);
                return;
            }
            const currentStatus = this.mcpServerManager.getServerStatus(serverId);
            if (currentStatus && currentStatus.status === ServerStatus.Connected) {
                LogManager.info(this.componentName, `Server '${serverId}' connected (polled).`);
                cleanup();
                ChatViewProvider.instance?.updateStatus("");
                resolve(true);
            }
        }, 1000);
    });
  }

  /** Cleans up resources */
  async cleanup() {
    // ... (Cleanup logic - ensure ws listeners are removed correctly) ...
     LogManager.info(this.componentName, `MCP Client cleaning up (WebSocket)...`);
     if (this.ws) {
         this.ws.removeAllListeners(); 
         if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
             this.ws.close();
         }
         this.ws = null;
     }
     this.jsonRpcClient = null; 
     LogManager.info(this.componentName, `Cleanup finished.`);
   }

   // REMOVE: Optional handler methods are not needed if using removeAllListeners or inline handlers
   // private _handleWsOpen = () => { /* ... */ };
   // ...

} // End of MCPClient class