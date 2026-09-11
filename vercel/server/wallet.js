const express = require("express");
const db = require("./db");
const { authRequired, ah } = require("./middleware");
const { publicUser } = require("./store");

const router = express.Router();

router.get(
  "/me",
  authRequired,
  ah(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 30",
      [req.user.id]
    );
    res.json({ user: publicUser(req.user), transactions: rows });
  })
);

module.exports = router;
