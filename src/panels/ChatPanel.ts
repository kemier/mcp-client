import * as vscode from 'vscode';
import { McpServerManager } from '../services/McpServerManager';
import { getWebviewContent } from './webview/chatWebview';
import { ModelRequest, ModelResponse, ServerStatusEvent, ServerStatus } from '../models/Types';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger';

export class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private chatHistory: { role: string; text: string }[] = [];
    private disposables: vscode.Disposable[] = [];
    private _serverManager: McpServerManager;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, serverManager: McpServerManager) {
        this.panel = panel;
        this._serverManager = serverManager;

        // Set the webview's initial html content
        this.updateWebviewContent(extensionUri);

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Update the content when the view state changes
        this.panel.onDidChangeViewState(
            e => {
                if (this.panel.visible) {
                    this.updateWebviewContent(extensionUri);
                }
            },
            null,
            this.disposables
        );

        // 处理消息
        this.setupMessageListener();

        // 服务器状态监听
        serverManager.on('status', (event: ServerStatusEvent) => {
            const statusText = event.status === ServerStatus.Connected ? 'Connected' : 'Disconnected';
            this.panel.webview.postMessage({ 
                command: 'updateServerStatus', 
                text: `Server ${event.serverId} ${statusText}`
            });
        });
    }

    private updateWebviewContent(extensionUri: vscode.Uri) {
        this.panel.webview.html = getWebviewContent(this.panel.webview, extensionUri);
    }

    public static createOrShow(extensionUri: vscode.Uri, serverManager: McpServerManager) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'chatPanel',
            'Chat Panel',
            column || vscode.ViewColumn.One,
            {
                // Enable JavaScript in the webview
                enableScripts: true,
                // Restrict the webview to only loading content from our extension's directory
                localResourceRoots: [extensionUri]
            }
        );

        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, serverManager);
    }

    public dispose() {
        ChatPanel.currentPanel = undefined;

        // Clean up our resources
        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private setupMessageListener(): void {
        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'sendMessage':
                    await this.handleMessage(message.text, message.servers || []);
                    break;
                case 'showError':
                    vscode.window.showErrorMessage(message.text);
                    break;
                case 'debugLog':
                    // Log messages from the webview for debugging
                    console.log(`[WebView Debug] ${message.text}`);
                    break;
            }
        });
    }

    private async handleMessage(text: string, servers: string[]): Promise<void> {
        try {
            const serverManager = McpServerManager.getInstance();
            
            logInfo(`Sending message to servers: ${servers.join(', ')}, text: "${text}"`);
            
            const responses = await Promise.all(
                servers.map(async (serverName) => {
                    try {
                        const request: ModelRequest = { 
                            prompt: text,
                            model: 'default'
                        };
                        
                        const responseString = await serverManager.sendMessage(serverName, request);
                        logInfo(`Received response string from ${serverName}: ${responseString}`);
                        
                        let responseText = '';
                        if (typeof responseString === 'string') {
                            try { 
                                const parsed = JSON.parse(responseString);
                                responseText = parsed.text || parsed.message || parsed.response || responseString; 
                            } catch { responseText = responseString; }
                        } else {
                            responseText = JSON.stringify(responseString);
                        }
                        
                        logDebug(`Extracted text from ${serverName} response: ${responseText}`);
                        
                        return { server: serverName, response: responseText };
                    } catch (error) {
                        logError(`Error sending message to ${serverName}: ${getErrorMessage(error)}`);
                        return { 
                            server: serverName, 
                            response: `Error: ${getErrorMessage(error)}` 
                        };
                    }
                })
            );

            responses.forEach(({ server, response }) => {
                logDebug(`Sending message to webview for ${server}: ${response}`);
                this.panel.webview.postMessage({ 
                    command: 'addBotMessage', 
                    text: `[${server}] ${response}` 
                });
            });
        } catch (error) {
            logError(`Error handling message: ${getErrorMessage(error)}`);
            vscode.window.showErrorMessage('Error sending message: ' + getErrorMessage(error));
        }
    }

    private async sendMessageToServer(message: string): Promise<void> {
        try {
            const serverManager = McpServerManager.getInstance();
            const serverName = 'default'; // 或从配置中获取

            // 向界面发送消息状态
            this.panel.webview.postMessage({
                command: 'updateStatus',
                text: '正在处理消息...'
            });

            const request: ModelRequest = { 
                prompt: message, 
                model: 'default'
            };

            const response = await serverManager.sendMessage(serverName, request);
            
            // Handle potential string or object response
            const responseText = typeof response === 'string' 
                ? response 
                : (response as any).text || JSON.stringify(response);

            // 更新聊天记录
            this.updateChatHistory({
                request: {
                    role: 'user',
                    text: message
                },
                response: {
                    role: 'assistant',
                    text: responseText
                }
            });

            // 更新webview
            this.updateWebview();
            
            // 清除状态信息
            this.panel.webview.postMessage({
                command: 'updateStatus',
                text: ''
            });
        } catch (error) {
            logError(`ChatPanel: Failed to send message: ${getErrorMessage(error)}`);
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`发送消息失败: ${errorMessage}`);
            
            // 在界面显示错误状态
            this.panel.webview.postMessage({
                command: 'updateStatus',
                text: '消息处理失败',
                isError: true
            });
        }
    }

    private updateChatHistory(message: { request: { role: string; text: string }; response: { role: string; text: string } }): void {
        this.chatHistory.push(message.request);
        this.chatHistory.push(message.response);
        
        // 限制历史记录长度，防止内存占用过大
        const maxHistoryLength = 100;
        if (this.chatHistory.length > maxHistoryLength) {
            this.chatHistory = this.chatHistory.slice(-maxHistoryLength);
        }
    }

    private updateWebview(): void {
        this.panel.webview.postMessage({
            command: 'updateChatHistory',
            chatHistory: this.chatHistory
        });
    }

    private updateServerStatus(event: ServerStatusEvent) {
        const statusText = event.status === ServerStatus.Connected ? 'Connected' : 'Disconnected';
        
        this.panel.webview.postMessage({  // 使用 this.panel.webview 替代 this.webview
            command: 'updateServerStatus',
            text: `Server ${event.serverId} ${statusText}`
        });
    }
}