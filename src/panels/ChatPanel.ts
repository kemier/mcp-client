import * as vscode from 'vscode';
import { ServerManager, ServerStatus } from '../services/McpServerManager';
import { getWebviewContent } from './webview/chatWebview';
import { ModelRequest, ModelResponse, ServerStatusEvent, ServerStatusType } from '../models/Types';
import { LogManager } from '../utils/LogManager';

export class ChatPanel {
    private static instance: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private chatHistory: { role: string; text: string }[] = [];

    private constructor(context: vscode.ExtensionContext) {
        const columnToShowIn = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
        
        this.panel = vscode.window.createWebviewPanel(
            'mcpChat',
            'MCP Chat',
            columnToShowIn,
            { enableScripts: true }
        );

        this.panel.webview.html = getWebviewContent();
        this.setupListeners(context);
    }

    public static show(context: vscode.ExtensionContext): ChatPanel {
        if (ChatPanel.instance) {
            ChatPanel.instance.panel.reveal();
            return ChatPanel.instance;
        }

        ChatPanel.instance = new ChatPanel(context);
        return ChatPanel.instance;
    }

    private setupListeners(context: vscode.ExtensionContext): void {
        // 处理面板关闭
        this.panel.onDidDispose(() => {
            ChatPanel.instance = undefined;
        }, null, context.subscriptions);

        // 处理消息
        this.setupMessageListener();

        // 服务器状态监听
        const serverManager = ServerManager.getInstance();
        serverManager.on('status', (event: ServerStatusEvent) => {
            const statusText = event.status === 'connected' ? '已连接' : '已断开';
            this.panel.webview.postMessage({ 
                command: 'updateServerStatus', 
                text: `服务器 ${event.serverId} ${statusText}`  // 修改 server 为 serverId
            });
        });
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
            }
        });
    }

    private async handleMessage(text: string, servers: string[]): Promise<void> {
        try {
            const serverManager = ServerManager.getInstance();
            const responses = await Promise.all(
                servers.map(async (serverName) => {
                    try {
                        const request: ModelRequest = { text };
                        const response = await serverManager.sendMessage(serverName, request);
                        return { 
                            server: serverName, 
                            response: response.text 
                        };
                    } catch (error) {
                        return { 
                            server: serverName, 
                            response: `错误: ${error instanceof Error ? error.message : String(error)}` 
                        };
                    }
                })
            );

            responses.forEach(({ server, response }) => {
                this.panel.webview.postMessage({ 
                    command: 'addBotMessage', 
                    text: `[${server}] ${response}` 
                });
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('发送消息时出错: ' + errorMessage);
        }
    }

    private async sendMessageToServer(message: string): Promise<void> {
        try {
            const serverManager = ServerManager.getInstance();
            const serverName = 'default'; // 或从配置中获取

            // 向界面发送消息状态
            this.panel.webview.postMessage({
                command: 'updateStatus',
                text: '正在处理消息...'
            });

            const request: ModelRequest = {
                text: message,
                model: 'default' // 可以从配置中获取
            };

            const response = await serverManager.sendMessage(serverName, request);
            
            // 更新聊天记录
            this.updateChatHistory({
                request: {
                    role: 'user',
                    text: message
                },
                response: {
                    role: 'assistant',
                    text: response.text
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
            LogManager.error('ChatPanel', '发送消息失败', error);
            
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
        const statusText = event.status === 'connected' ? '已连接' : '已断开';
        
        this.panel.webview.postMessage({  // 使用 this.panel.webview 替代 this.webview
            command: 'updateServerStatus',
            text: `服务器 ${event.serverId} ${statusText}`  // 修改 server 为 serverId
        });
    }
}