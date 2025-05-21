# cryptogram
A privacy-first, browser-based chat dApp built with client-side encryption, webhook-backed storage, and Automerge CRDTs. Offline-safe and end-to-end encrypted using libsodium, with zero-knowledge personal blobs and seamless invite flow. Perfect for secure, peer-to-peer messaging without relying on centralized servers.

Introduction
Cryptogram is a chat application demonstrating "zero-knowledge" and decentralized communication concepts. The primary goal of this project is to showcase how core cryptographic operations can be performed exclusively client-side, without storing sensitive information on central servers, while utilizing public web services for data persistence and messaging.

Key Principles and Features
Zero-Knowledge: All cryptographic operations, including key generation, encryption, and decryption of messages and personal data, occur solely on the user's device. External servers store only encrypted data, without access to the plaintext content.

Decentralized Architecture: The application leverages public web services (jsonblob.com for encrypted data storage and webhook.site for messaging) to avoid reliance on a centralized messaging server.

Offline Persistence: Thanks to IndexedDB (via Dexie.js), the application can store encrypted data locally, enabling partial offline functionality and an improved user experience.

CRDT Synchronization (Automerge): Chat documents are managed using Automerge, an implementation of Conflict-free Replicated Data Types (CRDTs), ensuring data consistency among participants even with concurrent modifications.

OpenTimestamps (OTS) Verification: The integrity and immutability of chat document snapshots can be verified via OpenTimestamps, providing cryptographic proof of data existence at a specific point in time.

Minimalist Experience: As an MVP, the user interface is simple and functional, focusing on demonstrating core technical concepts.

Project Structure
The project is organized into the following main files:

index.html: The main HTML file defining the UI structure and loading all necessary resources.

config.json: Configuration file for external API endpoints and operational parameters.

sha.js: A JavaScript module implementing the SHA256 hashing function using the Web Crypto API.

validator.js: A new JavaScript module providing utilities for user input validation.

0knowledge.js: The core application logic, including cryptography, personal data and chat management (Automerge, Dexie), and interaction with external services (webhook, OTS).

dapp.js: The user interface (UI) layer, managing DOM interactions, notifications, and orchestrating calls to functions in 0knowledge.js.

How to Run the Application
To run the Cryptogram MVP application, follow these steps:

Clone the Repository (or Save Files):

If you obtained the files from a Git repository, clone it:

git clone [REPOSITORY_URL]
cd [REPOSITORY_FOLDER_NAME]


If you downloaded the files directly, ensure all six files (index.html, config.json, sha.js, validator.js, dapp.js, 0knowledge.js) are in the same directory.

Start a Local Web Server:
Since the application uses ES modules (import ... from './file.js') and local fetch requests (for config.json), you must run it through a local web server. You cannot open it directly from your browser (e.g., file:///path/to/index.html).

With Node.js (http-server - if Node.js is installed):
Install http-server globally (one-time):

npm install -g http-server


Then, in your project directory, run:

http-server


Open your browser and navigate to the address shown (usually http://localhost:8080).

With text editor extensions: Many text editors (e.g., VS Code) offer extensions like "Live Server" that can quickly start a local server.

Use the Application:
Once the application is loaded in your browser, you can:

Register a new account: You will receive an "Extended token" that you must save.

Login: Use the saved token to authenticate.

Invite friends: Enter a friend's "slug" (which is their username).

Accept invitations: Received invitations will appear in the "Invites" tab.

Send messages: Once a chat is open, you can send encrypted messages.

Workflow Analysis
This application implements a "zero-knowledge" principle, meaning sensitive data and cryptographic operations primarily occur client-side. The dapp.js file handles the user interface and orchestrates calls to the core 0knowledge.js library, which in turn manages cryptography, data persistence, and external service interactions.

1. Account Registration Workflow
This process generates a new user account and provides a recovery token.

User Action: Clicks the "Register" button (#btn-reg).

CAPTCHA Validation (dapp.js):

The UI checks the user's CAPTCHA input against a client-side generated hash.

If invalid or too many attempts, an error message is displayed, and the process stops.

Account Creation (dapp.js calls 0knowledge.js):

dapp.js invokes ok0.createAccount().

0knowledge.js createAccount():

Generates a cryptographically secure random 32-byte seed.

Derives a public/private key pair (publicKey, privateKey) and a symmetric secretKey from this seed.

Initializes a personal data object containing the user's publicKey and session information.

Creates Remote Blob: Makes a POST request to CFG.jsonblob_endpoint with an empty body ({nonce:'',ciphertext:''}). This creates a new unique blob URL (blobUrl) on jsonblob.com for the user's encrypted personal data.

Encrypts and Stores Personal Data: Calls lockPersonal() to symmetrically encrypt the personal object using the secretKey. Then, it sends this encrypted data via a PUT request to the newly acquired blobUrl on jsonblob.com. If the PUT fails (e.g., 404), it attempts a POST.

Caches Profile Locally: Saves the personal data to IndexedDB (db.profile.put({key:'me',data:personal})).

Generates Recovery Token: Creates a base64-encoded JSON string containing the entropy (the original seed in hex) and the slug (the ID part of the blobUrl).

Returns this recovery token.

Token Display & Copy (dapp.js):

The returned token is displayed in a text area (#extended-out).

The registration message updates to "✔︎ save this token".

The user can click "OK, Got it" (#btn-reg-ok) to copy the token to the clipboard and navigate to the login tab.

2. User Login Workflow
This process authenticates the user and restores their session using the recovery token.

User Action: Enters the recovery token in the input field (#extended-inp) and clicks "Login" (#btn-log).

CAPTCHA Validation (dapp.js):

Similar to registration, the UI validates the CAPTCHA.

If invalid, an error message is displayed.

Authentication (dapp.js calls 0knowledge.js):

dapp.js invokes ok0.authenticate(token).

0knowledge.js authenticate():

Decodes Token: Parses the base64-encoded token to extract the entropy (seed) and the slug of the personal blob.

Derives Keys: Re-derives the secretKey, publicKey, and privateKey from the entropy.

Fetches Encrypted Personal Data: Constructs the blobUrl using the slug and fetches the encrypted personal blob from jsonblob.com.

Decrypts Personal Data: Calls unlockPersonal() to decrypt the fetched data using the secretKey. This populates the global personal object.

Updates Session: Sets personal.session.last_login to Date.now().

Saves Updated Personal Data: Calls putPersonalBlob() to save the updated personal data back to jsonblob.com.

Caches Profile Locally: Saves the personal data to IndexedDB.

Establishes Webhook Session: Calls newWebhookSession(), which makes a POST request to CFG.webhook_create_endpoint to obtain a new, unique webhook.site slug and URL for receiving messages and invites. This hookSlug, hookUrl, and hookEmail are stored in localStorage.

Sets Username: Derives myUsername from the hookSlug.

Stores Session Info: Saves blobUrl, myUsername, and a session token (with an expiration) to localStorage.

Returns myUsername.

Build UI (dapp.js):

dapp.js receives the myUsername and calls buildUI().

The authentication wrap (#auth-wrap) is hidden, and the dashboard wrap (#dash-wrap) is shown.

The user's slug is displayed.

loadProfile(), renderChats(), and renderInvites() are called to populate the dashboard.

3. Invite Sending Workflow
This process allows a user to initiate a new chat with another user.

User Action: Enters a friend's slug in the "Invite" modal (#slug-invite) and clicks "Send Invite" (#btn-invite).

Send Invite (dapp.js calls 0knowledge.js):

dapp.js invokes ok0.sendInvite(friendSlug).

0knowledge.js sendInvite():

Creates New Chat Document Blob: Makes a POST request to CFG.jsonblob_endpoint with an empty body ({}). This creates a new unique chatUrl on jsonblob.com that will host the Automerge chat document.

Generates Chat Key: Derives a symmetric keyHex for this chat using sha256(ts_hex + 'chat').

Adds Chat to Personal Data: Pushes a new chat entry (containing chat_url, key_hex, peerSlug: null, peerEmail: null, nickname: null) to the personal.chats array.

Saves Updated Personal Data: Calls putPersonalBlob() and cacheProfile().

Sends Invite Webhook: Constructs an invite message (containing type, chatUrl, keyHex, ts, fromSlug, fromEmail) and sends it via a POST request to the target friendSlug's webhook.site URL.

4. Invite Acceptance Workflow
This process handles a user receiving and accepting a chat invitation.

Invite Reception (External Mechanism):

The webhook.site endpoint associated with the recipient's hookSlug receives the "invite" webhook.

The dapp.js code has a mechanism to check for pending invites via a pin_url stored in a cookie. This pin_url is presumably where the webhook service logs incoming invites that might arrive before the user is logged in or actively polling.

Rendering Invites (dapp.js):

renderInvites() (called periodically by setInterval and on buildUI) fetches data from the pin_url.

It filters for new, unaccepted invites and displays them in the UI.

User Action: Clicks "accept" on a pending invite.

Accept Flow (dapp.js):

dapp.js captures the chat_url and ts from the clicked invite.

It prompts the user for a nickname for the new chat.

Fetches Initiator Slug: It fetches the chat_url blob content to extract the fromSlug of the initiator (this is a crucial step to identify the sender).

Processes Incoming Webhook (dapp.js calls 0knowledge.js): Manually calls ok0.onIncomingWebhook() with type:'invite', chatUrl, keyHex (derived from ts), fromSlug, and fromEmail.

0knowledge.js onIncomingWebhook() (for type:'invite'):

Adds the new chat entry (with chat_url, key_hex, peerSlug, peerEmail) to the personal.chats array.

Calls putPersonalBlob().

Sends Acceptance Webhook: Constructs an accepted message (containing type, chatUrl, bySlug, byEmail) and sends it via a POST request back to the fromSlug's webhook.site URL.

Sets Nickname (dapp.js calls 0knowledge.js): dapp.js then calls ok0.setNickname(chatUrl, nick) to update the chat's nickname in the user's personal data and save it.

UI Update (dapp.js): Calls renderChats() and renderInvites() to refresh the chat list and pending invites.

5. Chat Messaging Workflow
This process handles sending and receiving encrypted messages in a chat.

User Action (Sending): Types a message into the chat input (#chat-input) and clicks "Send" (#btn-send).

Send Message (dapp.js calls 0knowledge.js):

dapp.js invokes ok0.sendMessage(currentChat, text).

0knowledge.js sendMessage():

Ensures Chat Document Initialized: Calls ensureChat(currentChat).

ensureChat() calls initChatDoc(chat.chat_url, chat.key_hex). This function:

Checks if the Automerge document for this chat_url is already loaded.

If not, it attempts to fetch the existing chat document from chat.chat_url on jsonblob.com and Automerge.load() it. If no existing document, it Automerge.init() a new one.

Sets up an interval for syncChat() to periodically pull updates from jsonblob.com.

Handles initial OTS stamping for the chat document if not already done.

Uses amChange() to update the chat document's metadata with the sender's and receiver's webhook details.

Encrypts Message: Creates a message object ({from: myUsername, txt: text, ts: Date.now()}). It then encrypts this object using sodium.crypto_secretbox_easy() with the chat's symmetric ctx.key and a random nonce. A Message Authentication Code (MAC) is also generated.

Adds to Automerge Document: The encrypted message (nonce.ciphertext.mac) is pushed to the log array within the Automerge document using amChange(). The ctx.dirty flag is set to true.

Sends Message Webhook: If currentChat.peerSlug exists, a POST request is sent to the peer's webhook.site URL with a message type webhook containing the chatUrl and the encrypted payload.

Message Reception (via Webhook):

The recipient's webhook.site endpoint receives the "message" webhook.

This triggers 0knowledge.js onIncomingWebhook() (for type:'message'):

It directly pushes the received encrypted msg.payload to the log array of the relevant Automerge chat document using amChange().

Sets chatDocs[msg.chatUrl].dirty = true.

Message Display (dapp.js):

dapp.js calls loadMsgs() (periodically by chatPoll and after sending).

0knowledge.js getChatMessages(chatUrl) is called.

getChatMessages() iterates through the Automerge document's log, decrypting each message using the chat's ctx.key and verifying its MAC.

dapp.js then renders the decrypted messages in the chat pane, distinguishing between me and peer messages.

6. Chat Synchronization and Flushing Workflow
This ensures chat data is consistent across devices and persisted remotely.

Periodic Synchronization (Pull):

0knowledge.js initChatDoc() sets up an setInterval to call syncChat(url) every CFG.chat_sync_interval_ms.

syncChat(url) attempts to fetch the latest version of the chat document from jsonblob.com.

If a newer version is found, it Automerge.merge()s the remote document with the local one.

Periodic Flushing (Push):

While not explicitly on a timer for all dirty docs, flushChat(url) is called:

When a chat tab is closed (window.addEventListener('beforeunload')).

When a page is hidden (window.addEventListener('pagehide')) using navigator.sendBeacon for dirty documents.

When a flush type webhook is received (though the code for receiving flush webhooks seems to just call flushChat on the receiver, implying a peer initiated a flush).

flushChat(url):

If the ctx.dirty flag is true (meaning local changes exist), it Automerge.save()s the current local document state.

It then attempts to get an OTS stamp for the sha256Raw hash of this saved binary.

If a proof is obtained, it's added to d.meta.ots.flush in the Automerge document via amChange().

Finally, it sends a PUT request with the updated Automerge document (binary and meta) to jsonblob.com. If the PUT fails, ctx.dirty is reset to true for retry.

7. OpenTimestamps (OTS) Verification Workflow
This provides verifiable proof of a chat document's state at a point in time.

Trigger (dapp.js): When a user openChat(), dapp.js calls verifyLastOTS(chatUrl).

Verification (dapp.js calls 0knowledge.js):

dapp.js invokes ok0.verifySnapshot(chatUrl, last_ts).

0knowledge.js verifySnapshot(chatUrl, ts):

Ensures the chat document is loaded (initChatDoc(chatUrl)).

Retrieves the OTS proof (proof) associated with the given ts from ctx.doc.meta.ots.flush.

Saves Current Local Document: It Automerge.save()s the current local state of the Automerge document to a binary format.

Calculates the sha256Raw hash of this saved binary.

Calls otsVerify(hashHex) which makes a fetch request to CFG.ots_proof_endpoint to verify the proof against the hash.

Returns true if the proof is valid, false otherwise.

UI Feedback (dapp.js): Displays a toast message if the snapshot proof is invalid.
