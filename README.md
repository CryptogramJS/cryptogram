# Cryptogram

A privacy-first, browser-based chat dApp built with client-side encryption, webhook-backed storage, and Automerge CRDTs. Offline-safe and end-to-end encrypted using libsodium, with zero-knowledge personal blobs and seamless invite flow. Perfect for secure, peer-to-peer messaging without relying on centralized servers.

## Introduction

Cryptogram is a chat application demonstrating "zero-knowledge" and decentralized communication concepts. The primary goal is to showcase how core cryptographic operations can be performed exclusively client-side, without storing sensitive information on central servers, while utilizing public web services for data persistence and messaging.

## Key Principles and Features

* **Zero-Knowledge**: All cryptographic operations, including key generation, encryption, and decryption, occur solely on the user's device. External servers store only encrypted data.
* **Decentralized Architecture**: Leverages public web services (`jsonblob.com` for encrypted data storage and `webhook.site` for messaging) to avoid reliance on centralized servers.
* **Offline Persistence**: Utilizes IndexedDB (via Dexie.js) to store encrypted data locally, enhancing offline functionality.
* **CRDT Synchronization (Automerge)**: Manages chat documents using Automerge (CRDT), ensuring data consistency.
* **OpenTimestamps (OTS) Verification**: Verifies chat document integrity and immutability with cryptographic proofs.
* **Minimalist Experience**: A simple UI demonstrating core technical concepts.

## Project Structure

* **index.html**: Defines the UI structure and resources.
* **config.json**: Contains configuration for API endpoints and parameters.
* **sha.js**: SHA256 hashing implementation.
* **validator.js**: User input validation utilities.
* **0knowledge.js**: Core application logic including cryptography, data management, and external interactions.
* **dapp.js**: UI layer managing DOM, interactions, and calls to core logic.

## How to Run the Application

### 1. Clone or Download the Files

* **Clone repository**:

  ```bash
  git clone [REPOSITORY_URL]
  cd [REPOSITORY_FOLDER_NAME]
  ```
* **Direct download**: Ensure all files are in one directory.

### 2. Start a Local Web Server

ES modules and fetch require a local server:

* **Using Node.js (`http-server`)**:

  ```bash
  npm install -g http-server
  http-server
  ```

  Open browser at: `http://localhost:8080`.

* **VS Code Extension**: "Live Server".

### 3. Use the Application

* **Register**: Save generated recovery token.
* **Login**: Authenticate with token.
* **Invite Friends**: Use friend's slug.
* **Accept Invites**: Under "Invites" tab.
* **Send Messages**: Encrypted chats.

## Workflow Analysis

### 1. Account Registration

* Generates keys and secret seed.
* Creates and encrypts personal blob on `jsonblob.com`.
* Stores profile locally.
* Provides a recovery token.

### 2. User Login

* Authenticates using recovery token.
* Fetches and decrypts personal data.
* Establishes webhook session.
* Builds UI and caches session.

### 3. Invite Sending

* Creates chat blob and symmetric key.
* Adds chat to personal data.
* Sends invite via webhook.

### 4. Invite Acceptance

* Receives invite via webhook.
* Processes and stores new chat details.
* Sends acceptance confirmation.

### 5. Chat Messaging

* Encrypts/decrypts messages using libsodium.
* Syncs Automerge chat documents.
* Sends messages via webhook.

### 6. Synchronization and Flushing

* Periodically syncs chats via Automerge merge operations.
* Flushes updates remotely with OTS stamping for data integrity.

### 7. OpenTimestamps (OTS) Verification

* Verifies snapshots via OTS cryptographic proofs.
* Provides UI feedback for verification results.
