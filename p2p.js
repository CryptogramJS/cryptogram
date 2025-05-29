/*****************************************************************
 * p2p.js – invites, messaging, presence, TSA stamping
 *****************************************************************/
(() => {

/* IMPORTS */
const { sodium, Automerge } = window;
const ok0 = window.ok0;
if (!ok0) { console.error("core missing"); return; }

/* SHORTCUTS */
const CFG   = ok0.cfg;
const utils = ok0.utils;
const S     = ok0._state;

/* CONSTANTS */
const chatDocs     = {};
const DEF_SYNC_MS  = 3000;
const DEF_FALLBACK = 30000;

/* QUEUES */
const pending        = {};
const pendingOffline = {};

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
  let remote=null;
  try { const r = await fetch(url); if (r.ok) remote=await r.json(); } catch {}
  if (!remote?.bin) return;

  const newer = remote.meta.lastModified > ctx.meta.lastModified
             || (remote.meta.lastModified === ctx.meta.lastModified
                  && remote.meta.lastWriter !== ctx.meta.lastWriter);
  if (newer) {
    const merged = Automerge.merge(ctx.doc, Automerge.load(new Uint8Array(remote.bin)));
    if (!Automerge.equals(Automerge.getHeads(ctx.doc), Automerge.getHeads(merged))) {
      ctx.doc = merged; ctx.meta = remote.meta; ctx.dirty = true;
    }
  }

  const rec = S.personal?.chats?.find(c=>c.chat_url===url);
  if (rec){
    const nSlug = findLatestPeerSlug(ctx.doc.meta, rec.peerSlug);
    if (nSlug){
      rec.peerSlug  = nSlug;
      rec.peerEmail = `${nSlug}@${CFG.webhook_email_domain}`;
      await ok0.putPersonalBlob(); ok0.db.profile.put({ key:"me", data:S.personal });
      flushPending(rec); flushPendingOffline(rec);
    }
  }
}

async function flushChat(url) {
  const ctx = chatDocs[url]; if (!ctx || !ctx.dirty) return;
  await syncChat(url);
  if (!ctx.dirty) return;

  try {
    const r = await fetch(url);
    if (r.ok) { const remote = await r.json(); if (!safeToPush(ctx.meta, remote.meta)) { ctx.dirty=true; return; } }
  } catch {}

  const bin = Automerge.save(ctx.doc);
  ctx.meta.binLen = bin.length * 2;

  /* TSA stamp */
  const hash = await utils.sha512(bin.buffer);
  const tsr  = await ok0.tsaStamp(hash);
  if (tsr) {
    amChange(url, d=>{
      d.meta.tsa = d.meta.tsa || {};
      d.meta.tsa.flush = d.meta.tsa.flush || {};
      d.meta.tsa.flush[Date.now()] = Array.from(tsr);
    });
  }

  ctx.dirty = false;
  try {
    await fetch(url, { method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ bin:Array.from(bin), meta:ctx.meta }) });
  } catch { ctx.dirty = true; }
}

/* QUEUE HELPERS */
function flushPending(chat){
  if (!chat.peerSlug) return;
  const q = pending[chat.chat_url] || [];
  while (q.length){
    const enc=q.shift();
    // Send to the other client's direct webhook.site route
    fetch(`${CFG.webhook_base_url_direct}/${chat.peerSlug}`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"message",chatUrl:chat.chat_url,payload:enc})}).catch(()=>q.unshift(enc));
  }
}
function flushPendingOffline(chat){
  if (!chat.peerSlug) return;
  const q = pendingOffline[chat.chat_url] || [];
  while (q.length){
    const enc=q.shift();
    // Send to the other client's direct webhook.site route
    fetch(`${CFG.webhook_base_url_direct}/${chat.peerSlug}`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"message",chatUrl:chat.chat_url,payload:enc})}).catch(()=>q.unshift(enc));
  }
}

/* UTIL */
function findLatestPeerSlug(meta, current){
  let best=null;
  for (const e of Object.values(meta||{})){
    if (!e?.slug) continue;
    if (e.slug===current) continue;
    if (!best || (e.ts||0) > (best.ts||0)) best=e;
  }
  return best ? best.slug : null;
}

/* HIGH-LEVEL API */
async function ensureChat(chat){
  await initChatDoc(chat.chat_url, chat.key_hex);
  amChange(chat.chat_url,d=>{
    d.meta=d.meta||{};
    // Use S.hookUrl for the current user's direct webhook endpoint
    d.meta[S.myPubKeyHex]={ slug:S.hookSlug,http:S.hookUrl,email:S.hookEmail,ts:Date.now() };
    if (chat.peerSlug) d.meta[chat.peerSlug]={ slug:chat.peerSlug,http:`${CFG.webhook_base_url_direct}/${chat.peerSlug}`,email:chat.peerEmail,ts:Date.now() };
  });
}

async function sendInvite(friendSlug){
  const r=await fetch(CFG.jsonblob_endpoint,{method:"POST",headers:{'Content-Type':'application/json'},body:'{}'});
  if(!r.ok)throw new Error();
  const chatUrl=r.headers.get("Location").replace(/^http:/,"https:");
  const ts_hex=Date.now().toString(16);
  const keyHex=await utils.sha512(new TextEncoder().encode(ts_hex+"chat")).then(b=>Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(""));
  S.personal.chats.push({chat_url:chatUrl,key_hex:keyHex,peerSlug:null,peerEmail:null,nickname:null});
  await ok0.putPersonalBlob(); ok0.db.profile.put({key:"me",data:S.personal});
  const invite={type:"invite",chatUrl,keyHex,ts:ts_hex,fromSlug:S.hookSlug,fromEmail:S.hookEmail};
  // Send invite to the friend's direct webhook.site route
  await fetch(`${CFG.webhook_base_url_direct}/${friendSlug}`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify(invite)}).catch(()=>{});
}

async function declineInvite(chatUrl,inviterSlug){
  // Send decline to the inviter's direct webhook.site route
  await fetch(`${CFG.webhook_base_url_direct}/${inviterSlug}`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"declined",chatUrl,bySlug:S.hookSlug})}).catch(()=>{});
  const idx=S.personal.chats.findIndex(c=>c.chat_url===chatUrl);
  if(idx!==-1){S.personal.chats.splice(idx,1);await ok0.putPersonalBlob();ok0.db.profile.put({key:"me",data:S.personal});}
}

async function sendMessage(chat,txt){
  await ensureChat(chat);
  const ctx=chatDocs[chat.chat_url]; if(!ctx||!ctx.key) throw new Error("no key");
  const n=sodium.randombytes_buf(24);
  const plain=JSON.stringify({from:S.myUsername,txt,ts:Date.now()});
  const cipher=sodium.crypto_secretbox_easy(sodium.from_string(plain),n,ctx.key);
  const mac=sodium.crypto_generichash(32,cipher,ctx.key);
  const enc=`${sodium.to_base64(n)}.${sodium.to_base64(cipher)}.${sodium.to_base64(mac)}`;
  amChange(chat.chat_url,d=>{d.log=d.log||[];d.log.push(enc);});
  ctx.dirty=true;

  const queue=(!chat.peerSlug||!navigator.onLine)?(pendingOffline[chat.chat_url] ||= []):(pending[chat.chat_url] ||= []);
  if(chat.peerSlug&&navigator.onLine){
    // Send message to the peer's direct webhook.site route
    fetch(`${CFG.webhook_base_url_direct}/${chat.peerSlug}`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"message",chatUrl:chat.chat_url,payload:enc})}).catch(()=>queue.push(enc));
  }else queue.push(enc);
}

function getChatMessages(url){
  const ctx=chatDocs[url];
  if(!ctx||!ctx.doc?.log||!ctx.key)return[];
  return ctx.doc.log.map(row=>{
    try{
      const[a,b,c]=row.split(".");
      const calc=sodium.to_base64(sodium.crypto_generichash(32,sodium.from_base64(b),ctx.key));
      if(c!==calc)return null;
      const p=sodium.crypto_secretbox_open_easy(sodium.from_base64(b),sodium.from_base64(a),ctx.key);
      return JSON.parse(sodium.to_string(p));
    }catch{return null;}
  }).filter(Boolean).sort((x,y)=>(x.ts||0)-(y.ts||0));
}

async function verifySnapshot(chatUrl,ts){
  await initChatDoc(chatUrl);
  const ctx=chatDocs[chatUrl];
  const tsrBytes=ctx.doc.meta?.tsa?.flush?.[ts];
  return !!tsrBytes && tsrBytes.length>0;
}

async function closeChat(chat){
  await flushChat(chat.chat_url);
  if(chat.peerSlug){
    // Send flush to the peer's direct webhook.site route
    fetch(`${CFG.webhook_base_url_direct}/${chat.peerSlug}`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"flush",chatUrl:chat.chat_url,ts:Date.now()})}).catch(()=>{});
  }
}

/* WEBHOOK HANDLER */
async function onIncomingWebhook(msg){
  switch(msg.type){
  case"invite":{if(!S.personal.chats.some(c=>c.chat_url===msg.chatUrl)){S.personal.chats.push({chat_url:msg.chatUrl,key_hex:msg.keyHex,peerSlug:msg.fromSlug,peerEmail:msg.fromEmail,nickname:null});await ok0.putPersonalBlob();ok0.db.profile.put({key:"me",data:S.personal});}
    // Acknowledge invite by sending 'accepted' to the sender's direct webhook.site route
    fetch(`${CFG.webhook_base_url_direct}/${msg.fromSlug}`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"accepted",chatUrl:msg.chatUrl,bySlug:S.hookSlug,byEmail:S.hookEmail})}).catch(()=>{});break;}
  case"accepted":{const c=S.personal.chats.find(x=>x.chat_url===msg.chatUrl);if(c){c.peerSlug=msg.bySlug;c.peerEmail=msg.byEmail;await ok0.putPersonalBlob();ok0.db.profile.put({key:"me",data:S.personal});flushPending(c);flushPendingOffline(c);}break;}
  case"declined":{const idx=S.personal.chats.findIndex(c=>c.chat_url===msg.chatUrl);if(idx!==-1){const ch=S.personal.chats[idx];if(!ch.peerSlug){S.personal.chats.splice(idx,1);delete pending[ch.chat_url];delete pendingOffline[ch.chat_url];await ok0.putPersonalBlob();ok0.db.profile.put({key:"me",data:S.personal});}}break;}
  case"flush": await flushChat(msg.chatUrl); break;
  case"message":{await initChatDoc(msg.chatUrl);amChange(msg.chatUrl,d=>{d.log=d.log||[];d.log.push(msg.payload);});chatDocs[msg.chatUrl].dirty=true;break;}
  }
}

/* PRESENCE */
async function updateMyEndpointAll(){
  for(const ch of S.personal.chats){
    await initChatDoc(ch.chat_url,ch.key_hex);
    amChange(ch.chat_url,d=>{d.meta=d.meta||{};
      // Use S.hookUrl for the current user's direct webhook endpoint
      d.meta[S.myPubKeyHex]={slug:S.hookSlug,http:S.hookUrl,email:S.hookEmail,ts:Date.now()};
    });
  }
}
document.addEventListener("ok0:newSlug",updateMyEndpointAll);

/* LONG-POLL */
let lastPoll=0;
(async function poll(){
  for(;;){
    // Use S.hookUrl (your own direct webhook.site URL with token) for long polling
    if(!S.hookUrl){await new Promise(r=>setTimeout(r,2000));continue;}
    try{
      const url=`${S.hookUrl}/requests?min_id=${lastPoll}&sort=asc&limit=20`; // Changed to S.hookUrl
      const r=await fetch(url,{cache:"no-store"});
      if(r.ok){
        const list=await r.json();
        for(const it of list){lastPoll=Math.max(lastPoll,it.id);try{await onIncomingWebhook(JSON.parse(it.content));}catch{}}
      }
    }catch{}
    await new Promise(r=>setTimeout(r,3000));
  }
})();

/* ONLINE EVENT */
window.addEventListener("online",async()=>{
  for(const ch of S.personal.chats){flushPendingOffline(ch);}
  for(const ctx of Object.values(chatDocs)){ctx.dirty&&await flushChat(ctx.docUrl);}
});

/* EXPORT */
Object.assign(ok0,{
  ensureChat,
  sendInvite, declineInvite,
  sendMessage, closeChat,
  getChatMessages, verifySnapshot,
  onIncomingWebhook
});

})();
