import * as vscode from 'vscode';
import * as path from 'path';
import { ServerStatus, CapabilityManifest, ServerConfig } from '../models/Types';
import { McpServerManager } from '../services/McpServerManager';
import { ConfigStorage } from '../services/ConfigStorage';
import { LogManager } from '../utils/LogManager';
import { parseArgumentsString, configureEnvironmentVariables } from '../commands/ServerCommands';

export class ServerDashboard {
    public static currentPanel: ServerDashboard | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private serverManager: McpServerManager;
    private configStorage: ConfigStorage;
    
    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this.panel = panel;
        this.configStorage = ConfigStorage.getInstance(context);
        this.serverManager = McpServerManager.getInstance(this.configStorage);
        
        // Initial HTML content
        this.updateWebviewContent();
        
        // Listen for when the panel is disposed
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        
        // Update content when panel becomes visible
        this.panel.onDidChangeViewState(
            e => { if (this.panel.visible) { this.updateWebviewContent(); }},
            null,
            this.disposables
        );
        
        // Handle webview messages
        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'addServer':
                        await this.handleAddServer();
                        break;
                    case 'startServer':
                        await this.handleStartServer(message.serverId);
                        break;
                    case 'stopServer':
                        await this.handleStopServer(message.serverId);
                        break;
                    case 'removeServer':
                        await this.handleRemoveServer(message.serverId);
                        break;
                    case 'refreshCapabilities':
                        await this.handleRefreshCapabilities(message.serverId);
                        break;
                    case 'editServer':
                        await this.handleEditServer(message.serverId);
                        break;
                }
            },
            null,
            this.disposables
        );
        
        // Listen for server status changes
        this.serverManager.on('status', (event) => {
            LogManager.debug('ServerDashboard', `Server status event received for ${event.serverId}: ${event.status}`);
            this.updateWebviewContent();
        });
        
        // Listen for capabilities updates
        this.serverManager.on('capabilities', (event) => {
            LogManager.debug('ServerDashboard', `Capabilities received for ${event.serverId}`);
            this.updateWebviewContent();
        });
    }
    
    public static createOrShow(context: vscode.ExtensionContext): ServerDashboard {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
        
        // If we already have a panel, show it
        if (ServerDashboard.currentPanel) {
            ServerDashboard.currentPanel.panel.reveal(column);
            return ServerDashboard.currentPanel;
        }
        
        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'mcpServerDashboard', 
            'MCP Server Dashboard', 
            column, 
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            }
        );
        
        ServerDashboard.currentPanel = new ServerDashboard(panel, context);
        return ServerDashboard.currentPanel;
    }
    
    public updateWebviewContent(): void {
        this.panel.webview.html = this.getWebviewContent();
    }
    
    private getWebviewContent(): string {
        const serverConfigs = this.configStorage.getAllServers();
        const serverCapabilities = this.configStorage.getAllServerCapabilities();
        
        let serverCardsHtml = '';
        
        Object.entries(serverConfigs).forEach(([serverId, config]) => {
            const capabilities = this.configStorage.getServerCapabilities(serverId);
            const status = this.serverManager.getServerStatus(serverId);
            
            serverCardsHtml += this.generateServerCard(serverId, config, capabilities, status);
        });
        
        if (serverCardsHtml === '') {
            serverCardsHtml = `
                <div class="empty-state">
                    <div class="empty-icon">📡</div>
                    <h2>No MCP Servers Configured</h2>
                    <p>Add a server to get started with the Model Context Protocol.</p>
                    <button class="add-server-btn primary-button">Add Server</button>
                </div>
            `;
        }
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>MCP Server Dashboard</title>
            <style>
                :root {
                    --card-bg: var(--vscode-editor-background);
                    --card-border: var(--vscode-panel-border);
                    --header-color: var(--vscode-foreground);
                    --text-color: var(--vscode-foreground);
                    --primary-button-bg: var(--vscode-button-background);
                    --primary-button-fg: var(--vscode-button-foreground);
                    --tag-bg: var(--vscode-badge-background);
                    --tag-fg: var(--vscode-badge-foreground);
                    --status-connected: #4CAF50;
                    --status-disconnected: #F44336;
                    --status-connecting: #FFC107;
                    --status-error: #F44336;
                }
                
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--text-color);
                }
                
                .dashboard-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 24px;
                }
                
                .server-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
                    gap: 20px;
                }
                
                .server-card {
                    background-color: var(--card-bg);
                    border: 1px solid var(--card-border);
                    border-radius: 6px;
                    overflow: hidden;
                }
                
                .server-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--card-border);
                }
                
                .server-name {
                    font-weight: bold;
                    font-size: 16px;
                }
                
                .server-status {
                    padding: 4px 8px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: bold;
                }
                
                .status-connected { background: var(--status-connected); color: white; }
                .status-disconnected { background: var(--status-disconnected); color: white; }
                .status-connecting { background: var(--status-connecting); color: black; }
                .status-error { background: var(--status-error); color: white; }
                
                .server-content {
                    padding: 16px;
                }
                
                .command-display {
                    background-color: rgba(0, 0, 0, 0.1);
                    padding: 8px;
                    border-radius: 4px;
                    font-family: monospace;
                    margin-bottom: 16px;
                    white-space: nowrap;
                    overflow: auto;
                }
                
                .capabilities-section h3 {
                    margin-top: 0;
                    margin-bottom: 8px;
                }
                
                .capability-tags {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-bottom: 12px;
                }
                
                .capability-tag {
                    background-color: var(--tag-bg);
                    color: var(--tag-fg);
                    padding: 3px 8px;
                    border-radius: 12px;
                    font-size: 12px;
                }
                
                .server-actions {
                    display: flex;
                    gap: 8px;
                    margin-top: 16px;
                }
                
                button {
                    background: none;
                    border: 1px solid var(--card-border);
                    color: var(--text-color);
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                }
                
                button:hover {
                    background-color: rgba(255, 255, 255, 0.1);
                }
                
                .primary-button {
                    background-color: var(--primary-button-bg);
                    color: var(--primary-button-fg);
                    border: none;
                }
                
                .primary-button:hover {
                    opacity: 0.9;
                }
                
                .empty-state {
                    text-align: center;
                    padding: 60px 20px;
                    background-color: var(--card-bg);
                    border: 1px dashed var(--card-border);
                    border-radius: 8px;
                }
                
                .empty-icon {
                    font-size: 48px;
                    margin-bottom: 16px;
                }
                
                .no-capabilities {
                    font-style: italic;
                    opacity: 0.7;
                }
            </style>
        </head>
        <body>
            <div class="dashboard-header">
                <h1>MCP Server Dashboard</h1>
                <button class="add-server-btn primary-button">Add Server</button>
            </div>
            
            <div class="server-grid">
                ${serverCardsHtml}
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                
                // Add event listeners for buttons
                document.querySelectorAll('.add-server-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'addServer' });
                    });
                });
                
                document.querySelectorAll('.start-server-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const serverId = btn.getAttribute('data-server-id');
                        vscode.postMessage({ command: 'startServer', serverId });
                    });
                });
                
                document.querySelectorAll('.stop-server-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const serverId = btn.getAttribute('data-server-id');
                        vscode.postMessage({ command: 'stopServer', serverId });
                    });
                });
                
                document.querySelectorAll('.refresh-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const serverId = btn.getAttribute('data-server-id');
                        vscode.postMessage({ command: 'refreshCapabilities', serverId });
                    });
                });
                
                document.querySelectorAll('.edit-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const serverId = btn.getAttribute('data-server-id');
                        vscode.postMessage({ command: 'editServer', serverId });
                    });
                });
                
                document.querySelectorAll('.remove-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const serverId = btn.getAttribute('data-server-id');
                        vscode.postMessage({ command: 'removeServer', serverId });
                    });
                });
            </script>
        </body>
        </html>`;
    }
    
    private generateServerCard(serverId: string, config: ServerConfig, capabilities?: CapabilityManifest, status: ServerStatus = ServerStatus.Disconnected): string {
        // Generate status badge
        let statusBadge = '';
        let statusClass = '';
        let statusText = '';
        
        switch (status) {
            case ServerStatus.Connected:
                statusClass = 'status-connected';
                statusText = 'Connected';
                break;
            case ServerStatus.Connecting:
                statusClass = 'status-connecting';
                statusText = 'Connecting';
                break;
            case ServerStatus.Error:
                statusClass = 'status-error';
                statusText = 'Error';
                break;
            default:
                statusClass = 'status-disconnected';
                statusText = 'Disconnected';
        }
        
        statusBadge = `<span class="server-status ${statusClass}">${statusText}</span>`;
        
        // Generate command display
        const commandDisplay = `${config.command} ${config.args ? config.args.join(' ') : ''}`;
        
        // Generate capabilities section
        let capabilitiesHtml = '<p class="no-capabilities">No capabilities discovered yet.</p>';
        
        if (capabilities) {
            let modelsHtml = '';
            if (capabilities.models && capabilities.models.length > 0) {
                modelsHtml = `
                    <h3>Models</h3>
                    <div class="capability-tags">
                        ${capabilities.models.map(model => `<span class="capability-tag">${model}</span>`).join('')}
                    </div>
                `;
            }
            
            let capabilitiesTagsHtml = '';
            if (capabilities.capabilities && capabilities.capabilities.length > 0) {
                capabilitiesTagsHtml = `
                    <h3>Capabilities</h3>
                    <div class="capability-tags">
                        ${capabilities.capabilities.map(cap => `<span class="capability-tag">${cap.name}</span>`).join('')}
                    </div>
                `;
            }
            
            let contextTypesHtml = '';
            if (capabilities.contextTypes && capabilities.contextTypes.length > 0) {
                contextTypesHtml = `
                    <h3>Context Types</h3>
                    <div class="capability-tags">
                        ${capabilities.contextTypes.map(type => `<span class="capability-tag">${type}</span>`).join('')}
                    </div>
                `;
            }
            
            if (modelsHtml || capabilitiesTagsHtml || contextTypesHtml) {
                capabilitiesHtml = `
                    ${modelsHtml}
                    ${capabilitiesTagsHtml}
                    ${contextTypesHtml}
                    <p class="capability-timestamp">Last updated: ${new Date(capabilities.discoveredAt).toLocaleString()}</p>
                `;
            }
        }
        
        // Generate action buttons based on server status
        const isConnected = status === ServerStatus.Connected;
        
        let actionButtons = `
            <button class="start-server-btn" data-server-id="${serverId}" ${isConnected ? 'disabled' : ''}>
                Start Server
            </button>
            <button class="stop-server-btn" data-server-id="${serverId}" ${!isConnected ? 'disabled' : ''}>
                Stop Server
            </button>
            <button class="refresh-btn" data-server-id="${serverId}">
                Refresh Capabilities
            </button>
            <button class="edit-btn" data-server-id="${serverId}">
                Edit
            </button>
            <button class="remove-btn" data-server-id="${serverId}">
                Remove
            </button>
        `;
        
        return `
            <div class="server-card">
                <div class="server-header">
                    <span class="server-name">${serverId}</span>
                    ${statusBadge}
                </div>
                <div class="server-content">
                    <div class="command-display">${commandDisplay}</div>
                    <div class="capabilities-section">
                        ${capabilitiesHtml}
                    </div>
                    <div class="server-actions">
                        ${actionButtons}
                    </div>
                </div>
            </div>
        `;
    }
    
    private async handleAddServer(): Promise<void> {
        // Call with the corrected command ID
        vscode.commands.executeCommand('mcpServerManager.addServer');
    }
    
    private async handleStartServer(serverId: string): Promise<void> {
        try {
            vscode.window.showInformationMessage(`Starting server "${serverId}"...`);
            await this.serverManager.startServer(serverId);
            // vscode.window.showInformationMessage(`Server "${serverId}" started successfully.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    private async handleStopServer(serverId: string): Promise<void> {
        try {
            vscode.window.showInformationMessage(`Stopping server "${serverId}"...`);
            await this.serverManager.stopServer(serverId);
            vscode.window.showInformationMessage(`Server "${serverId}" stopped successfully.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop server: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    private async handleRemoveServer(serverId: string): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to remove server "${serverId}"?`,
            { modal: true },
            'Yes',
            'No'
        );

        if (confirmation !== 'Yes') return;

        try {
            vscode.window.showInformationMessage(`Removing server "${serverId}"...`);
            const result = await this.serverManager.removeServerConfiguration(serverId);

            if (result) {
                vscode.window.showInformationMessage(`Server "${serverId}" removed successfully.`);
                this.updateWebviewContent();
            } else {
                vscode.window.showErrorMessage(`Failed to remove server "${serverId}".`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error removing server: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    private async handleRefreshCapabilities(serverId: string): Promise<void> {
        try {
            vscode.window.showInformationMessage(`Refreshing capabilities for server "${serverId}"...`);
            await this.serverManager.refreshCapabilities(serverId);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh capabilities: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    private async handleEditServer(serverId: string): Promise<void> {
        LogManager.info('ServerDashboard', `Handling edit request for server: ${serverId}`);
        const currentConfig = this.configStorage.getServer(serverId);

        if (!currentConfig) {
            vscode.window.showErrorMessage(`Configuration for server "${serverId}" not found.`);
            LogManager.warn('ServerDashboard', `Edit request failed: Config not found for ${serverId}`);
            return;
        }

        try {
            const command = await vscode.window.showInputBox({
                prompt: `Edit command for server "${serverId}"`,
                value: currentConfig.command,
                validateInput: (input) => input ? null : 'Command cannot be empty',
                ignoreFocusOut: true
            });
            if (command === undefined) return;

            const argsInput = await vscode.window.showInputBox({
                prompt: `Edit command arguments (space separated)`,
                value: currentConfig.args?.join(' ') || '',
                placeHolder: 'e.g., --port 8080 --config ./config.json',
                ignoreFocusOut: true
            });
            if (argsInput === undefined) return;
            const args = parseArgumentsString(argsInput);

            const configureEnv = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: `Current Env: ${JSON.stringify(currentConfig.env || {})}. Edit environment variables?`,
                ignoreFocusOut: true
            });
            if (configureEnv === undefined) return;
            let env = currentConfig.env || {};
            if (configureEnv === 'Yes') {
                env = await configureEnvironmentVariables(env);
            }

            const useShell = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: `Use shell to execute command? (Current: ${currentConfig.shell ? 'Yes' : 'No'})`,
                ignoreFocusOut: true
            });
            if (useShell === undefined) return;
            const shell = useShell === 'Yes';

            const hideWindow = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: `Hide command window (Windows only)? (Current: ${currentConfig.windowsHide ? 'Yes' : 'No'})`,
                ignoreFocusOut: true
            });
            if (hideWindow === undefined) return;
            const windowsHide = hideWindow === 'Yes';

            const updatedConfig: ServerConfig = {
                ...currentConfig,
                command,
                args,
                shell,
                windowsHide,
                env
            };

            await this.configStorage.saveServerConfig(serverId, updatedConfig);
            LogManager.info('ServerDashboard', `Server config updated for ${serverId}`, { newConfig: updatedConfig });

            this.updateWebviewContent();

            vscode.window.showInformationMessage(`Server "${serverId}" configuration updated. Restart the server for changes to take effect.`);

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to edit server "${serverId}": ${error instanceof Error ? error.message : String(error)}`);
            LogManager.error('ServerDashboard', `Error editing server ${serverId}`, error);
        }
    }
    
    public handleStatusUpdate(event: { serverId: string; status: string; error?: Error }): void {
        LogManager.debug('ServerDashboard', `Handling status update for ${event.serverId}: ${event.status}`);
        try {
            // Update the dashboard view when server status changes
            this.updateWebviewContent();
            
            // Show error notification if there's an error
            if (event.error) {
                LogManager.error('ServerDashboard', `Error from server ${event.serverId}`, event.error);
                // Can optionally show error in webview or status bar here
            }
        } catch (error) {
            LogManager.error('ServerDashboard', `Error handling status update for ${event.serverId}`, error);
        }
    }
    
    public dispose(): void {
        ServerDashboard.currentPanel = undefined;
        
        // Clean up resources
        this.panel.dispose();
        
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
} 