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

let hReg = '', hLog = '';
let triesR = 0, triesL = 0, blkR = 0, blkL = 0;

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

async function refreshCaps() {
    hLog = await genCap($('#cap-img-log'));
    hReg = await genCap($('#cap-img-reg'));
}

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

$$('button[data-bs-toggle="tab"]').forEach(b => b.addEventListener('shown.bs.tab', refreshCaps));

['reg', 'log'].forEach(t => {
    $(`#cap-inp-${t}`).oninput = async e => {
        const ok = await sha256(e.target.value.trim()) === (t === 'reg' ? hReg : hLog);
        e.target.classList.toggle('is-valid', ok);
        e.target.classList.toggle('is-invalid', !ok);
    };
});

let myUsername = '', currentChat = null, chatPoll = null;

$('#btn-reg').onclick = async () => {
    const captchaInput = $('#cap-inp-reg').value.trim();
    const isCaptchaValid = await sha256(captchaInput) === hReg;

    if (!capPass('reg', isCaptchaValid)) return;

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
    document.querySelector('[data-bs-target="#tab-log"]').click();
    $('#extended-inp').value = t;
};

$('#btn-log').onclick = loginFlow;

async function loginFlow() {
    const captchaInput = $('#cap-inp-log').value.trim();
    const isCaptchaValid = await sha256(captchaInput) === hLog;

    if (!capPass('log', isCaptchaValid)) return;

    const tok = $('#extended-inp').value.trim() || window._tok;
    if (!validator.isNonEmptyString(tok)) {
        showToast('Please enter the authentication token.', 'warning');
        return;
    }

    toggleLoading($('#btn-log'), true);
    try {
        const username = await authenticate(tok);
        showToast(`Authentication successful! Welcome, ${username}!`, 'success');
        console.log('Authentication successful for user:', username);
        await buildUI(username);
    } catch (e) {
        showToast('Authentication error: ' + e.message, 'danger');
        console.error('Authentication error:', e);
    } finally {
        toggleLoading($('#btn-log'), false);
        refreshCaps();
    }
}

async function buildUI(u) {
    myUsername = u;
    $('#auth-wrap').classList.add('d-none');
    $('#dash-wrap').classList.remove('d-none');
    $('#user-slug').textContent = u;
    const link = localStorage.getItem('0k_blob_url') || '#';
    $('#blob-link').href = link;
    $('#blob-link').textContent = link;
    $('#chat-empty').classList.remove('d-none');
    $('#chat-pane').classList.add('d-none');
    await loadProfile();
    await renderChats();
    await renderInvites();
}

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

async function renderChats() {
    try {
        const chats = (await db.profile.get('me'))?.data.chats || [];
        $('#chat-list').innerHTML = chats.length ?
            chats.map(c => `<button class="list-group-item list-group-item-action bg-dark text-light" data-url="${c.chat_url}">${c.nickname || c.peerSlug || 'chat'}</button>`).join('') :
            '<p class="small text-muted text-center">No chats.</p>';
    } catch (e) {
        console.error('Error rendering chat list:', e);
        showToast('Error loading chat list.', 'danger');
    }
}
$('#chat-list').onclick = e => {
    if (e.target.dataset.url) openChat(e.target.dataset.url);
};

async function openChat(url) {
    if (chatPoll) clearInterval(chatPoll);
    try {
        const profile = await db.profile.get('me');
        currentChat = profile.data.chats.find(c => c.chat_url === url);
        if (!currentChat) throw new Error('Chat not found.');
        $('#chat-empty').classList.add('d-none');
        $('#chat-pane').classList.remove('d-none');
        $('#chat-msgs').innerHTML = '<p class="small text-muted text-center">Loading messages…</p>';
        await ensureChat(currentChat);
        await verifyLastOTS(currentChat.chat_url);
        await loadMsgs();
        chatPoll = setInterval(loadMsgs, CFG.chat_sync_interval_ms);
        showToast(`Chat opened with ${currentChat.nickname || currentChat.peerSlug || 'partner'}.`, 'info');
    } catch (e) {
        console.error('Error opening chat:', e);
        showToast('Error opening chat: ' + e.message, 'danger');
    }
}

async function verifyLastOTS(chatUrl) {
    try {
        const doc = (await db.doc.get(chatUrl))?.meta;
        const flushes = Object.keys(doc?.ots?.flush || {});
        if (!flushes.length) return;
        const last = flushes.sort((a, b) => b - a)[0];
        const ok = await verifySnapshot(chatUrl, last);
        if (!ok) showToast('⚠️ OTS snapshot verification failed!', 'warning');
        else showToast('✔ OTS snapshot verification successful.', 'success');
    } catch (e) {
        console.error('Error verifying OTS:', e);
        showToast('Error verifying chat integrity.', 'danger');
    }
}

async function loadMsgs() {
    if (!currentChat) return;
    try {
        const msgs = getChatMessages(currentChat.chat_url);
        $('#chat-msgs').innerHTML = msgs.length ?
            msgs.map(m => `
                <div class="${m.from === myUsername ? 'me' : 'peer'}">
                    <div class="message-sender">${m.from === myUsername ? 'Me' : currentChat.nickname || currentChat.peerSlug}</div>
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

let deb = null;
$('#chat-input').oninput = () => {
    clearTimeout(deb);
    $('#btn-send').disabled = true;
    deb = setTimeout(() => $('#btn-send').disabled = false, CFG.chat_input_debounce_ms);
};
$('#btn-send').onclick = async () => {
    const t = $('#chat-input').value.trim();
    if (!validator.isNonEmptyString(t)) return showToast('Message cannot be empty.', 'warning');

    $('#chat-input').value = '';
    toggleLoading($('#btn-send'), true);
    try {
        await sendMessage(currentChat, t);
        await loadMsgs();
        showToast('Message sent!', 'success');
    } catch (e) {
        console.error('Error sending message:', e);
        showToast('Error sending message: ' + e.message, 'danger');
    } finally {
        toggleLoading($('#btn-send'), false);
    }
};

$('#btn-invite').onclick = async () => {
    const slug = $('#slug-invite').value.trim();
    if (!validator.isValidSlug(slug)) return showToast('Invitee slug is invalid. Use only alphanumeric characters.', 'warning');

    toggleLoading($('#btn-invite'), true);
    try {
        await sendInvite(usernameToSlug(slug));
        showToast('Invitation sent successfully!', 'success');
        bootstrap.Modal.getInstance($('#inviteModal'))?.hide();
        $('#slug-invite').value = '';
    } catch (e) {
        console.error('Error sending invitation:', e);
        showToast('Error sending invitation: ' + e.message, 'danger');
    } finally {
        toggleLoading($('#btn-invite'), false);
    }
};

async function renderInvites() {
    try {
        const pin = document.cookie.match(/pin_url=([^;]+)/)?.[1];
        if (!pin) return $('#inv-box').innerHTML = '<p class="small text-muted text-center">No pending invitations.</p>';
        const { invites_log = [] } = await fetch(decodeURIComponent(pin)).then(r => r.json());
        const pend = invites_log.filter(i => i.op === 'new' && !invites_log.some(j => j.ts === i.ts && j.op === 'accepted'));
        $('#inv-box').innerHTML = pend.length ?
            pend.map(i => `<div class="d-flex justify-content-between align-items-center mb-2 p-2 bg-secondary rounded">
                <code class="text-light">${i.ts.slice(0, 8)}</code>
                <button class="btn btn-sm btn-primary accept" data-ts="${i.ts}" data-url="${i.chat_url}">Accept</button>
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
        const entry = { chat_url: e.target.dataset.url, ts: e.target.dataset.ts };
        $('#nicknameModal').dataset.chatUrl = entry.chat_url;
        $('#nicknameModal').dataset.ts = entry.ts;
        new bootstrap.Modal($('#nicknameModal')).show();
    }
};

$('#saveNicknameBtn').onclick = async () => {
    const chatUrl = $('#nicknameModal').dataset.chatUrl;
    const nick = $('#nicknameModal').querySelector('#nicknameInput').value.trim();
    if (!validator.isNonEmptyString(nick)) return showToast('Nickname cannot be empty.', 'warning');

    toggleLoading($('#saveNicknameBtn'), true);
    try {
        await acceptFlow({ chat_url: chatUrl, ts: $('#nicknameModal').dataset.ts }, nick);
        showToast('Invitation accepted and nickname set!', 'success');
        bootstrap.Modal.getInstance($('#nicknameModal')).hide();
        $('#nicknameInput').value = '';
    } catch (e) {
        console.error('Error accepting invitation:', e);
        showToast('Error accepting invitation: ' + e.message, 'danger');
    } finally {
        toggleLoading($('#saveNicknameBtn'), false);
    }
};

async function acceptFlow(entry, nick) {
    try {
        const raw = await fetch(entry.chat_url).then(r => r.text()).catch(() => null);
        const m = raw?.match(/"fromSlug":"([^"]+)"/);
        if (!m) {
            console.error('Invalid invitation, could not extract fromSlug:', entry.chat_url);
            throw new Error('Invalid or inaccessible invitation.');
        }
        const fromSlug = m[1];
        const fromEmail = `${fromSlug}@${CFG.webhook_email_domain}`;

        await onIncomingWebhook({
            type: 'invite',
            chatUrl: entry.chat_url,
            keyHex: await sha256(entry.ts + 'chat'),
            fromSlug,
            fromEmail
        });
        await setNickname(entry.chat_url, nick);

        const mySlug = localStorage.getItem('0k_webhook_slug');
        const myEmail = localStorage.getItem('0k_webhook_email');
        await fetch(`${CFG.webhook_base_url}/${fromSlug}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'accepted', chatUrl: entry.chat_url, bySlug: mySlug, byEmail: myEmail })
        }).catch(e => console.warn('Error sending acceptance confirmation:', e));

        await renderChats();
        await renderInvites();
    } catch (e) {
        console.error('Error in invite acceptance flow:', e);
        throw e;
    }
}

window.addEventListener('beforeunload', () => {
    if (currentChat) closeChat(currentChat);
});

$('#btn-logout').onclick = async () => {
    toggleLoading($('#btn-logout'), true);
    try {
        await logout();
        showToast('Logged out successfully!', 'success');
        location.reload();
    } catch (e) {
        console.error('Error logging out:', e);
        showToast('Error logging out: ' + e.message, 'danger');
    } finally {
        toggleLoading($('#btn-logout'), false);
    }
};

if (isSession()) {
    const u = localStorage.getItem('0k_username');
    if (u) buildUI(u);
}

document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('toast-container')) {
        const toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'position-fixed bottom-0 end-0 p-3';
        toastContainer.style.zIndex = '1050';
        document.body.appendChild(toastContainer);
    }
});