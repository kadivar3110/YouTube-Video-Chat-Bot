// ===== DOM Elements =====
const videoIdInput = document.getElementById('videoIdInput');
const loadVideoBtn = document.getElementById('loadVideoBtn');
const loadingState = document.getElementById('loadingState');
const retainSection = document.getElementById('retainSection');
const retainToggle = document.getElementById('retainToggle');
const loadedVideos = document.getElementById('loadedVideos');
const videoList = document.getElementById('videoList');
const clearAllBtn = document.getElementById('clearAllBtn');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const clearChatBtn = document.getElementById('clearChatBtn');
const headerStatus = document.getElementById('headerStatus');
const pasteBtn = document.getElementById('pasteBtn');

const API = '';  // same origin

let hasVideo = false;
let isLoading = false;

// ===== Video Loading =====
loadVideoBtn.addEventListener('click', loadVideo);
videoIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadVideo();
});

pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        // Extract video ID from full URL if needed
        const id = extractVideoId(text);
        videoIdInput.value = id;
        videoIdInput.focus();
    } catch (err) {
        // clipboard access denied
    }
});

function extractVideoId(input) {
    input = input.trim();
    // Full YouTube URL patterns
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
    ];
    for (const pattern of patterns) {
        const match = input.match(pattern);
        if (match) return match[1];
    }
    return input; // assume it's already just the ID
}

async function loadVideo() {
    const videoId = extractVideoId(videoIdInput.value.trim());
    if (!videoId || isLoading) return;

    isLoading = true;
    loadVideoBtn.disabled = true;
    loadingState.style.display = 'flex';

    const retain = hasVideo ? retainToggle.checked : false;

    try {
        const res = await fetch(`${API}/api/load_video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: videoId, retain })
        });

        const data = await res.json();

        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        hasVideo = true;
        videoIdInput.value = '';

        // If not retaining, clear old chat
        if (!data.retained) {
            clearChat();
        }

        // Update video list
        updateVideoList(data.loaded_videos);

        // Show retain toggle and clear button
        retainSection.style.display = 'block';
        clearAllBtn.style.display = 'flex';

        // Enable chat
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.placeholder = 'Ask a question about the video...';
        chatInput.focus();

        // Update header status
        updateStatus(data.loaded_videos.length);

        // Toast popup — auto-disappears
        const title = data.title || videoId;
        const msg = data.retained
            ? `Video "${title}" merged (${data.chunks} chunks). ${data.total_videos} videos loaded.`
            : `Video "${title}" loaded successfully (${data.chunks} chunks).`;
        showToast(msg, 'success');

    } catch (err) {
        showToast('Failed to connect to server. Is it running?', 'error');
    } finally {
        isLoading = false;
        loadVideoBtn.disabled = false;
        loadingState.style.display = 'none';
    }
}

function updateVideoList(videos) {
    loadedVideos.style.display = 'block';
    videoList.innerHTML = '';
    videos.forEach((vid, i) => {
        const li = document.createElement('li');
        const title = vid.title || vid.id || vid;
        const id = vid.id || vid;
        li.innerHTML = `
            <span class="video-badge">${i + 1}</span>
            <div class="video-info">
                <span class="video-title">${title}</span>
                <span class="video-id">${id}</span>
            </div>
        `;
        videoList.appendChild(li);
    });
}

function updateStatus(count) {
    const dot = headerStatus.querySelector('.status-dot');
    const text = headerStatus.querySelector('.status-text');
    dot.className = 'status-dot online';
    text.textContent = `${count} video${count > 1 ? 's' : ''} loaded`;
}

// ===== Chat =====
sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-resize textarea
chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

async function sendMessage() {
    const query = chatInput.value.trim();
    if (!query || !hasVideo) return;

    // Clear welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    // Add user message
    addMessage(query, 'user');
    chatInput.value = '';
    chatInput.style.height = 'auto';
    sendBtn.disabled = true;

    // Add typing indicator
    const typingEl = addTypingIndicator();

    try {
        const res = await fetch(`${API}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await res.json();
        typingEl.remove();

        if (data.error) {
            showToast(data.error, 'error');
        } else {
            addMessage(data.answer, 'bot');
        }
    } catch (err) {
        typingEl.remove();
        showToast('Failed to get response. Please try again.', 'error');
    } finally {
        sendBtn.disabled = false;
        chatInput.focus();
    }
}

function addMessage(text, type) {
    const div = document.createElement('div');
    div.className = `message ${type}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = type === 'bot' ? 'AI' : 'You';

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = formatMessage(text);

    div.appendChild(avatar);
    div.appendChild(content);
    chatMessages.appendChild(div);
    scrollToBottom();
}

function formatMessage(text) {
    // Basic markdown-like formatting
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code style="background:rgba(108,92,231,0.15);padding:2px 6px;border-radius:4px;font-family:JetBrains Mono,monospace;font-size:0.82em;">$1</code>')
        .replace(/\n/g, '<br>');
}

function addTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'message bot';
    div.innerHTML = `
        <div class="message-avatar">AI</div>
        <div class="message-content typing-indicator">
            <span></span><span></span><span></span>
        </div>
    `;
    chatMessages.appendChild(div);
    scrollToBottom();
    return div;
}

function addSystemMessage(text, type = '') {
    const div = document.createElement('div');
    div.className = `system-message ${type}`;
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollToBottom();
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${type === 'success' ? '✅' : '❌'}</span>
        <span class="toast-text">${message}</span>
    `;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('toast-visible');
    });

    // Auto-remove after 4 seconds
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-hiding');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

function clearChat() {
    chatMessages.innerHTML = `
        <div class="welcome-message">
            <div class="welcome-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7"></polygon>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                </svg>
            </div>
            <h3>Welcome to VidChat AI</h3>
            <p>Load a YouTube video to start chatting about its content.</p>
        </div>
    `;
}

// ===== Clear Actions =====
clearChatBtn.addEventListener('click', clearChat);

clearAllBtn.addEventListener('click', async () => {
    try {
        await fetch(`${API}/api/clear`, { method: 'POST' });
        hasVideo = false;
        retainSection.style.display = 'none';
        loadedVideos.style.display = 'none';
        clearAllBtn.style.display = 'none';
        chatInput.disabled = true;
        sendBtn.disabled = true;
        chatInput.placeholder = 'Load a video first...';

        const dot = headerStatus.querySelector('.status-dot');
        const text = headerStatus.querySelector('.status-text');
        dot.className = 'status-dot offline';
        text.textContent = 'No video loaded';

        // Clear chat
        clearChat();
        showToast('All videos and chat cleared.', 'success');
    } catch (err) {
        showToast('Failed to clear. Is server running?', 'error');
    }
});
