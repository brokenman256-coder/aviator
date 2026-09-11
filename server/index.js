const express = require("express");
const http = require("http");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const config = require("./config");
const db = require("./db");
const { hashPassword } = require("./crypto-utils");
const { ensureDefaults } = require("./store");
const { GameEngine } = require("./game");
const { router: tradeRoutes, TradeEngine } = require("./trade");

const authRoutes = require("./auth");
const adminRoutes = require("./admin");
const walletRoutes = require("./wallet");

function bootstrapAdmin() {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE is_admin = 1").get();
  if (existingAdmin) return;

  const existingByEmail = db.prepare("SELECT id FROM users WHERE email = ?").get(config.ADMIN_EMAIL);
  if (existingByEmail) {
    db.prepare("UPDATE users SET is_admin = 1, is_verified = 1 WHERE id = ?").run(existingByEmail.id);
    console.log(`[bootstrap] Promoted existing account ${config.ADMIN_EMAIL} to admin.`);
    return;
  }

  const { hash, salt } = hashPassword(config.ADMIN_PASSWORD);
  db.prepare(
    `INSERT INTO users (username, email, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at)
     VALUES (?, ?, ?, ?, 1, 1, 0, 0, ?)`
  ).run(config.ADMIN_USERNAME, config.ADMIN_EMAIL, hash, salt, new Date().toISOString());
  console.log(
    `[bootstrap] Created default admin account -> email: ${config.ADMIN_EMAIL}  password: ${config.ADMIN_PASSWORD} (change ADMIN_PASSWORD in .env)`
  );
}

ensureDefaults();
bootstrapAdmin();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/trade", tradeRoutes);

const server = http.createServer(app);
const io = new Server(server);
const game = new GameEngine(io);
const trade = new TradeEngine(io);

io.on("connection", (socket) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  let userId = null;

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.uid);
    if (!user || user.is_banned) throw new Error("unauthorized");
    userId = user.id;
    socket.join(`user:${userId}`);
  } catch {
    socket.emit("auth:error", { error: "Invalid session, please log in again" });
    socket.disconnect(true);
    return;
  }

  socket.emit("round:state", game.publicState());

  socket.on("bet:place", ({ slot, amount, autoCashout }) => {
    try {
      const result = game.placeBet(userId, Number(slot) || 0, amount, autoCashout);
      socket.emit("bet:placed", result);
    } catch (err) {
      socket.emit("bet:error", { slot, error: err.message });
    }
  });

  socket.on("bet:cancel", ({ slot }) => {
    try {
      const result = game.cancelBet(userId, Number(slot) || 0);
      socket.emit("bet:cancelled", result);
    } catch (err) {
      socket.emit("bet:error", { slot, error: err.message });
    }
  });

  socket.on("bet:cashout", ({ slot }) => {
    try {
      const result = game.cashOut(userId, Number(slot) || 0);
      socket.emit("bet:cashed_out", result);
    } catch (err) {
      socket.emit("bet:error", { slot, error: err.message });
    }
  });

  socket.on("trade:open", ({ symbol, direction, stake, durationSec }) => {
    try {
      const result = trade.openContract(userId, symbol, direction, stake, durationSec);
      socket.emit("trade:opened", result);
    } catch (err) {
      socket.emit("trade:error", { error: err.message });
    }
  });
});

server.listen(config.PORT, () => {
  console.log(`Zenith Markets server running on http://localhost:${config.PORT}`);
  game.start();
  trade.start();
});
