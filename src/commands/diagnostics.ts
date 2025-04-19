import * as vscode from 'vscode';
import { McpServerManager } from '../services/McpServerManager.js';
import { logInfo, logDebug, logError, getErrorMessage, logWarning } from '../utils/logger.js';
import { ServerStatus, ServerStatusEvent } from '../models/Types.js';
import { ConfigStorage } from '../services/ConfigStorage.js';
import { extensionContext } from '../extension.js';

// Helper function to safely convert ServerStatus enum to string
function getServerStatusString(status: ServerStatus | undefined): string {
    if (!status) return 'Unknown';
    switch (status) {
        case ServerStatus.Connected: return 'Connected';
        case ServerStatus.Connecting: return 'Connecting';
        case ServerStatus.Disconnected: return 'Disconnected';
        case ServerStatus.Error: return 'Error';
        default: return 'Unknown';
    }
}

export function registerDiagnosticCommands(context: vscode.ExtensionContext) {
    logInfo('[Diagnostics] Registering diagnostic commands');

    // Command to log current server statuses
    const logServerStatusCommand = vscode.commands.registerCommand('mcpClient.logServerStatus', () => {
        logInfo('[Diagnostics] Command executed: mcpClient.logServerStatus');
        try {
            const serverManager = McpServerManager.getInstance();
            const configStorage = ConfigStorage.getInstance(extensionContext);
            const serverNames = configStorage.getServerNames();
            
            if (serverNames.length === 0) {
                logInfo("[Diagnostics] No servers currently managed.");
                vscode.window.showInformationMessage("No servers are currently being managed.");
                return;
            }

            logDebug(`[Diagnostics] Checking status for servers: ${serverNames.join(', ')}`);
            serverNames.forEach(serverId => {
                const statusEvent = serverManager.getServerStatus(serverId);
                const statusString = getServerStatusString(statusEvent?.status);
                
                let logMessage = `[Diagnostics] Server: ${serverId}, Status: ${statusString}`;
                if (statusEvent?.pid) {
                    logMessage += `, PID: ${statusEvent.pid}`;
                }
                if (statusEvent?.error) {
                    logMessage += `, Error: ${statusEvent.error}`;
                }
                logInfo(logMessage);
            });
            vscode.window.showInformationMessage("Server statuses logged to the MCP Client output channel.");

        } catch (error: any) {
            logError(`[Diagnostics] Error logging server status: ${getErrorMessage(error)}`);
            vscode.window.showErrorMessage("Failed to log server status. Check the output channel.");
        }
    });

    context.subscriptions.push(logServerStatusCommand);
    logInfo('[Diagnostics] Registered command: mcpClient.logServerStatus');

    // Add other diagnostic commands here if needed

}
