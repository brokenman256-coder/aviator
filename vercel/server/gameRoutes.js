const express = require("express");
const { authRequired, ah } = require("./middleware");
const game = require("./game");

const router = express.Router();

router.get(
  "/state",
  authRequired,
  ah(async (req, res) => {
    res.json(await game.getRoundState(req.user.id));
  })
);

router.get(
  "/history",
  authRequired,
  ah(async (req, res) => {
    res.json({ history: await game.getHistory() });
  })
);

router.post(
  "/bet",
  authRequired,
  ah(async (req, res) => {
    try {
      const { slot, amount, autoCashout } = req.body || {};
      const result = await game.placeBet(req.user.id, Number(slot) || 0, amount, autoCashout);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

router.post(
  "/bet/cancel",
  authRequired,
  ah(async (req, res) => {
    try {
      const { slot } = req.body || {};
      const result = await game.cancelBet(req.user.id, Number(slot) || 0);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

router.post(
  "/cashout",
  authRequired,
  ah(async (req, res) => {
    try {
      const { slot } = req.body || {};
      const result = await game.cashOut(req.user.id, Number(slot) || 0);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

module.exports = router;
