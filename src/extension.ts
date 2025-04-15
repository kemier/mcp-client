// Import necessary modules
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { CommandManager } from './commands/CommandManager';
import { LogManager } from './utils/LogManager';
import { ServerManager } from './services/McpServerManager';
import { ServerStatusEvent } from './models/Types';
import { StdioServer, IServer } from './services/StdioServer';

// Global variable to track the chat panel and chat history
let chatPanel: vscode.WebviewPanel | undefined = undefined;
let chatHistory: { role: string; text: string }[] = []; // Array to store chat history

// Activate function
export async function activate(context: vscode.ExtensionContext) {
    // *** ADD THIS VERY FIRST LINE ***
    console.log('>>> activate function started'); 

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "mcp-client" is now active!');

    // 初始化日志管理器
    try {
        LogManager.initialize(context.extensionPath);
        
        // 记录更详细的激活信息
        const extensionInfo = {
            name: 'MCP Config Assistant',
            version: '0.0.1',
            env: process.env.NODE_ENV || 'development',
            platform: process.platform,
            nodeVersion: process.version
        };
        
        LogManager.info('Extension', '扩展激活', extensionInfo);
    } catch (error) {
        console.error('日志系统初始化失败:', error);
        vscode.window.showErrorMessage('日志系统初始化失败，请检查权限和磁盘空间。');
    }
    
    console.log('>>> Extension activated: mcp-client');
    
    // 注册命令
    const commandManager = new CommandManager(context);
    commandManager.registerCommands();

    // 监听配置变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('mcpClient')) {
                console.log('Configuration changed');
                const newConfig = vscode.workspace.getConfiguration('mcpClient');
                console.log('New configuration:', newConfig);
            }
        })
    );

    // 注册清理函数
    context.subscriptions.push({
        dispose: () => {
            ServerManager.getInstance().dispose();
        }
    });

    try {
        const serverManager = ServerManager.getInstance();

        // 监听服务器状态变化
        serverManager.on('status', (event: ServerStatusEvent) => {
            LogManager.info('Extension', `服务器状态变更: ${event.status}`, {
                serverId: event.serverId,
                pid: event.pid,
                error: event.error
            });
        });

        // 启动服务器
        serverManager.startServer().catch(error => {
            // Log the error if background startup fails, but don't block activation
            LogManager.error('Extension', '后台启动服务器失败', error);
            vscode.window.showErrorMessage('后台启动 MCP 服务器失败，请查看日志。');
        });
        
    } catch (error) {
        LogManager.error('Extension', '扩展激活失败', error);
        vscode.window.showErrorMessage('扩展激活失败，请查看日志了解详情。');
    }
}

// Deactivate function
export function deactivate() {
    // 清理资源
    if (chatPanel) {
        chatPanel.dispose();
    }
}

// Register the "Hello World" command
function registerHelloWorldCommand(context: vscode.ExtensionContext) {
    const helloWorldDisposable = vscode.commands.registerCommand('mcp-client.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from mcp-client!');
	});
    context.subscriptions.push(helloWorldDisposable);
}

// Register the "Start Chat" command
function registerStartChatCommand(context: vscode.ExtensionContext) {
    const startChatDisposable = vscode.commands.registerCommand('mcpClient.startChat', () => {
        console.log('Command executed: mcpClient.startChat');
        openChatPanel(context);
    });
    context.subscriptions.push(startChatDisposable);
}

// Open or create the chat panel
function openChatPanel(context: vscode.ExtensionContext) {
    const columnToShowIn = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

    if (chatPanel) {
        console.log('Revealing existing chat panel.');
        chatPanel.reveal(columnToShowIn);
    } else {
        console.log('Creating new chat panel.');
        chatPanel = vscode.window.createWebviewPanel(
            'mcpChat',
            'MCP Chat',
            columnToShowIn,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        chatPanel.webview.html = getWebviewContent();
        setupChatPanelListeners(chatPanel, context);
    }
}

// Setup listeners for the chat panel
function setupChatPanelListeners(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    panel.onDidDispose(() => {
        console.log('Chat panel disposed.');
        chatPanel = undefined;
    }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async (message) => {
        console.log('Received message:', message.command);
        if (message.command === 'sendMessage') {
            await handleSendMessage(message.text, context, panel);
        }
    }, undefined, context.subscriptions);

    // 添加服务器状态监听
    const serverManager = ServerManager.getInstance();
    serverManager.on('status', (event: ServerStatusEvent) => {
        panel.webview.postMessage({
            command: 'updateServerStatus',
            text: `服务器 ${event.serverId} ${event.status}${event.error ? ' - Error: ' + event.error : ''}`
        });
    });
}

// Handle the "sendMessage" command
async function handleSendMessage(text: string, context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    const config = vscode.workspace.getConfiguration('mcpClient');
    
    // 添加更多调试信息
    console.log('完整配置:', config);
    console.log('servers配置:', config.get('servers'));
    console.log('配置检查:', {
        hasConfig: config !== undefined,
        configKeys: Object.keys(config),
        rawConfig: config.inspect('servers')
    });

    console.log('Processing message:', text);

   
    const servers = config.get<Record<string, { type: string; command: string; args?: string[]; env?: Record<string, string> }>>('servers') || {};
    console.log('Parsed servers:', servers);

    if (Object.keys(servers).length === 0) {
        vscode.window.showErrorMessage('No MCP servers configured. Please add servers in settings.');
        return;
    }

    // 让用户选择一个或多个 MCP 服务器
    const selectedServers = await vscode.window.showQuickPick(
        Object.keys(servers),
        {
            canPickMany: true,
            placeHolder: 'Select one or more MCP servers to interact with'
        }
    );

    if (!selectedServers || selectedServers.length === 0) {
        vscode.window.showErrorMessage('No MCP server selected.');
        return;
    }

    // 移除 API Key 校验
    // const apiKey = await getApiKey(context);
    // if (!apiKey) {
    //     vscode.window.showErrorMessage('Cannot send message without API Key.');
    //     return;
    // }

    // 添加用户消息到聊天历史
    chatHistory.push({ role: 'user', text });

    if (chatPanel) {
        // Use type assertion to bypass the check
        (chatPanel.webview as any).setState({ history: chatHistory });
    } else {
        console.error("Cannot save state, chatPanel is undefined.");
        // Handle this case appropriately - maybe the panel was closed?
    }

    const serverManager = ServerManager.getInstance();
    
    // 并行发送消息到选定的 MCP 服务器
    try {
        const responses = await Promise.all(
            selectedServers.map(async (serverName) => {
                const serverConfig = servers[serverName];
                console.log(`准备发送消息到服务器 ${serverName}:`, {
                    config: serverConfig,
                    message: text
                });

                try {
                    // Use the existing ServerManager to send the message
                    // This handles getting/creating the server instance and sending the message correctly
                    // NOTE: Assuming your sendMessage expects a ModelRequest object like { text: string }
                    //       and returns a ModelResponse object like { text: string }
                    const response = await serverManager.sendMessage(serverName, { text: text }); // Pass request object
                    return { server: serverName, response: response.text }; // Adapt based on actual response structure
                } catch (error) {
                    console.error(`服务器 ${serverName} 错误:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    // Ensure the return structure matches the success case for Promise.all
                    return { server: serverName, response: `错误: ${errorMessage}` };
                }
            })
        );

        responses.forEach(({ server, response }) => {
            const formattedResponse = `[${server}] ${response}`;
            chatHistory.push({ role: 'bot', text: formattedResponse });
            panel.webview.postMessage({ 
                command: 'addBotMessage', 
                text: formattedResponse 
            });

            // Use type assertion again
            (panel.webview as any).setState({ history: chatHistory });
        });
    } catch (error) {
        console.error('处理消息时出错:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('发送消息时出错: ' + errorMessage);
    }
}

// Helper function to execute a stdio server
async function executeStdioServer(serverConfig: { command: string; args?: string[]; env?: Record<string, string> }, text: string): Promise<{ server: string; response: string }> {
    console.log('开始执行服务器命令');
    console.log('环境变量:', serverConfig.env);
    console.log('执行命令:', serverConfig.command);
    console.log('命令参数:', serverConfig.args);
    console.log('发送文本:', text);

    return new Promise((resolve) => {
        const child = cp.spawn(serverConfig.command, serverConfig.args || [], {
            env: { ...process.env, ...serverConfig.env },
            shell: true
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            console.log('收到服务器输出:', chunk);
            output += chunk;
        });

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            console.error('服务器错误输出:', chunk);
            errorOutput += chunk;
        });

        child.on('error', (error) => {
            console.error('进程错误:', error);
            resolve({ server: serverConfig.command, response: `Error: ${error.message}` });
        });

        child.on('close', (code) => {
            console.log('进程退出码:', code);
            console.log('最终输出:', output);
            console.log('错误输出:', errorOutput);
            
            if (code !== 0) {
                resolve({ 
                    server: serverConfig.command, 
                    response: `Error (${code}): ${errorOutput || output || 'No output'}` 
                });
            } else {
                resolve({ server: serverConfig.command, response: output.trim() || 'No response' });
            }
        });

        // 发送消息到服务器
        try {
            const input = JSON.stringify({ text }) + '\n';
            console.log('发送到服务器的输入:', input);
            child.stdin.write(input);
            child.stdin.end();
        } catch (error) {
            console.error('写入输入时出错:', error);
        }
    });
}

// Helper function to read the local index file
async function readLocalIndexFile(filePath: string): Promise<string | undefined> {
    try {
        const fileUri = vscode.Uri.file(filePath);
        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        return Buffer.from(fileContent).toString('utf8');
    } catch (error) {
        console.error('Error reading local index file:', error);
        return undefined;
    }
}

// Helper function to get the API key
async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    const SECRET_STORAGE_API_KEY = 'mcpClientApiKey';
    let apiKey = await context.secrets.get(SECRET_STORAGE_API_KEY);
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your LLM API Key',
            placeHolder: 'Paste your API key here',
            password: true,
            ignoreFocusOut: true
        });
        if (apiKey) {
            await context.secrets.store(SECRET_STORAGE_API_KEY, apiKey);
            vscode.window.showInformationMessage('API Key stored securely.');
        } else {
            vscode.window.showErrorMessage('API Key not entered. Cannot proceed.');
        }
    }
    return apiKey;
}

// Generate the webview content
function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Chat</title>
    <style>
        body { font-family: sans-serif; padding: 1em; }
        .chat-history { border: 1px solid #ccc; height: 300px; overflow-y: scroll; margin-bottom: 1em; padding: 0.5em; }
        .message { margin-bottom: 0.5em; }
        .user-message { text-align: right; }
        .bot-message { text-align: left; color: blue; }
        .input-area { display: flex; }
        #message-input { flex-grow: 1; margin-right: 0.5em; }
        .server-status { 
            margin-bottom: 1em; 
            padding: 0.5em;
            background-color: #f0f0f0;
            border-radius: 4px;
        }
        .connected { color: green; }
        .disconnected { color: red; }
    </style>
</head>
<body>
    <h1>MCP Chat Panel</h1>
    <div class="server-status" id="server-status">服务器状态: 未连接</div>
    <div class="chat-history" id="chat-history">
        <div class="message bot-message">Hello! How can I help you today?</div>
    </div>
    <div class="input-area">
        <input type="text" id="message-input" placeholder="Type your message...">
        <button id="send-button">Send</button>
    </div>
    <script>
        console.log('--- MINIMAL WEBVIEW SCRIPT EXECUTING ---');
        alert('Webview Script Running!'); // Add an alert for absolute confirmation
        try {
            const vscode = acquireVsCodeApi();
            console.log('--- acquireVsCodeApi() SUCCEEDED ---');
        } catch (e) {
            console.error('--- acquireVsCodeApi() FAILED ---', e);
            alert('acquireVsCodeApi FAILED!');
        }
    </script>
</body>
</html>`;
}
