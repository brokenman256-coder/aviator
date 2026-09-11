import { Hono } from "hono";
import { authRequired } from "./middleware.js";

const trade = new Hono();

trade.get("/assets", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM trade_assets WHERE enabled = 1 ORDER BY id").all();
  return c.json({
    assets: results.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      price: a.price,
      payoutPercent: a.payout_percent,
      enabled: !!a.enabled,
    })),
  });
});

trade.get("/history", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, a.symbol, a.name AS asset_name FROM trade_contracts c
     JOIN trade_assets a ON a.id = c.asset_id
     WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 30`
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ contracts: results });
});

export default trade;
