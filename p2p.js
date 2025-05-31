/*****************************************************************
 * p2p.js – invites, messaging, presence, TSA stamping
 *****************************************************************/
(() => {

  /* IMPORTS */
  const { sodium, Automerge } = window;
  const ok0 = window.ok0;

  /* SHORTCUTS */
  const CFG   = ok0.cfg;
  const utils = ok0.utils;
  const S     = ok0._state;

  /* CONSTANTS */
  const chatDocs     = {};
  const DEF_SYNC_MS  = 3000;
  const STATIC_WEBHOOK_PATHS = ['invite','accepted','declined','message','flush'];

  /* STATE */
  let invitePollInterval = null;
  let awaitingInviteChatUrl = null;

  /* CONFLICT POLICY */
  function safeToPush(localMeta, remoteMeta) {
    if (!remoteMeta?.lastModified) return true;
    if (remoteMeta.lastModified <  localMeta.lastModified) return true;
    if (remoteMeta.lastModified >  localMeta.lastModified) return false;
    return (localMeta.binLen || 0) >= (remoteMeta.binLen || 0);
  }

  /* CRDT */
  async function initChatDoc(url, keyHex) {
    if (chatDocs[url]) {
      if (keyHex && !chatDocs[url].key) chatDocs[url].key = sodium.from_hex(keyHex);
      return;
    }
    let doc  = Automerge.init();
    let meta = { lastModified:0, lastWriter:"" };
    let key  = keyHex ? sodium.from_hex(keyHex) : null;
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (j.bin) { doc = Automerge.load(new Uint8Array(j.bin)); meta = j.meta; }
      }
    } catch {}
    const interval = setInterval(() => syncChat(url), CFG.chat_sync_interval_ms || DEF_SYNC_MS);
    chatDocs[url] = { doc, meta, key, interval, dirty:false, docUrl:url };
  }

  function amChange(url, fn) {
    const ctx = chatDocs[url]; if (!ctx) return;
    const heads = Automerge.getHeads(ctx.doc);
    ctx.doc = Automerge.change(ctx.doc, fn);
    if (!Automerge.equals(heads, Automerge.getHeads(ctx.doc))) {
      ctx.meta.lastModified = Date.now();
      ctx.meta.lastWriter   = S.myPubKeyHex;
      ctx.dirty = true;
    }
  }

  async function syncChat(url) {
    const ctx = chatDocs[url]; if (!ctx) return;
    let remote = null;
    try {
      const r = await fetch(url);
      if (r.ok) remote = await r.json();
    } catch {}
    if (!remote?.bin) return;

    const newer = remote.meta.lastModified > ctx.meta.lastModified
               || (remote.meta.lastModified === ctx.meta.lastModified
                    && remote.meta.lastWriter !== S.myPubKeyHex);
    if (newer) {
      const merged = Automerge.merge(ctx.doc, Automerge.load(new Uint8Array(remote.bin)));
      if (!Automerge.equals(Automerge.getHeads(ctx.doc), Automerge.getHeads(merged))) {
        ctx.doc = merged; ctx.meta = remote.meta; ctx.dirty = true;
      }
    }

    const rec = S.personal?.chats?.find(c => c.chat_url === url);
    if (rec) {
      const nSlug = findLatestPeerSlug(ctx.doc.meta, rec.peerSlug);
      if (nSlug) {
        rec.peerSlug  = nSlug;
        rec.peerEmail = `${nSlug}@${CFG.webhook_email_domain}`;
        await ok0.putPersonalBlob();
        ok0.db.profile.put({ key:"me", data:S.personal });
        flushPending(rec);
        flushPendingOffline(rec);
      }
    }
  }

  async function flushChat(url) {
    const ctx = chatDocs[url]; if (!ctx || !ctx.dirty) return;
    await syncChat(url);
    if (!ctx.dirty) {
      const r = await fetch(url).catch(() => null);
      if (r?.ok) {
        const remote = await r.json();
        if (!safeToPush(ctx.meta, remote.meta)) {
          ctx.dirty = true;
          return;
        }
      }
    }

    const bin = Automerge.save(ctx.doc);
    ctx.meta.binLen = bin.length * 2;

    const hash = await utils.sha512(bin.buffer);
    const tsr  = await ok0.tsaStamp(hash);
    if (tsr) {
      amChange(url, d => {
        d.meta = d.meta || {};
        d.meta.tsa = d.meta.tsa || {};
        d.meta.tsa.flush = d.meta.tsa.flush || {};
        d.meta.tsa.flush[Date.now()] = Array.from(tsr);
      });
    }

    const finalBin = Automerge.save(ctx.doc);
    ctx.dirty = false;
    try {
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bin: Array.from(finalBin), meta: ctx.meta })
      });
    } catch {
      ctx.dirty = true;
    }
  }

  /* QUEUE HELPERS */
  function getPeerWebhookUrl(peerSlug, path) {
    const base = CFG.webhook_base_url.endsWith('/') ? CFG.webhook_base_url : CFG.webhook_base_url + '/';
    return `${base}${peerSlug}/${path}`;
  }

  function flushPending(chat) {
    if (!chat.peerSlug) return;
    const q = pending[chat.chat_url] || [];
    while (q.length) {
      const payloadToSend = q.shift();
      fetch(getPeerWebhookUrl(chat.peerSlug, 'message'), {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: "message", chatUrl: chat.chat_url, payload: payloadToSend })
      }).catch(err => { q.unshift(payloadToSend); });
    }
  }

  function flushPendingOffline(chat) {
    if (!chat.peerSlug) return;
    const q = pendingOffline[chat.chat_url] || [];
    while (q.length) {
      const payloadToSend = q.shift();
      fetch(getPeerWebhookUrl(chat.peerSlug, 'message'), {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: "message", chatUrl: chat.chat_url, payload: payloadToSend })
      }).catch(err => { q.unshift(payloadToSend); });
    }
  }

  /* UTIL */
  function findLatestPeerSlug(meta, current) {
    let best = null;
    for (const e of Object.values(meta || {})) {
      if (!e?.slug) continue;
      if (e.slug === current) continue;
      if (e.slug === S.hookSlug) continue;
      if (!best || (e.ts || 0) > (best.ts || 0)) best = e;
    }
    return best ? best.slug : null;
  }

  /* HIGH-LEVEL API */
  async function ensureChat(chat) {
    await initChatDoc(chat.chat_url, chat.key_hex);
    amChange(chat.chat_url, d => {
      d.meta = d.meta || {};
      d.meta[S.myPubKeyHex] = {
        slug: S.hookSlug,
        http: `${CFG.webhook_base_url}/${S.hookSlug}`,
        email: S.hookEmail,
        ts: Date.now()
      };
      if (chat.peerSlug) {
        const peerHttp = `${CFG.webhook_base_url}/${chat.peerSlug}`;
        d.meta[chat.peerSlug] = {
          slug: chat.peerSlug,
          http: peerHttp,
          email: chat.peerEmail,
          ts: Date.now()
        };
      }
    });
    await flushChat(chat.chat_url);
  }

  async function sendInvite(friendSlug) {
    if (!S.personal?.chats) throw new Error("Not authenticated");
    const r = await fetch(CFG.jsonblob_endpoint, {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!r.ok) throw new Error(`Failed to create chat blob: ${r.status}`);
    const chatUrl = r.headers.get("Location").replace(/^http:/, "https:");
    const ts_hex = Date.now().toString(16);
    const keyHex = await utils.sha512(new TextEncoder().encode(ts_hex + "chat" + S.myPubKeyHex + friendSlug))
      .then(b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(""));

    const newChat = {
      chat_url: chatUrl,
      key_hex: keyHex,
      peerSlug: friendSlug,
      peerEmail: `${friendSlug}@${CFG.webhook_email_domain}`,
      nickname: null,
      accepted: false,
      iInitiated: true
    };
    S.personal.chats.push(newChat);
    await ok0.putPersonalBlob();
    ok0.db.profile.put({ key: "me", data: S.personal });
    awaitingInviteChatUrl = chatUrl; // start waiting for B's response

    await ensureChat(newChat);

    const invite = {
      type: "invite",
      chatUrl,
      keyHex,
      ts: ts_hex,
      fromSlug: S.hookSlug,
      fromEmail: S.hookEmail,
      fromPubKey: S.myPubKeyHex
    };
    await fetch(getPeerWebhookUrl(friendSlug, 'invite'), {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invite)
    }).catch(() => { });

    startInvitePoll(); // only poll until accepted/declined
  }

  async function acceptInvite(chatUrl, inviterSlug, keyHex, inviterPubKey) {
    const chat = S.personal.chats.find(c => c.chat_url === chatUrl);
    if (chat) {
      chat.peerSlug = inviterSlug;
      chat.peerEmail = `${inviterSlug}@${CFG.webhook_email_domain}`;
      chat.key_hex = chat.key_hex || keyHex;
      chat.accepted = true;
      chat.peerPubKey = inviterPubKey;
      chat.iInitiated = false;
      awaitingInviteChatUrl = null;

      await ok0.putPersonalBlob();
      ok0.db.profile.put({ key: "me", data: S.personal });
      await ensureChat(chat);

      await fetch(getPeerWebhookUrl(inviterSlug, 'accepted'), {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: "accepted",
          chatUrl,
          bySlug: S.hookSlug,
          byEmail: S.hookEmail,
          byPubKey: S.myPubKeyHex
        })
      }).catch(() => { });

      stopInvitePoll();
    }
  }

  async function declineInvite(chatUrl, inviterSlug) {
    await fetch(getPeerWebhookUrl(inviterSlug, 'declined'), {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: "declined", chatUrl, bySlug: S.hookSlug })
    }).catch(() => { });
    const idx = S.personal.chats.findIndex(c => c.chat_url === chatUrl && c.peerSlug === inviterSlug);
    if (idx !== -1) {
      const ch = S.personal.chats.splice(idx, 1)[0];
      delete pending[ch.chat_url];
      delete pendingOffline[ch.chat_url];
      await ok0.putPersonalBlob();
      ok0.db.profile.put({ key: "me", data: S.personal });
      if (chatDocs[ch.chat_url]) {
        clearInterval(chatDocs[ch.chat_url].interval);
        delete chatDocs[ch.chat_url];
      }
      awaitingInviteChatUrl = null;
      stopInvitePoll();
    }
  }

  async function sendMessage(chat, txt) {
    await ensureChat(chat);
    const ctx = chatDocs[chat.chat_url]; if (!ctx || !ctx.key) throw new Error("Chat not properly initialized or missing key");
    const n = sodium.randombytes_buf(24);
    const plain = JSON.stringify({ from: S.myUsername, pubKey: S.myPubKeyHex, txt, ts: Date.now() });
    const cipher = sodium.crypto_secretbox_easy(sodium.from_string(plain), n, ctx.key);
    const mac = sodium.crypto_generichash(32, cipher, ctx.key);
    const enc = `${sodium.to_base64(n)}.${sodium.to_base64(cipher)}.${sodium.to_base64(mac)}`;
    amChange(chat.chat_url, d => { d.log = d.log || []; d.log.push(enc); });
    ctx.dirty = true;
    await flushChat(chat.chat_url);

    const queue = (!chat.peerSlug || !navigator.onLine)
      ? (pendingOffline[chat.chat_url] ||= [])
      : (pending[chat.chat_url] ||= []);
    if (chat.peerSlug && navigator.onLine) {
      fetch(getPeerWebhookUrl(chat.peerSlug, 'message'), {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: "message", chatUrl: chat.chat_url, payload: enc })
      }).catch(() => queue.push(enc));
    } else {
      queue.push(enc);
    }
  }

  function getChatMessages(url) {
    const ctx = chatDocs[url];
    if (!ctx || !ctx.doc?.log || !ctx.key) return [];
    return ctx.doc.log.map(row => {
      try {
        const [a, b, c] = row.split(".");
        if (!a || !b || !c) return null;
        const cipherBytes = sodium.from_base64(b);
        const keyBytes = ctx.key;
        const macBytes = sodium.from_base64(c);
        const calculatedMac = sodium.crypto_generichash(32, cipherBytes, keyBytes);
        if (sodium.to_base64(macBytes) !== sodium.to_base64(calculatedMac)) return null;
        const nonceBytes = sodium.from_base64(a);
        const p = sodium.crypto_secretbox_open_easy(cipherBytes, nonceBytes, keyBytes);
        return JSON.parse(sodium.to_string(p));
      } catch {
        return null;
      }
    }).filter(Boolean).sort((x, y) => (x.ts || 0) - (y.ts || 0));
  }

  async function verifySnapshot(chatUrl, ts) {
    await initChatDoc(chatUrl);
    const ctx = chatDocs[chatUrl];
    const tsrBytes = ctx?.doc?.meta?.tsa?.flush?.[ts];
    return !!tsrBytes && tsrBytes.length > 0;
  }

  async function closeChat(chat) {
    await flushChat(chat.chat_url);
    if (chat.peerSlug) {
      fetch(getPeerWebhookUrl(chat.peerSlug, 'flush'), {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: "flush", chatUrl: chat.chat_url, ts: Date.now() })
      }).catch(() => { });
    }
  }

  /* INVITE POLLING */
  async function pollInvitationResponse() {
    if (!awaitingInviteChatUrl) return;
    const realUrl = `${S.hookUrl}/requests?min_id=0&sort=asc&limit=20`;
    const aoUrl   = `https://api.allorigins.win/raw?url=${encodeURIComponent(realUrl)}`;
    try {
      const res = await fetch(aoUrl);
      if (res.ok) {
        const responseJson = await res.json();
        const list = responseJson.data || responseJson;
        for (const it of Array.isArray(list) ? list : []) {
          const parsed = (() => {
            try { return JSON.parse(it.content); }
            catch { return null; }
          })();
          if (!parsed) continue;
          if ((parsed.type === 'accepted' || parsed.type === 'declined') && parsed.chatUrl === awaitingInviteChatUrl) {
            stopInvitePoll();
            return;
          }
        }
      }
    } catch {}
  }

  function startInvitePoll() {
    if (invitePollInterval) return;
    invitePollInterval = setInterval(pollInvitationResponse, CFG.chat_sync_interval_ms || 3000);
  }

  function stopInvitePoll() {
    if (!invitePollInterval) return;
    clearInterval(invitePollInterval);
    invitePollInterval = null;
    awaitingInviteChatUrl = null;
  }

  /* WEBHOOK HANDLER */
  async function onIncomingWebhook(webhookRequest) {
    const msgType = webhookRequest.path?.replace(/^\//, '') || webhookRequest.type;
    const msgData = typeof webhookRequest.content === 'string'
      ? JSON.parse(webhookRequest.content)
      : webhookRequest.content;

    switch (msgType) {
      case "invite": {
        const { chatUrl, keyHex, fromSlug, fromEmail, fromPubKey } = msgData;
        if (!S.personal?.chats) return;
        if (!S.personal.chats.some(c => c.chat_url === chatUrl)) {
          S.personal.chats.push({
            chat_url: chatUrl,
            key_hex: keyHex,
            peerSlug: fromSlug,
            peerEmail: fromEmail,
            nickname: null,
            accepted: false,
            iInitiated: false,
            peerPubKey: fromPubKey
          });
          await ok0.putPersonalBlob();
          ok0.db.profile.put({ key: "me", data: S.personal });
          await initChatDoc(chatUrl, keyHex);
          document.dispatchEvent(new CustomEvent("ok0:p2p:inviteReceived", { detail: msgData }));
        }
        break;
      }
      case "accepted": {
        const { chatUrl, bySlug, byEmail, byPubKey } = msgData;
        const c = S.personal.chats.find(x => x.chat_url === chatUrl);
        if (c) {
          c.peerSlug = bySlug;
          c.peerEmail = byEmail;
          c.accepted = true;
          c.peerPubKey = byPubKey;
          await ok0.putPersonalBlob();
          ok0.db.profile.put({ key: "me", data: S.personal });
          await ensureChat(c);
          flushPending(c);
          flushPendingOffline(c);
          stopInvitePoll();
          document.dispatchEvent(new CustomEvent("ok0:p2p:inviteAccepted", { detail: msgData }));
        }
        break;
      }
      case "declined": {
        const { chatUrl, bySlug } = msgData;
        const idx = S.personal.chats.findIndex(c => c.chat_url === chatUrl && c.peerSlug === bySlug);
        if (idx !== -1) {
          const ch = S.personal.chats.splice(idx, 1)[0];
          delete pending[ch.chat_url];
          delete pendingOffline[ch.chat_url];
          await ok0.putPersonalBlob();
          ok0.db.profile.put({ key: "me", data: S.personal });
          if (chatDocs[ch.chat_url]) {
            clearInterval(chatDocs[ch.chat_url].interval);
            delete chatDocs[ch.chat_url];
          }
          stopInvitePoll();
          document.dispatchEvent(new CustomEvent("ok0:p2p:inviteDeclined", { detail: msgData }));
        }
        break;
      }
      case "flush": {
        const { chatUrl } = msgData;
        if (chatDocs[chatUrl]) {
          await syncChat(chatUrl);
        }
        break;
      }
      case "message": {
        const { chatUrl, payload } = msgData;
        const chat = S.personal.chats.find(c => c.chat_url === chatUrl);
        if (!chat) return;
        if (!chat.key_hex && chatDocs[chatUrl]?.key) {
          chat.key_hex = sodium.to_hex(chatDocs[chatUrl].key);
        }
        if (!chat.key_hex) return;
        await initChatDoc(chatUrl, chat.key_hex);
        amChange(chatUrl, d => { d.log = d.log || []; d.log.push(payload); });
        chatDocs[chatUrl].dirty = true;
        await flushChat(chatUrl);
        document.dispatchEvent(new CustomEvent("ok0:p2p:messageReceived", { detail: { chatUrl, payload } }));
        break;
      }
      default:
        break;
    }
  }

  /* PRESENCE & METADATA MANAGEMENT */
  async function updateMyEndpointInAllChats() {
    if (!S.personal?.chats) return;
    for (const ch of S.personal.chats) {
      if (ch.accepted || ch.iInitiated) {
        await ensureChat(ch);
      }
    }
  }
  document.addEventListener("ok0:newSlug", async () => {
    await setStaticWebhookPaths();
    await updateMyEndpointInAllChats();
  });

  /* SET STATIC WEBHOOK PATHS ON LOGIN/NEW SLUG */
  async function setStaticWebhookPaths() {
    if (!S.hookSlug || !S.hookApiToken) return;
    for (const path of STATIC_WEBHOOK_PATHS) {
      const apiPath = `/${path}`;
      const endpoint = `${CFG.webhook_base_url}/token/${S.hookSlug}/paths${apiPath}`;
      const payload = {
        response_body: JSON.stringify({ status: "ok", path: apiPath, description: `Path ${apiPath} active.` }),
        response_content_type: "application/json",
        response_code: 200
      };
      try {
        const r = await fetch(endpoint, {
          method: "PUT",
          headers: {
            'Content-Type': 'application/json',
            'Api-Key': S.hookApiToken
          },
          body: JSON.stringify(payload)
        });
        if (!r.ok) {
          const errText = await r.text();
          console.error(`Failed to set path ${apiPath}: HTTP ${r.status} - ${r.statusText}`, errText);
        }
      } catch {}
    }
  }

  /* EXPORT API */
  Object.assign(ok0, {
    ensureChat,
    sendInvite,
    acceptInvite,
    declineInvite,
    sendMessage,
    closeChat,
    getChatMessages,
    verifySnapshot,
    onIncomingWebhook
  });

})();
