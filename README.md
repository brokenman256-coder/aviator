# Aviator

A private, credits-only Aviator-style crash game for you and your friends. A
plane climbs while a multiplier rises; cash out before it "flies away" to win
your bet times the multiplier. No real money is involved anywhere — every
balance is virtual credits tracked on your own server.

## Running it

```
npm install
cp .env.example .env   # edit values, especially ADMIN_PASSWORD and JWT_SECRET
npm start
```

Then open `http://localhost:3000` (redirects to the login page).

On first run, a default admin account is created from the `ADMIN_EMAIL` /
`ADMIN_PASSWORD` values in `.env` (defaults to `admin@aviator.local` /
`ChangeMe123!` if unset — **change this** before letting friends use it).
Log in as that account and open **Admin** from the top bar.

## How registration/OTP works

New accounts must verify a 6-digit code before they can play. If you set
`SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` in `.env`, codes are emailed for
real. If you leave SMTP unset (the default), codes are printed to the
server's console **and** shown directly on the verification screen labeled
"dev mode" — good enough for a group of friends running their own server,
not something you'd want exposed on a public deployment.

## What the admin can do

- Adjust any user's credit balance (credit or debit, with a reason)
- Ban / unban accounts
- Promote or revoke admin rights
- Tune house edge %, signup bonus, min/max bet — live, no restart needed
- See aggregate stats: total wagered, total paid out, net house profit
- See recent round history (crash point, house edge applied)

## How the odds work

Each round's crash point is derived from a fresh random seed, hashed with
the same style of formula real crash games use, then scaled by the
configured house edge (default 5%). This means the *expected* payout to
players is mathematically below 100% of what's wagered by that edge
percentage — the house is expected to stay in profit over many rounds by
math, not by secretly rigging individual rounds or targeting specific
players. Round outcomes are generated and enforced server-side, so a
player can't see or influence the crash point in advance via the browser.

## Zenith Markets (Trade)

Alongside the crash game, this server also runs **Zenith Markets** at
`/trade.html` — a simple "predict up or down" trading-style game (pick an
instrument, pick up/down, pick an expiry, win a payout % if you're right).
Prices are a self-contained simulated random walk, not a live market data
feed — see the comment at the top of `server/trade.js` for the integration
point if you ever want to wire in a real price feed. It shares the same
account, credits balance, and admin panel as the Aviator game. Admins can
add/edit instruments, payout percentages, and stake limits from **Admin**.

**No real payment processing is wired in anywhere in this app.** The wallet
page's deposit/withdrawal UI is an intentional placeholder — the only way
credits move today is an admin manually adjusting a user's balance. Before
connecting a real payment gateway or accepting real deposits, get proper
legal/regulatory advice for your jurisdiction: running an up/down trading
product (or a crash game) for real money is a regulated financial-services
and/or gambling activity almost everywhere, and Mauritius (like most
jurisdictions) requires an FSC license for this kind of business.

## Notes

- Data is stored locally in `data/aviator.db` (SQLite). Delete it to reset
  everything.
- This is meant for a private group running their own instance — there's no
  payment processing, KYC, or real-money withdrawal path, and it isn't
  intended to be exposed to the public internet as a gambling service.
