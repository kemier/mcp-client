import * as vscode from 'vscode';
import { ChatPanel } from '../panels/ChatPanel';

export class CommandManager {
    constructor(private context: vscode.ExtensionContext) {}

    public registerCommands(): void {
        this.context.subscriptions.push(
            vscode.commands.registerCommand('mcpClient.startChat', () => {
                ChatPanel.show(this.context);
            })
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand('mcpClient.helloWorld', () => {
                vscode.window.showInformationMessage('Hello World from mcp-client!');
            })
        );
    }
}