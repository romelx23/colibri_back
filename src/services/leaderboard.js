const { query } = require('../config/db');

const WINDOW_SQL = {
  week: "now() - interval '7 days'",
  month: "now() - interval '30 days'",
  all: null,
};

const MAX_LIMIT = 100;

async function getLeaderboard({ period = 'all', limit = 50, viewerId = null }) {
  if (!(period in WINDOW_SQL)) {
    throw Object.assign(new Error('periodo inválido'), { status: 400 });
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
  const since = WINDOW_SQL[period];

  const scoreExpr = since
    ? `COALESCE(SUM(se.xp_delta), 0)::int`
    : `p.xp::int`;
  const joinSql = since
    ? `LEFT JOIN session_events se ON se.player_id = p.id AND se.created_at >= ${since}`
    : `LEFT JOIN session_events se ON false`;

  const params = [lim];
  const sql = `
    WITH scored AS (
      SELECT p.id,
             p.display_name,
             p.avatar_seed,
             p.is_guest,
             p.streak,
             p.created_at,
             ${scoreExpr} AS score
      FROM players p
      ${joinSql}
      GROUP BY p.id
    )
    SELECT id,
           display_name,
           avatar_seed,
           is_guest,
           streak,
           score,
           RANK() OVER (ORDER BY score DESC, created_at ASC) AS rank
    FROM scored
    ORDER BY rank, display_name
    LIMIT $1
  `;

  const { rows } = await query(sql, params);

  const items = rows.map((r, i) => ({
    rank: Number(r.rank) || i + 1,
    playerId: r.id,
    displayName: r.display_name,
    avatarSeed: r.avatar_seed,
    isGuest: r.is_guest,
    streak: r.streak,
    score: Number(r.score),
  }));

  let me = null;
  if (viewerId) {
    const idx = items.findIndex((it) => it.playerId === viewerId);
    if (idx >= 0) me = { ...items[idx], position: idx + 1 };
  }

  return { period, items, me };
}

module.exports = { getLeaderboard, WINDOW_SQL };
