export function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP 聊天</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', "Microsoft YaHei", sans-serif;
            padding: 1em;
            margin: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .chat-container {
            max-width: 800px;
            margin: 0 auto;
        }
        .chat-history { 
            border: 1px solid var(--vscode-widget-border);
            border-radius: 4px;
            height: calc(100vh - 200px);
            overflow-y: auto;
            margin-bottom: 1em;
            padding: 1em;
            background: var(--vscode-editor-background);
        }
        .message { 
            margin-bottom: 1em;
            padding: 0.5em 1em;
            border-radius: 4px;
        }
        .user-message { 
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: 20%;
            text-align: right;
        }
        .bot-message { 
            background: var(--vscode-editor-inactiveSelectionBackground);
            margin-right: 20%;
        }
        .input-area { 
            display: flex;
            gap: 8px;
        }
        #message-input { 
            flex-grow: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        #send-button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        #send-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .server-status {
            margin-bottom: 1em;
            padding: 0.5em;
            background: var(--vscode-banner-background);
            border-radius: 4px;
            font-size: 0.9em;
        }
        .connected { color: var(--vscode-testing-iconPassed); }
        .disconnected { color: var(--vscode-testing-iconFailed); }
        .loading {
            display: inline-block;
            margin-left: 8px;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0% { opacity: .5; }
            50% { opacity: 1; }
            100% { opacity: .5; }
        }
        .error-message {
            color: var(--vscode-errorForeground);
            font-size: 0.9em;
            margin-top: 4px;
        }
        .server-selector {
            margin-bottom: 1em;
            padding: 0.5em;
            background: var(--vscode-banner-background);
            border-radius: 4px;
        }
        .server-selector select {
            padding: 4px 8px;
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 2px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            margin-left: 8px;
        }
        .server-status-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 1em;
        }
        .server-status-item {
            padding: 4px 8px;
            border-radius: 4px;
            background: var(--vscode-banner-background);
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.9em;
        }
        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }
        .status-connected {
            background-color: var(--vscode-testing-iconPassed);
        }
        .status-disconnected {
            background-color: var(--vscode-testing-iconFailed);
        }
        .status-connecting {
            background-color: var(--vscode-testing-iconQueued);
            animation: pulse 1.5s infinite;
        }
    </style>
</head>
<body>
    <div class="chat-container">
        <h1>MCP 聊天助手</h1>
        <div class="server-selector">
            <label for="server-select">选择服务器:</label>
            <select id="server-select" multiple>
                <option value="Perplexity">Perplexity</option>
                <option value="echo">Echo Server</option>
            </select>
        </div>
        <div class="server-status-list" id="server-status-list">
            <!-- 服务器状态指示器将在这里动态添加 -->
        </div>
        <div class="server-status" id="server-status">服务器状态: 未连接</div>
        <div class="chat-history" id="chat-history">
            <div class="message bot-message">你好！我是 MCP 助手，有什么可以帮你的吗？</div>
        </div>
        <div class="input-area">
            <input type="text" 
                   id="message-input" 
                   placeholder="输入您的消息..." 
                   autocomplete="off"
                   spellcheck="false">
            <button id="send-button">发送</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const serverSelect = document.getElementById('server-select');
        const sendButton = document.getElementById('send-button');
        const messageInput = document.getElementById('message-input');
        const chatHistoryDiv = document.getElementById('chat-history');

        // 发送消息
        function sendMessage() {
            const messageText = messageInput.value.trim();
            const selectedServers = Array.from(serverSelect.selectedOptions).map(opt => opt.value);
            
            if (!selectedServers.length) {
                vscode.postMessage({ 
                    command: 'showError', 
                    text: '请选择至少一个服务器' 
                });
                return;
            }

            if (messageText) {
                // 禁用输入框和按钮
                messageInput.disabled = true;
                sendButton.disabled = true;

                const userDiv = document.createElement('div');
                userDiv.className = 'message user-message';
                userDiv.textContent = messageText;
                chatHistoryDiv.appendChild(userDiv);

                // 添加等待提示
                const loadingDiv = document.createElement('div');
                loadingDiv.className = 'message bot-message';
                loadingDiv.innerHTML = '正在思考中<span class="loading">...</span>';
                chatHistoryDiv.appendChild(loadingDiv);
                chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;

                messageInput.value = '';
                vscode.postMessage({ 
                    command: 'sendMessage', 
                    text: messageText,
                    servers: selectedServers
                });

                // 30秒后如果还没收到响应，显示超时提示
                setTimeout(() => {
                    if (loadingDiv.parentNode) {
                        loadingDiv.innerHTML = '服务器响应超时，请重试';
                        loadingDiv.classList.add('error-message');
                        messageInput.disabled = false;
                        sendButton.disabled = false;
                    }
                }, 30000);
            }
        }

        // 事件监听器
        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // 接收消息
        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.command) {
                case 'addBotMessage':
                    // 移除等待提示
                    const loadingDivs = document.querySelectorAll('.bot-message .loading');
                    loadingDivs.forEach(div => {
                        const parentMessage = div.closest('.message');
                        if (parentMessage) {
                            parentMessage.remove();
                        }
                    });

                    const botDiv = document.createElement('div');
                    botDiv.className = 'message bot-message';
                    botDiv.textContent = message.text;
                    chatHistoryDiv.appendChild(botDiv);
                    chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;

                    // 重新启用输入
                    messageInput.disabled = false;
                    sendButton.disabled = false;
                    messageInput.focus();
                    break;
                    
                case 'updateServerStatus':
                    const [serverName, status] = message.text.match(/服务器 (.*?) (已连接|已断开|连接中)/).slice(1);
                    updateServerStatus(serverName, 
                        status === '已连接' ? 'connected' : 
                        status === '连接中' ? 'connecting' : 
                        'disconnected'
                    );
                    break;
            }
        });

        // 选择默认服务器
        serverSelect.options[0].selected = true;

        // 自动聚焦输入框
        messageInput.focus();

        // 更新服务器状态显示
        function updateServerStatus(serverName, status) {
            let statusItem = document.querySelector(\`.server-status-item[data-server="\${serverName}"]\`);
            
            if (!statusItem) {
                statusItem = document.createElement('div');
                statusItem.className = 'server-status-item';
                statusItem.setAttribute('data-server', serverName);
                document.getElementById('server-status-list').appendChild(statusItem);
            }

            const statusClass = status === 'connected' ? 'status-connected' : 
                              status === 'connecting' ? 'status-connecting' : 
                              'status-disconnected';

            statusItem.innerHTML = \`
                <span class="status-indicator \${statusClass}"></span>
                <span>\${serverName}: \${status === 'connected' ? '已连接' : 
                                      status === 'connecting' ? '连接中' : 
                                      '已断开'}</span>
            \`;
        }

        // 初始化所有服务器状态
        Array.from(serverSelect.options).forEach(option => {
            updateServerStatus(option.value, 'disconnected');
        });
    </script>
</body>
</html>`;
}