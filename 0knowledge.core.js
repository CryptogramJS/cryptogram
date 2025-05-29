/*****************************************************************
 * 0knowledge.core.js – core crypto, storage, TSA stamp/verify
 *****************************************************************/
(() => {

/* IMPORTS */
const { sodium, Dexie } = window;

/* CONFIG */
const CFG = {};

/* DB */
const db = new Dexie("ok0");
db.version(2).stores({ profile: "key", doc: "id" });

/* UTILS */
const utils = {
  slugToUsername: s => BigInt("0x" + s.replace(/-/g, "")).toString(36),
  usernameToSlug(u) {
    let v = 0n;
    for (const ch of u) v = v * 36n + BigInt(parseInt(ch, 36));
    return v.toString(10);
  },
  sha512: async buf => {
    const h = await crypto.subtle.digest("SHA-512", buf);
    return new Uint8Array(h);
  }
};

/* STATE */
let personal = null;
let secretKey = null;
let blobUrl = "";
let myUsername = "";
let myPubKeyHex = "";
let hookSlug = "";
let hookUrl = ""; // This will now include allorigins.win
let hookEmail = "";

/* STATE GATEWAY */
const _state = {};
Object.defineProperties(_state, {
  personal:    { get: () => personal,    set: v => personal   = v },
  secretKey:   { get: () => secretKey,   set: v => secretKey  = v },
  blobUrl:     { get: () => blobUrl,     set: v => blobUrl    = v },
  myUsername:  { get: () => myUsername,  set: v => myUsername = v },
  myPubKeyHex: { get: () => myPubKeyHex, set: v => myPubKeyHex= v },
  hookSlug:    { get: () => hookSlug,    set: v => hookSlug   = v },
  hookUrl:     { get: () => hookUrl,     set: v => hookUrl    = v },
  hookEmail:   { get: () => hookEmail,   set: v => hookEmail  = v }
});

/* PERSONAL BLOB */
const seedFromHex = h => sodium.from_hex(h);
function keysFromSeed(seed) {
  const { publicKey } = sodium.crypto_sign_seed_keypair(seed);
  const sym = sodium.crypto_generichash(
      32, sodium.from_string("personal_blob_key_derivation"), seed);
  return { publicKey, sym };
}
const lockPersonal = () => {
  const n = sodium.randombytes_buf(24);
  const c = sodium.crypto_secretbox_easy(
      sodium.from_string(JSON.stringify(personal)), n, secretKey);
  return { nonce: sodium.to_base64(n), ciphertext: sodium.to_base64(c) };
};
const unlockPersonal = enc => {
  const p = sodium.crypto_secretbox_open_easy(
      sodium.from_base64(enc.ciphertext),
      sodium.from_base64(enc.nonce),
      secretKey);
  if (!p) throw Error("Decryption failed");
  return JSON.parse(sodium.to_string(p));
};
async function putPersonalBlob() {
  const body = JSON.stringify(lockPersonal());
  let r = await fetch(blobUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
  if (r.status === 404)
    r = await fetch(blobUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}
const cacheProfile = () => db.profile.put({ key: "me", data: personal }).catch(() => {});

/* WEBHOOK */
async function newWebhookSession() {
  // Use webhook_create_endpoint (with allorigins.win) for new token generation
  const r = await fetch(CFG.webhook_create_endpoint, { method: "POST" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  hookSlug  = j.uuid;
  // Set hookUrl to use CFG.webhook_base_url (which includes allorigins.win)
  hookUrl   = `${CFG.webhook_base_url}/${hookSlug}`;
  hookEmail = `${hookSlug}@${CFG.webhook_email_domain}`;
  localStorage.setItem("0k_webhook_slug", hookSlug);
  localStorage.setItem("0k_webhook_url",  hookUrl);
  localStorage.setItem("0k_webhook_email",hookEmail);
  document.dispatchEvent(new CustomEvent("ok0:newSlug", { detail:{ slug:hookSlug, http:hookUrl, email:hookEmail }}));
}

/* SESSION TOKEN */
function setSessionToken(ttl) {
  const rnd = [...crypto.getRandomValues(new Uint8Array(16))]
      .map(b => b.toString(16).padStart(2,"0")).join("");
  localStorage.setItem("0k_token", rnd);
  localStorage.setItem("0k_token_exp", (Date.now() + ttl).toString());
}
const isSession   = () => Date.now() < +(localStorage.getItem("0k_token_exp") || 0);
const hasPersonal = () => personal !== null;

/* TSA (RFC-3161) */
function buildTSQ(hashBytes) {
  if (window.KJUR?.asn1) {
    const req = new KJUR.asn1.tsp.TSPUtil.newTimeStampReq({
      hashAlg  : "sha512",
      hashValue: hashBytes,
      certreq  : false
    });
    return req.getContentInfoEncodedHex("der");
  }
  return null;
}
async function tsaStamp(hashBuf) {
  const tsqDer = buildTSQ(hashBuf);
  if (!tsqDer) return null;
  const resp = await fetch(CFG.tsa_endpoint, {
    method : "POST",
    headers: { "Content-Type": "application/timestamp-query" },
    body   : tsqDer
  });
  if (!resp.ok) return null;
  return new Uint8Array(await resp.arrayBuffer());    // TSR bytes
}

/* ACCOUNT */
async function createAccount() {
  const seed = sodium.randombytes_buf(32);
  const entropyHex = sodium.to_hex(seed);
  const { publicKey, sym } = keysFromSeed(seed);
  secretKey    = sym;
  myPubKeyHex= sodium.to_hex(publicKey);
  personal = {
    pubkey : sodium.to_base64(publicKey),
    session: { issued:Date.now(), expires:Date.now()+CFG.token_lifetime_ms, last_login:null, last_logout:null },
    chats  : []
  };
  const r = await fetch(CFG.jsonblob_endpoint, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ nonce:"", ciphertext:"" }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  blobUrl = r.headers.get("Location").replace(/^http:/,"https:");
  await putPersonalBlob();
  cacheProfile();
  const exportObj = { entropy:entropyHex, slug:blobUrl.split("/").pop() };
  return sodium.to_base64(sodium.from_string(JSON.stringify(exportObj)));
}
async function authenticate(ext) {
  const { entropy, slug } = JSON.parse(sodium.to_string(sodium.from_base64(ext)));
  const { publicKey, sym } = keysFromSeed(seedFromHex(entropy));
  secretKey     = sym;
  myPubKeyHex = sodium.to_hex(publicKey);
  blobUrl       = `${CFG.jsonblob_endpoint}/${slug}`;
  personal      = unlockPersonal(await fetch(blobUrl).then(r=>r.json()));
  personal.session.last_login = Date.now();
  await putPersonalBlob();
  cacheProfile();
  await newWebhookSession(); // Generates and sets S.hookUrl to use CFG.webhook_base_url
  myUsername = utils.slugToUsername(hookSlug);
  localStorage.setItem("0k_blob_url", blobUrl);
  localStorage.setItem("0k_username", myUsername);
  setSessionToken(CFG.token_lifetime_ms);
  return myUsername;
}

/* LOGOUT */
async function logout() {
  ["0k_webhook_slug","0k_webhook_url","0k_webhook_email","0k_token","0k_token_exp","0k_blob_url","0k_username"]
  .forEach(k=>localStorage.removeItem(k));
  await db.delete();
  personal = secretKey = blobUrl = myUsername = "";
}

/* EXPORT */
window.ok0 = {
  createAccount,
  authenticate,
  logout,
  isSession,
  hasPersonal,
  utils,
  db,
  cfg:CFG,
  putPersonalBlob,
  tsaStamp,
  _state
};

/* INIT CONFIG */
(async () => {
  await sodium.ready;
  Object.assign(CFG, await fetch("config.json").then(r=>r.json()));
})();
})();
