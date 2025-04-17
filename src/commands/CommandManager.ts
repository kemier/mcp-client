import * as vscode from 'vscode';
import { ChatPanel } from '../panels/ChatPanel';
import { McpServerManager } from '../services/McpServerManager';
import { registerAddServerCommand } from './ServerCommands';

export class CommandManager {
    private context: vscode.ExtensionContext;
    
    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }
    
    public registerShowChatCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('mcpClient.showChat', () => {
            ChatPanel.createOrShow(this.context.extensionUri, McpServerManager.getInstance());
        });
    }
    
    public registerShowChatWithServerCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('mcpClient.chatWithServer', async () => {
            // Placeholder for chat with specific server command
            // Implementation will go here
            ChatPanel.createOrShow(this.context.extensionUri, McpServerManager.getInstance());
        });
    }
    
    public registerCommands(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];
        
        disposables.push(this.registerShowChatCommand());
        disposables.push(this.registerShowChatWithServerCommand());
        
        // Add the new server management commands
        disposables.push(registerAddServerCommand(this.context));
        
        return disposables;
    }
}