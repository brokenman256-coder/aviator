# Aviator — Cloudflare Workers build

Same game as the root `server/` build, rearchitected to run on Cloudflare's
free tier (no credit card required): Workers for HTTP/static assets, a
Durable Object for the live game room (WebSockets), and D1 (SQLite-compatible)
for storage.

## One-time setup

```
cd cloudflare
npm install
npx wrangler d1 create aviator-db
```

Copy the `database_id` it prints into `wrangler.toml` (replacing
`REPLACE_WITH_D1_DATABASE_ID`), then:

```
npx wrangler d1 execute aviator-db --remote --file=./migrations/0001_init.sql
npx wrangler secret put JWT_SECRET   # paste a long random string when prompted
node seed-admin.mjs "admin@aviator.local" "admin" "your-password" > seed.sql
npx wrangler d1 execute aviator-db --remote --file=./seed.sql
npx wrangler deploy
```

## Local dev

```
npx wrangler d1 execute aviator-db --local --file=./migrations/0001_init.sql
npx wrangler dev
```

`.dev.vars` (gitignored) should contain `JWT_SECRET=anything-for-local-dev`.

## Differences from the `server/` (Node) build

- No SMTP/email sending — Workers has no raw TCP sockets, so OTP codes are
  always returned directly in the API response and logged (`wrangler tail`).
  Fine for a private group; could be extended with an HTTP email API (e.g.
  Resend) later if wanted.
- Password hashing uses PBKDF2 via Web Crypto instead of Node's `scrypt`.
- Realtime transport is a plain WebSocket instead of Socket.io (Cloudflare
  Durable Objects don't run arbitrary Node servers).
