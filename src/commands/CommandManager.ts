import * as vscode from 'vscode';
import { ChatPanel } from '../panels/ChatPanel.js';
import { McpServerManager } from '../services/McpServerManager.js';
import { ConfigStorage } from '../services/ConfigStorage.js';
import { registerAddServerCommand } from './ServerCommands.js';
import { inputServerDetails } from '../utils/inputUtils.js'; // Uncommented
import { logError, logInfo } from '../utils/logger.js';
import { getErrorMessage } from '../utils/logger.js';

export class CommandManager {
    private context: vscode.ExtensionContext;
    private serverManager: McpServerManager;
    private configStorage: ConfigStorage;
    
    constructor(context: vscode.ExtensionContext, serverManager: McpServerManager, configStorage: ConfigStorage) {
        this.context = context;
        this.serverManager = serverManager;
        this.configStorage = configStorage;
    }
    
    public registerShowChatCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('mcpClient.showChat', () => {
            ChatPanel.createOrShow(this.context.extensionUri, this.serverManager, this.configStorage);
        });
    }
    
    public registerShowChatWithServerCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('mcpClient.chatWithServer', async () => {
            ChatPanel.createOrShow(this.context.extensionUri, this.serverManager, this.configStorage);
        });
    }
    
    public registerCommands(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];
        
        disposables.push(this.registerShowChatCommand());
        disposables.push(this.registerShowChatWithServerCommand());
        
        disposables.push(registerAddServerCommand(this.context));
        
        disposables.push(
            vscode.commands.registerCommand('mcpClient.addServer', async () => {
                logInfo('[CommandManager] Executing command: mcpClient.addServer');
                 try {
                     const details = await inputServerDetails(this.context);
                     if (details) {
                         await this.configStorage.addOrUpdateServer(details.id, details.config);
                         vscode.window.showInformationMessage(`Server '${details.id}' configuration added.`);
                         this.serverManager.startServer(details.id).catch(e => logError(`Failed auto-start after add: ${getErrorMessage(e)}`));
                     }
                 } catch (error) {
                    logError('[CommandManager] Error adding server:', getErrorMessage(error));
                    vscode.window.showErrorMessage(`Failed to add server: ${getErrorMessage(error)}`);
                 }
            })
        );
        
        disposables.push(
            vscode.commands.registerCommand('mcpServerManager.showDashboard', () => {
                logInfo('[CommandManager] Executing command: mcpServerManager.showDashboard');
                ChatPanel.createOrShow(this.context.extensionUri, this.serverManager, this.configStorage);
            })
        );
        
        return disposables;
    }
}