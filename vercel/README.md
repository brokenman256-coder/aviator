# Zenith Markets — Vercel build

A rewrite of the Node/Express + Socket.io + SQLite app (in `../server`) for
Vercel's serverless model, since serverless functions can't hold a
persistent process, WebSocket connection, or on-disk SQLite file alive
between requests. The differences:

- **Realtime is polling, not Socket.io.** The client polls `/api/game/state`
  (~every 300ms) and `/api/trade/state` (~every 1s) instead of receiving
  pushed events. Round phase, multiplier, and trade prices are computed from
  stored timestamps rather than an in-memory tick loop, so any request can
  compute the correct current state — see the comments at the top of
  `server/game.js` and `server/trade.js`.
- **Postgres instead of SQLite**, via the `pg` package and a `DATABASE_URL`
  env var (works with Neon, Vercel Postgres, Supabase, or any Postgres
  provider — prefer a pooled connection string if your provider offers one).

## Deploying

1. Create a Postgres database with your provider of choice and grab its
   connection string.
2. In the Vercel dashboard: **New Project** → import this repo → set
   **Root Directory** to `vercel` (this repo has multiple deployment
   targets side by side, so Vercel needs to be told which one to build).
3. Add environment variables from `.env.example` (`DATABASE_URL` at minimum,
   plus `JWT_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`).
4. Deploy. The schema is created automatically on first request — no manual
   migration step.

## Local dev

```
cd vercel
npm install
cp .env.example .env   # point DATABASE_URL at a local/dev Postgres
npm run dev
```

## No real payment processing

Same as the other builds in this repo: wallet top-ups/withdrawals are an
intentional placeholder (admin manually adjusts balances). See the root
`README.md` for the full note on what's needed before handling real money.
