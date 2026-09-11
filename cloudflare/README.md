# Zenith Markets — Cloudflare Workers build

Same product as the root `server/` build, rearchitected to run on Cloudflare's
free tier (no credit card required): Workers for HTTP/static assets, Durable
Objects for the live game rooms (WebSockets), and D1 (SQLite-compatible) for
storage. Two game modes: **Aviator** (crash game, `GameRoom` Durable Object)
and **Trade** (up/down contracts on simulated prices, `TradeRoom` Durable
Object) — plus daily bonus wheel, referrals, and a leaderboard that the
`server/`/`vercel/` builds don't have.

## One-time setup

```
cd cloudflare
npm install
npx wrangler d1 create aviator-db
```

Copy the `database_id` it prints into `wrangler.toml` (replacing the
existing value), then run every migration in order:

```
npx wrangler d1 execute aviator-db --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0002_referrals.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0003_bet_uniqueness.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0004_recharge_requests.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0005_phone_and_banner.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0006_withdrawal_requests.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0007_daily_bonus.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0008_streak.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0009_referral_rewards.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0011_payment_screenshots.sql
npx wrangler d1 execute aviator-db --remote --file=./migrations/0012_trade.sql
```

(or just `npm run db:migrate:remote`, which runs all of the above in order —
note there's no `0010`, it was never used), then:

```
npx wrangler secret put JWT_SECRET   # paste a long random string when prompted
node seed-admin.mjs "admin@zenithmarkets.local" "admin" "your-password" > seed.sql
npx wrangler d1 execute aviator-db --remote --file=./seed.sql
npx wrangler deploy
```

## Manual payments (screenshot + admin approval)

Players add funds by paying via UPI/bank, uploading a payment screenshot, and
waiting for admin approval. No third-party payment gateway required — same
placeholder-until-you-add-a-real-one approach as the other builds in this
repo (see the root `README.md`'s "No real payment processing" note).

1. In the **Admin panel → Payment Details**, set your UPI ID and instructions.
2. Set **Credits per ₹** in Game Settings (default 1 credit per rupee).

Players see payment details on the Wallet page, submit amount + screenshot, and
credits are added when an admin approves the request.

## Trade

Prices are a self-contained simulated random walk, not a live market data
feed — see the comment at the top of `src/tradeRoom.js` for the integration
point if you ever want to wire in a real price feed. Admins manage
instruments, payout percentages, and stake limits from **Admin → Trade
Instruments / Trade Limits**.

## Local dev

```
npx wrangler d1 execute aviator-db --local --file=./migrations/0001_init.sql
# ...run the rest of the migrations the same way, through 0012_trade.sql
# (or: npm run db:migrate:local)
npx wrangler dev
```

`.dev.vars` (gitignored) should contain:

```
JWT_SECRET=anything-for-local-dev
```

## Differences from the `server/` (Node) build

- No SMTP/email sending — Workers has no raw TCP sockets, so OTP codes are
  always returned directly in the API response and logged (`wrangler tail`).
  Fine for a private group; could be extended with an HTTP email API (e.g.
  Resend) later if wanted.
- Password hashing uses PBKDF2 via Web Crypto instead of Node's `scrypt`.
- Realtime transport is a plain WebSocket instead of Socket.io (Cloudflare
  Durable Objects don't run arbitrary Node servers).
- Site branding (the name shown in the header) is admin-configurable at
  runtime via **Admin → Game Settings → Site name** — defaults to "Zenith
  Markets" but isn't hardcoded the way the other two builds' branding is.
