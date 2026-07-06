import { Hono } from "hono";
import { authRequired } from "./middleware.js";

const stats = new Hono();

// Per-user play stats, derived from the bets ledger (no extra tables needed).
async function computeUserStats(db, userId) {
  const row = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS rounds,
        SUM(CASE WHEN status = 'cashed_out' THEN 1 ELSE 0 END) AS wins,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN amount ELSE 0 END), 0) AS wagered,
        COALESCE(SUM(CASE WHEN status = 'cashed_out' THEN payout ELSE 0 END), 0) AS won,
        COALESCE(MAX(payout), 0) AS biggestWin,
        COALESCE(MAX(cashout_multiplier), 0) AS bestMultiplier
      FROM bets WHERE user_id = ?`
    )
    .bind(userId)
    .first();

  const rounds = row.rounds || 0;
  const wins = row.wins || 0;
  return {
    rounds,
    wins,
    winRate: rounds ? Math.round((wins / rounds) * 100) : 0,
    wagered: Math.round(row.wagered * 100) / 100,
    won: Math.round(row.won * 100) / 100,
    net: Math.round((row.won - row.wagered) * 100) / 100,
    biggestWin: Math.round(row.biggestWin * 100) / 100,
    bestMultiplier: Math.round(row.bestMultiplier * 100) / 100,
  };
}

// Every badge, with a rule evaluated against the player's stats. Computing them
// on the fly (rather than persisting) means they're always accurate and there's
// no award-timing logic to get wrong.
function achievementsFor(s, extra) {
  const defs = [
    { id: "first_flight", icon: "🛫", name: "First Flight", desc: "Place your first bet", earned: s.rounds >= 1 },
    { id: "first_cashout", icon: "💰", name: "Cashed In", desc: "Win your first round", earned: s.wins >= 1 },
    { id: "sharpshooter", icon: "🎯", name: "Sharpshooter", desc: "Win 25 rounds", earned: s.wins >= 25 },
    { id: "to_the_moon", icon: "🚀", name: "To The Moon", desc: "Cash out at 10x or higher", earned: s.bestMultiplier >= 10 },
    { id: "high_roller", icon: "🐋", name: "High Roller", desc: "Wager 10,000 credits total", earned: s.wagered >= 10000 },
    { id: "big_winner", icon: "💎", name: "Big Winner", desc: "Win 5,000 on a single round", earned: s.biggestWin >= 5000 },
    { id: "on_fire", icon: "🔥", name: "On Fire", desc: "Reach a 7-day spin streak", earned: (extra.streak || 0) >= 7 },
    { id: "recruiter", icon: "🤝", name: "Recruiter", desc: "Invite an active friend", earned: (extra.activeReferrals || 0) >= 1 },
  ];
  return defs;
}

stats.get("/me", authRequired, async (c) => {
  const user = c.get("user");
  const s = await computeUserStats(c.env.DB, user.id);
  const ref = await c.env.DB.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE referred_by = ? AND referral_rewarded = 1"
  ).bind(user.id).first();
  const extra = { streak: user.daily_streak || 0, activeReferrals: ref.c || 0 };
  const badges = achievementsFor(s, extra);
  return c.json({
    username: user.username,
    joinedAt: user.created_at,
    streak: extra.streak,
    stats: s,
    badges,
    badgesEarned: badges.filter((b) => b.earned).length,
  });
});

const LEADERBOARD_METRICS = {
  net: "SUM(CASE WHEN b.status = 'cashed_out' THEN b.payout ELSE 0 END) - SUM(CASE WHEN b.status != 'cancelled' THEN b.amount ELSE 0 END)",
  wagered: "SUM(CASE WHEN b.status != 'cancelled' THEN b.amount ELSE 0 END)",
  biggest: "MAX(b.payout)",
};

stats.get("/leaderboard", authRequired, async (c) => {
  const metric = LEADERBOARD_METRICS[c.req.query("metric")] ? c.req.query("metric") : "net";
  const expr = LEADERBOARD_METRICS[metric];
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, ${expr} AS value
     FROM bets b JOIN users u ON u.id = b.user_id
     WHERE u.is_admin = 0
     GROUP BY b.user_id
     HAVING value IS NOT NULL
     ORDER BY value DESC
     LIMIT 20`
  ).all();
  return c.json({
    metric,
    leaders: results.map((r, i) => ({
      rank: i + 1,
      userId: r.id,
      username: r.username,
      value: Math.round((r.value || 0) * 100) / 100,
    })),
  });
});

export default stats;
