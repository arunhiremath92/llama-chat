/**
 * Obsidian Frost Chat UI Controller
 * State-driven vanilla JavaScript client for local Llama chat.
 */

// Application State
const state = {
    username: "",
    sessions: [],
    activeSessionFilename: "",
    messages: [],
    isGenerating: false
};

// Markdown Engine Instance
let md = null;
window.addEventListener('DOMContentLoaded', () => {
    if (window.markdownit) {
        md = window.markdownit({
            html: false,
            linkify: true,
            typographer: true,
            breaks: true
        });
    }
    initModelSelector();
});

// DOM Cache Elements
const els = {
    // Setup / Auth
    usernameInput: document.getElementById("username-input"),
    btnSetUser: document.getElementById("btn-set-user"),
    btnLogout: document.getElementById("btn-logout"),
    userSetupPanel: document.getElementById("user-setup-panel"),
    userProfilePanel: document.getElementById("user-profile-panel"),
    displayUsername: document.getElementById("display-username"),
    userAvatar: document.getElementById("user-avatar"),

    // Sessions
    btnNewChat: document.getElementById("btn-new-chat"),
    sessionsList: document.getElementById("sessions-list"),

    // Chat Header
    chatTitle: document.getElementById("chat-title"),
    chatSubtitle: document.getElementById("chat-subtitle"),
    summaryBox: document.getElementById("summary-box"),
    summaryText: document.getElementById("summary-text"),

    // Messages Board
    messagesContainer: document.getElementById("messages-container"),
    welcomeScreen: document.getElementById("welcome-screen"),

    // Inputs & Forms
    messageForm: document.getElementById("message-form"),
    messageInput: document.getElementById("message-input"),
    btnSubmit: document.getElementById("btn-submit"),
    modelSelect: document.getElementById("model-select"),

    // Memory Vault UI elements
    btnShowMemories: document.getElementById("btn-show-memories"),
    memoryModal: document.getElementById("memory-modal"),
    btnCloseMemoryModal: document.getElementById("btn-close-memory-modal"),
    memoryList: document.getElementById("memory-list")
};

// LocalStorage Helpers to remember username
const STORAGE_KEY = "llama_chat_username";
const savedUsername = localStorage.getItem(STORAGE_KEY);
if (savedUsername) {
    els.usernameInput.value = savedUsername;
}

// Initialize Event Handlers
els.btnSetUser.addEventListener("click", () => handleConnectUser());
els.usernameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleConnectUser();
});
els.btnLogout.addEventListener("click", () => handleDisconnectUser());
els.btnNewChat.addEventListener("click", () => handleCreateNewSession());
els.btnShowMemories.addEventListener("click", () => handleOpenMemoryModal());
els.btnCloseMemoryModal.addEventListener("click", () => handleCloseMemoryModal());
els.memoryModal.querySelector(".modal-backdrop").addEventListener("click", () => handleCloseMemoryModal());

// Auto-resizing textarea to avoid scrollbar clutter
els.messageInput.addEventListener("input", function () {
    this.style.height = "auto";
    const newHeight = Math.min(this.scrollHeight, 180);
    this.style.height = `${newHeight}px`;
});

els.messageForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSendMessage();
});

// Enter key sends the message, Shift+Enter starts a new line
els.messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        els.messageForm.requestSubmit();
    }
});


/* ==========================================================================
   Core Event Actions
   ========================================================================== */

/**
 * Log in the user and load their session catalog.
 */
async function handleConnectUser() {
    const rawVal = els.usernameInput.value.trim();
    if (!rawVal) return;

    state.username = rawVal;
    localStorage.setItem(STORAGE_KEY, state.username);

    // Switch login panel to active profile panel
    els.userSetupPanel.classList.add("hidden");
    els.userProfilePanel.classList.remove("hidden");
    els.displayUsername.textContent = state.username;
    els.userAvatar.textContent = state.username.substring(0, 2).toUpperCase();

    // Enable core action controls
    els.btnNewChat.disabled = false;
    els.messageInput.disabled = false;
    els.btnSubmit.disabled = false;
    els.btnShowMemories.disabled = false;

    // Load and render existing sessions
    await loadSessionsCatalog();
}

/**
 * Log out and clear state.
 */
function handleDisconnectUser() {
    state.username = "";
    state.sessions = [];
    state.activeSessionFilename = "";
    state.messages = [];

    localStorage.removeItem(STORAGE_KEY);

    // Hide controls and clear message boards
    els.userSetupPanel.classList.remove("hidden");
    els.userProfilePanel.classList.add("hidden");

    els.btnNewChat.disabled = true;
    els.messageInput.disabled = true;
    els.btnSubmit.disabled = true;
    els.btnShowMemories.disabled = true;

    els.sessionsList.innerHTML = `<div class="sessions-placeholder">Connect to load your chats</div>`;
    els.welcomeScreen.classList.remove("hidden");
    els.summaryBox.classList.add("hidden");
    els.chatTitle.textContent = "Welcome to LlamaWorkspace";
    els.chatSubtitle.textContent = "Create or select a conversation from the sidebar to begin.";

    // Clear chat board
    const bubbles = els.messagesContainer.querySelectorAll(".message");
    bubbles.forEach(b => b.remove());
}

/**
 * Ask backend to create a brand new session file.
 */
async function handleCreateNewSession() {
    if (!state.username || state.isGenerating) return;

    try {
        const response = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: state.username })
        });

        if (!response.ok) throw new Error("Failed to create session");

        const data = await response.json();
        const newFilename = data.filename;

        // Refresh catalog, select new filename
        await loadSessionsCatalog();
        await handleSelectSession(newFilename);
    } catch (e) {
        console.error(e);
        alert("Could not start a new session. Ensure Ollama is running locally.");
    }
}

/**
 * Load list of recent user sessions from disk and draw them in sidebar.
 */
async function loadSessionsCatalog() {
    if (!state.username) return;

    try {
        const res = await fetch(`/api/sessions?username=${encodeURIComponent(state.username)}`);
        if (!res.ok) throw new Error("Failed to load catalog");

        state.sessions = await res.json();
        renderSessionsCatalog();
    } catch (e) {
        console.error(e);
    }
}

/**
 * Render catalog list in the sidebar.
 */
function renderSessionsCatalog() {
    els.sessionsList.innerHTML = "";

    if (state.sessions.length === 0) {
        els.sessionsList.innerHTML = `<div class="sessions-placeholder">No active conversations.<br>Click "New Conversation" above!</div>`;
        return;
    }

    state.sessions.forEach(session => {
        const item = document.createElement("div");
        item.className = `session-item ${session.filename === state.activeSessionFilename ? 'active' : ''}`;
        item.dataset.filename = session.filename;

        // Truncate the summary or fallback message
        let snippet = session.summary ? session.summary : session.last_message;
        if (snippet.startsWith("Here is the updated summary:") || snippet.startsWith("Here is a concise summary:")) {
            snippet = snippet.split("\n\n").slice(1).join(" ") || snippet;
        }
        // Remove markdown tags from snippet for cleaner card looks
        snippet = snippet.replace(/[#*`_\[\]]/g, "");

        item.innerHTML = `
            <div class="session-card-info">
                <div class="session-card-header">
                    <span class="session-date">${session.formatted_time}</span>
                    <span class="session-count">${session.message_count} msgs</span>
                </div>
                <div class="session-summary-snippet">${snippet}</div>
            </div>
            <button class="btn-delete-session btn-icon" title="Delete Session" aria-label="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            </button>
        `;

        // Clicking card selects it
        item.addEventListener("click", (e) => {
            if (e.target.closest(".btn-delete-session")) return; // ignore if delete clicked
            handleSelectSession(session.filename);
        });

        // Deleting card
        const btnDel = item.querySelector(".btn-delete-session");
        btnDel.addEventListener("click", (e) => {
            e.stopPropagation();
            handleDeleteSession(session.filename);
        });

        els.sessionsList.appendChild(item);
    });
}

/**
 * Handle session selection. Loads files and draws message bubbles.
 */
async function handleSelectSession(filename) {
    if (state.isGenerating) return;

    state.activeSessionFilename = filename;

    // Highlight selected in sidebar catalog immediately
    const items = els.sessionsList.querySelectorAll(".session-item");
    items.forEach(el => {
        el.classList.toggle("active", el.dataset.filename === filename);
    });

    try {
        const res = await fetch(`/api/sessions/${filename}?username=${encodeURIComponent(state.username)}`);
        if (!res.ok) throw new Error("Failed to load session content");

        const data = await res.json();
        state.messages = data.messages || [];
        const summary = data.summarized_context || "";

        // Draw the main header details
        const selected = state.sessions.find(s => s.filename === filename);
        if (selected) {
            els.chatTitle.textContent = `Session — ${selected.formatted_time}`;
            els.chatSubtitle.textContent = `Ollama Local Llama Workspace`;
        }

        // Draw summary if it exists
        if (summary) {
            els.summaryBox.classList.remove("hidden");
            // clean up summary formatting if needed
            let cleanSummary = summary;
            if (cleanSummary.includes("Here is the updated summary:") || cleanSummary.includes("Here is a concise summary:")) {
                cleanSummary = cleanSummary.split("\n\n").slice(1).join(" ") || cleanSummary;
            }
            els.summaryText.textContent = cleanSummary;
        } else {
            els.summaryBox.classList.add("hidden");
        }

        // Clear old message bubbles
        els.welcomeScreen.classList.add("hidden");
        const bubbles = els.messagesContainer.querySelectorAll(".message");
        bubbles.forEach(b => b.remove());

        // Render current list of loaded messages
        // Don't render system instructions
        state.messages.forEach(msg => {
            if (msg.role !== "system") {
                appendMessageBubble(msg.role, msg.content);
            }
        });

        scrollToBottom();
        els.messageInput.focus();
    } catch (e) {
        console.error(e);
    }
}

/**
 * Ask backend to delete a session file.
 */
async function handleDeleteSession(filename) {
    if (state.isGenerating) return;

    const confirmDel = confirm("Are you sure you want to delete this conversation?");
    if (!confirmDel) return;

    try {
        const res = await fetch(`/api/sessions/${filename}?username=${encodeURIComponent(state.username)}`, {
            method: "DELETE"
        });

        if (!res.ok) throw new Error("Failed to delete session");

        // If the active session was deleted, clean up board
        if (state.activeSessionFilename === filename) {
            state.activeSessionFilename = "";
            state.messages = [];

            els.welcomeScreen.classList.remove("hidden");
            els.summaryBox.classList.add("hidden");
            els.chatTitle.textContent = "Welcome to LlamaWorkspace";
            els.chatSubtitle.textContent = "Create or select a conversation from the sidebar to begin.";

            const bubbles = els.messagesContainer.querySelectorAll(".message");
            bubbles.forEach(b => b.remove());
        }

        // Refresh catalog list
        await loadSessionsCatalog();
    } catch (e) {
        console.error(e);
    }
}

/**
 * Send user message and read real-time stream reply.
 */
async function handleSendMessage() {
    const text = els.messageInput.value.trim();
    if (!text || state.isGenerating || !state.activeSessionFilename) return;

    // Clear textarea and reset scale height
    els.messageInput.value = "";
    els.messageInput.style.height = "auto";

    // Disable inputs while generating to prevent race conditions
    state.isGenerating = true;
    els.messageInput.disabled = true;
    els.btnSubmit.disabled = true;

    // Render user message bubble locally
    appendMessageBubble("user", text);
    scrollToBottom();

    // Render placeholder generating bubble for assistant
    const assistantBubble = appendMessageBubble("assistant", "", true);
    scrollToBottom();

    let completeText = "";

    try {
        const response = await fetch(`/api/sessions/${state.activeSessionFilename}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: state.username,
                message: text
            })
        });

        if (!response.ok) throw new Error("Failed to fetch stream");

        // Stream reading logic over HTTP POST using ReadableStream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); // keep incomplete line in buffer

            for (let line of lines) {
                line = line.trim();
                if (line.startsWith("data: ")) {
                    try {
                        const parsed = JSON.parse(line.substring(6));

                        if (parsed.token) {
                            completeText += parsed.token;
                            // Incremental markdown rendering
                            assistantBubble.querySelector(".msg-text").innerHTML = renderMarkdown(completeText);
                            scrollToBottom();
                        }

                        if (parsed.error) {
                            throw new Error(parsed.error);
                        }

                        if (parsed.done) {
                            if (parsed.session_closed) {
                                // Insert closing badge
                                const badge = document.createElement("div");
                                badge.className = "msg-tag tag-closed";
                                badge.textContent = "Session Terminated by Assistant";
                                assistantBubble.querySelector(".msg-bubble").appendChild(badge);
                            }
                        }
                    } catch (err) {
                        console.error("Error parsing SSE line:", line, err);
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
        assistantBubble.querySelector(".msg-text").innerHTML = `<span style="color: var(--accent-red)">Error: Could not generate response. Verify Ollama service state.</span>`;
    } finally {
        state.isGenerating = false;
        els.messageInput.disabled = false;
        els.btnSubmit.disabled = false;

        // Remove generation text blinking caret class
        assistantBubble.classList.remove("generating");

        // Refresh catalog to load new summaries or message counts
        await loadSessionsCatalog();

        // If we are still looking at the active session, reload details to update the summary box
        if (state.activeSessionFilename) {
            await reloadActiveSessionMetadata();
        }

        els.messageInput.focus();
    }
}

/**
 * Reload active session quietly to get updated summaries after conversation turns.
 */
async function reloadActiveSessionMetadata() {
    try {
        const res = await fetch(`/api/sessions/${state.activeSessionFilename}?username=${encodeURIComponent(state.username)}`);
        if (!res.ok) return;
        const data = await res.json();

        const summary = data.summarized_context || "";
        if (summary) {
            els.summaryBox.classList.remove("hidden");
            let cleanSummary = summary;
            if (cleanSummary.includes("Here is the updated summary:") || cleanSummary.includes("Here is a concise summary:")) {
                cleanSummary = cleanSummary.split("\n\n").slice(1).join(" ") || cleanSummary;
            }
            els.summaryText.textContent = cleanSummary;
        } else {
            els.summaryBox.classList.add("hidden");
        }
    } catch (e) {
        console.error(e);
    }
}


/* ==========================================================================
   UI View Modifiers
   ========================================================================== */

/**
 * Helper to construct and insert a message bubble.
 */
function appendMessageBubble(role, content, isGenerating = false) {
    const msg = document.createElement("div");
    msg.className = `message ${role} ${isGenerating ? 'generating' : ''}`;

    const avatarChar = role === "user" ? state.username.substring(0, 1).toUpperCase() : "🦙";

    msg.innerHTML = `
        <div class="msg-avatar">${avatarChar}</div>
        <div class="msg-bubble">
            <div class="msg-text">${renderMarkdown(content)}</div>
        </div>
    `;

    els.messagesContainer.appendChild(msg);
    return msg;
}

/**
 * Secure markdown content parser. Fallback if CDN fails.
 */
function renderMarkdown(text) {
    if (!text) return "";
    if (md) {
        return md.render(text);
    }
    // Simple basic HTML sanitizer if markdown library fails to load
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
}

/**
 * Auto scroll messages list window.
 */
function scrollToBottom() {
    els.messagesContainer.scrollTop = els.messagesContainer.scrollHeight;
}

/**
 * Dynamic Model Selection Initialization
 * Fetches the supported model list and current model from the FastAPI server,
 * populates the dropdown selection, and hooks changes to synchronize back to the backend.
 */
async function initModelSelector() {
    try {
        // Fetch supported models
        const resModels = await fetch("/api/supported-models");
        if (!resModels.ok) throw new Error("Failed to fetch supported models");
        const models = await resModels.json();
        
        // Fetch current active model
        const resCurrent = await fetch("/api/current-model");
        if (!resCurrent.ok) throw new Error("Failed to fetch current active model");
        const currentModel = await resCurrent.json();
        
        // Clear option container
        if (els.modelSelect) {
            els.modelSelect.innerHTML = "";
            models.forEach(model => {
                const opt = document.createElement("option");
                opt.value = model;
                opt.textContent = model;
                if (model === currentModel) {
                    opt.selected = true;
                }
                els.modelSelect.appendChild(opt);
            });
            
            // Watch for selection changes to update global state
            els.modelSelect.addEventListener("change", async (e) => {
                const newModel = e.target.value;
                try {
                    const putRes = await fetch("/api/current-model", {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(newModel)
                    });
                    
                    if (!putRes.ok) throw new Error("Server rejected model update request");
                    console.log(`Active LLM Model synchronized successfully to: ${newModel}`);
                } catch (err) {
                    console.error("Failed to synchronize active LLM Model to server:", err);
                    alert(`Could not change server model. Please verify Ollama connection.`);
                }
            });
        }
    } catch (e) {
        console.error("Dynamic model selection initialization failed:", e);
        if (els.modelSelect) {
            els.modelSelect.innerHTML = `<option value="">Failed to load models</option>`;
        }
    }
}

/**
 * Open Memory Vault Modal
 * Triggered by clicking the brain icon button in the sidebar.
 * Displays a loading state and calls the load function.
 */
async function handleOpenMemoryModal() {
    if (!state.username) return;
    
    els.memoryList.innerHTML = `<div class="memory-placeholder">Loading memory vault...</div>`;
    els.memoryModal.classList.remove("hidden");
    
    await loadUserMemories();
}

/**
 * Close Memory Vault Modal
 */
function handleCloseMemoryModal() {
    els.memoryModal.classList.add("hidden");
}

/**
 * Fetch and render user memories from FastAPI server
 */
async function loadUserMemories() {
    try {
        const res = await fetch(`/api/memories/${encodeURIComponent(state.username)}`);
        if (!res.ok) throw new Error("Failed to fetch memories from server");
        
        const data = await res.json();
        renderMemories(data);
    } catch (e) {
        console.error("Failed to load user memories:", e);
        els.memoryList.innerHTML = `<div class="memory-placeholder" style="color: var(--accent-red)">Error loading memory vault. Make sure the database and server are active.</div>`;
    }
}

/**
 * Render list of memories inside modal body
 * Supports dynamic categorizing and deletion callbacks.
 */
function renderMemories(data) {
    els.memoryList.innerHTML = "";
    
    const ids = data.ids || [];
    const documents = data.documents || [];
    const metadatas = data.metadatas || [];
    
    if (ids.length === 0) {
        els.memoryList.innerHTML = `
            <div class="memory-placeholder">
                No persistent facts saved in your vault yet.
                <span style="font-size: 0.75rem; color: var(--text-dark); display: block; margin-top: 6px;">
                    They are automatically extracted from your chats.
                </span>
            </div>
        `;
        return;
    }
    
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const fact = documents[i];
        const meta = metadatas[i] || {};
        const category = meta.category || "General";
        
        const card = document.createElement("div");
        card.className = "memory-card";
        card.dataset.id = id;
        
        card.innerHTML = `
            <div class="memory-card-content">
                <div class="memory-fact">${fact}</div>
                <div class="memory-meta">
                    <span class="memory-category-badge">${category}</span>
                </div>
            </div>
            <button class="btn-delete-memory btn-icon" title="Forget Memory" aria-label="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            </button>
        `;
        
        const btnDel = card.querySelector(".btn-delete-memory");
        btnDel.addEventListener("click", (e) => {
            e.stopPropagation();
            handleDeleteMemory(id, fact);
        });
        
        els.memoryList.appendChild(card);
    }
}

/**
 * Request memory deletion from server with confirmation dialog
 */
async function handleDeleteMemory(id, factSnippet) {
    const truncated = factSnippet.length > 50 ? factSnippet.substring(0, 50) + "..." : factSnippet;
    const confirmForget = confirm(`Are you sure you want to forget this fact?\n"${truncated}"`);
    if (!confirmForget) return;
    
    try {
        const res = await fetch(`/api/memories/${encodeURIComponent(state.username)}/${id}`, {
            method: "DELETE"
        });
        
        if (!res.ok) throw new Error("Failed to delete memory from server");
        console.log(`Memory ${id} forgotten successfully.`);
        
        // Refresh vault
        await loadUserMemories();
    } catch (e) {
        console.error("Failed to delete memory:", e);
        alert("Failed to delete memory from database vault. Please try again.");
    }
}

