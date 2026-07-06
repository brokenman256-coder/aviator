import { Hono } from "hono";
import { authRequired } from "./middleware.js";
import { publicUser } from "./store.js";

const wallet = new Hono();

wallet.get("/me", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30"
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ user: publicUser(c.get("user")), transactions: results });
});

wallet.get("/recharge-requests", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM recharge_requests WHERE user_id = ? ORDER BY id DESC LIMIT 30"
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ requests: results });
});

wallet.post("/recharge-request", authRequired, async (c) => {
  const user = c.get("user");
  const { amount, type } = await c.req.json().catch(() => ({}));
  const requestType = type === "withdrawal" ? "withdrawal" : "recharge";
  const parsed = Math.round(Number(amount) * 100) / 100;
  if (!isFinite(parsed) || parsed <= 0 || parsed > 1000000) {
    return c.json({ error: "Enter a valid amount" }, 400);
  }
  if (requestType === "withdrawal" && parsed > user.balance) {
    return c.json({ error: "You can't request a withdrawal larger than your current balance" }, 400);
  }

  const pending = await c.env.DB.prepare(
    "SELECT id FROM recharge_requests WHERE user_id = ? AND status = 'pending'"
  ).bind(user.id).first();
  if (pending) return c.json({ error: "You already have a pending request" }, 400);

  const now = new Date().toISOString();
  const info = await c.env.DB.prepare(
    "INSERT INTO recharge_requests (user_id, amount, type, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
  ).bind(user.id, parsed, requestType, now).run();

  return c.json({ id: info.meta.last_row_id, status: "pending", type: requestType });
});

export default wallet;
