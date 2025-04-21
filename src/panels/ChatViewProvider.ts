import * as vscode from 'vscode';
import { LogManager } from '../utils/LogManager.js';
import { extensionContext } from '../extension.js'; // Assuming global context access
import { handleSendMessage, getMcpClient } from '../extension.js'; // <-- Import getMcpClient
import { McpServerManager } from '../services/McpServerManager.js'; // Needed for status updates
import { ServerStatusEvent, ChatMessage, ChatSessionMetadata } from '../models/Types.js'; // <-- Import ChatMessage and ChatSessionMetadata
import * as marked from 'marked'; // Use namespace import for ES modules

// We'll store chat history here for now, associated with the provider instance
let chatHistory: { role: string; text: string }[] = [];

export class ChatViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'mcpChatView'; // Must match package.json
    public static instance: ChatViewProvider | undefined;

    private _view?: vscode.WebviewView;
    private _statusListenerDisposable?: vscode.Disposable; // To clean up listener

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext // Store context if needed
    ) {
        // Set the static instance
        ChatViewProvider.instance = this;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log('--- MCP ChatViewProvider resolving view ---');
        LogManager.info('ChatViewProvider', '--- MCP ChatViewProvider resolving view ---');

        this._view = webviewView;
        LogManager.debug('ChatViewProvider', 'Resolving webview view.');

        // Set options for the webview
        webviewView.webview.options = {
            enableScripts: true, // Enable JavaScript in the webview
            localResourceRoots: [this._extensionUri] // Restrict webview to local resources
        };

        // Set the HTML content for the webview
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            LogManager.debug('ChatViewProvider', `Received message from webview`, message);
            const mcpClient = getMcpClient(); // Get the client instance

            switch (message.command) {
                case 'sendMessage':
                    if (message.text) {
                        LogManager.info('ChatViewProvider', `Forwarding message to handleSendMessage: ${message.text.substring(0, 20)}...`);
                        await handleSendMessage(message, this); // Pass the object { command: 'sendMessage', text: '...' }
                    } else {
                        LogManager.warn('ChatViewProvider', 'Received empty message from webview.');
                    }
                    return;
                case 'newChat':
                     LogManager.debug('ChatViewProvider', 'Received newChat command from webview');
                    if (mcpClient) {
                        mcpClient.startNewChat(); // Correct method name
                        this.clearChatDisplay(); // Clear the current view
                        this.sendSessionListToWebview(mcpClient); // Correct arguments
                        // Send the (now empty) history of the new session
                        const newHistory = mcpClient.getHistory();
                        this.postMessage({ command: 'syncHistory', history: newHistory });
                    } else {
                        this.postMessage({ command: 'addBotMessage', text: '[Error: Could not create new chat - client not ready.]' });
                    }
                    return;
                case 'switchSession':
                    LogManager.debug('ChatViewProvider', 'Received switchSession command from webview', { sessionId: message.sessionId });
                    if (message.sessionId) {
                        if (mcpClient) {
                            // ---> Log ID before switching
                            const currentActiveIdBeforeSwitch = mcpClient.getActiveSessionId(); // Use getter
                            LogManager.debug('ChatViewProvider', `Attempting to switch session. Current active ID: ${currentActiveIdBeforeSwitch}, Target ID: ${message.sessionId}`);

                            const success = mcpClient.switchActiveSession(message.sessionId); // Correct method name

                            // ---> Log ID after switching
                            const currentActiveIdAfterSwitch = mcpClient.getActiveSessionId(); // Use getter
                            LogManager.debug('ChatViewProvider', `Switch attempt finished. Success: ${success}. New active ID: ${currentActiveIdAfterSwitch}`);

                            if (success) {
                                // ---> FIX: Send the history of the newly activated session back to the webview
                                const history = mcpClient.getHistory(); // Get history for the *new* active session
                                LogManager.debug('ChatViewProvider', `Switch successful, sending history for session ${message.sessionId} (${history.length} messages).`);
                                this.postMessage({ command: 'syncHistory', history });
                                // We could also send the session list again to update highlighting, but syncHistory might be enough if frontend handles it
                                this.sendSessionListToWebview(mcpClient); // Send session list to ensure highlighting update
                            } else {
                                this.postMessage({ command: 'addBotMessage', text: `[Error: Could not switch to session ${message.sessionId}]` });
                            }
                        } else {
                            this.postMessage({ command: 'addBotMessage', text: '[Error: Could not switch session - client not ready.]' });
                        }
                    }
                    return;
                // Add other commands if needed (e.g., 'getInitialState')
            }
        }, null, this._context.subscriptions); // Use context subscriptions for cleanup

        // Handle view disposal
        webviewView.onDidDispose(() => {
            LogManager.debug('ChatViewProvider', 'Webview view disposed.');
            this._view = undefined;
            this._statusListenerDisposable?.dispose(); // Clean up the status listener
        }, null, this._context.subscriptions);

        // Setup listener for server status updates ONLY when the view is resolved
        this.setupStatusListener();

        // Load and send persisted history to the webview
        try {
            const mcpClient = getMcpClient();
            if (mcpClient) {
                const history = mcpClient.getHistory();
                const activeSessionId = mcpClient.getActiveSessionId(); // <-- Get the active ID
                LogManager.debug('ChatViewProvider', `Sending ${history.length} history messages to webview for initial load (Session: ${activeSessionId}).`);
                // FIX: Include localSessionId in the initial sync message
                if (activeSessionId) { // Ensure we have an active ID before sending
                     this.postMessage({ 
                         command: 'syncHistory', 
                         history: history, 
                         localSessionId: activeSessionId 
                     });
                } else {
                    LogManager.warn('ChatViewProvider', 'No active session ID found during initial load, cannot send history ID.');
                    // Optionally send history without ID, or send empty history?
                    // Sending history without ID might lead to the bug we saw.
                    // Let's clear the display instead if no active session is found initially.
                    this.postMessage({ command: 'clearChat' }); 
                }

                // Also send the session list
                this.sendSessionListToWebview(mcpClient);
            } else {
                LogManager.warn('ChatViewProvider', 'MCPClient not available when resolving view, cannot send history or session list.');
            }
        } catch (error: any) {
            LogManager.error('ChatViewProvider', 'Error sending history to webview', error);
        }

        LogManager.debug('ChatViewProvider', 'Webview view resolved successfully.');
    }

    // Method to send a message TO the webview (e.g., add bot message, update status)
    public postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message).then(success => {
                if (!success) {
                    LogManager.warn('ChatViewProvider', `Failed to post message to webview: ${message.command}`);
                }
            });
        } else {
            LogManager.warn('ChatViewProvider', 'Attempted to post message, but view is not available.');
        }
    }

    // --- Helper for Status Updates ---
    private setupStatusListener() {
        // Dispose any existing listener first
        this._statusListenerDisposable?.dispose();

        const serverManager = McpServerManager.getInstance();
        const statusListener = (event: ServerStatusEvent) => {
            if (this._view) { // Check if view still exists
                LogManager.debug('ChatViewProvider', `Forwarding status update to webview: ${event.serverId} -> ${event.status}`);
                this.postMessage({
                    command: 'updateServerStatus',
                    text: `Server ${event.serverId}: ${event.status}${event.error ? ` (Error: ${event.error})` : ''}`,
                    status: event.status,
                    serverId: event.serverId,
                    error: event.error
                });
            }
        };
        serverManager.on('status', statusListener);

        // Store the listener registration for disposal
        this._statusListenerDisposable = { dispose: () => serverManager.removeListener('status', statusListener) };
        // Add it to extension subscriptions for safety, although onDidDispose should handle it too
        this._context.subscriptions.push(this._statusListenerDisposable);
    }

    // Method to add a complete bot message (can be used for errors or non-streamed messages)
    public updateChat(message: string, sessionId: string): void {
        if (!this._view) {
            LogManager.warn('ChatViewProvider', 'Cannot update chat - view not initialized');
            return;
        }
        LogManager.info('ChatViewProvider', `Updating chat with full message for session ${sessionId}: ${message}`);
        this.postMessage({
            command: 'addBotMessage', // Command for adding a complete message
            text: message,
            sessionId: sessionId // <-- Include sessionId in payload
        });
    }

    // New method to handle streaming text chunks
    public appendChatChunk(chunk: string, localSessionId: string) {
        LogManager.debug('ChatViewProvider', `Sending chunk to webview for session ${localSessionId}. Length: ${chunk.length}`);
        this._view?.webview.postMessage({
            command: 'addBotMessageChunk',
            text: chunk,
            localSessionId: localSessionId,
        });
    }

    // New method to update a status indicator in the UI
    public updateStatus(statusText: string): void {
        if (!this._view) {
            // LogManager.warn('ChatViewProvider', 'Cannot update status - view not initialized');
            return;
        }
        this.postMessage({
            command: 'updateProcessingStatus', // New command for status text
            text: statusText
        });
    }

    // Method to clear chat history display (called by MCPClient or command)
    public clearChatDisplay(): void {
         if (this._view) {
             LogManager.info('ChatViewProvider', 'Clearing chat display in webview.');
            this.postMessage({ command: 'clearChat' });
         } else {
             LogManager.warn('ChatViewProvider', 'Attempted to clear chat display, but view is not available.');
         }
    }

    // --- HTML Content Generation ---
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();

        // --- FIX: Get URI for the external script ---
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chatView.js'));
        // Optional: Get URI for CSS if you move styles too
        // const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chatView.css'));

        // --- FIX: Return HTML referencing the script, remove inline script ---
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <!-- *** Updated CSP to allow script-src from our extension's media path *** -->
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource};">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>MCP Chat</title>
            <style>
                /* --- Keep the CSS styles here (or move to chatView.css) --- */
                :root {
                    /* Define some theme-based colors */
                    --vscode-input-background: #3c3c3c;
                    --vscode-input-border: #3c3c3c;
                    --vscode-input-foreground: #cccccc;
                    --vscode-button-background: #0e639c;
                    --vscode-button-foreground: #ffffff;
                    --vscode-button-hoverBackground: #1177bb;
                    --vscode-sideBar-border: #cccccc33;
                    --vscode-editor-foreground: #cccccc;
                    --vscode-list-hoverBackground: #2a2d2e;
                    --vscode-scrollbarSlider-background: #4e4e4e66;
                    --vscode-scrollbarSlider-hoverBackground: #68686888;
                    --vscode-editor-background: #1e1e1e;
                    --vscode-statusBar-background: #007acc;
                    --vscode-statusBar-foreground: #ffffff;
                    --user-message-bg: #0078d4; /* Example blue */
                    --bot-message-bg: var(--vscode-list-hoverBackground, #2a2d2e);
                }
                /* ... rest of your CSS styles ... */
                body {
                    font-family: var(--vscode-font-family, sans-serif);
                    padding: 0 10px 10px 10px;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                    box-sizing: border-box;
                    background-color: var(--vscode-sideBar-background, var(--vscode-editor-background)); /* Match sidebar bg */
                    color: var(--vscode-input-foreground);
                }
                 /* Session List Styling */
                #session-list-container {
                    border-bottom: 1px solid var(--vscode-sideBar-border);
                    padding-bottom: 5px;
                    margin-bottom: 5px;
                    max-height: 150px; /* Limit height */
                    overflow-y: auto;
                    flex-shrink: 0; /* Prevent shrinking */
                }
                #session-list-container h2 {
                    margin: 5px 0;
                    font-size: 0.9em;
                    color: var(--vscode-editor-foreground);
                }
                #session-list {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                }
                .session-item {
                    padding: 4px 8px;
                    cursor: pointer;
                    border-radius: 3px;
                    margin-bottom: 2px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .session-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .session-item.active-session {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    font-weight: bold;
                }
                /* End Session List Styling */

                .chat-history {
                    border: 1px solid var(--vscode-sideBar-border);
                    flex-grow: 1;
                    overflow-y: scroll; /* Changed from auto to scroll */
                    margin-bottom: 10px;
                    padding: 10px;
                    background-color: var(--vscode-editor-background); /* Slightly different background */
                    border-radius: 4px;
                }
                .message-container {
                    display: flex;
                    align-items: flex-start; /* Align icon with top of bubble */
                    margin-bottom: 12px;
                    max-width: 90%; /* Prevent bubbles from taking full width */
                }
                .message-icon {
                    flex-shrink: 0; /* Prevent icon from shrinking */
                    width: 30px;
                    height: 30px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    font-size: 14px; /* Adjust as needed */
                    margin-right: 8px; /* Space between icon and bubble */
                }
                .message-bubble {
                    padding: 8px 12px;
                    border-radius: 10px;
                    word-wrap: break-word; /* Wrap long words */
                    white-space: pre-wrap; /* Preserve whitespace and newlines */
                    overflow-wrap: break-word; /* Ensure long words break */
                    /* --- Additions for better wrapping --- */
                    max-width: 100%; /* Allow bubble to use full container width */
                    display: inline-block; /* Needed for max-width to work correctly with wrapping */
                    /* ------------------------------------ */
                }

                /* User messages */
                .user-message {
                    justify-content: flex-end; /* Align container to the right */
                    margin-left: auto; /* Push to the right */
                }
                .user-message .message-icon {
                    order: 2; /* Move icon to the right */
                    margin-right: 0;
                    margin-left: 8px; /* Space on the left */
                    background-color: #0078d4; /* Example user color */
                    color: white;
                }
                .user-message .message-bubble {
                    order: 1; /* Move bubble to the left */
                    background-color: var(--user-message-bg);
                    color: white;
                    border-bottom-right-radius: 2px; /* Slight point */
                }

                /* Bot messages */
                .bot-message .message-icon {
                    background-color: #555; /* Example bot color */
                    color: white;
                }
                .bot-message .message-bubble {
                    background-color: var(--bot-message-bg);
                    color: var(--vscode-editor-foreground);
                    border-bottom-left-radius: 2px; /* Slight point */
                }
                .bot-message .message-bubble.error-message {
                    color: lightcoral; /* Highlight errors */
                    border: 1px solid lightcoral;
                }

                .input-area { display: flex; margin-top: 5px; align-items: center; /* Align items center */ }
                #message-input { 
                    flex-grow: 1; 
                    margin-right: 8px; 
                    background-color: var(--vscode-input-background); 
                    border: 1px solid var(--vscode-input-border); 
                    color: var(--vscode-input-foreground); 
                    padding: 6px 8px; 
                    border-radius: 4px; 
                    /* --- Textarea specific styles --- */
                    resize: none; /* Disable manual resizing */
                    min-height: 28px; /* Minimum height (adjust as needed) */
                    height: auto; /* Allow height to grow based on content */
                    max-height: 150px; /* Limit max growth */
                    overflow-y: auto; /* Add scroll if it exceeds max-height */
                    font-family: inherit; /* Inherit font from body */
                    font-size: inherit;
                    line-height: 1.4; /* Adjust line height */
                    /* ----------------------------- */
                }
                #send-button, #new-chat-button { 
                    flex-shrink: 0; /* Prevent buttons from shrinking */
                    background-color: var(--vscode-button-background); 
                    color: var(--vscode-button-foreground); 
                    border: none; 
                    padding: 6px 12px; /* Keep padding consistent */
                    cursor: pointer; 
                    border-radius: 4px; 
                    height: 30px; /* Match typical button height */
                    margin-left: 5px; /* Add some space between buttons */
                    line-height: 1; /* Ensure text is centered vertically */
                }
                #send-button:hover, #new-chat-button:hover { background-color: var(--vscode-button-hoverBackground); }
                .server-status {
                     display: none; /* Hide status for now, can be re-enabled */
                }

                /* Scrollbar styling */
                ::-webkit-scrollbar { width: 8px; }
                ::-webkit-scrollbar-track { background: var(--vscode-editor-background); }
                ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
                ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

                /* Styles for collapsible messages */
                .message-bubble.collapsible {
                    /* Remove direct padding, let children handle it */
                    padding: 0; 
                }
                .message-summary {
                    padding: 8px 12px; /* Restore padding for summary */
                    white-space: pre-wrap; /* Keep line breaks */
                    cursor: default;
                }
                .message-full-text {
                    padding: 8px 12px; /* Restore padding for full text */
                    white-space: pre-wrap; /* Keep line breaks */
                }
                .toggle-button {
                    display: block; /* Make it block level */
                    margin: 8px 12px 8px auto; /* Push to the right */
                    padding: 2px 8px;
                    font-size: 0.8em;
                    background-color: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 3px;
                    color: var(--vscode-input-foreground);
                    cursor: pointer;
                }
                .toggle-button:hover {
                    background-color: rgba(255, 255, 255, 0.2);
                }

                /* Adjustments for user messages */
                .message-container.user-message {
                    justify-content: flex-end; /* Align container to the right */
                    margin-left: auto; /* Push to the right */
                }
                .message-container.user-message .message-icon {
                    order: 2; /* Move icon to the right */
                    margin-right: 0;
                    margin-left: 8px; /* Space on the left */
                    background-color: #0078d4; /* Example user color */
                    color: white;
                }
                .message-container.user-message .message-bubble {
                    order: 1; /* Move bubble to the left */
                    background-color: var(--user-message-bg);
                    color: white;
                    border-bottom-right-radius: 2px; /* Slight point */
                }
            </style>
        </head>
        <body>
             <!-- Session List Placeholder -->
            <div id="session-list-container">
                <h2>Sessions</h2>
                <ul id="session-list">
                    <!-- Session items will be populated by JS -->
                </ul>
            </div>
            <!-- End Session List Placeholder -->

            <div class="chat-history" id="chat-history">
                <!-- Messages will be added here -->
            </div>
            <div class="input-area">
                <textarea id="message-input" placeholder="Enter your message..." rows="1"></textarea>
                <button id="send-button">Send</button>
                <button id="new-chat-button" title="Start New Chat">New Chat</button>
            </div>
            <div class="status-area" id="status-area">
                <!-- Server statuses will be shown here -->
            </div>

            <!-- *** Reference the external script *** -->
            <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
    }

    // Add method to handle status updates from extension.ts
    public handleStatusUpdate(event: { serverId: string; status: string; error?: any }): void {
        LogManager.info('ChatViewProvider', `Handling status update for ${event.serverId}: ${event.status}`);
        
        // Format a status message
        const statusMessage = `Server ${event.serverId}: ${event.status}${event.error ? ` (Error: ${typeof event.error === 'string' ? event.error : event.error.message || 'Unknown error'})` : ''}`;
        
        // Update status display in the view
        if (this._view) {
            this.postMessage({
                command: 'updateServerStatus',
                text: statusMessage,
                status: event.status,
                serverId: event.serverId,
                error: event.error
            });
        }
    }

    // Helper method to send session list - Needs to be public for MCPClient
    public sendSessionListToWebview(mcpClient: any) { // Use 'any' for now, replace with LocalLLMClient if possible
        try {
            const sessions = mcpClient.getSessionList(); // Get {id, title} list
            const activeSessionId = mcpClient.getActiveSessionId(); // Need direct access or getter
            LogManager.debug('ChatViewProvider', `Sending session list to webview (${sessions.length} sessions). Active: ${activeSessionId}`);
            this.postMessage({ command: 'syncSessionList', sessions: sessions, activeSessionId: activeSessionId });
        } catch (error: any) {
             LogManager.error('ChatViewProvider', 'Error sending session list to webview', error);
        }
    }

    // New method to handle streaming text chunks
    public syncHistory(history: ChatMessage[], localSessionId: string) {
        LogManager.debug('ChatViewProvider', `Sending ${history.length} history messages to webview for session ${localSessionId}.`);
        this._view?.webview.postMessage({
            command: 'syncHistory',
            history: history,
            localSessionId: localSessionId
        });
    }

    // New method to handle session list
    public syncSessionList(sessions: ChatSessionMetadata[], activeSessionId: string) {
        LogManager.debug('ChatViewProvider', `Sending session list to webview (${sessions.length} sessions). Active: ${activeSessionId}`);
        this._view?.webview.postMessage({
            command: 'syncSessionList',
            sessions: sessions,
            activeSessionId: activeSessionId
        });
    }
}

// Function to generate nonce (reuse if you have it elsewhere)
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// Export handleSendMessage if it's not already (we need to call it)
// We will likely need to adjust handleSendMessage to work with the provider

// Export handleSendMessage if it's not already (we need to call it)
// We will likely need to adjust handleSendMessage to work with the provider 