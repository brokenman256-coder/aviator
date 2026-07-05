import { Hono } from "hono";
import authRoutes from "./authRoutes.js";
import adminRoutes from "./adminRoutes.js";
import walletRoutes from "./walletRoutes.js";
import feedbackRoutes from "./feedbackRoutes.js";
import { getSetting } from "./store.js";

export { GameRoom } from "./gameRoom.js";

const app = new Hono();

app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/wallet", walletRoutes);
app.route("/api/feedback", feedbackRoutes);

// Public — every player (and the logged-out login page) needs to see this.
app.get("/api/banner", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM banner WHERE id = 1").first();
  if (!row || !row.enabled) return c.json({ enabled: false });
  return c.json({
    enabled: true,
    title: row.title || "",
    message: row.message || "",
    imageDataUrl: row.image_data_url || null,
  });
});

// Public — small set of player-facing text labels an admin can customize.
app.get("/api/site-settings", async (c) => {
  return c.json({
    feedbackSectionTitle: await getSetting(c.env.DB, "feedback_section_title"),
  });
});

app.all("/ws", async (c) => {
  const id = c.env.GAME_ROOM.idFromName("global");
  const stub = c.env.GAME_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
