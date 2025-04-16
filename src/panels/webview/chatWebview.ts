import * as vscode from 'vscode';
import { getNonce } from '../../utils';

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:;">
  <title>MCP Chat</title>
  <style>
    :root {
      --background-color: #1e1e1e;
      --foreground-color: #cccccc;
      --border-color: #3c3c3c;
      --button-background: #3a3d41;
      --button-hover-background: #45494e;
      --input-background: #252526;
      --system-message-background: #2d3040;
      --user-message-background: #2c4c4c;
      --assistant-message-background: #44475a;
      --error-message-background: #5a3434;
      --header-color: #e2e2e2;
      --accent-color: #007acc;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      background-color: var(--background-color);
      color: var(--foreground-color);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }
    
    .container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 15px;
      box-sizing: border-box;
    }
    
    .header {
      margin-bottom: 15px;
    }
    
    .title {
      margin: 0;
      color: var(--header-color);
      font-size: 24px;
      font-weight: 600;
    }
    
    .subtitle {
      margin: 0;
      color: var(--foreground-color);
      opacity: 0.8;
      font-size: 14px;
    }
    
    .controls {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    
    .button {
      background-color: var(--button-background);
      color: var(--foreground-color);
      border: none;
      padding: 6px 12px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
    }
    
    .button:hover {
      background-color: var(--button-hover-background);
    }
    
    .chat-container {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-color);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    
    .chat-log {
      flex-grow: 1;
      overflow-y: auto;
      padding: 10px;
      background-color: var(--background-color);
    }
    
    .message {
      margin-bottom: 8px;
      padding: 8px 12px;
      border-radius: 4px;
      max-width: 85%;
      word-break: break-word;
    }
    
    .system-message {
      background-color: var(--system-message-background);
      text-align: center;
      width: auto;
      margin-left: auto;
      margin-right: auto;
    }
    
    .user-message {
      background-color: var(--user-message-background);
      margin-left: auto;
      border-radius: 12px 12px 0 12px;
    }
    
    .assistant-message {
      background-color: var(--assistant-message-background);
      margin-right: auto;
      border-radius: 12px 12px 12px 0;
    }
    
    .error-message {
      background-color: var(--error-message-background);
      text-align: center;
      width: auto;
      margin-left: auto;
      margin-right: auto;
    }
    
    .input-container {
      display: flex;
      padding: 10px;
      gap: 10px;
      background-color: var(--background-color);
      border-top: 1px solid var(--border-color);
    }
    
    .message-input {
      flex-grow: 1;
      background-color: var(--input-background);
      color: var(--foreground-color);
      border: 1px solid var(--border-color);
      border-radius: 3px;
      padding: 8px;
      resize: none;
      min-height: 40px;
      font-family: inherit;
    }
    
    .send-button {
      align-self: stretch;
      min-width: 70px;
    }
    
    .status-bar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      font-size: 13px;
      padding: 5px 0;
      color: var(--foreground-color);
      opacity: 0.8;
      margin-bottom: 10px;
    }
    
    .server-status-list {
      display: flex;
      gap: 8px;
    }
    
    .server-status-item {
      display: flex;
      align-items: center;
      padding: 2px 6px;
      border-radius: 3px;
      background-color: var(--input-background);
    }
    
    .status-indicator {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    
    .connected {
      background-color: #3fb950;
    }
    
    .disconnected {
      background-color: #f85149;
    }
    
    .debug-container {
      border: 1px solid var(--border-color);
      border-radius: 3px;
      margin-bottom: 10px;
      max-height: 150px;
      display: flex;
      flex-direction: column;
    }
    
    .debug-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 10px;
      background-color: var(--button-background);
      border-bottom: 1px solid var(--border-color);
    }
    
    .debug-title {
      font-weight: 600;
      font-size: 13px;
    }
    
    .debug-log {
      padding: 5px 10px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 12px;
      flex-grow: 1;
      background-color: var(--input-background);
    }
    
    .debug-entry {
      margin-bottom: 4px;
      border-bottom: 1px dashed rgba(255, 255, 255, 0.1);
      padding-bottom: 4px;
    }
    
    .debug-entry:last-child {
      margin-bottom: 0;
      border-bottom: none;
    }

    /* Checkbox styles for multi-select */
    .server-checkbox-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    
    .server-checkbox-item {
      display: flex;
      align-items: center;
      background-color: var(--input-background);
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid var(--border-color);
    }
    
    .server-checkbox-item input {
      margin-right: 6px;
    }
    
    .server-checkbox-item label {
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">MCP Chat</h1>
      <p class="subtitle">Communicate with MCP servers</p>
    </div>
    
    <div class="controls">
      <button id="addServerBtn" class="button">Add Server</button>
      <button id="clearChatBtn" class="button">Clear Chat</button>
      <button id="testConnectionBtn" class="button">Test Connection</button>
    </div>
    
    <div class="chat-container">
      <div id="chatLog" class="chat-log"></div>
      <div class="input-container">
        <textarea id="messageInput" class="message-input" placeholder="Type your message here..."></textarea>
        <button id="sendBtn" class="button send-button">Send</button>
      </div>
    </div>
    
    <div class="status-bar">
      <div id="serverStatusList" class="server-status-list">
          <!-- Status indicators will be added here -->
      </div>
    </div>
    
    <div class="debug-container">
      <div class="debug-header">
        <div class="debug-title">Debug Log</div>
        <button id="clearDebugBtn" class="button">Clear</button>
      </div>
      <div id="debugLog" class="debug-log"></div>
    </div>
  </div>
  
  <script nonce="${nonce}">
    (function() {
      // DOM elements
      const vscode = acquireVsCodeApi();
      const chatLog = document.getElementById('chatLog');
      const messageInput = document.getElementById('messageInput');
      const sendBtn = document.getElementById('sendBtn');
      const addServerBtn = document.getElementById('addServerBtn');
      const clearChatBtn = document.getElementById('clearChatBtn');
      const testConnectionBtn = document.getElementById('testConnectionBtn');
      const serverStatusList = document.getElementById('serverStatusList');
      const debugLog = document.getElementById('debugLog');
      const clearDebugBtn = document.getElementById('clearDebugBtn');
      
      // State
      let serverList = [];
      let serverStatuses = {}; // Track status of all servers { serverId: 'connected' | 'disconnected' | 'connecting' }
      
      // Initialize
      function initialize() {
        addDebugEntry('Initializing chat webview', 'info');
        
        // Restore previous state if available
        const state = vscode.getState() || { messages: [] };
        
        // Display previous messages
        if (state.messages && state.messages.length > 0) {
          state.messages.forEach(message => {
            addMessageToChat(message.text, message.type);
          });
        }
        
        // Request initial state
        vscode.postMessage({
          command: 'getInitialState'
        });
        
        addDebugEntry('Sent getInitialState command to extension', 'info');
      }
      
      // Add message to chat
      function addMessageToChat(text, type = 'system', duration = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message ' + type + '-message';
        messageDiv.textContent = text;
        
        chatLog.appendChild(messageDiv);
        chatLog.scrollTop = chatLog.scrollHeight;
        
        // Save non-expiring messages to state
        if (duration === null) {
            const state = vscode.getState() || { messages: [] };
            state.messages = [
                ...state.messages,
                { text, type } // Only save non-expiring messages
            ];
            vscode.setState(state);
        } else {
            // If duration is set, remove the message after the timeout
            addDebugEntry('Message "' + text.substring(0, 30) + '..." will disappear in ' + duration + 'ms', 'info');
            setTimeout(() => {
                if (messageDiv.parentNode === chatLog) { // Check if still attached
                    chatLog.removeChild(messageDiv);
                }
            }, duration);
        }
      }
      
      // Add debug entry
      function addDebugEntry(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = 'debug-entry';
        entry.textContent = '[' + timestamp + '] [' + type.toUpperCase() + '] ' + message;
        
        debugLog.appendChild(entry);
        debugLog.scrollTop = debugLog.scrollHeight;
      }
      
      // Update server list (Now mostly just updates the status map)
      function updateServerList(servers) {
        addDebugEntry('Updating server list data with ' + servers.length + ' servers', 'info');
        serverList = servers; // Update internal list if needed elsewhere

        const newServerStatuses = {};
        servers.forEach(server => {
          // Preserve existing status if known, otherwise default to disconnected
          newServerStatuses[server.id] = serverStatuses[server.id] || server.status || 'disconnected';
        });
        serverStatuses = newServerStatuses; // Overwrite with the potentially pruned list

        // No dropdown to update anymore

        // Enable/disable input based on *any* server being connected
        const isAnyConnected = Object.values(serverStatuses).some(s => s === 'connected');
        if (isAnyConnected) {
             messageInput.disabled = false;
             sendBtn.disabled = false;
             addDebugEntry('At least one server connected, input enabled.', 'info');
        } else {
             messageInput.disabled = true;
             sendBtn.disabled = true;
             addDebugEntry('No servers connected, input disabled.', 'info');
        }

        updateStatusDisplay();
      }
      
      // Update a single server's status (New function for handling specific updates)
      function updateSingleServerStatus(serverId, status) {
          addDebugEntry('Updating status for ' + serverId + ' to ' + status, 'info');
          if (serverId) {
              serverStatuses[serverId] = status;
              updateStatusDisplay();

              // Optional: Re-evaluate input enable/disable
              const isAnyConnected = Object.values(serverStatuses).some(s => s === 'connected');
              messageInput.disabled = !isAnyConnected;
              sendBtn.disabled = !isAnyConnected;
          }
      }
      
      // Update the status display in the bottom right
      function updateStatusDisplay() {
        if (!serverStatusList) return;
        serverStatusList.innerHTML = ''; // Clear current status list
        addDebugEntry('Updating status display for servers: ' + Object.keys(serverStatuses).join(', '), 'info');

        // Create status items for each server
        for (const serverId in serverStatuses) {
          const status = serverStatuses[serverId] || 'disconnected'; // Default just in case
          const statusClass = status === 'connected' ? 'connected' : 'disconnected';

          const statusItem = document.createElement('div');
          statusItem.className = 'server-status-item';
          // Add a data attribute for easier removal/update if needed later
          statusItem.dataset.serverId = serverId; 
          statusItem.innerHTML =
            '<span class="status-indicator ' + statusClass + '"></span>' +
            serverId; // Simplify: Just show name and indicator
            // serverId + ': ' + status; // Original with text status

          serverStatusList.appendChild(statusItem);
        }
      }
      
      // Handler for server removal
      function handleServerRemoval(serverId) {
        addDebugEntry('Handling server removal for: ' + serverId, 'info');

        // Remove the server from our status tracking
        if (serverStatuses[serverId]) {
            delete serverStatuses[serverId];
            addDebugEntry('Removed server from status map: ' + serverId, 'info');
        } else {
            addDebugEntry('Server not found in status map: ' + serverId, 'warning');
        }

        // Remove from server list array (if still used)
        serverList = serverList.filter(server => server.id !== serverId);

        // Update the status display
        updateStatusDisplay();

        // Re-evaluate input enable/disable
        const isAnyConnected = Object.values(serverStatuses).some(s => s === 'connected');
        messageInput.disabled = !isAnyConnected;
        sendBtn.disabled = !isAnyConnected;
      }
      
      // Send message (Temporary: Sends to first connected server)
      function sendMessage() {
        const targetServerId = Object.keys(serverStatuses).find(id => serverStatuses[id] === 'connected');

        if (!targetServerId) {
          addMessageToChat('No servers are currently connected. Cannot send message.', 'system');
          addDebugEntry('Send cancelled: No connected servers.', 'warning');
          return;
        }

        const text = messageInput.value.trim();
        if (!text) return;

        addMessageToChat(text, 'user');
        addDebugEntry('Sending message via server ' + targetServerId + ': ' + text, 'info');

        // Send to extension, specifying the chosen server
        vscode.postMessage({
          command: 'sendMessage',
          serverId: targetServerId,
          text: text
        });

        messageInput.value = '';
      }
      
      // Event listeners
      sendBtn.addEventListener('click', sendMessage);
      messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      
      addServerBtn.addEventListener('click', () => {
          addDebugEntry('Add server button clicked', 'info');
          vscode.postMessage({ command: 'addServer' });
      });
      
      clearChatBtn.addEventListener('click', () => {
        chatLog.innerHTML = '';
        vscode.setState({ messages: [] });
        addMessageToChat('Chat cleared', 'system');
      });
      
      testConnectionBtn.addEventListener('click', () => {
          addDebugEntry('Test Connection button clicked', 'info');
          // Test connection now needs to potentially test all or prompt?
          // For now, let's make it test the first *configured* server as a simple check.
          const firstServerId = serverList.length > 0 ? serverList[0].id : null;
          if (!firstServerId) {
               addMessageToChat('No servers configured to test.', 'system');
               return;
          }
          addDebugEntry('Sending testConnection command for first configured server: ' + firstServerId, 'info');
          vscode.postMessage({
            command: 'testConnection',
            serverId: firstServerId
          });
      });
      
      clearDebugBtn.addEventListener('click', () => {
          debugLog.innerHTML = '';
      });
      
      // Handle messages from extension
      window.addEventListener('message', (event) => {
        const message = event.data;
        addDebugEntry('Received message from extension: ' + message.command, 'info');

        try {
          switch (message.command) {
            case 'updateServerList':
              updateServerList(message.servers);
              break;

            case 'updateSingleServerStatus': // New handler
                if(message.serverId && message.status) {
                    updateSingleServerStatus(message.serverId, message.status);
                }
                break;

            case 'receiveMessage':
              let responseText = message.text;
              if (typeof responseText === 'object') {
                responseText = responseText.text ? responseText.text : JSON.stringify(responseText);
              }
              addMessageToChat(responseText, 'assistant');
              break;
            case 'error':
              addMessageToChat(message.error || 'An error occurred', 'error', message.duration || null); // Allow errors to expire too
              break;
            case 'systemMessage':
              addDebugEntry('Displaying system message (duration: ' + (message.duration || 'null') + '): ' + message.message, 'info');
              addMessageToChat(message.message, message.type || 'system', message.duration || null);
              break;
            case 'showStatus': // This seems generic, maybe remove or make specific?
               addMessageToChat(message.message || 'Status: ' + message.status, 'system');
               break;
            case 'serverRemoved':
              addDebugEntry('Received serverRemoved command for ' + message.serverId, 'info');
              handleServerRemoval(message.serverId);
              // No need to request refresh, extension should send updated list or status
              break;

            default:
              addDebugEntry('Unknown message command: ' + message.command, 'warning');
          }
        } catch (error) {
          console.error('Error handling message:', error);
          addDebugEntry('Error handling message: ' + error.message, 'error');
        }
      });
      
      // Initialize the webview
      initialize();
    })();
  </script>
</body>
</html>`;
}

/**
 * Helper function to append messages to the chat log
 * (This is needed for external code that might call into this module)
 */
export function appendToChatLog(type: string, message: string) {
  // This function is meant to be called from the webview context
  // Here we're just defining a stub for TypeScript
}

