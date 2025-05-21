/*****************************************************************
 * 0knowledge.js – core crypto + storage + invite/chat logic
 * MVP 2025-05 – webhook-based • Automerge persistence • offline-safe
 *****************************************************************/
(() => {
    const { sodium, Dexie, Automerge } = window;

    /* CONFIG (lazy-loaded) + DB */
    const CFG = {};
    const db = new Dexie('ok0'); // one DB version for whole app
    db.version(2).stores({ profile: 'key', doc: 'id' });

    /* UTILS */
    const utils = {
        slugToUsername: s => BigInt('0x' + s.replace(/-/g, '')).toString(36),
        usernameToSlug(u) {
            let v = 0n;
            for (const ch of u) v = v * 36n + BigInt(parseInt(ch, 36));
            return v.toString(10);
        },
        sha256: str => window.sha256(str),
        sha256Raw: buf => Array.from(sodium.crypto_generichash(32, buf)).map(b => b.toString(16).padStart(2, '0')).join('')
    };

    /* STATE */
    let personal = null,
        secretKey = null,
        blobUrl = '';
    let myUsername = '',
        myPubKeyHex = '';
    let hookSlug = '',
        hookUrl = '',
        hookEmail = '';

    /* PERSONAL BLOB ------------------------------------------------------------ */
    const seedFromHex = h => sodium.from_hex(h);

    function keysFromSeed(seed){
        const { publicKey, privateKey } = sodium.crypto_sign_seed_keypair(seed);
        // Derive a symmetric key for personal blob encryption
        const sym = sodium.crypto_generichash(32, sodium.from_string('personal_blob_key_derivation'), seed);
        return { publicKey, privateKey, sym };
    }

    const lockPersonal = () => {
        const n = sodium.randombytes_buf(24); // Nonce for secretbox
        const c = sodium.crypto_secretbox_easy(
            sodium.from_string(JSON.stringify(personal)), n, secretKey);
        return { nonce: sodium.to_base64(n), ciphertext: sodium.to_base64(c) };
    };

    const unlockPersonal = enc => {
        const p = sodium.crypto_secretbox_open_easy(
            sodium.from_base64(enc.ciphertext),sodium.from_base64(enc.nonce),secretKey);
        if(!p) throw Error('Decryption failed: incorrect key or corrupted data.');
        return JSON.parse(sodium.to_string(p));
    };

    async function putPersonalBlob() {
        const body = JSON.stringify(lockPersonal());
        let r;
        try {
            r = await fetch(blobUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
            if (r.status === 404) {
                console.warn('Blob not found, attempting POST to create.');
                r = await fetch(blobUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            }
            if (!r.ok) {
                throw new Error(`HTTP error saving personal blob: ${r.statusText} (Status: ${r.status})`);
            }
        } catch (e) {
            console.error('Error saving personal blob:', e);
            throw e;
        }
        return r;
    }

    const cacheProfile = () => {
        try {
            db.profile.put({ key: 'me', data: personal });
        } catch (e) {
            console.error('Error caching profile in IndexedDB:', e);
        }
    };

    /* WEBHOOK SESSION ---------------------------------------------------------- */
    async function newWebhookSession() {
        try {
            const r = await fetch(CFG.webhook_create_endpoint, { method: 'POST' });
            if (!r.ok) {
                throw new Error(`Error creating webhook session: ${r.statusText} (Status: ${r.status})`);
            }
            // FIX: Parse the JSON response and extract the UUID
            const responseJson = await r.json();
            hookSlug = responseJson.uuid; // Extract the UUID from the JSON response
            
            hookUrl = `${CFG.webhook_base_url}/${hookSlug}`;
            hookEmail = `${hookSlug}@${CFG.webhook_email_domain}`;
            localStorage.setItem('0k_webhook_slug', hookSlug);
            localStorage.setItem('0k_webhook_url', hookUrl);
            localStorage.setItem('0k_webhook_email', hookEmail);
            console.log('New webhook session created:', hookSlug);
        } catch (e) {
            console.error('Error creating webhook session:', e);
            throw e;
        }
    }

    /* SESSION TOKEN */
    function setSessionToken(ttl) {
        const rnd = [...crypto.getRandomValues(new Uint8Array(16))]
            .map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('0k_token', rnd);
        localStorage.setItem('0k_token_exp', (Date.now() + ttl).toString());
        console.log('Session token set.');
    }

    const isSession = () => Date.now() < +(localStorage.getItem('0k_token_exp') || 0);
    const hasPersonal = () => personal !== null;

    /* OPEN-TIMESTAMPS ---------------------------------------------------------- */
    async function otsStamp(hashHex) {
        if (!CFG.ots_stamp_endpoint) {
            console.warn('OTS stamp endpoint not configured.');
            return null;
        }
        try {
            const r = await fetch(CFG.ots_stamp_endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: hashHex
            });
            if (!r.ok) {
                console.error(`Error stamping OTS: ${r.statusText} (Status: ${r.status})`);
                return null;
            }
            return sodium.to_base64(new Uint8Array(await r.arrayBuffer()));
        } catch (e) {
            console.error('Error stamping OTS:', e);
            return null;
        }
    }

    async function otsVerify(hashHex) {
        if (!CFG.ots_proof_endpoint) {
            console.warn('OTS proof endpoint not configured.');
            return false;
        }
        try {
            const r = await fetch(`${CFG.ots_proof_endpoint}${hashHex}`, { cache: 'no-store' });
            if (!r.ok) {
                console.warn(`Error verifying OTS: ${r.statusText} (Status: ${r.status})`);
                return false;
            }
            return (await r.arrayBuffer()).byteLength > 0;
        } catch (e) {
            console.error('Error verifying OTS:', e);
            return false;
        }
    }

    /* CRDT CHAT --------------------------------------------------------------- */
    const chatDocs = {};
    const DEF_SYNC_MS = 3000;
    const DEF_FALLBACK = 30000;

    /**
     * Determines if it's safe to push local changes to the chat blob.
     * This simple logic prevents direct overwrites in case of concurrent modifications.
     * @param {object} localMeta - Local Automerge document metadata.
     * @param {object} remoteMeta - Remote Automerge document metadata from the server.
     * @returns {boolean} True if it's safe to push, otherwise false.
     */
    function safeToPush(localMeta, remoteMeta) {
        // If no remote metadata or no last writer, it's safe.
        if (!remoteMeta?.lastWriter) return true;
        // If I am the last writer, it's safe.
        if (remoteMeta.lastWriter === myPubKeyHex) return true;
        // If the remote modification is old (past fallback time), it's safe.
        if ((remoteMeta.lastModified || 0) + (CFG.chat_write_fallback_ms || DEF_FALLBACK) < Date.now()) return true;
        // Otherwise, use a tie-breaker based on public key (lexicographical).
        // The one with the lexicographically smaller public key has priority.
        return myPubKeyHex < remoteMeta.lastWriter;
    }

    /**
     * Initializes or loads an Automerge document for chat.
     * @param {string} url - The chat blob URL.
     * @param {string} [keyHex] - The symmetric chat key in hex format.
     */
    async function initChatDoc(url, keyHex) {
        if (chatDocs[url]) {
            if (keyHex && !chatDocs[url].key) {
                chatDocs[url].key = sodium.from_hex(keyHex);
            }
            return;
        }

        let doc = Automerge.init();
        let meta = { lastModified: 0, lastWriter: '' };
        let key = keyHex ? sodium.from_hex(keyHex) : null;

        try {
            const r = await fetch(url);
            if (r.ok) {
                const j = await r.json();
                if (j.bin) {
                    doc = Automerge.load(new Uint8Array(j.bin));
                    meta = j.meta;
                }
            }
        } catch (e) {
            console.warn(`Error loading chat document from ${url}:`, e);
        }

        if (chatDocs[url] && chatDocs[url].interval) {
            clearInterval(chatDocs[url].interval);
        }
        const interval = setInterval(() => syncChat(url), CFG.chat_sync_interval_ms || DEF_SYNC_MS);
        chatDocs[url] = { doc, meta, key, interval, dirty: false };
        console.log(`Chat doc initialized for ${url}.`);

        /* OTS init */
        if (!doc.meta?.ots?.init) {
            const h0 = utils.sha256(`${url}${keyHex || ''}`);
            const proof = await otsStamp(h0);
            if (proof) {
                amChange(url, d => {
                    d.meta.ots = { init: proof, flush: {} };
                });
                console.log(`OTS init stamp created for ${url}.`);
            }
        }
    }

    /**
     * Applies a change to the Automerge document and marks the document as "dirty".
     * @param {string} url - The chat blob URL.
     * @param {function} fn - The Automerge change function.
     */
    function amChange(url, fn) {
        const ctx = chatDocs[url];
        if (!ctx) {
            console.error(`Missing chat context for URL: ${url}`);
            return;
        }
        const prevHeads = Automerge.getHeads(ctx.doc);
        ctx.doc = Automerge.change(ctx.doc, fn);
        if (!Automerge.equals(prevHeads, Automerge.getHeads(ctx.doc))) {
            ctx.meta.lastModified = Date.now();
            ctx.meta.lastWriter = myPubKeyHex;
            ctx.dirty = true;
            console.log(`Change applied and chat marked dirty for ${url}.`);
        }
    }

    /**
     * Pushes local chat document changes to the remote blob.
     * Includes OTS stamping logic for each flush.
     * @param {string} url - The chat blob URL.
     */
    async function flushChat(url) {
        const ctx = chatDocs[url];
        if (!ctx || !ctx.dirty) {
            return;
        }
        console.log(`Starting flush for ${url}.`);

        await syncChat(url);

        if (!ctx.dirty) {
            console.log(`Flush cancelled for ${url} - no local changes after sync.`);
            return;
        }

        try {
            const remoteResponse = await fetch(url);
            let remoteJson = null;
            if (remoteResponse.ok) {
                remoteJson = await remoteResponse.json();
            }

            if (remoteJson && !safeToPush(ctx.meta, remoteJson.meta)) {
                console.warn(`Not safe to push changes for ${url}. Another modification detected recently. Retrying on next sync.`);
                ctx.dirty = true;
                return;
            }
        } catch (e) {
            console.error(`Error checking remote state before flush for ${url}:`, e);
            ctx.dirty = true;
            return;
        }

        ctx.dirty = false;
        const bin = Automerge.save(ctx.doc);
        const proof = await otsStamp(utils.sha256Raw(bin));

        if (proof) {
            amChange(url, d => {
                d.meta.ots = d.meta.ots || {};
                d.meta.ots.flush = d.meta.ots.flush || {};
                d.meta.ots.flush[Date.now()] = proof;
            });
            console.log(`OTS flush stamp created for ${url}.`);
        }

        try {
            const r = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bin: Array.from(bin), meta: ctx.meta })
            });
            if (!r.ok) {
                throw new Error(`HTTP error during flush: ${r.statusText} (Status: ${r.status})`);
            }
            console.log(`Flush successful for ${url}.`);
        } catch (e) {
            console.error(`Error during flush for ${url}:`, e);
            ctx.dirty = true;
        }
    }

    /**
     * Synchronizes the chat document with the remote version.
     * This is a "pull" operation.
     * @param {string} url - The chat blob URL.
     */
    async function syncChat(url) {
        const ctx = chatDocs[url];
        if (!ctx) {
            console.warn(`Missing chat context for sync: ${url}`);
            return;
        }
        let remoteJson = null;
        try {
            const r = await fetch(url);
            if (r.ok) {
                remoteJson = await r.json();
            }
        } catch (e) {
            console.warn(`Error fetching for sync ${url}:`, e);
            return;
        }

        if (!remoteJson?.bin) {
            console.log(`No valid remote data for sync ${url}.`);
            return;
        }

        if (remoteJson.meta.lastModified > ctx.meta.lastModified ||
            (remoteJson.meta.lastModified === ctx.meta.lastModified && remoteJson.meta.lastWriter !== ctx.meta.lastWriter)) {
            try {
                const mergedDoc = Automerge.merge(ctx.doc, Automerge.load(new Uint8Array(remoteJson.bin)));
                if (!Automerge.equals(Automerge.getHeads(ctx.doc), Automerge.getHeads(mergedDoc))) {
                    ctx.doc = mergedDoc;
                    ctx.meta = remoteJson.meta;
                    ctx.dirty = true;
                    console.log(`Sync and merge successful for ${url}. Document is now dirty.`);
                } else {
                    console.log(`Sync for ${url}: No new or relevant changes found.`);
                }
            } catch (e) {
                console.error(`Error during merge in sync for ${url}:`, e);
            }
        } else {
            console.log(`Sync for ${url}: Local version is up-to-date or newer.`);
        }
    }

    /**
     * Extracts and decrypts messages from a chat document.
     * @param {string} url - The chat blob URL.
     * @returns {Array<object>} An array of decrypted message objects.
     */
    function getChatMessages(url) {
        const ctx = chatDocs[url];
        if (!ctx || !ctx.doc?.log || !ctx.key) {
            console.warn(`Missing chat context, log, or key for ${url}.`);
            return [];
        }
        return ctx.doc.log.map(l => {
            try {
                const [n, c, mac] = l.split('.');
                const calc = sodium.to_base64(sodium.crypto_generichash(32, sodium.from_base64(c), ctx.key));
                if (mac !== calc) {
                    console.warn(`MAC mismatch for a message in chat ${url}. Corrupted or altered message.`);
                    return null;
                }
                const p = sodium.crypto_secretbox_open_easy(sodium.from_base64(c), sodium.from_base64(n), ctx.key);
                return JSON.parse(sodium.to_string(p));
            } catch (e) {
                console.error(`Error decrypting or parsing a message in chat ${url}:`, e);
                return null;
            }
        }).filter(Boolean).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }

    /* verifySnapshot helper (public) */
    async function verifySnapshot(chatUrl, ts) {
        try {
            await initChatDoc(chatUrl);
            const ctx = chatDocs[chatUrl];
            if (!ctx) {
                console.error(`Missing chat context for snapshot verification: ${chatUrl}`);
                return false;
            }
            const proof = ctx.doc.meta?.ots?.flush?.[ts];
            if (!proof) {
                console.warn(`No OTS proof found for timestamp ${ts} in chat ${chatUrl}.`);
                return false;
            }
            const bin = Automerge.save(ctx.doc);
            return otsVerify(utils.sha256Raw(bin));
        } catch (e) {
            console.error(`Error in verifySnapshot for ${chatUrl} at ts ${ts}:`, e);
            return false;
        }
    }

    /* CHAT META / NICK */
    async function ensureChat(chat) {
        try {
            await initChatDoc(chat.chat_url, chat.key_hex);
            amChange(chat.chat_url, d => {
                d.meta = d.meta || {};
                d.meta[hookSlug] = { http: hookUrl, email: hookEmail };
                if (chat.peerSlug) {
                    d.meta[chat.peerSlug] = { http: `${CFG.webhook_base_url}/${chat.peerSlug}`, email: chat.peerEmail };
                }
            });
            console.log(`Chat metadata ensured for ${chat.chat_url}.`);
        } catch (e) {
            console.error(`Error ensuring chat metadata for ${chat.chat_url}:`, e);
            throw e;
        }
    }

    async function setNickname(chatUrl, nick) {
        try {
            const c = personal.chats.find(x => x.chat_url === chatUrl);
            if (c) {
                c.nickname = nick;
                await putPersonalBlob();
                cacheProfile();
                console.log(`Nickname set for chat ${chatUrl}: ${nick}`);
            } else {
                console.warn(`Chat ${chatUrl} not found to set nickname.`);
            }
        } catch (e) {
            console.error(`Error setting nickname for chat ${chatUrl}:`, e);
            throw e;
        }
    }

    /* ACCOUNT -------------------------------------------------- */
    async function createAccount() {
        try {
            const seed = sodium.randombytes_buf(32);
            const entropyHex = sodium.to_hex(seed);
            const { publicKey, sym } = keysFromSeed(seed);
            secretKey = sym;
            myPubKeyHex = sodium.to_hex(publicKey);
            personal = {
                pubkey: sodium.to_base64(publicKey),
                session: { issued: Date.now(), expires: Date.now() + CFG.token_lifetime_ms, last_login: null, last_logout: null},
                chats: []
            };
            const r = await fetch(CFG.jsonblob_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: '', ciphertext: '' }) });
            if (!r.ok) {
                throw new Error(`Error creating initial blob: ${r.statusText} (Status: ${r.status})`);
            }
            blobUrl = r.headers.get('Location').replace(/^http:/, 'https:');
            await putPersonalBlob();
            cacheProfile();
            console.log('Account created successfully. Blob URL:', blobUrl);
            return sodium.to_base64(sodium.from_string(JSON.stringify({ entropy: entropyHex, slug: blobUrl.split('/').pop() })));
        } catch (e) {
            console.error('Error in createAccount:', e);
            throw e;
        }
    }

    async function authenticate(ext) {
        try {
            const { entropy, slug } = JSON.parse(sodium.to_string(sodium.from_base64(ext)));
            const { publicKey, sym } = keysFromSeed(seedFromHex(entropy));
            secretKey = sym;
            myPubKeyHex = sodium.to_hex(publicKey);
            blobUrl = `${CFG.jsonblob_endpoint}/${slug}`;
            personal = unlockPersonal(await fetch(blobUrl).then(r => {
                if (!r.ok) throw new Error(`Error fetching personal blob: ${r.statusText} (Status: ${r.status})`);
                return r.json();
            }));
            personal.session.last_login = Date.now();
            await putPersonalBlob();
            cacheProfile();
            await newWebhookSession();
            myUsername = utils.slugToUsername(hookSlug);
            localStorage.setItem('0k_blob_url', blobUrl);
            localStorage.setItem('0k_username', myUsername);
            setSessionToken(CFG.token_lifetime_ms);
            console.log('Authentication successful. User:', myUsername);
            return myUsername;
        } catch (e) {
            console.error('Error in authenticate:', e);
            throw e;
        }
    }

    /* INVITES -------------------------------------------------- */
    async function sendInvite(friendSlug) {
        try {
            const r = await fetch(CFG.jsonblob_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (!r.ok) {
                throw new Error(`Error creating blob for invitation: ${r.statusText} (Status: ${r.status})`);
            }
            const chatUrl = r.headers.get('Location').replace(/^http:/, 'https:');
            const ts_hex = Date.now().toString(16);
            const keyHex = await utils.sha256(ts_hex + 'chat');
            personal.chats.push({ chat_url: chatUrl, key_hex: keyHex, peerSlug: null, peerEmail: null, nickname: null });
            await putPersonalBlob();
            cacheProfile();
            const invite = { type: 'invite', chatUrl, keyHex, ts: ts_hex, fromSlug: hookSlug, fromEmail: hookEmail };
            await fetch(`${CFG.webhook_base_url}/${friendSlug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(invite) })
                .catch(e => console.warn('Error sending invitation webhook:', e));
            console.log(`Invitation sent to ${friendSlug} for chat ${chatUrl}.`);
        } catch (e) {
            console.error('Error in sendInvite:', e);
            throw e;
        }
    }

    async function onIncomingWebhook(msg) {
        console.log('Webhook received:', msg.type, msg);
        try {
            switch (msg.type) {
                case 'invite':
                    {
                        if (!personal.chats.some(c => c.chat_url === msg.chatUrl)) {
                            personal.chats.push({ chat_url: msg.chatUrl, key_hex: msg.keyHex, peerSlug: msg.fromSlug, peerEmail: msg.fromEmail, nickname: null });
                            await putPersonalBlob();
                            cacheProfile();
                            console.log(`Invitation accepted and chat added: ${msg.chatUrl}`);
                        } else {
                            console.warn(`Duplicate invitation for chat ${msg.chatUrl} ignored.`);
                        }

                        const mySlug = localStorage.getItem('0k_webhook_slug');
                        const myEmail = localStorage.getItem('0k_webhook_email');
                        if (mySlug && myEmail) {
                            fetch(`${CFG.webhook_base_url}/${msg.fromSlug}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ type: 'accepted', chatUrl: msg.chatUrl, bySlug: mySlug, byEmail: myEmail })
                            }).catch(e => console.warn('Error sending acceptance confirmation:', e));
                        }
                        break;
                    }
                case 'accepted':
                    {
                        const c = personal.chats.find(x => x.chat_url === msg.chatUrl);
                        if (c) {
                            c.peerSlug = msg.bySlug;
                            c.peerEmail = msg.byEmail;
                            await putPersonalBlob();
                            cacheProfile();
                            console.log(`Invitation accepted by ${msg.bySlug} for chat ${msg.chatUrl}.`);
                        } else {
                            console.warn(`Chat ${msg.chatUrl} not found to mark as accepted.`);
                        }
                        break;
                    }
                case 'flush':
                    await flushChat(msg.chatUrl);
                    console.log(`Flush webhook received for ${msg.chatUrl}.`);
                    break;
                case 'message':
                    await initChatDoc(msg.chatUrl);
                    amChange(msg.chatUrl, d => {
                        d.log = d.log || [];
                        d.log.push(msg.payload);
                    });
                    chatDocs[msg.chatUrl].dirty = true;
                    console.log(`Message webhook received for ${msg.chatUrl}.`);
                    break;
                default:
                    console.warn('Unknown webhook type:', msg.type);
            }
        } catch (e) {
            console.error('Error processing webhook:', e);
        }
    }

    /* MESSAGING ------------------------------------------------ */
    async function sendMessage(chat, txt) {
        try {
            await ensureChat(chat);
            const ctx = chatDocs[chat.chat_url];
            if (!ctx || !ctx.key) {
                throw new Error('Missing chat context or key for sending message.');
            }

            const n = sodium.randombytes_buf(24);
            const messagePayload = JSON.stringify({ from: myUsername, txt, ts: Date.now() });
            const cipher = sodium.crypto_secretbox_easy(
                sodium.from_string(messagePayload), n, ctx.key);
            const mac = sodium.crypto_generichash(32, cipher, ctx.key);
            const enc = `${sodium.to_base64(n)}.${sodium.to_base64(cipher)}.${sodium.to_base64(mac)}`;

            amChange(chat.chat_url, d => {
                d.log = d.log || [];
                d.log.push(enc);
            });
            ctx.dirty = true;
            console.log(`Local message added and marked dirty for ${chat.chat_url}.`);

            if (chat.peerSlug) {
                fetch(`${CFG.webhook_base_url}/${chat.peerSlug}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'message', chatUrl: chat.chat_url, payload: enc })
                }).catch(e => console.warn('Error sending message webhook to peer:', e));
                console.log(`Message webhook sent to peer ${chat.peerSlug}.`);
            }
        } catch (e) {
            console.error('Error in sendMessage:', e);
            throw e;
        }
    }

    /* CLOSE CHAT & BEACON ------------------------------------------------------- */
    async function closeChat(chat) {
        try {
            await flushChat(chat.chat_url);
            if (chat.peerSlug) {
                fetch(`${CFG.webhook_base_url}/${chat.peerSlug}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'flush', chatUrl: chat.chat_url, ts: Date.now() })
                }).catch(e => console.warn('Error sending flush webhook to peer:', e));
            }
            console.log(`Chat closed and flush initiated for ${chat.chat_url}.`);
        } catch (e) {
            console.error('Error in closeChat:', e);
        }
    }

    window.addEventListener('pagehide', () => {
        for (const [url, ctx] of Object.entries(chatDocs)) {
            if (!ctx.dirty) continue;
            try {
                const bin = Automerge.save(ctx.doc);
                navigator.sendBeacon(url, JSON.stringify({ bin: Array.from(bin), meta: ctx.meta }));
                ctx.dirty = false;
                console.log(`Beacon sent for dirty chat on pagehide: ${url}.`);
            } catch (e) {
                console.error(`Error sending beacon for ${url}:`, e);
            }
        }
    });

    window.addEventListener('online', () => {
        console.log('Application back online. Reloading page...');
        location.reload(true);
    });

    /* LOGOUT --------------------------------------------------- */
    async function logout() {
        try {
            ['0k_webhook_slug', '0k_webhook_url', '0k_webhook_email',
                '0k_token', '0k_token_exp', '0k_blob_url', '0k_username'
            ]
            .forEach(k => localStorage.removeItem(k));
            await db.delete();
            personal = secretKey = blobUrl = myUsername = '';
            Object.values(chatDocs).forEach(c => clearInterval(c.interval));
            console.log('Full logout and local data cleared.');
        } catch (e) {
            console.error('Error in logout:', e);
            throw e;
        }
    }

    /* EXPORT --------------------------------------------------- */
    window.ok0 = {
        /* flows */ createAccount,
        authenticate,
        logout,
        /* status */ isSession,
        hasPersonal,
        /* chat  */ sendInvite,
        sendMessage,
        closeChat,
        ensureChat,
        getChatMessages,
        onIncomingWebhook,
        setNickname,
        /* OTS   */ verifySnapshot,
        /* misc  */ utils,
        db,
        cfg: CFG
    };

    /* INIT CONFIG --------------------------------------------- */
    (async () => {
        await sodium.ready;
        try {
            Object.assign(CFG, await fetch('config.json').then(r => {
                if (!r.ok) throw new Error(`Error loading config.json: ${r.statusText} (Status: ${r.status})`);
                return r.json();
            }));
            console.log('Configuration loaded:', CFG);
        } catch (e) {
            console.error('Error loading configuration:', e);
        }
    })();
})();
