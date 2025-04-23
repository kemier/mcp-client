/* eslint-disable @typescript-eslint/naming-convention */
// This script will run in the context of the webview
console.log("[WebviewView] chatView.js script started");

// --- Globally acquire the VS Code API ---
const vscode = acquireVsCodeApi();
console.log("[WebviewView] VS Code API acquired.");

const sendButton = document.getElementById('send-button');
const messageInput = document.getElementById('message-input');
const chatHistoryDiv = document.getElementById('chat-history');
const newChatButton = document.getElementById('new-chat-button'); // Get reference to the new button
const sessionListUl = document.getElementById('session-list'); // Get session list UL element
// const statusDiv = document.getElementById('server-status'); // Status hidden for now

// --- Get references once (more robust) ---
const msgInput = document.getElementById('message-input');
const sndButton = document.getElementById('send-button');
// ----------------------------------------

// --- Explicitly clear input on load --- 
if (messageInput) {
    messageInput.value = '';
    console.log('[WebviewView] Input field explicitly cleared on load.');
}
// --------------------------------------

let localChatHistory = [];
let currentSessionList = []; // Cache the session list
let currentActiveSessionId = null; // Cache the active session ID
let currentStreamingMessageElement = null; // <<--- Initialize here

// --- Function to clean LLM think tags and content ---
function cleanLLMOutput(text) {
    // Remove <think>...</think> blocks including content, handling multi-line and greedy matching prevention
    // Also remove potential JSON fragments often paired with </think>
    let cleaned = (text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    // Experimental: Attempt to remove common JSON fragment patterns near end-think tags
    cleaned = cleaned.replace(/<\/think>\s*(?:"?json"?|{)?/g, '');
    // Explicitly remove the observed problematic pattern if it somehow remains
    cleaned = cleaned.replace(/<\/think>\s*<think>/g, ''); 
    // Remove standalone think tags as well
    cleaned = cleaned.replace(/<\/?think>/g, '');
    return cleaned.trim();
}

// --- Refactored: DOM Manipulation for Streaming ---

// Threshold for collapsing long messages (e.g., lines or characters)
const COLLAPSE_THRESHOLD_LINES = 10;
const COLLAPSE_THRESHOLD_CHARS = 500; // Optional character limit

// Helper to create a message element (user or assistant)
function createMessageElement(role, textContent) {
    const isUser = role === 'user';
    const isAssistant = role === 'assistant';
    const isTool = role === 'tool';
    const isSystemBot = role === 'bot'; // Keep for system messages

    // REMOVED: cleanLLMOutput is not defined here
    // const cleanedText = (textContent || '').replace(/<\/?think>/g, '').trim(); 
    const cleanedText = cleanLLMOutput(textContent); // <<--- USE THE CLEANING FUNCTION

    const container = document.createElement('div');
    container.className = 'message-container ';
    if (isUser) container.classList.add('user-message');
    else if (isTool) container.classList.add('bot-message', 'tool-message');
    else /* assistant or system bot */ container.classList.add('bot-message');

    // Create Icon
    const icon = document.createElement('div');
    icon.className = 'message-icon';
    icon.textContent = isUser ? '👤' : (isTool ? '🛠️' : '🤖');

    // Create Bubble
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    // Check if the message needs collapsing
    const lines = cleanedText.split('\n').length;
    const needsCollapsing = isAssistant && (lines > COLLAPSE_THRESHOLD_LINES || cleanedText.length > COLLAPSE_THRESHOLD_CHARS);

    // Always create the content div
    const messageContent = document.createElement('div');
    messageContent.className = 'message-content'; 
    messageContent.textContent = cleanedText;
    bubble.appendChild(messageContent);

    if (needsCollapsing) {
        bubble.classList.add('collapsible', 'collapsed'); // Add 'collapsed' class initially

        // Create toggle button
        const toggleButton = document.createElement('button');
        toggleButton.className = 'toggle-button';
        toggleButton.textContent = 'Show more...';
        toggleButton.onclick = (event) => {
            event.stopPropagation(); // Prevent container click event if any
            const isCollapsed = bubble.classList.contains('collapsed');
            if (isCollapsed) {
                bubble.classList.remove('collapsed');
                toggleButton.textContent = 'Show less...';
            } else {
                bubble.classList.add('collapsed');
                toggleButton.textContent = 'Show more...';
            }
        };
        // Append button AFTER the content, within the bubble
        bubble.appendChild(toggleButton);
    }

    // Basic error styling (can be refined)
    if (!isUser && !isTool && (cleanedText.toLowerCase().startsWith('[error') || cleanedText.toLowerCase().startsWith('error:'))) {
        bubble.classList.add('error-message');
    }
    if (isTool) {
        bubble.style.fontFamily = 'monospace';
        bubble.style.opacity = '0.8';
    }

    container.appendChild(icon);
    container.appendChild(bubble);
    return container;
}

// --- Original Render History (clears and redraws ALL) ---
function renderHistory(historyArray) {
    // --- Add Log ---
    console.log('[WebviewView] >>> renderHistory FUNCTION CALLED <<<');
    // ---------------
    try {
        console.log('[WebviewView] renderHistory called (Full Redraw).');
        chatHistoryDiv.innerHTML = ''; // Clear current display
        currentStreamingMessageElement = null; // <<<--- RESET STREAMING ELEMENT HERE

        if (!historyArray || !Array.isArray(historyArray) || historyArray.length === 0) {
            console.log('[WebviewView] History array empty or invalid.');
            localChatHistory = [];
            return;
        }

        console.log('[WebviewView] Rendering history with ' + historyArray.length + ' messages.');
        localChatHistory = historyArray; // Update local cache

        historyArray.forEach((msg, index) => {
            if (!msg || !msg.role) {
                console.warn('[WebviewView] Skipping invalid message in history:', msg);
                return; // Skip invalid messages
            }

            // Determine text based on role (user/assistant/tool/bot)
            let textContent = '';
            if (msg.role === 'user' && typeof msg.content === 'string') {
                textContent = msg.content;
            } else if (msg.role === 'assistant') {
                if (typeof msg.content === 'string') { textContent = msg.content; }
                else if (msg.tool_calls) { textContent = `[Requesting tools: ${JSON.stringify(msg.tool_calls)}]`; }
                else { textContent = '[Assistant message]'; } // Placeholder if content is null (but not tools)
            } else if (msg.role === 'tool') {
                if (typeof msg.content === 'string') { 
                    try {
                        // Attempt to parse and re-stringify for consistent formatting
                        const parsedContent = JSON.parse(msg.content);
                        textContent = `[Tool Results: ${JSON.stringify(parsedContent, null, 2)}]`; // Pretty print JSON
                    } catch (e) {
                        // If parsing fails, show the raw string content
                        textContent = `[Tool Results: ${msg.content}]`; 
                        console.warn('[WebviewView] Failed to parse tool result content as JSON, showing raw:', msg.content);
                    }
                } 
                else { textContent = '[Tool message]'; } // Fallback
            } else if (msg.role === 'bot' && typeof msg.text === 'string') {
                textContent = msg.text; // System message
            } else {
                 console.warn('[WebviewView] Skipping message with unhandled role/structure in renderHistory:', msg);
                 return;
            }

            const messageElement = createMessageElement(msg.role, textContent);
            chatHistoryDiv.appendChild(messageElement);
        });
        // chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight; // Scroll after adding all
        setTimeout(() => { // Scroll after DOM update
            chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;
        }, 0);
        console.log('[WebviewView] History rendering complete.');
    } catch (e) {
        console.error('[WebviewView] Error during renderHistory:', e);
        chatHistoryDiv.innerHTML = '<div class="message bot-message" style="color:red;">Error rendering chat history.</div>';
        localChatHistory = [];
    }
}

// --- Function to Append/Update Last Assistant Message --- 
// Keep track of the currently streaming message element
function appendAssistantChunk(chunk) {
    console.log('Appending assistant chunk', chunk);
    // Use the new cleaning function
    const cleanedChunk = cleanLLMOutput(chunk); 
    if (cleanedChunk === null || cleanedChunk === undefined || cleanedChunk === '') { // Check for empty string *after* cleaning
        console.log('Received empty or null chunk after cleaning, skipping.');
        return; // Do nothing if the cleaned chunk is empty
    }

    // Check if we are already streaming a message
    if (currentStreamingMessageElement) {
        // Find the bubble within the existing element
        const bubble = currentStreamingMessageElement.querySelector('.message-bubble');
        if (bubble) {
            // Append the new cleaned chunk to the existing content
            bubble.textContent += cleanedChunk; 
        } else {
             console.error("Could not find message bubble in current streaming element!");
             // Fallback: create a new element (shouldn't happen ideally)
             currentStreamingMessageElement = null; 
        }
    } 
    
    // If not currently streaming, create a new message element
    if (!currentStreamingMessageElement) {
        // Create a new assistant message element with the first chunk
        currentStreamingMessageElement = createMessageElement('assistant', cleanedChunk);
        chatHistoryDiv.appendChild(currentStreamingMessageElement);
    }

    // Scroll to bottom to keep the latest chunk visible
    // chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;
    setTimeout(() => { // Scroll after DOM update
        chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;
    }, 0);
    
    // REMOVED: Don't update localChatHistory here, let syncHistory handle the final state.
    // REMOVED: Don't call updateChatContainer()
    // REMOVED: Don't call saveHistoryState() here, state saved on syncHistory
}

// --- Function to Render Session List ---
function renderSessionList(sessions, activeSessionId) {
    console.log('[WebviewView] renderSessionList called.', { sessionCount: sessions?.length, activeId: activeSessionId });
    if (!sessionListUl || !Array.isArray(sessions)) {
        console.error('[WebviewView] Session list element not found or invalid sessions data.');
        return;
    }

    sessionListUl.innerHTML = ''; // Clear current list
    currentSessionList = sessions; // Update cache
    currentActiveSessionId = activeSessionId; // <-- Update active ID cache

    sessions.forEach(session => {
        const li = document.createElement('li');
        li.className = 'session-item';
        li.textContent = session.title || 'Chat'; // Default title if needed
        li.dataset.sessionId = session.id;

        if (session.id === activeSessionId) {
            li.classList.add('active-session');
        }

        li.addEventListener('click', () => {
            const sessionId = li.dataset.sessionId;
            if (sessionId && sessionId !== currentActiveSessionId) {
                console.log(`[WebviewView] Session item clicked, requesting switch to: ${sessionId}`);
                vscode.postMessage({ command: 'switchSession', sessionId: sessionId });
                // Optionally provide visual feedback immediately, e.g., spinner
            } else if (sessionId === currentActiveSessionId) {
                 console.log(`[WebviewView] Clicked on already active session: ${sessionId}`);
            }
        });

        sessionListUl.appendChild(li);
    });
    console.log('[WebviewView] Session list rendering complete.');
}

// --- VS Code Communication ---

window.addEventListener('message', event => {
    const message = event.data; // The JSON data VS Code sent
    console.log('Message received from extension:', message);

    // Ensure we have references (might need to re-get if not global)
    const msgInput = document.getElementById('message-input');
    const sndButton = document.getElementById('send-button');

    switch (message.command) {
        case 'syncHistory':
            // --- Add Log ---
            console.log('[WebviewView] >>> Received syncHistory command <<<'); 
            // ---------------
            currentStreamingMessageElement = null; // Reset streaming element on history sync
            currentActiveSessionId = message.localSessionId;
            localChatHistory = message.history || [];
            console.log(`[WebviewView] History synced for session ${currentActiveSessionId}:`, localChatHistory);
            renderHistory(localChatHistory); // Re-render the DOM from the final history
            // REMOVED: saveHistoryState is not defined
            // saveHistoryState(); 
            break;
        case 'addBotMessageChunk':
            // <-- Check if chunk belongs to the currently active session
            if (message.localSessionId !== currentActiveSessionId) {
                console.warn(`[WebviewView] Discarding chunk for inactive session ${message.localSessionId} (active: ${currentActiveSessionId})`);
                return; // Ignore chunk if it doesn't match the active session
            }
            // Pass the actual text content to appendAssistantChunk
            appendAssistantChunk(message.text); // <-- Use message.text
            break;
        case 'addBotMessage':
             // Ensure message is for the active session
            if (message.sessionId !== currentActiveSessionId) {
                console.warn(`[WebviewView] Discarding addBotMessage for inactive session ${message.sessionId} (active: ${currentActiveSessionId})`);
                return;
            }
            console.log(`[WebviewView] Adding complete bot message for session ${message.sessionId}`);
            // Stop any current streaming
            currentStreamingMessageElement = null; 
            // Create and append the new message element
            const botMessageElement = createMessageElement('bot', message.text);
            chatHistoryDiv.appendChild(botMessageElement);
            // Scroll to bottom AGAIN after appending
            setTimeout(() => { 
                chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight; 
                console.log('[WebviewView] Scrolled to bottom after adding bot message.');
            }, 0);
            break;
        case 'updateProcessingStatus':
            console.log(`[WebviewView] Received updateProcessingStatus: ${message.text}`);
            const isProcessing = message.text && message.text.trim() !== '';
            if (msgInput) {
                msgInput.disabled = isProcessing;
                console.log(`[WebviewView] msgInput.disabled set to: ${msgInput.disabled}`);
                // --- Set focus if enabling ---
                if (!isProcessing) {
                    msgInput.focus();
                    console.log(`[WebviewView] Attempted to set focus to msgInput.`);
                }
            }
            if (sndButton) {
                sndButton.disabled = isProcessing;
                console.log(`[WebviewView] sndButton.disabled set to: ${sndButton.disabled}`);
                // --- Change button text based on state ---
                sndButton.textContent = isProcessing ? 'Sending...' : 'Send'; 
            }
            break;
        case 'setUserInput':
            if (msgInput) {
                msgInput.value = message.text;
            }
            break;
        case 'clearChat':
            currentStreamingMessageElement = null; // Reset streaming element on clear
            localChatHistory = [];
            renderHistory(localChatHistory); // Re-render the DOM (now empty)
            // REMOVED: saveHistoryState is not defined
            // saveHistoryState(); 
            break;
        case 'showError':
            showError(message.text);
            break;
        case 'syncSessionList':
            if (message.sessions && message.activeSessionId) {
                // <-- Update active session ID when list syncs too
                currentActiveSessionId = message.activeSessionId;
                renderSessionList(message.sessions, message.activeSessionId);
            }
            break;
    }
});

// --- Initial Setup ---
// REMOVED: Attempt to restore state when the script loads - rely on syncHistory instead.
// restoreHistoryState(); 

// --- Add event listeners ---

// REMOVED: This block is being replaced by the listeners added inside DOMContentLoaded
// // Handle sending messages
// sendButton.addEventListener('click', sendMessage);
// messageInput.addEventListener('keydown', function (e) {
//     if (e.key === 'Enter') {
//         if (!e.shiftKey) {
//             e.preventDefault();
//             sendMessage();
//         }
//     }
// });
// 
// // Handle "New Chat" button click
// newChatButton.addEventListener('click', () => {
//     console.log("[WebviewView] New Chat button clicked");
//     // Tell the extension to create a new chat session
//     vscode.postMessage({ command: 'newChat' });
//     // Optionally clear the input field immediately
//     messageInput.value = ''; 
// });

// --- Helper Functions (Keep sendMessage etc.) ---
// REMOVED: sendMessage is replaced by handleSend
// function sendMessage() { ... }

// Request initial state when webview is ready (optional, but good practice)
// This tells the extension "I'm ready, send me the current data"
// Do this AFTER setting up the message listener

// REMOVE this call - vscode is not defined globally here anymore
// vscode.postMessage({ command: 'webviewReady' }); 
console.log("[WebviewView] Script loaded. Waiting for DOMContentLoaded to set up listeners and request state.");

// --- DOMContentLoaded Listener Block (KEEP THIS) ---
window.addEventListener('DOMContentLoaded', (event) => {
    console.log('[WebviewView] DOM loaded. Finding elements...');
    // REMOVED: const vscode = acquireVsCodeApi(); - It's now global

    const chatInput = document.getElementById('message-input'); // <-- CHANGE ID HERE
    const sendButton = document.getElementById('send-button');
    const newChatButton = document.getElementById('new-chat-button');

    // --- DEBUG LOGS (KEEP THESE LISTENERS) ---
    if (sendButton) {
        const sendButtonStyle = window.getComputedStyle(sendButton);
        console.log(`[WebviewView] Send button found. Pointer Events: ${sendButtonStyle.pointerEvents}. Adding listener.`);
        // Use simple anonymous function for test
        sendButton.addEventListener('click', () => { 
            console.log('[WebviewView] *** Send Button Clicked ***');
            handleSend(vscode);
        });
    } else {
        console.error('[WebviewView] Send button NOT found!');
    }
    if (newChatButton) {
        const newChatButtonStyle = window.getComputedStyle(newChatButton);
        console.log(`[WebviewView] New Chat button found. Pointer Events: ${newChatButtonStyle.pointerEvents}. Adding listener.`);
        // Use simple anonymous function for test
        newChatButton.addEventListener('click', () => {
            console.log('[WebviewView] *** New Chat Button Clicked ***');
            handleNewChat(vscode);
        }); 
    } else {
        console.error('[WebviewView] New Chat button NOT found!');
    }
    if (chatInput) {
        console.log('[WebviewView] Chat input found. Adding keydown listener.');
        chatInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                console.log('[WebviewView] *** Enter Key Pressed in Input ***');
                handleSend(vscode); // Pass vscode (it's global now, but passing is fine)
            }
        });
    } else {
         console.error('[WebviewView] Chat input (ID: message-input) NOT found!'); // <-- CHANGE ID HERE (in error log)
    }
    console.log('[WebviewView] Initial setup complete.');

    // Request initial state AFTER setting up listeners
    vscode.postMessage({ command: 'requestState' }); 
    console.log("[WebviewView] DOM ready, requesting initial state.");

}); // END of DOMContentLoaded

// --- Function definitions (KEEP THESE) ---
// Ensure handleSend and handleNewChat are defined correctly, accepting vscode
function handleSend(vscode) { 
     console.log('[WebviewView] handleSend function executing...');
     if (!msgInput) { 
        console.error('[WebviewView] handleSend: Chat input (ID: message-input) not found!');
        return;
    }
    const text = msgInput.value.trim();
    if (text) {
        console.log(`[WebviewView] handleSend: Sending message (Session: ${currentActiveSessionId}):`, text);
        
        // --- Disable input ---
        if(msgInput) msgInput.disabled = true;
        if(sndButton) {
             sndButton.disabled = true;
             sndButton.textContent = 'Sending...'; // Also change text here
        }

        // --- Optimistically add user message to UI --- 
        const userMessageElement = createMessageElement('user', text);
        chatHistoryDiv.appendChild(userMessageElement);
        setTimeout(() => { chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight; }, 0);
        // -------------------------------------------

        // --- Send to extension --- 
        vscode.postMessage({
            command: 'sendMessage',
            text: text,
            localSessionId: currentActiveSessionId
        });
        msgInput.value = ''; // Clear input AFTER sending
    } else {
        console.log('[WebviewView] handleSend: No text to send.');
    }
}

function handleNewChat(vscode) { 
    console.log('[WebviewView] handleNewChat function executing...');
    const chatInput = document.getElementById('message-input'); // <-- CHANGE ID HERE
     // ... rest of handleNewChat logic
    if (chatInput) {
         chatInput.value = ''; // Clear the input field
    }
    localChatHistory = []; // Clear local history representation
    renderHistory(); // Clear the display
    currentActiveSessionId = null; // Reset active session ID locally until synced
    console.log('[WebviewView] Posting newChat command to extension.');
    vscode.postMessage({ command: 'newChat' });
}

// ... other functions like renderHistory etc. ... 