const express = require("express");
const db = require("./db");
const { authRequired } = require("./middleware");
const { publicUser } = require("./store");

const router = express.Router();

router.get("/me", authRequired, (req, res) => {
  const transactions = db
    .prepare("SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30")
    .all(req.user.id);
  res.json({ user: publicUser(req.user), transactions });
});

module.exports = router;
