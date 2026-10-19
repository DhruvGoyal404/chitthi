# Chitthi

A real-time chat app: 1:1 and group conversations, durable ordered history, read receipts, presence and typing indicators.

> **Status: rewrite in progress.** The API (data model, REST, real-time delivery) is built and tested; the web app is a skeleton until the frontend phase.

**Not end-to-end encrypted.** Messages are stored in plaintext on the server, which can read them. There are no voice or video calls.

## Stack

Node 22 · TypeScript · Express 5 · PostgreSQL 18 · Socket.IO · React 19 · Vite · Tailwind CSS v4 · TanStack Query

## Running locally

Requirements: Node 22.12 or later, and Docker.

```sh
cp .env.example .env        # then set the owner and chitthi_api passwords (see comments inside)
npm ci
docker compose up -d db     # Postgres on 127.0.0.1:5435
npm run db:migrate
npm run db:api-password     # sets the chitthi_api login from DATABASE_URL
npm run dev:api             # http://127.0.0.1:8082/api/health
npm run dev:web             # http://localhost:5175
```

## Docs

- [docs/AUDIT.md](docs/AUDIT.md): audit of the legacy codebase and the plan for this rewrite.
- [docs/SCHEMA.md](docs/SCHEMA.md): the data model and what the database enforces.
- [docs/REALTIME.md](docs/REALTIME.md): real-time delivery, the guarantees, failure modes and the client sync contract.
- [CLAUDE.md](CLAUDE.md): invariants, phases and working rules.

## Licence

MIT
