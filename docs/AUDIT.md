# Real-Chat-WebApp: Deep Audit

Audit date: 2026-10-19. This was a **read-only audit**. Nothing was installed, started or committed, and this file is the only write. Every source file under `backend/` and `frontend/src/` was read in full, along with the manifests, lockfiles, Dockerfile and compose file. To classify `.env` values without printing them I used a shell one-liner that reports only key, length and URI shape. To read resolved versions from the two `package-lock.json` files I used `node -e`, which parses JSON and does not execute project code. **Secret values are never reproduced in this file.**

The line numbers below are from the files as they stood on the audit date.

---

## 0. TL;DR

- **The core flow is broken for 1:1 chat.** The room id for a 1:1 chat is the *recipient's username* (`frontend/src/components/Sidebar.jsx:53`). As a result:
  - The recipient never receives messages in real time.
  - The conversation is split across two "rooms" (A→B messages go to room `"B"`, B→A messages go to room `"A"`).
  - **Any third party who opens a chat with B joins room `"B"`, and so receives and can read every message anyone sends to B.**
- **The Socket.IO layer has no authentication.** `user_join` trusts a client-supplied username (`backend/server.js:29-40`). Anyone can impersonate anyone, then send messages as them and read their rooms. `join_room` has no authorization check (`server.js:63-103`).
- **Persisted history is never shown.** The server emits `room_messages` (`server.js:100`), but the frontend never listens for it. After a reload every chat looks empty.
- **Uploads are broken and also exploitable.**
  - The frontend posts to `/api/upload`, but the real route is `/api/upload/upload` (`backend/app.js:54` + `backend/routes/uploadRoutes.js:16`), so uploads from the UI fail with 404.
  - The real route needs no authentication, has no size or type limits, and serves files from the API origin. That makes stored XSS via HTML/SVG uploads, followed by account takeover, possible right now.
- **Docker is non-functional.**
  - `backend/Dockerfile`, `mongo-init.js`, `nginx/`, `ssl/` and `frontend/nginx.conf` are missing.
  - The compose file claims host ports 27017, 6379, 5000, 80, 443, **8080 (reserved for CodeJudge)** and 8443.
- **Read receipts, unread counts, pagination, calls and the profile panel** are schema-only, faked (a 500 ms "delivered" timer) or mock data.
- **Not a git repo. Nothing has ever been committed or pushed.** `backend/.env` holds a live Atlas URI with embedded credentials. The code no longer loads that file, but the credentials should still be rotated.
- **Recommendation:** keep the UI shell (Tailwind/lucide components) as visual reference. **Rewrite the backend data model, the socket layer and the state management.** Rebuild Docker from scratch.

---

## 1. Architecture as it actually is

### 1.1 Layout

```
.env, .env.example, docker-compose.yml, .gitignore (".env" only)
backend/   Express 4 + Socket.IO 4 + Mongoose 8 (CommonJS)
  server.js       HTTP server, ALL socket handlers, Mongo connect, process handlers (526 lines)
  app.js          Express app: cookie-parser, CORS, json, static /uploads, routes, /health, /api/docs
  config.js       loads ../.env (ROOT .env, not backend/.env); throws if JWT_SECRET is unset
  middlewares/authMiddleware.js   JWT from `token` cookie → req.userId / req.username
  models/         User, Message, Contact, Group
  controllers/    authController, userController, groupController
  routes/         authRoutes, userRoutes, groupRoutes, uploadRoutes
  uploads/        empty directory
frontend/  Vite 4 + React 18 + Tailwind 3 (ESM)
  src/context/    AuthContext (fetch), SocketContext (socket + ALL chat state), ThemeContext
  src/pages/      LoginPage, ChatPage
  src/components/ Sidebar, ChatArea, MessageBubble, MessageInput, UserProfile, LoadingSpinner
                  ChatRoom.js, FileUpload.js, ../services/socket.js  ← dead leftovers
  Dockerfile      contains BOTH a backend stage and the frontend stages (misplaced)
```

### 1.2 REST routes (all mounted in `backend/app.js:51-54`)

| Method & path | Auth | Handler | Notes |
|---|---|---|---|
| POST `/api/auth/register` | – | `authController.register` | Takes username and password only. Uses bcrypt cost 12 (`authController.js:27`). |
| POST `/api/auth/login` | – | `authController.login` | Sets the `token` cookie: JWT, 24h, httpOnly, `sameSite: strict`, `secure` only in production (`:81-96`). |
| POST `/api/auth/logout` | cookie | `logout` | Clears the cookie. The JWT stays valid until it expires (stateless). |
| GET `/api/auth/me` | cookie | `getMe` | |
| GET `/api/auth/protected` | cookie | inline | Test route. |
| POST `/api/user/add-contact` | cookie | `userController.addContact` | **Creates both directions, with no consent from the other user** (`userController.js:31-41`). |
| GET `/api/user/contacts` | cookie | `getContacts` | |
| DELETE `/api/user/contacts/:contactId` | cookie | `removeContact` | |
| PUT `/api/user/contacts/:contactId/block` and `/unblock` | cookie | `blockContact` / `unblockContact` | The block flag is **never enforced** anywhere. |
| GET `/api/user/groups` | cookie | `getGroups` | |
| GET `/api/user/search?query=` | cookie | `searchUsers` | Passes raw user input to `$regex` (`:144-145`). |
| PUT `/api/user/profile` | cookie | `userController.updateProfile` | **No uniqueness check and no validation.** Lets a user change their own username, which breaks rooms, contacts and the JWT claim. |
| POST `/api/groups/create`, GET/PUT/DELETE `/api/groups/:groupId`, POST `/:groupId/members`, DELETE `/:groupId/members/:memberId`, POST `/:groupId/leave`, PUT `/:groupId/transfer-admin` | cookie | `groupController.*` | Admin checks exist and are reasonable. Deleting a group leaves its messages orphaned. |
| POST `/api/upload/upload` | **none** | inline multer | Double path. **No auth, no limits, no fileFilter** (`uploadRoutes.js:5-18`). |
| GET `/uploads/*` | none | `express.static('uploads')` | Relative to the process cwd (`app.js:30`). |
| GET `/health`, GET `/api/docs` | none | inline | `/api/docs` documents the wrong paths for uploads and contacts. |

Dead controller code: `authController.updateProfile`, `changePassword` and `getOnlineUsers` (`authController.js:151-256`) are never routed. `Message.getMessagesForRoom`, `getUnreadCount`, `markAsRead`, `addReaction` and `removeReaction`, plus `Group.searchGroups`, `updateLastMessage`, `addMember` and `removeMember` and `Contact.getUserContacts`/`isMuted`, are never called.

### 1.3 Models

- **User** (`models/User.js`): `username` (unique, 3–20 characters, no allowed-character rule), `password` (bcrypt hash), `email` (optional), `avatar`, `status` enum online/offline/away, `lastSeen`, `isActive`. `toJSON` strips the password. Indexes on username and email are declared twice: `unique` already creates one, and `:46-47` adds another, which Mongoose warns about.
- **Message** (`models/Message.js`): `roomId: String` (a *username* for 1:1 chats, a group ObjectId string for groups), `sender` ObjectId, `message: String` (required, **no max length**; for media it holds the file path), `messageType` enum, `fileName`, `fileSize` (String), `reactions[{user: ObjectId, emoji}]`, `replyTo`, `edited`, `deleted`, `readBy[]`, `timestamp`. Index `{roomId:1, timestamp:-1}`. **No conversation id, no sequence number, no client message id.**
- **Contact** (`models/Contact.js`): a directed edge user→contact with per-edge `lastMessage`, `lastMessageTime`, `unreadCount` (never incremented), `pinned`, `archived`, `muted` and `blocked`. Unique `{user, contact}`.
- **Group** (`models/Group.js`): `name`, `admin`, `members[]`, `lastMessage*`, and `settings.onlyAdminCanMessage` and friends (**never enforced**). `disappearingMessages` is never implemented. A pre-save hook adds the admin to members.

### 1.4 Socket.IO events (all in `backend/server.js`)

The server keeps in-memory state: `activeUsers: Map<username, {socketId,…}>`, `userSockets: Map<socketId, username>` and `roomUsers: Map<roomId, Set<username>>` (`:21-23`). There is **no handshake auth**. The client sends `query: {username}` (`SocketContext.jsx:29-31`), but the server ignores it.

| Event (client→server) | Payload | Server action | Emits | Authorization |
|---|---|---|---|---|
| `user_join` | `{username}` | Sets `socket.username` from the payload, marks the user online in the DB | `online_users` (array of usernames) via `io.emit` **to every connected socket** | **None. Trusts the client.** (`:29-60`) |
| `join_room` | `roomId` (string) | `socket.join(roomId)`, loads the last 50 messages for that roomId | `room_messages {roomId, messages}` to the caller; `user_joined_room` to the room | Requires only that `socket.username` is set. **No membership check.** (`:63-116`) |
| `leave_room` | `roomId` | `socket.leave` | `user_left_room` | none |
| `send_message` | `{roomId, message, messageType, metadata}` | For 1:1, looks up a user whose `username == roomId` and requires a Contact edge. For groups, does `Group.findById(roomId)` and checks membership. Saves the message, updates the last-message fields. | `receive_message` to `io.to(roomId)`; after a **500 ms timer**, `message_status_update {status:'delivered'}` | Checks the sender's contact or group membership. Ignores `blocked` and `onlyAdminCanMessage`. (`:142-254`) |
| `typing` | `{roomId, isTyping}` | | `user_typing` to the room except the sender | none (`:257-270`) |
| `react_to_message` | `{messageId, reaction, roomId}` | `$push` into reactions with `user: socket.username`, a **string pushed into an ObjectId field, which fails with CastError**. `messageId` is the float id, not a DB `_id`, which also fails. | `message_reaction` | none. **The frontend never emits this event.** |
| `call_request` / `call_response` | `{targetUser, callType, roomId}` / `{caller, accepted, roomId}` | Relays to the target's *single* stored socketId | `incoming_call`, `call_answered`, `call_failed` | none. Anyone can ring anyone. |
| `update_status` | `status` (any value) | Writes it to the DB. **Validators are not run**, so arbitrary strings are stored. | `user_status_update` broadcast | none. **The frontend never emits this event.** |
| `disconnect` | – | Marks the user **offline** and deletes them from `activeUsers` | `online_users`, `user_disconnected` broadcast | – |

Frontend listeners (`SocketContext.jsx:34-145`): `connect`, `online_users`, `receive_message`, `user_typing`, `message_status_update`, `incoming_call`, `call_answered`, `contact_added`, `group_created`, `group_updated`, `user_status_update`.

Mismatches between client and server:
- **Never emitted by the server, but listened for by the client:** `contact_added`, `group_created`, `group_updated`, `user_status_update` (only `update_status` triggers it, and nothing sends that).
- **Emitted by the server, but never listened for:** `room_messages`, `user_joined_room`, `user_left_room`, `message_reaction`, `call_failed`, `user_disconnected`, `error`.

### 1.5 Frontend state

- `AuthContext` calls `GET /api/auth/me` on mount. Login, register and logout use `fetch` with `credentials: 'include'`. The URLs are **hard-coded to `http://localhost:5000`** in 8 places; `VITE_API_URL` is unused.
- `SocketContext` holds everything: socket, `messages` keyed by roomId, typing users, contacts, groups and call state. It creates the socket on `[user]` change.
- `ChatPage` has a hard-coded fake "General" chat (`ChatPage.jsx:10-20`) that is auto-selected. Its `chats` and `onNewChat` props are passed to `Sidebar`, which ignores them.
- `Sidebar` builds the chat list from contacts (`id = contact.username`) and groups (`id = group._id`).
- `UserProfile` is **100% mock data**: `mockMembers` ("Alice Johnson"…), and `mockMedia` with `via.placeholder.com` URLs (`UserProfile.jsx:26-38`).
- No UI consumes `voiceCallData` or `videoCallData`, so incoming calls are invisible. `initializeCall` is a `console.log` (`SocketContext.jsx:343-346`).

### 1.6 Real data flows

**Sign up → log in**
1. `LoginPage` posts to `POST /api/auth/register` (`AuthContext.jsx:81`). The server hashes the password with bcrypt and creates the user with `status:'online'`, which is wrong because nobody is connected yet (`authController.js:30-35`).
2. The client immediately calls `login` (`LoginPage.jsx:37`). The server sets the httpOnly JWT cookie.
3. The client stores `{id, username}` in state. The SocketContext effect connects and emits `user_join {username}`.
4. Works, but the cookie is never used by the socket.

**Start a 1:1 chat**
1. The user types a username into "Add Contact", which calls `POST /api/user/add-contact`. That creates **two** Contact edges immediately; the target is never asked.
2. The Sidebar auto-selects `{id: username}` (`Sidebar.jsx:115-119`), and `ChatPage.handleChatSelect` emits `join_room(username)`.
3. The server joins the socket to room `"<recipientUsername>"` and emits `room_messages`, which **the client drops**.

**Send a message**
1. `MessageInput` → `ChatArea.handleSendMessage` → `SocketContext.sendMessage` (`:187-210`).
2. The client emits `send_message` with a client-made float id, then appends an optimistic copy with `status:'sending'`.
3. The server does 4–6 awaited Mongo calls, saves, then emits `receive_message` with a **new** float id (`server.js:191`) to `io.to(roomId)`.
4. The client appends that echo as a *second* copy, because the ids differ.
5. The optimistic copy stays at `'sending'` forever. The echo turns "delivered" 500 ms later regardless of what the recipient did.

**Recipient receives**
- **They don't.** For A→B, the room is `"B"`. Only sockets that have opened a chat *with* B are in room `"B"`: A, plus anyone else (C) who chats with B. B's own socket joins room `"A"` when B opens the chat with A.
- So B never gets A's messages live. C does, and C's UI files them under C's chat with B.
- History reads share the same flaw: `Message.find({roomId:"B"})` returns *everything anyone sent to B*.

**Group chat**
1. `POST /api/groups/create` adds only members who are already the creator's contacts (`groupController.js:16-28`).
2. The other members are not notified (no `group_created` emit) and see the group only after a reload.
3. Messages are delivered live only to members whose socket has *currently selected* that group, which is what calls `join_room`. Members viewing another chat receive nothing: no notification, no unread count.
4. Group delivery is the only path that actually works when both sides have the group open.
5. Removing a member does not remove their socket from the room. Since `join_room` doesn't check membership anyway, they can keep reading the group.

### 1.7 AI-generated code: signs and dead code

- Over-declared dependencies. **Unused in the backend:** `bcryptjs`, `helmet`, `express-rate-limit`, `compression`, `morgan`, `express-validator`, `nodemailer`, `cloudinary`, `sharp`, `uuid`, `joi`. **Unused in the frontend:** `axios`, `date-fns`, `emoji-picker-react`, `react-hot-toast`, `framer-motion`, `react-intersection-observer`, `react-virtualized`, `lodash`, `uuid`. The frontend actually uses only react, react-dom, react-router-dom, socket.io-client and lucide-react.
- Dead files: `frontend/src/components/ChatRoom.js`, `FileUpload.js` (JSX in `.js` files, which would not compile under Vite if imported), and `frontend/src/services/socket.js`.
- Duplicated logic: two `updateProfile` implementations (auth vs user controller, with different validation). The room-membership checks in `send_message` are inline rather than shared. 8 hard-coded API URLs.
- Features that look implemented but aren't wired:
  - read receipts (`readBy`, the blue double-tick UI in `MessageBubble.jsx:112`)
  - unread counts
  - reactions
  - pin/mute/archive/delete/block (`ChatArea.jsx:58-81`, `// TODO: Send to backend`)
  - Archived and Starred tabs (no data; `chat.archived` and `chat.pinned` are never set)
  - Status button (`showStatus` set, never rendered)
  - Settings menu (closes the menu)
  - camera ("coming soon", `MessageInput.jsx:562`)
  - audio playback (fake progress bar with hard-coded "0:32 / 1:45", no `<audio>`; `MessageBubble.jsx:71-94`)
  - file download button (no handler)
  - voice/video calls (signalling relay only)
  - disappearing messages
  - "end-to-end encrypted" claim in the empty-state text (`ChatArea.jsx:318`), which is **false**
  - `/health` advertises "Voice messages", "File upload" and "Contact management" as features
- Error plumbing is mismatched. The server returns `{error}`, but `addContact` and `createGroup` read `error.message` (`SocketContext.jsx:251, 273`), so users always see a generic failure.

---

## 2. Stack and versions

Declared ranges are from `package.json`; **resolved** versions are from `package-lock.json` (lockfileVersion 3). `node_modules` exists in both folders. The host has Node v22.19.0.

### Backend (`backend/package.json`)

| Package | Declared | Resolved | Status / expected advisories |
|---|---|---|---|
| express | ^4.18.2 | 4.21.1 | Express 4 is in maintenance. The bundled `path-to-regexp@0.1.10` has a ReDoS advisory (CVE-2024-52798, fixed in 0.1.12 / express 4.21.2). **Expect a moderate.** |
| socket.io | ^4.7.4 | 4.8.1 | Current major. `ws@8.17.1` is patched. |
| mongoose | ^8.0.3 | 8.7.3 (driver 6.9.0) | **Expect high/critical:** `populate().match` `$where` injection (CVE-2024-53900 and CVE-2025-23061, fixed in 8.9.5). The code doesn't pass user input to `match`, so practical risk is low, but upgrade. The `useNewUrlParser` and `useUnifiedTopology` options passed at `server.js:419-422` are deprecated no-ops. |
| multer | ^1.4.5-lts.1 | 1.4.5-lts.1 | **Expect high:** several 2025 DoS advisories in the 1.x line (malformed multipart, stream leaks), fixed in multer 2.x. Upgrade or replace. |
| jsonwebtoken | ^9.0.2 | 9.0.2 | OK. |
| bcrypt **and** bcryptjs | ^5.1.1 / ^2.4.3 | 5.1.1 / 2.4.3 | Only `bcrypt` (native, node-pre-gyp) is used. Pick one; native builds are painful on Alpine and Windows. |
| cookie-parser / cookie | ^1.4.6 | 1.4.7 / 0.7.2 | OK (cookie ≥0.7 is patched). |
| cors | ^2.8.5 | 2.8.5 | OK. |
| dotenv | ^16.3.1 | 16.4.5 | OK. |
| helmet, express-rate-limit, compression, morgan, express-validator, joi, uuid | various | – | **Unused.** `on-headers@1.0.2` (pulled in via morgan/compression) has a low advisory (fixed in 1.1.0). |
| nodemailer | ^6.9.7 | 6.10.1 | Unused. Expect an advisory about address-parsing/domain confusion in 6.x. |
| cloudinary | ^1.41.0 | 1.41.3 | Unused. An old major. |
| sharp | ^0.32.6 | 0.32.6 | Unused. A heavy native install that bundles libvips; remove it. |
| form-data | (transitive) | 4.0.3 | Expect a critical-rated advisory about predictable multipart boundaries (CVE-2025-7783, fixed in 4.0.4). |
| brace-expansion | (transitive) | 1.1.11 | Low ReDoS (fixed in 1.1.12). |
| dev: nodemon 3, jest 29, supertest 6, eslint 8 (EOL), babel | | | `npm test` runs jest, which will report no tests. There is no eslint config in `backend/`, so `npm run lint` fails. There is no babel config either. |
| engines | node ≥18 | | Node 18 has been EOL since April 2025. |

### Frontend (`frontend/package.json`)

| Package | Declared | Resolved | Status |
|---|---|---|---|
| react / react-dom | ^18.2.0 | 18.3.1 | OK (React 19 is current). |
| react-router-dom | ^6.20.1 | 6.30.1 | OK. v7 is current. |
| socket.io-client | ^4.7.4 | 4.8.1 | OK. |
| vite | ^4.5.0 | 4.5.14 | **Vite 4 is EOL.** Bundles `esbuild@0.18.20`, which has a dev-server cross-origin read advisory (GHSA-67mh-4wv8-2f99, fixed in 0.25). Also `rollup@3.29.5`. Expect moderate advisories; they are dev-only. |
| tailwindcss | ^3.3.6 | 3.4.14 | OK. Note that `tailwind.config.js` uses `module.exports` inside a `"type":"module"` package, which may break config loading; it should be renamed to `.cjs`. `darkMode` is not configured, so `dark:` classes follow the OS setting, and the ThemeContext toggle (which sets `data-theme`) likely does nothing. This is likely but was not run. |
| axios | ^1.6.2 | 1.10.0 | Unused. Expect a 2025 DoS advisory (fixed in 1.12). |
| eslint 8 + plugins | | | `eslint.config.js` is flat config, but the `lint` script passes `--ext`, which flat config rejects, and `@eslint/js` and `globals` are not declared (they are present only transitively). Lint is broken. |
| Others (`cross-spawn@7.0.3`, `nanoid@3.3.7`, `brace-expansion@1.1.11`) | transitive | | Low/moderate ReDoS and predictability advisories; dev-only. |

**Expected `npm audit` result, which was not run:** backend roughly 2–4 high (multer, mongoose, form-data) plus several moderate/low. Frontend: a handful of moderate/low, all dev-tooling (vite/esbuild, cross-spawn, nanoid, brace-expansion) plus axios.

### Docker (`docker-compose.yml`, `frontend/Dockerfile`)

- Compose uses `version: '3.8'`, an obsolete key that produces a warning.
- Services: `mongo:7.0` (OK), `redis:7-alpine` (**not used by any code**), backend, frontend (nginx) and a second `nginx:alpine`.
- **Broken:**
  - `backend/Dockerfile` does not exist.
  - `./mongo-init.js` does not exist, so `whatsapp_user` is never created and the backend `MONGO_URI` at compose `:44` fails authentication.
  - `nginx/nginx.conf`, `nginx/conf.d/` and `ssl/` don't exist.
  - The frontend Dockerfile `COPY nginx.conf` would fail because there is no `frontend/nginx.conf`.
  - The frontend Dockerfile's first stage is a *backend* stage built from the frontend context.
  - The healthcheck uses `curl`, which node:alpine doesn't ship.
  - `VITE_*` variables are passed at *runtime* to nginx, where they have no effect (Vite inlines them at build time), and the code hard-codes localhost:5000 anyway.
  - Node 18 base images.
- **Conflicts with the coexistence rules:**
  - Host ports 27017, 6379, 5000, 80, 443, **8080 (CodeJudge)** and 8443.
  - Fixed `container_name: whatsapp_*`.
  - Volumes `mongodb_data` and `redis_data` (not prefixed `realchat_`).
  - No project name.
  - The Vite default dev port is 5173, which is CodeJudge's.
- What changed since INVENTORY.md: the compose `MONGO_INITDB_ROOT_PASSWORD` is now `${MONGO_ROOT_PASSWORD}` (`docker-compose.yml:11`; the username literal `admin` remains, and that is not a secret). `.env.example` was added. Both are dated 2026-10-10.

---

## 3. What works vs what doesn't

The "Works" column means the code reads as functional. Nothing was run, so none of this is tested.

| Area | Status | Evidence |
|---|---|---|
| Register / login / logout / `me` with an httpOnly cookie | **Works** | `authController.js`, `AuthContext.jsx` |
| JWT secret required at boot | **Works** (verified) | `config.js:4-6` throws when `JWT_SECRET` is unset; the old hardcoded fallback is gone |
| Add or list contacts | Works, but there's no consent step and the error message is mis-read client-side | `userController.js:5-83` |
| Create a group / list groups / admin operations | Backend works. Other members are not notified. The members picker is limited to the creator's contacts. | `groupController.js` |
| **1:1 messaging** | **Broken.** The recipient never receives; third parties do. | §1.6 |
| **Message history in the UI** | **Broken.** `room_messages` is never handled. | `server.js:100` vs `SocketContext.jsx` |
| Group messaging (both members have the group open) | **Works** live, with a duplicate for the sender | §1.6 |
| Default "General" chat | **Broken.** `Group.findById('general')` throws CastError, the error is emitted, and the client has no `error` listener. The optimistic bubble stays forever. Also, `joinRoom` runs before the socket exists, so General is never joined. | `ChatPage.jsx:10-29`, `server.js:178` |
| Typing indicator | Works in groups. Broken for 1:1 for the same room-id reason (third parties see it). The list isn't de-duplicated. | `server.js:257`, `SocketContext.jsx:63-70` |
| Presence (online list) | Partially works. Broadcast to *all* users, keyed by username. Breaks with multiple tabs (see §4). | `server.js:36-53, 362-398` |
| Last seen | Written to the DB. The UI always shows "last seen recently". | `ChatArea.jsx:165` |
| "Delivered" tick | **Fake.** A 500 ms timer. | `server.js:242-247` |
| Read receipts / unread counts | **Not implemented.** Schema only. | `Message.js:66-75, 115-153`, `Contact.js:43` |
| Reactions | **Broken and unwired** (CastError; no UI) | `server.js:273-296` |
| File and image upload from the UI | **Broken** (404, wrong path) | `MessageInput.jsx:196` vs `uploadRoutes.js:16` |
| Voice notes | Recording works client-side. The upload 404s and playback is fake. | `MessageInput.jsx:236-340`, `MessageBubble.jsx:71-94` |
| Voice/video calls | Signalling relay only. No UI, no WebRTC. | `SocketContext.jsx:86-112, 343` |
| Pin/mute/archive/block/delete chat, starred, settings, status, camera | Stubbed (TODOs or local state only) | `ChatArea.jsx:58-81`, `MessageInput.jsx:562` |
| Profile / group info panel | Mock data | `UserProfile.jsx:26-38` |
| In-chat search | Works client-side over loaded messages only | `ChatArea.jsx:85-87` |
| Browser notifications | Only if permission was already granted. Never requested. | `SocketContext.jsx:363` |
| Docker | Broken | §2 |
| Lint / tests | Broken / none | §2, §7 |
| Dark mode toggle | Unclear; likely a no-op for `dark:` classes | `tailwind.config.js` has no `darkMode` |

---

## 4. Chat semantics as implemented

### Ordering
- **No sequence numbers.** Two timestamps are taken independently: one on the socket payload (`server.js:197`) and one saved to the DB (`server.js:211`). Both have millisecond resolution.
- **Live order is emit order.** Each `send_message` does 4–6 awaited DB round-trips before it emits. If X sends at t0 and Y at t0+1 ms, the emits can arrive in either order depending on DB latency.
- Within a single Node process, Socket.IO delivers emits to all room members in the same order. So *passive* viewers agree with each other, but that order can differ from the DB timestamp order.
- **The two senders can disagree.** Each sender's optimistic copy is appended locally at send time, before the server echo. X sees "X, Y" and Y sees "Y, X".
- **History order** is `sort({timestamp:-1}).limit(50)` with no tie-breaker (`server.js:79-81`), so same-millisecond messages have undefined order. The client never sorts.

### Delivery
- **Offline recipient:** nothing is queued or pushed. They would see messages only by calling `join_room` and receiving the last 50, and the client doesn't render those. In practice the messages are lost from the UI, although they exist in the DB.
- **Reconnect:** a socket.io-client auto-reconnect re-emits `user_join` (the `connect` handler), but **rooms are not re-joined**. The new socket isn't in any room until the user clicks a chat again. Messages sent during the gap are never fetched.
- **Two tabs or devices:**
  - `activeUsers` stores one socketId per username, and the last tab wins (`server.js:36`). Calls ring only that tab.
  - Each tab receives room messages only for the chat it has open.
  - **Closing any tab marks the user offline**: `activeUsers` is deleted and `status:'offline'` is written (`server.js:364-378`) even though the other tab is still connected.
  - Messages sent from tab 1 appear in tab 2 only if tab 2 has the same room open.
- **Duplicates:** the sender always sees their own message twice (the optimistic copy with the client id, plus the echo with the server id; `SocketContext.jsx:195-208` and `server.js:191, 239`). There is no idempotency key. A retried emit (for example from the socket.io-client send buffer after a reconnect) would save a second DB row.
- **Lost messages:** for 1:1 chat, all of them are lost from the recipient's point of view. A save that fails produces an `error` event that the client ignores, so the bubble shows "sending" forever.

### Read receipts, typing, presence
- **Read receipts:** not implemented (schema and UI only). "Delivered" is a timer.
- **Typing:** per room, broadcast to the room except the sender. There's no server-side timeout, so a tab closed mid-typing leaves "typing…" stuck for the others. In the reducer each `true` event appends without de-duplicating (`SocketContext.jsx:67`). With two tabs typing, the same name is stored twice, and one tab's `false` removes both.
- **Presence:** a global broadcast of every online username to every client (a privacy leak, and O(N) per connect). It isn't scoped to contacts. It's wrong with multiple tabs, as described above. `register` stores `online` for a user who isn't connected. If the process crashes, the DB is left saying `online`.

### Pagination
- **None.** Only the last 50 messages are loaded, inside `join_room` (and then discarded by the client). `Message.getMessagesForRoom(limit, skip)` exists but is unused, and it uses skip-based paging, which is unstable when new messages arrive. There's no REST endpoint for history.

### Media and file uploads
- Storage: multer `diskStorage` to `uploads/` relative to the **process cwd** (`uploadRoutes.js:6-7`). The directory exists in `backend/` and is empty. Files are named `Date.now()-<originalname>`, using the client-supplied name with no sanitisation beyond multer's basename.
- Limits: **none server-side.** The only check is client-side at 10 MB (`MessageInput.jsx:178`). `MAX_FILE_SIZE` and `UPLOAD_DIR` in config are never used.
- Validation: **no fileFilter or MIME check.** The `accept=` attributes on the inputs are cosmetic. Video files are sent as `messageType:'file'`.
- Serving: `express.static('uploads')` on the API origin, with the Content-Type taken from the extension. No `Content-Disposition` and no `nosniff`.
- The message content *is* the path string. The client renders `<img src={message.message}>` and calls `window.open(message.message)` (`MessageBubble.jsx:39-43`), and the sender chooses `messageType`.

---

## 5. Security findings

Severity reflects a deployed, network-reachable instance.

| # | Severity | Finding | Location |
|---|---|---|---|
| S1 | **CRITICAL** | **No socket authentication: full impersonation.** `user_join {username:"victim"}` makes the socket act as the victim. It can then send messages as the victim to their contacts and groups, read their rooms, and set their presence. The JWT cookie is never checked during the handshake. | `server.js:29-40`; client `SocketContext.jsx:29-36` |
| S2 | **CRITICAL** | **No room authorization (IDOR).** `join_room(<any id>)` joins the room and returns its last 50 messages. Any group ObjectId, or any username (which returns every 1:1 message sent *to* that user), can be read live and historically. | `server.js:63-103` |
| S3 | **CRITICAL** (design) | **The 1:1 room id is the recipient's username**, so ordinary users receive and read other people's conversations without any malicious action. This is the same data leak as S2, reached through normal use. | `Sidebar.jsx:53`, `server.js:168-182, 239` |
| S4 | **HIGH** | **Unauthenticated, unlimited upload that serves active content from the API origin.** POST `/api/upload/upload` with `evil.html` or `.svg`, which is then served at `/uploads/...` from `localhost:5000`. Script there is same-origin with `/api/*`, and the `token` cookie (cookies ignore ports) is sent with its requests. **The result is account takeover.** Disk exhaustion is also possible (no limits), and multer 1.x has DoS CVEs. | `uploadRoutes.js`, `app.js:30` |
| S5 | **HIGH** | **A real Atlas URI with embedded credentials sits in plaintext** in `backend/.env` (key `MONGO_URI`, a `mongodb+srv` URI with user:password). The code no longer loads that file (`config.js:2` loads the root `.env`, whose `MONGO_URI` is a local, credential-free URI), but the credential is live. **Rotate the Atlas user and delete the file.** `backend/.env` also holds a `JWT_SECRET`, which is unused. | `backend/.env` (keys `MONGO_URI`, `JWT_SECRET`) |
| S6 | **MEDIUM** | **The Mongo connection string, including credentials, is printed to stdout** on every boot and failure (`console.log('📍 Connection string:', config.mongoUri)`). | `server.js:417, 441` |
| S7 | **MEDIUM** | **XSS via a `javascript:` URL.** A malicious client can send `messageType:'image'` with `message:"javascript:…"`. `<img src>` won't execute it, but clicking the image calls `window.open(message.message)`, and browsers run a `javascript:` URL opened that way in the opener's origin. This is plausible but unverified. Text messages render as React text nodes, so **plain-text XSS is safe**; there is no `dangerouslySetInnerHTML` anywhere. | `MessageBubble.jsx:39-43` |
| S8 | **MEDIUM** | **No rate limiting** on login, register, socket events or uploads, so brute force and spam are possible. `express-rate-limit` is declared but unused. bcrypt cost 12 on register is also a CPU-DoS lever. | `app.js` |
| S9 | **MEDIUM** | **NoSQL operator injection / ReDoS.** `express.json` lets objects through, and Mongoose `sanitizeFilter` is off. Examples: `add-contact {username:{"$ne":"x"}}` adds an arbitrary user. Login with `{username:{"$gt":""}}` targets the first user, but the password must still match, so this is low. `search?query=` goes straight into `$regex`, giving regex injection and ReDoS. Group `members[]` has the same issue. | `userController.js:16, 144`; `authController.js:16, 63`; `groupController.js:17` |
| S10 | **MEDIUM** | **Unsolicited contacts and messaging.** `add-contact` creates both directions without consent, so anyone can message anyone. `blocked` is never enforced in `send_message`. | `userController.js:31-41`, `server.js:171-175` |
| S11 | **MEDIUM** | `PUT /api/user/profile` lets a user change their username with no uniqueness or format check. It also accepts arbitrary `status` and `avatar` URL values. Changing the username desynchronises the JWT `username` claim, the socket identity and the room ids. Combined with S3, a user could rename to a freed username and inherit that user's 1:1 room. | `userController.js:156-177` |
| S12 | **LOW** | Logout does not revoke the JWT, which stays valid for 24h. There's no session store and no rotation. | `authController.js:112-129` |
| S13 | **LOW** | No `helmet` (no CSP, nosniff or frame-ancestors; `X-Powered-By` is exposed). `/health` discloses `NODE_ENV`. Error messages leak in development. | `app.js:33-48, 92-97` |
| S14 | **LOW** | CORS/Origin handling. Express CORS is a single origin from `CLIENT_URL` (fine). Socket.IO `cors` applies only to the polling transport. A **WebSocket upgrade from any Origin is accepted** (no `allowRequest` check), which means cross-site WebSocket hijacking once cookie auth is added to sockets. | `server.js:13-18` |
| S15 | **LOW** | User enumeration through response timing: the user-not-found path skips bcrypt. Register reveals "Username already exists", which is acceptable for a chat app. | `authController.js:63-72` |
| S16 | **LOW** | Password policy is a 6-character minimum and nothing else. No max length (bcrypt truncates at 72 bytes). | `authController.js:22` |
| S17 | INFO | Password hashing uses **bcrypt cost 12, which is fine**. The hash is excluded from responses by `toJSON` and `.select('-password')`. | `authController.js:27`, `User.js:51-55` |
| S18 | INFO | `JWT_SECRET` handling is **fixed**: there's no fallback and boot fails if it's missing (`config.js:4-6`). The secret lives in the root `.env` (key `JWT_SECRET`, 128 characters) and is passed to compose via `${JWT_SECRET}`. `.env` is git-ignored by the root `.gitignore`. | `config.js`, `.env` |
| S19 | INFO | Messages have no max length. The socket's default `maxHttpBufferSize` (1 MB) is the only cap, and REST JSON accepts up to 10 MB. | `Message.js:14-17`, `app.js:26` |

Secret locations (keys only):
- `backend/.env`: `MONGO_URI` (Atlas, with credentials), `JWT_SECRET`, `PORT`
- `.env` (root): `JWT_SECRET`; `MONGO_URI` (local, no credentials)
- `.env.example`: placeholders only (`MONGO_ROOT_PASSWORD`, `MONGO_PASSWORD`, `REDIS_PASSWORD`, `CLOUDINARY_*`, `EMAIL_*`)

No secrets were found in the source code.

---

## 6. Git

- **Not a git repository.** There is no `.git` at the root or in any subfolder (checked to depth 3). So there is no remote, no history, and **no credential has ever been committed or pushed from this folder**. There are no commit hashes to report.
- Caveat: I can't rule out that the same code was ever pushed from another copy elsewhere; nothing here references a remote. The Atlas credential in `backend/.env` should still be treated as exposed-at-rest and rotated.
- Before running `git init`, the root `.gitignore` (which lists only `.env`) must be extended to cover `backend/.env`, `**/.env*` except `.env.example`, `node_modules`, `uploads/` and `logs/`. Today `backend/.env` *is* matched, because `.env` with no slash matches at any depth, but `backend/node_modules` and `backend/uploads` are not ignored. `frontend/.gitignore` covers `node_modules`.

## 7. Tests

- **None.** There are no `*.test.*` or `*.spec.*` files and no `__tests__`. Backend `npm test` runs jest, which would report "no tests found". Supertest and babel-jest are installed but unused. The frontend has no test runner. Coverage is 0%.
- The code is hard to test as written. `server.js` combines the socket handlers, the DB connection and `listen()` at import time, and `uncaughtException` calls `process.exit`.

## 8. Salvage vs rewrite

| Area | Verdict | Why |
|---|---|---|
| **Backend REST (auth, contacts, groups)** | **Rewrite, reusing small pieces** | The auth controller is fine as a reference (bcrypt plus httpOnly cookie). But the data model has to change (conversations, sequence numbers, membership), validation is absent, and there are two `updateProfile` versions plus dead statics. It's under 700 lines, so rewriting is cheaper than patching. The group admin checks can be copied as ideas. |
| **Models** | **Rewrite** | The username-as-roomId design is the root of the worst bugs. There is no conversation entity, no sequence, no client id, and unread state lives on the wrong entity. |
| **Socket layer** | **Rewrite** | No auth, no authorization, in-memory username-keyed presence, fake delivery, split rooms, a CastError path in reactions, and all of it in one 500-line file mixed with boot code. Nothing is worth keeping beyond the event *names* as inspiration. |
| **Frontend UI components** | **Salvage visually** | The Tailwind/lucide markup for `Sidebar`, `ChatArea`, `MessageBubble`, `MessageInput` and `LoginPage` is a decent WhatsApp-like skin. Keep the JSX layout and the voice-recorder logic in `MessageInput.jsx:236-308`. |
| **Frontend state and data** | **Rewrite** | `SocketContext` is a god-object. It has no message store keyed by id/seq, no history fetch, no reconnect logic, hard-coded URLs, mock data, and a fake "General" chat. Replace it with a proper store and a typed API/socket client. |
| **Docker** | **Rewrite from scratch** | Every referenced file is missing, it uses the wrong ports for this machine, and it has no project name. |
| **Dependencies** | **Prune** | Drop roughly 20 unused packages and upgrade multer, mongoose and vite. |

---

# PROPOSED PLAN

Nothing below has been started. Each phase needs your approval before it begins.

## P1. Database: MongoDB or PostgreSQL

| Need | MongoDB | PostgreSQL |
|---|---|---|
| Per-conversation gap-free sequence | Needs a counter document per conversation, updated with `findOneAndUpdate({$inc})`, plus a transaction (replica set required) to make "increment, then insert" atomic. Without that you get gaps or duplicates on failure. | `UPDATE conversations SET last_seq = last_seq + 1 … RETURNING last_seq` and the `INSERT` in **one transaction**, with a `UNIQUE (conversation_id, seq)` constraint. Gap-free by construction. |
| History pagination | `{conv, seq}` index with keyset paging works fine. | Same, with `WHERE seq < $cursor ORDER BY seq DESC LIMIT n`. |
| Unread counts | Store `last_read_seq` per member, then unread = `conv.last_seq - member.last_read_seq`. Works in both. | Same. It's a join plus a subtraction, and is trivially correct. |
| Membership and authorization joins | `$lookup` is clunky. | Native joins and foreign keys. Membership checks are a single indexed lookup. |
| Search | `$text` index (basic; no ranking control). Atlas Search isn't available locally. | `tsvector` with a GIN index, or `pg_trgm` for substring matching. Good enough for this project. |
| Idempotent sends | Unique index on `{sender, client_msg_id}`. | `UNIQUE (sender_id, client_msg_id)` with `ON CONFLICT DO NOTHING RETURNING`. |
| Fan-out / notify | Change streams (replica set). | `LISTEN/NOTIFY` (built in). |
| Matches our other projects | – | Hisaab already uses Postgres (port 5434 reserved), so the patterns and tooling carry over. |

**Recommendation: move to PostgreSQL**, on host port 5435 with a `realchat_pgdata` volume. Chat data here is relational: users, conversations, members, messages, receipts. The key invariant, a gap-free per-conversation sequence, is one transaction plus one unique constraint in Postgres, whereas in Mongo it needs a replica set and careful counter logic. The existing Mongo data is test-only and the model is being rewritten anyway, so migration cost is near zero.

Sketch of the schema:

```
users(id, username UNIQUE, display_name, password_hash NULL, created_at)
identities(user_id, provider, provider_uid UNIQUE(provider, provider_uid))   -- OAuth
sessions(id_hash PK, user_id, created_at, last_seen_at, expires_at, user_agent)
conversations(id, kind 'direct'|'group', title, created_by, last_seq BIGINT DEFAULT 0, created_at)
direct_pairs(user_lo, user_hi, conversation_id, PK(user_lo,user_hi))         -- one DM per pair
conversation_members(conversation_id, user_id, role, joined_at, left_at,
                     last_delivered_seq, last_read_seq, muted_until, PK(conversation_id,user_id))
messages(id, conversation_id, seq, sender_id, client_msg_id UUID, kind, body, attachment_id,
         created_at, edited_at, deleted_at,
         UNIQUE(conversation_id, seq), UNIQUE(sender_id, client_msg_id))
attachments(id, owner_id, storage_key, mime, size_bytes, sha256, status, created_at)
contact_requests / blocks(...)                                                 -- consent and blocks
```

## P2. Message delivery design

**Chosen design: push the message with its sequence number, and catch up over REST.**

1. The client creates a `client_msg_id` (UUIDv7), renders an optimistic bubble keyed by it, and emits `message:send {conversationId, clientMsgId, body}` with a Socket.IO **ack** callback.
2. The server authenticates the socket (session), checks membership and block status, validates the body (length and type), and then in one transaction:
   - `UPDATE conversations SET last_seq = last_seq+1 RETURNING last_seq`
   - `INSERT messages … ON CONFLICT (sender_id, client_msg_id) DO NOTHING`
   - On a conflict it returns the **existing** row, which makes the send idempotent.
3. After the commit, the server acks the sender with `{clientMsgId, id, seq, createdAt}`, and the client swaps the optimistic bubble in place. It then emits `message:new {conversationId, seq, message}` to the **conversation room** `conv:<id>` *and* to each member's **user room** `user:<id>`. The user room is what lets members who don't have the chat open still get badges and previews.
4. The client keeps `lastSeq[conversationId]`.
   - If `seq == last+1`, append.
   - If `seq > last+1`, there's a gap: call `GET /api/conversations/:id/messages?after=<last>` and merge by seq.
   - If `seq <= last`, it's a duplicate: drop it.
5. **On (re)connect**, the client calls `GET /api/sync?since=<per-conv lastSeq map>`, or `GET /api/conversations` (which returns each `last_seq`), and then fetches the gaps. The server auto-joins the socket to `user:<id>` (and to `conv:*` for open chats) **in the connection handler from the session**, never because a client asked.
6. If an ack times out, the client retries with the same `clientMsgId`. The server deduplicates, so the result is at-least-once on the wire and exactly-once in the DB.

**Compared with pure notify-then-pull**, where the server emits `conversation:changed {id, lastSeq}` and the client always fetches over REST:
- Notify-then-pull is simpler to make correct (a single code path) and has a smaller socket payload, but every message costs an extra HTTP round-trip, which adds roughly 20–100 ms and N requests for N recipients.
- Push-with-seq gives instant display, and the seq makes push safe, because gaps are detectable and repaired by the same REST path.
- Since the REST catch-up path is needed for reconnects anyway, push-with-seq costs very little extra.
- **Use push-with-seq for message events. Use notify-then-pull for heavy or rare things** like membership changes and edits.

Ordering guarantee: everyone sees the server's commit order (`seq`). Optimistic bubbles render in a "pending" zone below the last confirmed message until their ack arrives, so the two concurrent senders converge.

## P3. Read receipts, presence and typing with multiple tabs and devices

- **Receipts.** Store watermarks, not per-message rows.
  - `conversation_members.last_delivered_seq` and `last_read_seq` are monotonic (`UPDATE … SET last_read_seq = GREATEST(last_read_seq, $1)`).
  - The client sends `receipt:read {conversationId, seq}` when the chat is visible and focused (Page Visibility API), debounced.
  - The server broadcasts `receipt:update {conversationId, userId, readSeq}` to `user:<id>` for the reader's other tabs (to clear badges) and to the conv room (for ticks).
  - "Delivered" means any socket of that user has acked receipt of `message:new`, advancing `last_delivered_seq`.
  - Unread = `last_seq - last_read_seq`, so it is the same on every device.
  - Group ticks are computed as `min(last_read_seq)` across members, or shown as a per-member "seen by" list.
- **Presence.** Count connections per user: `Map<userId, Set<socketId>>`, or a Valkey hash once there are multiple instances.
  - Online when the count goes 0→1. Offline only when it reaches 0, *after a 10–30 s grace period* so a reload doesn't flicker.
  - `last_seen_at` is written on the final disconnect.
  - Presence is broadcast **only to the user's contacts and fellow conversation members**, never globally.
  - Clients send heartbeats via the Socket.IO ping, and the server trusts nothing the client says about its status.
- **Typing.** This is ephemeral and never persisted.
  - The client sends `typing:start` at most every 3 s while typing, and `typing:stop` on send or blur.
  - The server relays to the conv room *excluding all of the sender's sockets*, keyed `(conversationId, userId)`. The receiving client expires each entry after ~5 s without a refresh.
  - Two tabs of the same user collapse to one "X is typing", because the key is the user, not the socket.

## P4. Scaling beyond one API instance

- What is actually needed: **one instance** is plenty for this project; it's a portfolio-scale chat. The design should still be *instance-safe*: no in-memory state that matters, presence and rate limits in a shared store, and rooms named by id.
- When there are 2+ instances:
  - Socket.IO needs an **adapter** so that `io.to(room).emit` reaches sockets on the other nodes. Options are `@socket.io/redis-adapter` (or the Redis Streams adapter) on **Valkey at port 6381**, or `@socket.io/postgres-adapter`, which uses `LISTEN/NOTIFY` with no extra service.
  - The load balancer needs sticky sessions only if long-polling is enabled. Websocket-only transport avoids that.
  - Presence counts and rate-limit buckets move to Valkey.
- **Recommendation:** single instance now, with the code structured behind a small `Bus` interface. Add the Postgres adapter if a second instance is ever needed (no new container). Add Valkey only when rate limiting or presence actually needs shared state. Leave it out of the compose file until then; the RAM budget matters.

## P5. Media uploads

- **Dev (now):** local disk volume `realchat_uploads`, outside the web root.
  - Uploads go through an **authenticated** `POST /api/attachments` (multer 2.x or busboy) with `limits.fileSize` (for example 10 MB), `files: 1`, an allow-list of MIME types checked by **magic bytes** (`file-type`) and not by extension, a random storage key (UUID, never the original name) and a stored sha256.
  - The upload creates an `attachments` row with `status='ready'`. The message references `attachment_id`; a URL string from the client is never accepted.
  - Downloads go through `GET /api/attachments/:id`, which checks conversation membership and then streams the file with `Content-Type` from the DB, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` for anything that isn't an image, and `Content-Security-Policy: sandbox`.
  - SVG and HTML are refused entirely.
  - Per-user quota and upload rate limit.
- **Later (deployment):** presigned PUT to S3-compatible object storage (S3, R2 or MinIO).
  1. The server issues `{uploadUrl, attachmentId}` with a content-length range and content-type condition.
  2. The client PUTs directly to storage.
  3. The client calls `POST /attachments/:id/complete`, and the server HEADs the object and verifies size and type.
  4. Downloads use short-lived presigned GETs.
  - Optional: thumbnailing in a background job (this is where `sharp` would come back).

## P6. Auth

- **Options:** (a) keep email/password plus a stateless JWT cookie, as today; (b) server-side hashed sessions plus OAuth (Google and GitHub), matching the approach used in our other projects.
- **Recommendation: (b).**
  - Sessions: a random 32-byte token goes in the cookie, and only its SHA-256 is stored in `sessions`. The cookie is `HttpOnly; Secure; SameSite=Lax`, with a 30-day sliding expiry.
  - **Logout and revocation are real**, and "log out other devices" is possible. Rotate the token on login.
  - Socket auth reads the same cookie in `io.use()` middleware, plus an **Origin allow-list** check against cross-site WebSocket hijacking. It attaches `socket.data.userId`, joins `user:<id>`, and rejects the connection otherwise.
  - OAuth uses Authorization Code + PKCE + `state` and links to `identities`. On first login, the user picks a unique handle.
  - Optional email/password fallback for local dev: argon2id or bcrypt cost ≥12, rate limiting, and a 72-byte password cap. Good dev ergonomics also argues for a **dev-only seeded login** flag so multi-user testing doesn't need OAuth apps.
  - CSRF: SameSite=Lax plus requiring `Content-Type: application/json` and an Origin check on state-changing REST calls.
- Also: rotate the Atlas credential in `backend/.env` and delete the file. Generate a fresh session secret.

## P7. Phases

Each phase has a "done means" line.

1. **Audit** (this document).
   *Done means:* `docs/AUDIT.md` reviewed and the plan approved, including the DB and auth choices.
2. **Foundations.**
   - `git init` with a proper `.gitignore`; delete `backend/.env` after rotating the Atlas credential.
   - Monorepo layout `apps/api`, `apps/web`, optionally `packages/shared` for zod schemas and event types.
   - TypeScript; ESLint 9 flat config plus Prettier; Vitest.
   - Compose project `realchat` with Postgres on 5435 only, a `realchat_pgdata` volume, healthchecks, and `mem_limit` values.
   - Vite on **5175** and API on **8082**; a config module validated with zod; pino logging with redaction.
   *Done means:* `docker compose -p realchat up db` gives a healthy Postgres on 5435. `npm test` runs one green smoke test. API `/healthz` and web dev both start on their assigned ports, and no ports from the other projects are touched.
3. **Data model and messaging core** (no sockets yet).
   - Migrations for the schema in P1.
   - Services: create DM (idempotent per pair), create group, add/remove member, `sendMessage` (transactional seq plus client-id dedupe), keyset history, `markRead`.
   - REST endpoints wrapping them, with zod validation and membership guards on every conversation-scoped route.
   *Done means:* integration tests against a real Postgres prove that 100 concurrent sends to one conversation produce seq 1..100 with no gaps or duplicates, that a retried `clientMsgId` returns the same row, that a non-member gets 403/404 on history and send, and that unread counts are correct.
4. **Real-time delivery.**
   - Socket.IO with session middleware and Origin check; server-side room joins only.
   - `message:send` with ack, `message:new` to conv and user rooms, receipt watermarks, presence with connection counting and grace period, typing with TTL.
   - Per-socket event rate limits.
   *Done means:* automated socket tests with two users and three sockets (one user with two tabs) show ack before echo, no duplicates, a gap repaired after a forced disconnect, presence staying online when one of two tabs closes, read state syncing across tabs, and a forged `join` or send to a foreign conversation being rejected.
5. **Frontend.**
   - Reuse the existing Tailwind/lucide components as the skin.
   - A new store keyed by `(conversationId, seq)` plus a pending map keyed by `clientMsgId`.
   - Infinite scroll upwards (keyset), a reconnect/sync routine, unread badges from watermarks, real presence, typing, and the "seen" UI.
   - Remove the mock data, the fake General chat, the dead files and unused dependencies; a single API base URL from env.
   *Done means:* two browsers (and a third tab) can register, start a DM, chat, see each other's typing and read state, reload without losing history, and survive airplane-mode toggling without duplicates or holes. A Playwright e2e test covers this.
6. **Auth hardening and limits.**
   - OAuth (Google and GitHub) plus hashed sessions, logout-all, contact requests/consent, block enforcement.
   - helmet/CSP, rate limits (login, send, upload), input length caps, audit of error messages.
   *Done means:* `npm audit --omit=dev` shows no high or critical issues. Security tests for S1–S16 (impersonation, IDOR, injection, CSWSH, brute force) all pass. The session can be revoked server-side.
7. **Media.**
   - The authenticated attachment pipeline from P5 on local disk: limits, magic-byte checks, a membership-checked download route, voice notes with a real `<audio>` player, image previews.
   *Done means:* tests show that an oversized file, an HTML/SVG file, or a renamed executable is rejected, that a non-member can't fetch an attachment, and that voice notes and images round-trip between two users.
8. **Deploy.**
   - Production Dockerfiles: multi-stage, Node 22 LTS, non-root user, tiny nginx (or the API serving the built web app), env-driven config.
   - A presigned object-storage adapter, a backup note for Postgres, CI (lint, typecheck, test, build), and a README.
   *Done means:* one `docker compose -p realchat up` brings up web, API and DB on the assigned ports from a clean checkout. CI is green. A deploy target is documented, and secrets are only in the platform's secret store.

## P8. Patterns to reuse from our other projects

These are ideas only; I did not open those folders.

- **From CodeJudge:**
  - The way it labels and isolates the containers it manages, applied here to our own containers and volumes (the `realchat_` prefix and a compose project name).
  - A job/worker split, which here would be a background worker for thumbnails and cleanup of expired attachments.
  - Strict resource limits per service.
  - Health-check-gated startup.
- **From Hisaab:**
  - Postgres with migrations, and money-style correctness thinking (transactions plus unique constraints as the source of truth, never trusting client-computed totals). Here, that becomes seq and unread counts.
  - Server-side hashed sessions plus Google/GitHub OAuth.
  - Live updates over Socket.IO where the client re-fetches authoritative state after a notification.
  - Per-room authorization checks done on the server.
- **Shared conventions:**
  - Per-project reserved ports and compose project names.
  - A zod-validated config module that fails fast.
  - Structured logs with secret redaction.
  - An `.env.example` as the single documented contract.
  - A `docs/` folder holding the audit and decisions (ADR-style notes for "Postgres over Mongo", "push-with-seq", "sessions over JWT").
