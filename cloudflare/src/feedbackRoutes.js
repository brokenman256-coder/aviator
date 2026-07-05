import { Hono } from "hono";
import { authRequired } from "./middleware.js";

const feedback = new Hono();

feedback.post("/", authRequired, async (c) => {
  const { rating, message } = await c.req.json().catch(() => ({}));
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    return c.json({ error: "Rating must be a whole number from 1 to 5" }, 400);
  }
  const text = (message || "").trim().slice(0, 1000);

  await c.env.DB.prepare(
    "INSERT INTO feedback (user_id, rating, message, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(c.get("user").id, r, text || null, new Date().toISOString())
    .run();

  return c.json({ ok: true });
});

export default feedback;
