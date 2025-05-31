/*****************************************************************
 * dapp.js – UI layer for Cryptogram MVP (2025-05, TSA edition)
 *****************************************************************/

import { sha256 } from './sha.js';
import { validator } from './validator.js';

window.sha256 = sha256;

await sodium.ready;

await import('./0knowledge.core.js');
await import('./p2p.js');

const ok0 = window.ok0;
const {
  createAccount,
  authenticate,
  logout,
  isSession,
  hasPersonal,
  sendInvite,
  sendMessage,
  closeChat,
  ensureChat,
  getChatMessages,
  onIncomingWebhook,
  acceptInvite,
  verifySnapshot,
  utils,
  db,
  cfg: CFG
} = ok0;
const { usernameToSlug } = utils;

/* DOM Helpers */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function showToast(msg, type = 'info') {
  const box = $('#toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast align-items-center text-white bg-${type} border-0 rounded-lg shadow-lg mb-3`;
  el.role = 'alert'; el.ariaLive = 'assertive'; el.ariaAtomic = 'true';
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${msg}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto"
              data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  box.appendChild(el);
  new bootstrap.Toast(el, { delay: 3000 }).show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

function toggleLoading(btn, show) {
  if (show) {
    btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Loading…`;
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.originalText;
    btn.disabled = false;
  }
}

/* CAPTCHA */
let hReg = '', hLog = '', triesR = 0, triesL = 0, blkR = 0, blkL = 0;

async function genCap(img) {
  const s = Math.random().toString(36).slice(2, 8);
  const c = document.createElement('canvas'); c.width = 160; c.height = 50;
  const g = c.getContext('2d'); g.fillStyle = '#343a40'; g.fillRect(0, 0, 160, 50);
  g.font = '24px monospace'; g.fillStyle = '#fff'; g.setTransform(1, 0.1, -0.1, 1, 10, 5); g.fillText(s, 10, 35);
  img.src = c.toDataURL();
  return sha256(s);
}

async function refreshCaps() {
  hLog = await genCap($('#cap-img-log'));
  hReg = await genCap($('#cap-img-reg'));
}

function capPass(type, ok) {
  const now = Date.now(), max = CFG.captcha_max_attempts, cool = CFG.captcha_cooldown_ms;
  const block = type === 'reg' ? blkR : blkL;
  if (block > now) {
    showToast(`Blocked ${Math.ceil((block - now) / 1000)}s`, 'warning');
    return false;
  }
  if (ok) {
    if (type === 'reg') triesR = 0; else triesL = 0;
    return true;
  }
  type === 'reg' ? triesR++ : triesL++;
  const cur = type === 'reg' ? triesR : triesL;
  if (cur >= max) {
    if (type === 'reg') blkR = now + cool; else blkL = now + cool;
    triesR = triesL = 0;
    showToast(`Blocked ${cool / 1000}s`, 'danger');
  } else {
    showToast(`Captcha wrong. Left ${max - cur}`, 'warning');
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

/* UI State */
let myUsername = '', currentChat = null, chatPoll = null;

/* Register / Login */
$('#btn-reg').onclick = async () => {
  if (!capPass('reg', await sha256($('#cap-inp-reg').value.trim()) === hReg)) return;
  toggleLoading($('#btn-reg'), true);
  try {
    const tok = await createAccount();
    $('#extended-out').value = tok;
    $('#reg-sec').classList.remove('d-none');
    window._tok = tok;
    showToast('Account created – save the token.', 'success');
  } catch (e) {
    showToast(e.message, 'danger');
  }
  toggleLoading($('#btn-reg'), false);
  refreshCaps();
};

$('#btn-reg-ok').onclick = async () => {
  const t = $('#extended-out').value.trim();
  try {
    await navigator.clipboard.writeText(t);
    showToast('Token copied.', 'success');
  } catch {
    $('#extended-out').select();
    document.execCommand('copy');
    showToast('Token copied.', 'success');
  }
  document.querySelector('[data-bs-target="#tab-log"]').click();
  $('#extended-inp').value = t;
};

$('#btn-log').onclick = loginFlow;

async function loginFlow() {
  if (!capPass('log', await sha256($('#cap-inp-log').value.trim()) === hLog)) return;
  const tok = $('#extended-inp').value.trim() || window._tok;
  if (!validator.isNonEmptyString(tok)) return showToast('Enter token.', 'warning');
  toggleLoading($('#btn-log'), true);
  try {
    const u = await authenticate(tok);
    showToast(`Welcome ${u}!`, 'success');
    await buildUI(u);
  } catch (e) {
    showToast(e.message, 'danger');
  }
  toggleLoading($('#btn-log'), false);
  refreshCaps();
}

/* Dashboard */
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
  const p = await db.profile.get('me');
  $('#profile-box').textContent = JSON.stringify({
    username: localStorage.getItem('0k_username'),
    session: p?.data?.session || {}
  }, null, 2);
}

async function renderChats() {
  const chats = (await db.profile.get('me'))?.data.chats || [];
  $('#chat-list').innerHTML = chats.length
    ? chats.map(c => `<button class="list-group-item list-group-item-action bg-dark text-light" data-url="${c.chat_url}">${c.nickname || c.peerSlug || 'chat'}</button>`).join('')
    : '<p class="small text-muted text-center">No chats.</p>';
}

$('#chat-list').onclick = e => {
  if (e.target.dataset.url) openChat(e.target.dataset.url);
};

/* Chat Open */
async function openChat(url) {
  if (chatPoll) clearInterval(chatPoll);
  const prof = await db.profile.get('me');
  currentChat = prof.data.chats.find(c => c.chat_url === url);
  if (!currentChat) return showToast('Chat not found.', 'danger');
  $('#chat-empty').classList.add('d-none');
  $('#chat-pane').classList.remove('d-none');
  $('#chat-msgs').innerHTML = '<p class="small text-muted text-center">Loading…</p>';
  await ensureChat(currentChat);
  await verifyLastTSA(currentChat.chat_url);
  await loadMsgs();
  chatPoll = setInterval(loadMsgs, CFG.chat_sync_interval_ms);
}

async function verifyLastTSA(chatUrl) {
  try {
    const meta = (await db.doc.get(chatUrl))?.meta;
    const flush = Object.keys(meta?.tsa?.flush || {}).sort((a, b) => b - a)[0];
    if (!flush) return;
    const ok = await verifySnapshot(chatUrl, flush);
    showToast(ok ? '✔ Timestamp verified.' : '⚠️ Timestamp failed!', ok ? 'success' : 'warning');
  } catch {
    showToast('Timestamp verify error', 'danger');
  }
}

/* Messages */
async function loadMsgs() {
  if (!currentChat) return;
  const msgs = getChatMessages(currentChat.chat_url);
  $('#chat-msgs').innerHTML = msgs.length
    ? msgs.map(m => `
        <div class="${m.from === myUsername ? 'me' : 'peer'}">
          <div class="message-sender">${m.from === myUsername ? 'Me' : (currentChat.nickname || currentChat.peerSlug)}</div>
          <div class="message-bubble">${m.txt}</div>
        </div>`).join('')
    : '<p class="small text-muted text-center">No messages.</p>';
  $('#chat-msgs').scrollTop = $('#chat-msgs').scrollHeight;
}

let deb = null;
$('#chat-input').oninput = () => {
  clearTimeout(deb);
  $('#btn-send').disabled = true;
  deb = setTimeout(() => $('#btn-send').disabled = false, CFG.chat_input_debounce_ms);
};

$('#btn-send').onclick = async () => {
  const t = $('#chat-input').value.trim();
  if (!validator.isNonEmptyString(t)) return showToast('Message empty.', 'warning');
  $('#chat-input').value = '';
  toggleLoading($('#btn-send'), true);
  try {
    await sendMessage(currentChat, t);
    await loadMsgs();
  } catch (e) {
    showToast(e.message, 'danger');
  }
  toggleLoading($('#btn-send'), false);
};

/* Invite */
$('#btn-invite').onclick = async () => {
  const slug = $('#slug-invite').value.trim();
  if (!validator.isValidSlug(slug)) return showToast('Invalid slug', 'warning');
  toggleLoading($('#btn-invite'), true);
  try {
    await sendInvite(usernameToSlug(slug));
    showToast('Invite sent.', 'success');
    bootstrap.Modal.getInstance($('#inviteModal'))?.hide();
    $('#slug-invite').value = '';
  } catch (e) {
    showToast(e.message, 'danger');
  }
  toggleLoading($('#btn-invite'), false);
};

/* Invites List */
async function renderInvites() {
  try {
    const pin = document.cookie.match(/pin_url=([^;]+)/)?.[1];
    if (!pin) {
      $('#inv-box').innerHTML = '<p class="small text-muted text-center">No pending invitations.</p>';
      return;
    }
    const { invites_log = [] } = await fetch(decodeURIComponent(pin)).then(r => r.json());
    const pend = invites_log.filter(i => i.op === 'new' && !invites_log.some(j => j.ts === i.ts && j.op === 'accepted'));
    $('#inv-box').innerHTML = pend.length
      ? pend.map(i => `
          <div class="d-flex justify-content-between align-items-center mb-2 p-2 bg-secondary rounded">
            <code class="text-light">${i.ts.slice(0, 8)}</code>
            <button class="btn btn-sm btn-primary accept" data-ts="${i.ts}" data-url="${i.chat_url}">Accept</button>
          </div>`).join('')
      : '<p class="small text-muted text-center">No pending invitations.</p>';
  } catch {
    showToast('Error loading invites', 'danger');
  }
}

setInterval(renderInvites, 30000);

$('#inv-box').onclick = e => {
  if (e.target.classList.contains('accept')) {
    $('#nicknameModal').dataset.chatUrl = e.target.dataset.url;
    $('#nicknameModal').dataset.ts = e.target.dataset.ts;
    new bootstrap.Modal($('#nicknameModal')).show();
  }
};

/* Derive KeyHex */
async function deriveKeyHex(ts_hex) {
  const bytes = new TextEncoder().encode(ts_hex + 'chat');
  const hash = await utils.sha512(bytes);
  return Array.from(hash).map(x => x.toString(16).padStart(2, '0')).join('');
}

/* Accept Invite Flow */
$('#saveNicknameBtn').onclick = async () => {
  const chatUrl = $('#nicknameModal').dataset.chatUrl;
  const nick = $('#nicknameInput').value.trim();
  if (!validator.isNonEmptyString(nick)) return showToast('Nickname empty.', 'warning');
  toggleLoading($('#saveNicknameBtn'), true);
  try {
    const ts = $('#nicknameModal').dataset.ts;
    const raw = await fetch(chatUrl).then(r => r.text()).catch(() => null);
    const fromSlug = raw?.match(/"fromSlug":"([^"]+)"/)?.[1];
    if (!fromSlug) throw new Error('Invalid invitation.');
    const keyHex = await deriveKeyHex(ts);
    await acceptInvite(chatUrl, fromSlug, keyHex, null);
    await ok0.setNickname(chatUrl, nick);
    const mySlug = localStorage.getItem('0k_webhook_slug');
    const myEmail = localStorage.getItem('0k_webhook_email');
    await fetch(`${CFG.webhook_base_url}/${fromSlug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'accepted', chatUrl, bySlug: mySlug, byEmail: myEmail })
    }).catch(() => { });
    await renderChats();
    await renderInvites();
    showToast('Invite accepted.', 'success');
    bootstrap.Modal.getInstance($('#nicknameModal')).hide();
    $('#nicknameInput').value = '';
  } catch (e) {
    showToast(e.message, 'danger');
  }
  toggleLoading($('#saveNicknameBtn'), false);
};

/* Misc */
window.addEventListener('beforeunload', () => {
  if (currentChat) closeChat(currentChat);
});

$('#btn-logout').onclick = async () => {
  toggleLoading($('#btn-logout'), true);
  try {
    await logout();
    location.reload();
  } catch (e) {
    showToast(e.message, 'danger');
  }
  toggleLoading($('#btn-logout'), false);
};

if (isSession()) {
  const u = localStorage.getItem('0k_username');
  if (u) buildUI(u);
}

document.addEventListener('DOMContentLoaded', () => {
  if (!$('#toast-container')) {
    const d = document.createElement('div');
    d.id = 'toast-container';
    d.className = 'position-fixed bottom-0 end-0 p-3';
    d.style.zIndex = '1050';
    document.body.appendChild(d);
  }
});
