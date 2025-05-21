/*****************************************************************
 * dapp.js – UI layer for Cryptogram MVP  (2025-05)
 * • captcha guard (CFG-driven)           • debounce input
 * • register → copy → login              • nickname local
 * • invite accept fixed (slug/email)     • OTS verify on first open
 *****************************************************************/
import { sha256 } from './sha.js';
import { validator } from './validator.js';
window.sha256 = sha256;

await sodium.ready;
await import('./0knowledge.js');

const ok0 = window.ok0;
const {
    createAccount, authenticate, logout,
    isSession, hasPersonal,
    sendInvite, sendMessage, closeChat,
    ensureChat, getChatMessages, onIncomingWebhook,
    setNickname, verifySnapshot, utils, db, cfg: CFG
} = ok0;
const { usernameToSlug } = utils;

/* --- DOM helpers ----------------------------------------------------------- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/**
 * Displays a non-blocking Bootstrap "toast" notification.
 * @param {string} message - The message to display.
 * @param {string} type - The Bootstrap alert type (e.g., 'success', 'danger', 'info', 'warning').
 */
function showToast(message, type = 'info') {
    const toastContainer = $('#toast-container');
    if (!toastContainer) {
        console.error('Toast container not found!');
        return;
    }

    const toastElement = document.createElement('div');
    toastElement.className = `toast align-items-center text-white bg-${type} border-0 rounded-lg shadow-lg mb-3`;
    toastElement.setAttribute('role', 'alert');
    toastElement.setAttribute('aria-live', 'assertive');
    toastElement.setAttribute('aria-atomic', 'true');
    toastElement.innerHTML = `
        <div class="d-flex">
            <div class="toast-body">
                ${message}
            </div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
    `;

    toastContainer.appendChild(toastElement);
    const bsToast = new bootstrap.Toast(toastElement, { delay: 3000 });
    bsToast.show();

    toastElement.addEventListener('hidden.bs.toast', () => {
        toastElement.remove();
    });
}

/**
 * Shows/hides a loading spinner on a button.
 * @param {HTMLElement} buttonElement - The button associated with the operation.
 * @param {boolean} show - True to show the spinner, false to hide it.
 */
function toggleLoading(buttonElement, show) {
    if (show) {
        buttonElement.setAttribute('data-original-text', buttonElement.innerHTML);
        buttonElement.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...`;
        buttonElement.disabled = true;
    } else {
        buttonElement.innerHTML = buttonElement.getAttribute('data-original-text');
        buttonElement.disabled = false;
    }
}

/* ╔══════════════════════════════════════╗  CAPTCHA */
let hReg = '', hLog = '';
let triesR = 0, triesL = 0, blkR = 0, blkL = 0;

/**
 * Generates a new CAPTCHA and returns its SHA256 hash.
 * @param {HTMLImageElement} img - The <img> element where the CAPTCHA will be displayed.
 * @returns {Promise<string>} The SHA256 hash of the CAPTCHA text.
 */
async function genCap(img) {
    const s = Math.random().toString(36).slice(2, 8);
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 50;
    const g = c.getContext('2d');
    g.fillStyle = '#343a40';
    g.fillRect(0, 0, 160, 50);
    g.font = '24px monospace';
    g.fillStyle = '#fff';
    g.setTransform(1, 0.1, -0.1, 1, 10, 5);
    g.fillText(s, 10, 35);
    img.src = c.toDataURL();
    return sha256(s);
}

/**
 * Refreshes both CAPTCHAs (for registration and login).
 */
async function refreshCaps() {
    hLog = await genCap($('#cap-img-log'));
    hReg = await genCap($('#cap-img-reg'));
}

/**
 * Checks if a CAPTCHA passed and manages blocking/retries logic.
 * @param {'reg'|'log'} type - The CAPTCHA type ('reg' for registration, 'log' for login).
 * @param {boolean} ok - True if the entered CAPTCHA is correct.
 * @returns {boolean} True if the CAPTCHA is valid and not blocked, otherwise false.
 */
function capPass(type, ok) {
    const now = Date.now();
    const max = CFG.captcha_max_attempts;
    const cool = CFG.captcha_cooldown_ms;

    const currentBlockTime = (type === 'reg' ? blkR : blkL);
    if (currentBlockTime > now) {
        showToast(`You are blocked for ${Math.ceil((currentBlockTime - now) / 1000)} seconds.`, 'warning');
        return false;
    }

    if (ok) {
        if (type === 'reg') triesR = 0;
        else triesL = 0;
        return true;
    }

    if (type === 'reg') triesR++;
    else triesL++;

    const currentTries = (type === 'reg' ? triesR : triesL);
    if (currentTries >= max) {
        const newBlockTime = now + cool;
        if (type === 'reg') blkR = newBlockTime;
        else blkL = newBlockTime;
        if (type === 'reg') triesR = 0;
        else triesL = 0;
        showToast(`Too many attempts. You are blocked for ${cool / 1000} seconds.`, 'danger');
    } else {
        showToast(`Incorrect captcha. You have ${max - currentTries} attempts left.`, 'warning');
    }
    return false;
}

refreshCaps();

// Event listeners for captcha input fields
['reg', 'log'].forEach(t => {
    $(`#cap-inp-${t}`).oninput = async e => {
        const ok = await sha256(e.target.value.trim()) === (t === 'reg' ? hReg : hLog);
        e.target.classList.toggle('is-valid', ok);
        e.target.classList.toggle('is-invalid', !ok);
    };
});

/* runtime */
let myUsername = '', currentChat = null, chatPoll = null;

/**
 * Updates the styling of Bootstrap tabs within a given container.
 * Adds 'glass' to inactive tabs and removes it from the active one.
 * @param {string} navTabsContainerSelector - CSS selector for the .nav-tabs container.
 */
function updateTabStyles(navTabsContainerSelector) {
    const tabButtons = document.querySelectorAll(`${navTabsContainerSelector} .nav-link`);
    tabButtons.forEach(button => {
        if (button.classList.contains('active')) {
            button.classList.remove('glass');
        } else {
            button.classList.add('glass');
        }
    });
}

/* UI State Management */
function showAuthUI() {
    $('#auth-wrap').classList.remove('d-none');
    $('#dash-wrap').classList.add('d-none');

    // Hide Logout button in navbar
    const navLogoutBtn = $('#nav-logout');
    if (navLogoutBtn) {
        navLogoutBtn.classList.add('d-none');
    }

    // Ensure login tab is active by default in the main content area
    const loginTabTrigger = document.querySelector('#auth-wrap .nav-tabs .nav-link[data-bs-target="#tab-log"]');
    if (loginTabTrigger) {
        const loginTab = new bootstrap.Tab(loginTabTrigger);
        loginTab.show();
        updateTabStyles('#auth-wrap .nav-tabs'); // Update styles after showing the tab
    }
}

async function showDashboardUI(u) {
    myUsername = u;
    $('#auth-wrap').classList.add('d-none');
    $('#dash-wrap').classList.remove('d-none');

    // Show Logout button in navbar
    const navLogoutBtn = $('#nav-logout');
    if (navLogoutBtn) {
        navLogoutBtn.classList.remove('d-none');
    }

    $('#user-slug').textContent = u;
    const link = localStorage.getItem('0k_blob_url') || '#';
    $('#blob-link').href = link;
    $('#blob-link').textContent = link;
    $('#chat-empty').classList.remove('d-none');
    $('#chat-pane').classList.add('d-none');
    await loadProfile();
    await renderChats();
    await renderInvites();
    updateTabStyles('#dash-wrap .nav-tabs'); // Update styles for dashboard tabs
}

/* ╔══════════════════════════════════════╗  REGISTER */
$('#btn-reg').onclick = async () => {
    const captchaInput = $('#cap-inp-reg').value.trim();
    const isCaptchaValid = await sha256(captchaInput) === hReg;

    if (!capPass('reg', isCaptchaValid)) {
        return;
    }

    toggleLoading($('#btn-reg'), true);
    try {
        const tok = await createAccount();
        $('#extended-out').value = tok;
        $('#reg-sec').classList.remove('d-none');
        window._tok = tok;
        showToast('Account created successfully! Save this token.', 'success');
        console.log('Account created. Token:', tok);
    } catch (e) {
        showToast('Error creating account: ' + e.message, 'danger');
        console.error('Error creating account:', e);
    } finally {
        toggleLoading($('#btn-reg'), false);
        refreshCaps();
    }
};

$('#btn-reg-ok').onclick = async () => {
    const t = $('#extended-out').value.trim();
    try {
        await navigator.clipboard.writeText(t);
        showToast('Token copied to clipboard!', 'success');
    } catch (e) {
        $('#extended-out').select();
        document.execCommand('copy');
        showToast('Token copied (fallback method)!', 'success');
        console.warn('Clipboard copy error, fallback used:', e);
    }
    // After saving token, switch to login tab and pre-fill
    const loginTabTrigger = document.querySelector('#auth-wrap .nav-tabs .nav-link[data-bs-target="#tab-log"]');
    if (loginTabTrigger) {
        const loginTab = new bootstrap.Tab(loginTabTrigger);
        loginTab.show();
        updateTabStyles('#auth-wrap .nav-tabs'); // Update styles after switching tab
    }
    $('#extended-inp').value = t;
};

/* ╔══════════════════════════════════════╗  LOGIN */
$('#btn-log').onclick = loginFlow;

async function loginFlow() {
    const captchaInput = $('#cap-inp-log').value.trim();
    const isCaptchaValid = await sha256(captchaInput) === hLog;

    if (!capPass('log', isCaptchaValid)) {
        return;
    }

    const tok = $('#extended-inp').value.trim() || window._tok;
    if (!validator.isNonEmptyString(tok)) {
        showToast('Please enter the authentication token.', 'warning');
        return;
    }

    toggleLoading($('#btn-log'), true);
    try {
        const username = await authenticate(tok);
        localStorage.setItem('0k_extended_token', tok); // Store the extended token for session restoration
        showToast(`Authentication successful! Welcome, ${username}!`, 'success');
        console.log('Authentication successful for user:', username);
        await showDashboardUI(username); // Call the new function to manage UI state
    } catch (e) {
        showToast('Authentication error: ' + e.message, 'danger');
        console.error('Authentication error:', e);
    } finally {
        toggleLoading($('#btn-log'), false);
        refreshCaps();
    }
}

/* ╔══════════════════════════════════════╗  DASHBOARD */
/* Profile */
async function loadProfile() {
    try {
        const p = await db.profile.get('me');
        $('#profile-box').textContent = JSON.stringify({
            username: localStorage.getItem('0k_username'),
            session: p?.data?.session || {}
        }, null, 2);
    } catch (e) {
        console.error('Error loading profile:', e);
        showToast('Error loading profile data.', 'danger');
    }
}

/* Chats list */
async function renderChats() {
    try {
        const chats = (await db.profile.get('me'))?.data.chats || [];
        $('#chat-list').innerHTML = chats.length ?
            chats.map(c => `<button class="list-group-item list-group-item-action bg-dark text-light" data-url="${c.chat_url}">${c.nickname || c.peerShortUsername || c.peerSlug || 'chat'}</button>`).join('') :
            '<p class="small text-muted text-center">No chats.</p>';
    } catch (e) {
        console.error('Error rendering chat list:', e);
        showToast('Error loading chat list.', 'danger');
    }
}
$('#chat-list').onclick = e => {
    if (e.target.dataset.url) {
        openChat(e.target.dataset.url);
    }
};

/* open chat */
async function openChat(url) {
    if (chatPoll) {
        clearInterval(chatPoll);
        chatPoll = null;
    }
    try {
        const profile = await db.profile.get('me');
        currentChat = profile.data.chats.find(c => c.chat_url === url);

        if (!currentChat) {
            showToast('Chat not found.', 'danger');
            console.error('Attempt to open non-existent chat:', url);
            return;
        }

        $('#chat-empty').classList.add('d-none');
        $('#chat-pane').classList.remove('d-none');
        $('#chat-msgs').innerHTML = '<p class="small text-muted text-center">Loading messages…</p>';

        await ensureChat(currentChat);
        await verifyLastOTS(currentChat.chat_url);
        await loadMsgs();
        chatPoll = setInterval(loadMsgs, CFG.chat_sync_interval_ms);
        showToast(`Chat opened with ${currentChat.nickname || currentChat.peerShortUsername || currentChat.peerSlug || 'partner'}.`, 'info');
    } catch (e) {
        showToast('Error opening chat: ' + e.message, 'danger');
        console.error('Error opening chat:', e);
    }
}

/* OTS verify */
async function verifyLastOTS(chatUrl) {
    try {
        const doc = (await db.doc.get(chatUrl))?.meta;
        const flushes = Object.keys(doc?.ots?.flush || {});
        if (!flushes.length) {
            return;
        }
        const last = flushes.sort((a, b) => b - a)[0];
        const ok = await verifySnapshot(chatUrl, last);
        if (!ok) {
            showToast('⚠️ OTS snapshot verification failed!', 'warning');
            console.warn('OTS snapshot verification failed for chat:', chatUrl, 'at timestamp:', last);
        } else {
            showToast('✔ OTS snapshot verification successful.', 'success');
        }
    } catch (e) {
        console.error('Error verifying OTS:', e);
        showToast('Error verifying chat integrity.', 'danger');
    }
}

/* load messages */
async function loadMsgs() {
    if (!currentChat) return;
    try {
        const msgs = getChatMessages(currentChat.chat_url);
        $('#chat-msgs').innerHTML = msgs.length ?
            msgs.map(m => `
                <div class="${m.from === myUsername ? 'me' : 'peer'}">
                    <div class="message-sender">${m.from === myUsername ? 'Me' : currentChat.nickname || currentChat.peerShortUsername || currentChat.peerSlug}</div>
                    <div class="message-bubble">${m.txt}</div>
                </div>
            `).join('') :
            '<p class="small text-muted text-center">No messages.</p>';
        $('#chat-msgs').scrollTop = $('#chat-msgs').scrollHeight;
    } catch (e) {
        console.error('Error loading messages:', e);
        showToast('Error loading chat messages.', 'danger');
    }
}

/* send message */
let deb = null;
$('#chat-input').oninput = () => {
    clearTimeout(deb);
    $('#btn-send').disabled = true;
    deb = setTimeout(() => $('#btn-send').disabled = false, CFG.chat_input_debounce_ms);
};
$('#btn-send').onclick = async () => {
    const t = $('#chat-input').value.trim();
    if (!validator.isNonEmptyString(t)) {
        showToast('Message cannot be empty.', 'warning');
        return;
    }

    $('#chat-input').value = '';
    $('#btn-send').disabled = true;
    toggleLoading($('#btn-send'), true);
    try {
        await sendMessage(currentChat, t);
        await loadMsgs();
        showToast('Message sent!', 'success');
    } catch (e) {
        showToast('Error sending message: ' + e.message, 'danger');
        console.error('Error sending message:', e);
    } finally {
        toggleLoading($('#btn-send'), false);
    }
};

/* invite modal send */
$('#btn-invite').onclick = async () => {
    const slug = $('#slug-invite').value.trim();
    // Validate that the slug is a valid base-36 username (alphanumeric)
    if (!validator.isValidSlug(slug)) { 
        showToast('Invitee username is invalid. Use only alphanumeric characters.', 'warning');
        return;
    }

    toggleLoading($('#btn-invite'), true);
    try {
        // Pass the short username directly to sendInvite
        await sendInvite(slug); 
        showToast('Invitation sent successfully!', 'success');
        const inviteModalInstance = bootstrap.Modal.getInstance($('#inviteModal'));
        if (inviteModalInstance) inviteModalInstance.hide();
        $('#slug-invite').value = '';
    } catch (e) {
        showToast('Error sending invitation: ' + e.message, 'danger');
        console.error('Error sending invitation:', e);
    } finally {
        toggleLoading($('#btn-invite'), false);
    }
};

/* pending invites */
async function renderInvites() {
    try {
        // We need to fetch from our own public lookup blob to get incoming invites
        const publicLookupBlobUrl = localStorage.getItem('0k_public_lookup_blob_url');
        if (!publicLookupBlobUrl) {
            $('#inv-box').innerHTML = '<p class="small text-muted text-center">No pending invitations.</p>';
            return;
        }

        // Fetch the public lookup blob (which now contains invites_log)
        const r = await fetch(publicLookupBlobUrl);
        if (!r.ok) {
            console.warn(`Failed to fetch public lookup blob for invites: ${r.statusText}`);
            $('#inv-box').innerHTML = '<p class="small text-muted text-center">Error loading invites.</p>';
            return;
        }
        const publicLookupData = await r.json();
        const invites_log = publicLookupData.invites_log || [];

        const pend = invites_log.filter(i => i.op === 'new' && !invites_log.find(j => j.ts === i.ts && j.op === 'accepted'));
        $('#inv-box').innerHTML = pend.length ?
            pend.map(i => `<div class="d-flex justify-content-between align-items-center mb-2 p-2 rounded">
                <code class="text-light">${i.ts.slice(0, 8)} - From: ${i.fromShortUsername || i.fromSlug.slice(0, 8)}</code>
                <button class="btn btn-sm btn-primary accept" data-ts="${i.ts}" data-chat-url="${i.chatUrl}" data-from-slug="${i.fromSlug}" data-from-email="${i.fromEmail}" data-from-short-username="${i.fromShortUsername}">Accept</button>
            </div>`).join('') :
            '<p class="small text-muted text-center">No pending invitations.</p>';
    } catch (e) {
        console.error('Error rendering invitations:', e);
        showToast('Error loading pending invitations.', 'danger');
    }
}
setInterval(renderInvites, 30000);

$('#inv-box').onclick = e => {
    if (e.target.classList.contains('accept')) {
        const entry = { 
            chat_url: e.target.dataset.chatUrl, 
            ts: e.target.dataset.ts,
            fromSlug: e.target.dataset.fromSlug,
            fromEmail: e.target.dataset.fromEmail,
            fromShortUsername: e.target.dataset.fromShortUsername
        };
        $('#nicknameModal').dataset.chatUrl = entry.chat_url;
        $('#nicknameModal').dataset.ts = entry.ts;
        $('#nicknameModal').dataset.fromSlug = entry.fromSlug;
        $('#nicknameModal').dataset.fromEmail = entry.fromEmail;
        $('#nicknameModal').dataset.fromShortUsername = entry.fromShortUsername;
        const nicknameModal = new bootstrap.Modal($('#nicknameModal'));
        // Pre-fill nickname with sender's short username if available
        $('#nicknameInput').value = entry.fromShortUsername || 'friend'; 
        nicknameModal.show();
    }
};

$('#saveNicknameBtn').onclick = async () => {
    const chatUrl = $('#nicknameModal').dataset.chatUrl;
    const ts = $('#nicknameModal').dataset.ts;
    const fromSlug = $('#nicknameModal').dataset.fromSlug;
    const fromEmail = $('#nicknameModal').dataset.fromEmail;
    const fromShortUsername = $('#nicknameModal').dataset.fromShortUsername;
    const nick = $('#nicknameInput').value.trim();

    if (!validator.isNonEmptyString(nick)) {
        showToast('Nickname cannot be empty.', 'warning');
        return;
    }

    const entry = { chat_url: chatUrl, ts: ts, fromSlug: fromSlug, fromEmail: fromEmail, fromShortUsername: fromShortUsername };
    toggleLoading($('#saveNicknameBtn'), true);
    try {
        await acceptFlow(entry, nick);
        showToast('Invitation accepted and nickname set!', 'success');
        const nicknameModal = bootstrap.Modal.getInstance($('#nicknameModal'));
        if (nicknameModal) nicknameModal.hide();
        $('#nicknameInput').value = '';
    } catch (e) {
        showToast('Error accepting invitation: ' + e.message, 'danger');
        console.error('Error accepting invitation:', e);
    } finally {
        toggleLoading($('#saveNicknameBtn'), false);
    }
};


/* accept invite flow */
async function acceptFlow(entry, nick) {
    try {
        // Instead of fetching chat blob, we pass the info from the invite log directly
        // The `fromSlug` and `fromEmail` are already in the `entry` from `renderInvites`
        await onIncomingWebhook({
            type: 'invite',
            chatUrl: entry.chat_url,
            keyHex: await sha256(entry.ts + 'chat'), // Key derived from timestamp
            fromSlug: entry.fromSlug, // Sender's webhook UUID
            fromEmail: entry.fromEmail, // Sender's webhook email
            fromShortUsername: entry.fromShortUsername // Sender's short username
        });
        await setNickname(entry.chat_url, nick);

        // Mark invite as accepted in my public lookup blob
        const publicLookupBlobUrl = localStorage.getItem('0k_public_lookup_blob_url');
        if (publicLookupBlobUrl) {
            const r = await fetch(publicLookupBlobUrl);
            if (r.ok) {
                const publicLookupData = await r.json();
                publicLookupData.invites_log = publicLookupData.invites_log || [];
                publicLookupData.invites_log.push({ ts: entry.ts, op: 'accepted' });
                await fetch(publicLookupBlobUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(publicLookupData)
                });
            }
        }

        // Send acceptance confirmation to the sender's webhook UUID
        const myWebhookSlug = localStorage.getItem('0k_webhook_slug');
        const myWebhookEmail = localStorage.getItem('0k_webhook_email');

        await fetch(`${CFG.webhook_base_url}/${entry.fromSlug}`, { // Send to sender's UUID via proxy
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'accepted', chatUrl: entry.chat_url, bySlug: myWebhookSlug, byEmail: myEmail })
        }).catch(e => console.warn('Error sending acceptance confirmation:', e));

        await renderChats();
        await renderInvites();
    } catch (e) {
        console.error('Error in invite acceptance flow:', e);
        throw e;
    }
}

/* tab close -> flush */
window.addEventListener('beforeunload', () => {
    if (currentChat) {
        console.log('Closing chat on beforeunload:', currentChat.chat_url);
        closeChat(currentChat);
    }
});

/* restore / initial load */
document.addEventListener('DOMContentLoaded', async () => {
    if (!document.getElementById('toast-container')) {
        const toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'position-fixed bottom-0 end-0 p-3';
        toastContainer.style.zIndex = '1050';
        document.body.appendChild(toastContainer);
    }

    // Navbar Logout Button - moved inside DOMContentLoaded
    const navLogoutBtn = $('#nav-logout');
    if (navLogoutBtn) {
        navLogoutBtn.onclick = async () => {
            toggleLoading(navLogoutBtn, true);
            try {
                await logout();
                localStorage.removeItem('0k_extended_token'); // Clear the stored token on logout
                showToast('Logged out successfully!', 'success');
                console.log('User logged out.');
                location.reload(); // Reload to reset UI state
            } catch (e) {
                showToast('Error logging out: ' + e.message, 'danger');
                console.error('Error logging out:', e);
            } finally {
                toggleLoading(navLogoutBtn, false);
            }
        };
    }

    // Add event listener for auth tab clicks to update styles
    const authNavTabs = document.querySelector('#auth-wrap .nav-tabs');
    if (authNavTabs) {
        authNavTabs.addEventListener('shown.bs.tab', function (e) {
            updateTabStyles('#auth-wrap .nav-tabs');
        });
    }

    // Add event listener for dashboard tab clicks to update styles
    const dashNavTabs = document.querySelector('#dash-wrap .nav-tabs');
    if (dashNavTabs) {
        dashNavTabs.addEventListener('shown.bs.tab', function (e) {
            updateTabStyles('#dash-wrap .nav-tabs');
        });
    }

    const storedExtendedToken = localStorage.getItem('0k_extended_token');

    if (storedExtendedToken && isSession()) {
        try {
            console.log('Attempting to restore session with stored token...');
            const username = await authenticate(storedExtendedToken);
            await showDashboardUI(username);
            showToast('Session restored!', 'success');
        } catch (e) {
            console.error('Failed to restore session:', e);
            showToast('Session expired or invalid, please log in again.', 'danger');
            localStorage.removeItem('0k_extended_token'); // Clear invalid token
            showAuthUI();
            updateTabStyles('#auth-wrap .nav-tabs'); // Initial style update for auth tabs
        }
    } else {
        console.log('No active session or stored token found, showing auth UI.');
        showAuthUI();
        updateTabStyles('#auth-wrap .nav-tabs'); // Initial style update for auth tabs
    }
});
