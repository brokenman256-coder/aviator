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

export default wallet;
