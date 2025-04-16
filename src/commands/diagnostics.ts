import * as vscode from 'vscode';
import { McpServerManager } from '../services/McpServerManager';
import { logInfo, logDebug, logError, getErrorMessage, logWarning } from '../utils/logger';
import { ServerStatus } from '../models/Types';
import { ConfigStorage } from '../services/ConfigStorage';
import { extensionContext } from '../extension';

// Helper function to safely convert ServerStatus enum to string
function getServerStatusString(status: ServerStatus | undefined): string {
    if (status === undefined) {
        return 'Unknown';
    }
    switch (status) {
        case ServerStatus.Connecting: return 'Connecting';
        case ServerStatus.Connected: return 'Connected';
        case ServerStatus.Disconnected: return 'Disconnected';
        case ServerStatus.Error: return 'Error';
        default:
            // This handles potential unexpected enum values gracefully
            const exhaustiveCheck: never = status;
            logWarning(`[Diagnostics] Encountered unexpected server status value: ${exhaustiveCheck}`);
            return 'InvalidStatus'; 
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
                const status = serverManager.getServerStatus(serverId);
                const uptime = serverManager.getServerUptime(serverId);
                const lastResponse = serverManager.getLastServerResponseTime(serverId);
                const statusString = getServerStatusString(status);
                
                let logMessage = `[Diagnostics] Server: ${serverId}, Status: ${statusString}`;
                if (uptime) {
                    logMessage += `, Uptime (ms): ${Date.now() - uptime}`;
                }
                if (lastResponse) {
                    logMessage += `, Last Response: ${new Date(lastResponse).toISOString()}`;
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
