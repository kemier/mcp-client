console.log('>>> [WebviewView] Script tag executing <<<');
const vscode = acquireVsCodeApi();
const sendButton = document.getElementById('send-button');
const messageInput = document.getElementById('message-input');
const chatHistoryDiv = document.getElementById('chat-history');
// const statusDiv = document.getElementById('server-status'); // Status hidden for now

let localChatHistory = [];

// --- Function to Render History ---
function renderHistory(historyArray) {
    // ... (rest of the renderHistory function as it was) ...
    try {
        console.log('[WebviewView] renderHistory called.');
        chatHistoryDiv.innerHTML = ''; // Clear current display

        if (!historyArray || historyArray.length === 0) {
            // Optionally display a welcome message or leave empty
            console.log('[WebviewView] History array empty.');
            localChatHistory = [];
            return;
        }

        console.log('[WebviewView] Rendering history with ' + historyArray.length + ' messages.');
        localChatHistory = historyArray; // Update local cache

        historyArray.forEach((msg, index) => {
            const isUser = msg.role === 'user';
            const container = document.createElement('div');
            container.className = 'message-container ' + (isUser ? 'user-message' : 'bot-message');

            // Create Icon
            const icon = document.createElement('div');
            icon.className = 'message-icon';
            icon.textContent = isUser ? '👤' : '🤖'; // Use emojis or initials like 'U'/'B'

            // Create Bubble
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            bubble.textContent = msg.text || ''; // Make sure text is never null/undefined

            // Basic error check for bot messages
            if (!isUser && (msg.text.toLowerCase().startsWith('error:') || msg.text.toLowerCase().startsWith('failed'))) {
                bubble.classList.add('error-message');
            }

            // Append icon and bubble to container
            container.appendChild(icon);
            container.appendChild(bubble);

            // Append container to history div
            chatHistoryDiv.appendChild(container);
        });
        chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight; // Scroll after adding all
        console.log('[WebviewView] History rendering complete.');
    } catch (e) {
        console.error('[WebviewView] Error during renderHistory:', e);
        chatHistoryDiv.innerHTML = '<div class="message bot-message" style="color:red;">Error rendering chat history.</div>';
        localChatHistory = [];
    }
}

 // --- Restore State on Load ---
const initialState = vscode.getState() || { history: [] };
console.log('[WebviewView] Initial state:', initialState);
renderHistory(initialState.history);

// --- Event Listeners ---
sendButton.addEventListener('click', () => {
    const messageText = messageInput.value;
    if (messageText.trim()) {
        const userMessage = { role: 'user', text: messageText };
        localChatHistory.push(userMessage);
        renderHistory(localChatHistory);
        vscode.setState({ history: localChatHistory });

        console.log('[WebviewView] Sending message to extension:', messageText);
        vscode.postMessage({ command: 'sendMessage', text: messageText });
        messageInput.value = '';
    }
});

messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendButton.click();
    }
});

window.addEventListener('message', (event) => {
    const message = event.data;
    console.log('[WebviewView] Received message from extension:', message);
    try {
        switch (message.command) {
            case 'addBotMessage':
                // Add bot message and update state
                const botMessage = { role: 'bot', text: message.text };
                localChatHistory.push(botMessage);
                renderHistory(localChatHistory); // Re-render
                vscode.setState({ history: localChatHistory }); // Save state
                break;
            // case 'updateServerStatus': // Status hidden for now
            //     if (statusDiv) {
            //          statusDiv.textContent = message.text;
            //          statusDiv.className = 'server-status';
            //          if (message.status === 'connected') statusDiv.classList.add('connected');
            //          else if (message.status === 'processing' || message.status === 'connecting') statusDiv.classList.add('processing');
            //          else statusDiv.classList.add('disconnected');
            //     }
            //     break;
            case 'syncHistory':
                if(message.history) {
                    renderHistory(message.history);
                    vscode.setState({ history: message.history });
                }
                break;
        }
    } catch(e) {
        console.error('[WebviewView] Error processing message from extension:', message, e);
    }
});

// --- End of media/chatView.js --- 