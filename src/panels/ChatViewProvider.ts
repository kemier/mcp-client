import * as vscode from 'vscode';
import { LogManager } from '../utils/LogManager.js';
import { extensionContext } from '../extension.js'; // Assuming global context access
import { handleSendMessage, getMcpClient } from '../extension.js'; // <-- Import getMcpClient
import { McpServerManager } from '../services/McpServerManager.js'; // Needed for status updates
import { ServerStatusEvent } from '../models/Types.js';

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

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'), // If you have local resources
                vscode.Uri.joinPath(this._extensionUri, 'out')   // Or wherever your JS lives
            ]
        };

        // Set the HTML content
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async message => {
            LogManager.debug('ChatViewProvider', 'Received message from webview', { command: message.command });
            switch (message.command) {
                case 'sendMessage':
                    if (message.text && this._view) {
                        // Call the central handler from extension.ts
                        await handleSendMessage({ text: message.text }, this);
                    }
                    return;
                case 'newChat':
                    LogManager.debug('ChatViewProvider', 'Received newChat command from webview');
                    try {
                        // Get the MCPClient instance via exported function
                        const mcpClient = getMcpClient();
                        if (mcpClient) {
                             mcpClient.startNewChat();
                             // Also tell the webview to clear its display
                            this.postMessage({ command: 'clearChat' });
                        } else {
                             LogManager.warn('ChatViewProvider', 'MCPClient instance not found when handling newChat.');
                             this.postMessage({ command: 'addBotMessage', text: '[Error: Could not start new chat - client not ready.]' });
                        }
                    } catch (error: any) {
                         LogManager.error('ChatViewProvider', 'Error handling newChat command', error);
                         this.postMessage({ command: 'addBotMessage', text: `[Error: Could not start new chat: ${error.message}]` });
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

    // Add the updateChat method referenced in extension.ts
    public updateChat(message: string): void {
        if (!this._view) {
            LogManager.warn('ChatViewProvider', 'Cannot update chat - view not initialized');
            return;
        }
        
        LogManager.info('ChatViewProvider', `Updating chat with message: ${message}`);
        
        // Send the message to the webview for display
        this.postMessage({
            command: 'addBotMessage',
            text: message
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
                .chat-history {
                    border: 1px solid var(--vscode-sideBar-border);
                    flex-grow: 1;
                    overflow-y: auto;
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

                .input-area { display: flex; margin-top: 5px; }
                #message-input { flex-grow: 1; margin-right: 8px; background-color: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); padding: 6px 8px; border-radius: 4px; }
                #send-button { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; }
                #send-button:hover { background-color: var(--vscode-button-hoverBackground); }
                .server-status {
                     display: none; /* Hide status for now, can be re-enabled */
                }

                /* Scrollbar styling */
                ::-webkit-scrollbar { width: 8px; }
                ::-webkit-scrollbar-track { background: var(--vscode-editor-background); }
                ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
                ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
            </style>
        </head>
        <body>
            <div class="chat-history" id="chat-history">
                <!-- Messages will be added here -->
            </div>
            <div class="input-area">
                <textarea id="message-input" placeholder="Enter your message..."></textarea>
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