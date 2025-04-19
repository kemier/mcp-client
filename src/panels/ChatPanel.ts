import * as vscode from 'vscode';
import { McpServerManager } from '../services/McpServerManager.js';
import { getWebviewContent } from '../utils/webviewUtils.js';
import { ConfigStorage } from '../services/ConfigStorage.js';
import { ModelRequest, ModelResponse, ServerStatusEvent, ServerStatus, ServerConfig } from '../models/Types.js';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger.js';

export class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private chatHistory: { role: string; text: string }[] = [];
    private _disposables: vscode.Disposable[] = [];
    private _serverManager: McpServerManager;
    private _configStorage: ConfigStorage;
    private _extensionUri: vscode.Uri;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        serverManager: McpServerManager,
        configStorage: ConfigStorage
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._serverManager = serverManager;
        this._configStorage = configStorage;

        this.updateWebviewContent();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this.setupMessageListener();

        this._serverManager.on('serverStatusChanged', (event: ServerStatusEvent) => {
            logDebug(`[ChatPanel] Received serverStatusChanged event for ${event.serverId}: ${event.status}`);
            this._panel?.webview.postMessage({
                command: 'updateSingleServerStatus',
                payload: event
            });
        });

        setTimeout(() => this.sendInitialStateToWebview(), 500);
    }

    private updateWebviewContent() {
        try {
            this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri);
            logInfo('[ChatPanel] Webview content updated.');
        } catch (e) {
            logError(`[ChatPanel] Error setting webview HTML: ${getErrorMessage(e)}. Check path for getWebviewContent.`);
            this._panel.webview.html = `<body>Error loading webview content. Check extension logs.</body>`;
        }
    }

    public static createOrShow(extensionUri: vscode.Uri, serverManager: McpServerManager, configStorage: ConfigStorage) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatPanel',
            'MCP Chat Panel',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist')
                ]
            }
        );

        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, serverManager, configStorage);
    }

    public dispose() {
        ChatPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
        this._serverManager.off('serverStatusChanged', () => {});
    }

    private setupMessageListener(): void {
        this._panel.webview.onDidReceiveMessage(async (message) => {
            logDebug(`[ChatPanel][WebView->Ext] Received command: ${message.command}`, message.payload ?? '');
            try {
                const serverId = message.payload?.serverId;

                switch (message.command) {
                    case 'sendMessage':
                        if (message.payload?.text) {
                            await this.handleSendMessage(message.payload);
                        } else {
                            throw new Error('Missing text for sendMessage.');
                        }
                        break;
                    case 'showError':
                        vscode.window.showErrorMessage(message.text);
                        break;
                    case 'debugLog':
                        console.log(`[WebView Debug] ${message.text}`);
                        break;
                    case 'runServerTool': {
                        if (serverId && message.payload?.request) {
                            const result = await this.handleRunServerTool(message.payload);
                            this._panel.webview.postMessage({
                                command: 'toolResult',
                                payload: { success: true, result: result, originalPayload: message.payload }
                            });
                        } else {
                            throw new Error('Missing serverId or request for runServerTool.');
                        }
                        break;
                    }
                    case 'streamResponse': {
                        try {
                            const { serverName, request } = message.payload;
                            const serverManager = McpServerManager.getInstance();
                            if (!serverName || !request) { throw new Error('Missing serverName or request'); }
                            const requestObject = JSON.parse(request);
                            if (!requestObject.method) {
                                throw new Error('Invalid request payload: missing method.');
                            }
                            logWarning('[ChatPanel] streamResponse command is using non-streaming callServerMethod. Full response will be sent at once.');
                            const response = await serverManager.callServerMethod(
                                serverName,
                                requestObject.method,
                                requestObject.params
                            );

                            this._panel.webview.postMessage({ command: 'streamChunk', payload: { content: response } });
                            this._panel.webview.postMessage({ command: 'streamEnd' });
                        } catch (error) {
                            logError('[ChatPanel] Error streaming response:', getErrorMessage(error));
                            this._panel.webview.postMessage({ command: 'streamError', payload: { error: getErrorMessage(error) } });
                        }
                        break;
                    }
                    case 'startServer':
                        if (serverId) { await this._serverManager.startServer(serverId); }
                        else { throw new Error('Missing serverId for startServer.'); }
                        break;
                    case 'stopServer':
                        if (serverId) { await this._serverManager.stopServer(serverId); }
                        else { throw new Error('Missing serverId for stopServer.'); }
                        break;
                    case 'refreshCapabilities':
                        if (serverId) { await this._serverManager.refreshCapabilities(serverId); }
                        else { throw new Error('Missing serverId for refreshCapabilities.'); }
                        break;
                    default:
                        logWarning(`[ChatPanel] Received unknown command: ${message.command}`);
                }
            } catch (error) {
                const errorMsg = getErrorMessage(error);
                logError(`[ChatPanel] Error processing command ${message.command}: ${errorMsg}`, error);
                this._panel.webview.postMessage({ command: 'showError', payload: { message: `Error processing command '${message.command}': ${errorMsg}` } });
            }
        });
    }

    private async handleRunServerTool(payload: { serverId: string; request: string }): Promise<any> {
        const { serverId, request: requestString } = payload;
        logInfo(`[ChatPanel] Handling runServerTool for ${serverId}`);
        try {
            const statusEvent = this._serverManager.getServerStatus(serverId);
            if (!statusEvent || statusEvent.status === ServerStatus.Disconnected || statusEvent.status === ServerStatus.Error) {
                logInfo(`[ChatPanel] Server ${serverId} not running, attempting start...`);
                await this._serverManager.startServer(serverId);
                await new Promise(resolve => setTimeout(resolve, 300));
                const newStatus = this._serverManager.getServerStatus(serverId);
                if (newStatus?.status !== ServerStatus.Connected && newStatus?.status !== ServerStatus.Connecting) {
                    throw new Error(`Server ${serverId} failed to start/connect for tool run.`);
                }
            } else if (statusEvent.status === ServerStatus.Connecting) {
                logInfo(`[ChatPanel] Server ${serverId} connecting, waiting...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                const newStatus = this._serverManager.getServerStatus(serverId);
                if (newStatus?.status !== ServerStatus.Connected) {
                    throw new Error(`Server ${serverId} did not connect.`);
                }
            }

            const requestObject = JSON.parse(requestString);
            if (!requestObject.method) {
                throw new Error('Invalid tool request payload: missing method.');
            }
            const result = await this._serverManager.callServerMethod(
                serverId,
                requestObject.method,
                requestObject.params
            );
            return result;
        } catch (error) {
            logError(`[ChatPanel] Error in handleRunServerTool for ${serverId}:`, getErrorMessage(error));
            throw error;
        }
    }

    private async handleSendMessage(payload: { text: string }): Promise<void> {
        const text = payload.text;
        logInfo(`[ChatPanel] Handling sendMessage: "${text}"`);
        this._panel?.webview.postMessage({ command: 'systemMessage', payload: { message: `Processing: "${text}"...`, type: 'info' } });

        this._panel?.webview.postMessage({ command: 'addMessage', payload: { role: 'user', text: text } });

        const connectedServers = this._serverManager.getConnectedServerIdsAndCapabilities();
        const targetServer = connectedServers.length > 0 ? connectedServers[0] : null;

        if (targetServer) {
            const targetServerId = targetServer.serverId;
            logInfo(`[ChatPanel] Sending prompt to first connected server: ${targetServerId}`);
            try {
                const method = "process_prompt";
                const params = { prompt: text };
                const result = await this._serverManager.callServerMethod(targetServerId, method, params);

                logInfo(`[ChatPanel] Received result from ${targetServerId}:`, result);

                this._panel?.webview.postMessage({
                    command: 'addMessage',
                    payload: { role: 'assistant', text: JSON.stringify(result, null, 2) }
                });

            } catch (error) {
                const errorMsg = getErrorMessage(error);
                logError(`[ChatPanel] Error calling server ${targetServerId}: ${errorMsg}`);
                this._panel?.webview.postMessage({ command: 'showError', payload: { message: `Error contacting server ${targetServerId}: ${errorMsg}` } });
                this._panel?.webview.postMessage({ command: 'addMessage', payload: { role: 'error', text: `Error contacting server ${targetServerId}: ${errorMsg}` } });
            }
        } else {
            logWarning('[ChatPanel] No connected servers to send message to.');
            this._panel?.webview.postMessage({ command: 'showError', payload: { message: 'No connected servers available.' } });
            this._panel?.webview.postMessage({ command: 'addMessage', payload: { role: 'system', text: 'No connected servers available.' } });
        }
    }

    private async sendInitialStateToWebview() {
        if (!this._panel) return;
        logDebug('[ChatPanel] Sending initial state to webview.');
        try {
            const statuses = this._serverManager.getAllServerStatuses();
            const configs = this._configStorage.getAllServers();

            const serverList = statuses.map(status => {
                const config: ServerConfig | undefined = configs[status.serverId];
                return {
                    id: status.serverId,
                    config: config || {},
                    status: status.status,
                    isRunning: status.status === ServerStatus.Connected || status.status === ServerStatus.Connecting,
                    error: status.error,
                    capabilities: status.capabilities
                };
            });
            this._panel.webview.postMessage({
                command: 'updateServerList',
                payload: serverList
            });
        } catch (error) {
            logError('[ChatPanel] Error sending initial server list:', getErrorMessage(error));
        }
    }
}