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
const S     = ok0._state; // State now includes sessionToken

/* CONSTANTS */
const chatDocs     = {};
const DEF_SYNC_MS  = 3000;
const DEF_FALLBACK = 30000;

// Define static paths to be set on the user's personal webhook
const STATIC_WEBHOOK_PATHS = ['invite', 'accepted', 'declined', 'message', 'flush'];

// Flag to indicate if static webhook paths have been successfully set
let staticPathsReady = false;
let setPathsPromise = null; // To hold the promise for setting paths

/* QUEUES */
const pending        = {};
const pendingOffline = {};

/* CONFLICT POLICY */
function safeToPush(localMeta, remoteMeta) {
  if (!remoteMeta?.lastModified) return true;
  if (remoteMeta.lastModified <  localMeta.lastModified) return true;
  if (remoteMeta.lastModified >  localMeta.lastModified) return false;
  return (localMeta.binLen || 0) >= (remote.binLen || 0);
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
  try {
    const r = await fetch(url);
    if (r.ok) remote=await r.json();
  } catch {}
  if (!remote?.bin) return;

  const newer = remote.meta.lastModified > ctx.meta.lastModified
             || (remote.meta.lastModified === ctx.meta.lastModified
                  && remote.meta.lastWriter !== remote.meta.lastWriter);
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
    fetch(`${CFG.webhook_base_url}/${chat.peerSlug}/message`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"message",chatUrl:chat.chat_url,payload:q.shift()})}).catch(enc=>q.unshift(enc));
  }
}
function flushPendingOffline(chat){
  if (!chat.peerSlug) return;
  const q = pendingOffline[chat.chat_url] || [];
  while (q.length){
    fetch(`${CFG.webhook_base_url}/${chat.peerSlug}/message`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"message",chatUrl:chat.chat_url,payload:q.shift()})}).catch(enc=>q.unshift(enc));
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
    d.meta[S.myPubKeyHex]={ slug:S.hookSlug,http:S.hookUrl,email:S.hookEmail,ts:Date.now() };
    if (chat.peerSlug) d.meta[chat.peerSlug]={ slug:chat.peerSlug,http:`${CFG.webhook_base_url}/${chat.peerSlug}`,email:chat.peerEmail,ts:Date.now() };
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
  fetch(`${CFG.webhook_base_url}/${friendSlug}/invite`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify(invite)}).catch(()=>{});
}

async function declineInvite(chatUrl,inviterSlug){
  fetch(`${CFG.webhook_base_url}/${inviterSlug}/declined`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"declined",chatUrl,bySlug:S.hookSlug})}).catch(()=>{});
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
    fetch(`${CFG.webhook_base_url}/${chat.peerSlug}/message`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"message",chatUrl:chat.chat_url,payload:enc})}).catch(()=>queue.push(enc));
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
    fetch(`${CFG.webhook_base_url}/${chat.peerSlug}/flush`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"flush",chatUrl:chat.chat_url,ts:Date.now()})}).catch(()=>{});
  }
}

/* WEBHOOK HANDLER */
async function onIncomingWebhook(webhookRequest){
  const msgType = webhookRequest.path?.replace(/^\//, '') || webhookRequest.type;

  switch(msgType){
  case"invite":{
    const msg = webhookRequest;
    if(!S.personal.chats.some(c=>c.chat_url===msg.chatUrl)){
      S.personal.chats.push({chat_url:msg.chatUrl,key_hex:msg.keyHex,peerSlug:msg.fromSlug,peerEmail:msg.fromEmail,nickname:null});
      await ok0.putPersonalBlob(); ok0.db.profile.put({key:"me",data:S.personal});
    }
    fetch(`${CFG.webhook_base_url}/${msg.fromSlug}/accepted`,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({type:"accepted",chatUrl:msg.chatUrl,bySlug:S.hookSlug,byEmail:S.hookEmail})}).catch(()=>{});
    break;
  }
  case"accepted":{
    const msg = webhookRequest;
    const c=S.personal.chats.find(x=>x.chat_url===msg.chatUrl);
    if(c){
      c.peerSlug=msg.bySlug;c.peerEmail=msg.byEmail;
      await ok0.putPersonalBlob();ok0.db.profile.put({key:"me",data:S.personal});
      flushPending(c); flushPendingOffline(c);
    }
    break;
  }
  case"declined":{
    const msg = webhookRequest;
    const idx=S.personal.chats.findIndex(c=>c.chat_url===msg.chatUrl);
    if(idx!==-1){
      const ch=S.personal.chats[idx];
      if(!ch.peerSlug){
        S.personal.chats.splice(idx,1);delete pending[ch.chat_url];delete pendingOffline[ch.chat_url];
        await ok0.putPersonalBlob();ok0.db.profile.put({key:"me",data:S.personal});
      }
    }
    break;
  }
  case"flush": {
    const msg = webhookRequest;
    await flushChat(msg.chatUrl);
    break;
  }
  case"message":{
    const msg = webhookRequest;
    await initChatDoc(msg.chatUrl);
    amChange(msg.chatUrl,d=>{d.log=d.log||[];d.log.push(msg.payload);});
    chatDocs[msg.chatUrl].dirty=true;
    break;
  }
  default:
    console.warn("Unknown incoming webhook type or path:", msgType, webhookRequest);
  }
}

/* PRESENCE */
async function updateMyEndpointAll(){
  for(const ch of S.personal.chats){
    await initChatDoc(ch.chat_url,ch.key_hex);
    amChange(ch.chat_url,d=>{d.meta=d.meta||{};
      d.meta[S.myPubKeyHex]={slug:S.hookSlug,http:S.hookUrl,email:S.hookEmail,ts:Date.now()};
    });
  }
}
document.addEventListener("ok0:newSlug",updateMyEndpointAll);

/* Set Static Webhook Paths on Login */
async function setStaticWebhookPaths() {
  if (!S.hookUrl || !S.sessionToken) {
    // If not logged in or token not available, ensure promise is not left hanging.
    // This case usually means ok0:newSlug hasn't fired yet, so it will be called again.
    return Promise.reject(new Error("Hook URL or session token not available for setting static paths."));
  }

  if (setPathsPromise) { // If already in progress, return the existing promise
    return setPathsPromise;
  }

  setPathsPromise = new Promise(async (resolve, reject) => {
    console.log("Attempting to set static webhook paths for token:", S.hookSlug);
    let allPathsSetSuccessfully = true;

    for (const path of STATIC_WEBHOOK_PATHS) {
      const fullPath = `/${path}`;
      const endpoint = `${S.hookUrl}/paths${fullPath}`;
      const payload = {
        response_body: JSON.stringify({ status: "ok", path: fullPath, received: true }),
        response_content_type: "application/json"
      };

      try {
        const r = await fetch(endpoint, {
          method: "PUT",
          headers: {
            'Content-Type': 'application/json',
            '0K-Token': S.sessionToken
          },
          body: JSON.stringify(payload)
        });

        if (r.ok) {
          console.log(`Successfully set webhook path: ${fullPath}`);
        } else {
          allPathsSetSuccessfully = false;
          const errorText = await r.text();
          console.error(`Failed to set webhook path ${fullPath}: HTTP ${r.status} - ${r.statusText}, Body: ${errorText}`);
        }
      } catch (e) {
        allPathsSetSuccessfully = false;
        console.error(`Error setting webhook path ${fullPath}:`, e);
      }
    }

    if (allPathsSetSuccessfully) {
      console.log("%cAll static webhook paths configured successfully!", "color: green; font-weight: bold;");
      staticPathsReady = true; // Set the flag
      resolve();
    } else {
      console.error("%cFailed to configure all static webhook paths.", "color: red; font-weight: bold;");
      staticPathsReady = false; // Ensure flag is false on failure
      reject(new Error("Failed to set all static webhook paths."));
    }
    setPathsPromise = null; // Clear the promise after completion (success or failure)
  });

  return setPathsPromise;
}

// Ensure setStaticWebhookPaths is called when the slug is available
document.addEventListener("ok0:newSlug", async () => {
    try {
        await setStaticWebhookPaths();
    } catch (e) {
        console.error("Initial static path setup failed, polling might not start:", e);
    }
});

/* LONG-POLL */
let lastPoll=0;
(async function poll(){
  for(;;){
    // Wait until static paths are confirmed ready
    if (!staticPathsReady) {
        // If there's an ongoing promise to set paths, wait for it
        if (setPathsPromise) {
            try {
                await setPathsPromise;
            } catch (e) {
                // If setting paths failed, polling cannot proceed reliably.
                console.error("Polling cannot start: Static webhook paths failed to set up.", e);
                await new Promise(r => setTimeout(r, DEF_FALLBACK)); // Wait longer on failure
                continue; // Retry after delay
            }
        } else {
            // If staticPathsReady is false but no promise is active, means setup hasn't been attempted yet
            // or failed previously without a promise. Wait and retry.
            console.log("Waiting for static webhook paths to be ready before polling...");
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
    }

    // Ensure session is active before polling
    if(!S.hookUrl || !S.sessionToken){await new Promise(r=>setTimeout(r,2000));continue;}

    try{
      const url=`${S.hookUrl}/requests?min_id=${lastPoll}&sort=asc&limit=20`;
      const r=await fetch(url,{
        cache:"no-store",
        headers: { '0K-Token': S.sessionToken }
      });
      if(r.ok){
        const list=await r.json();
        for(const it of list){
          lastPoll=Math.max(lastPoll,it.id);
          try{
            let parsedContent;
            try {
                parsedContent = JSON.parse(it.content);
            } catch (jsonErr) {
                console.warn("Could not parse incoming webhook content as JSON:", it.content, jsonErr);
                parsedContent = { raw_content: it.content, type: 'unknown_raw' };
            }

            if (it.path) {
                parsedContent.path = it.path;
            }

            await onIncomingWebhook(parsedContent);
          }catch(e){
            console.error("Error processing incoming webhook:", e);
          }
        }
      } else {
        console.warn(`Polling failed: HTTP ${r.status} - ${r.statusText}`);
        if (r.status === 401 || r.status === 404) {
          console.error("Authentication or token issue during polling. Consider re-authenticating.");
        }
      }
    }catch(e){
      console.error("Polling error:", e);
    }
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
