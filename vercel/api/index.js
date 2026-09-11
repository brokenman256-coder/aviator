const express = require("express");
const path = require("path");

const config = require("../server/config");
const db = require("../server/db");
const { hashPassword } = require("../server/crypto-utils");
const { ensureDefaults } = require("../server/store");

const authRoutes = require("../server/auth");
const adminRoutes = require("../server/admin");
const walletRoutes = require("../server/wallet");
const gameRoutes = require("../server/gameRoutes");
const { router: tradeRoutes } = require("../server/trade");

// Runs once per cold start (cached across warm invocations of the same
// instance), not once per request — safe to call on every request.
let bootstrapPromise = null;
async function bootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      await ensureDefaults();

      const { rows: existingAdmin } = await db.query("SELECT id FROM users WHERE is_admin = true LIMIT 1");
      if (existingAdmin.length) return;

      const { rows: existingByEmail } = await db.query("SELECT id FROM users WHERE email = $1", [config.ADMIN_EMAIL]);
      if (existingByEmail.length) {
        await db.query("UPDATE users SET is_admin = true, is_verified = true WHERE id = $1", [existingByEmail[0].id]);
        console.log(`[bootstrap] Promoted existing account ${config.ADMIN_EMAIL} to admin.`);
        return;
      }

      const { hash, salt } = hashPassword(config.ADMIN_PASSWORD);
      await db.query(
        `INSERT INTO users (username, email, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at)
         VALUES ($1, $2, $3, $4, true, true, false, 0, now())`,
        [config.ADMIN_USERNAME, config.ADMIN_EMAIL, hash, salt]
      );
      console.log(`[bootstrap] Created default admin account -> email: ${config.ADMIN_EMAIL} (change ADMIN_PASSWORD in env)`);
    })().catch((err) => {
      bootstrapPromise = null;
      throw err;
    });
  }
  return bootstrapPromise;
}

const app = express();
app.use(express.json());
app.use(async (req, res, next) => {
  try {
    await bootstrap();
    next();
  } catch (err) {
    next(err);
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/game", gameRoutes);
app.use("/api/trade", tradeRoutes);

// Local dev only — on Vercel, static files under /public are served
// directly by the platform per vercel.json, not through this handler.
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, "..", "public")));
}

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Zenith Markets (Vercel build) running on http://localhost:${port}`));
}

module.exports = app;
