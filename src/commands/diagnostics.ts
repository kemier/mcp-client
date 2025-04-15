import * as vscode from 'vscode';
import { ServerManager } from '../services/McpServerManager';
import { LogManager } from '../utils/LogManager';

export async function diagnoseServerConnection() {
    const serverManager = ServerManager.getInstance();
    const status = serverManager.getStatus();
    
    // 获取配置信息
    const config = vscode.workspace.getConfiguration('mcpClient.servers');
    const defaultServer = config.get('default');
    
    // 检查Python环境
    let pythonInfo = '';
    try {
        const { execSync } = require('child_process');
        pythonInfo = execSync('python --version', { encoding: 'utf8' });
    } catch (error) {
        pythonInfo = '未找到Python';
    }
    
    LogManager.info('Diagnostics', '服务器诊断信息', {
        status,
        config: defaultServer,
        python: pythonInfo,
        nodeVersion: process.version,
        platform: process.platform
    });

    // 构建用户友好的消息
    let message = status.isReady 
        ? `服务器正常运行${status.pid ? ` (PID: ${status.pid})` : ''}`
        : `服务器未连接\n${status.lastError ? `原因: ${status.lastError}` : ''}`;

    if (!status.isReady) {
        message += '\n\n可能的解决方案:\n';
        message += '1. 检查Python是否已安装\n';
        message += '2. 检查mcp_server模块是否已安装\n';
        message += '3. 检查服务器配置是否正确';
    }

    await vscode.window.showInformationMessage(message, 
        '查看日志',
        '打开设置'
    ).then(selection => {
        if (selection === '查看日志') {
            vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        } else if (selection === '打开设置') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'mcpClient.servers');
        }
    });
}
