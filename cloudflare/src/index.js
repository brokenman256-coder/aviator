import { Hono } from "hono";
import authRoutes from "./authRoutes.js";
import adminRoutes from "./adminRoutes.js";
import walletRoutes from "./walletRoutes.js";
import statsRoutes from "./statsRoutes.js";
import { getSetting } from "./store.js";

export { GameRoom } from "./gameRoom.js";

const app = new Hono();

app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/wallet", walletRoutes);
app.route("/api/stats", statsRoutes);

// Public branding so pages can show the admin-chosen site name.
app.get("/api/site-settings", async (c) => {
  return c.json({ siteName: await getSetting(c.env.DB, "site_name") });
});

app.all("/ws", async (c) => {
  const id = c.env.GAME_ROOM.idFromName("global");
  const stub = c.env.GAME_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
