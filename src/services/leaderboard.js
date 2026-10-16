const { query } = require('../config/db');
const { DEFAULT_AVATAR } = require('../config/avatars');

const WINDOW_SQL = {
  week: "now() - interval '7 days'",
  month: "now() - interval '30 days'",
  all: null,
};

const MAX_LIMIT = 100;

function toEntry(r) {
  return {
    rank: Number(r.rank) || 1,
    playerId: r.id,
    displayName: r.display_name,
    avatarSeed: r.avatar_seed,
    avatarId: r.avatar_id || DEFAULT_AVATAR,
    isGuest: r.is_guest,
    streak: r.streak,
    score: Number(r.score),
  };
}

async function getLeaderboard({ period = 'all', limit = 50, viewerId = null }) {
  if (!(period in WINDOW_SQL)) {
    throw Object.assign(new Error('periodo inválido'), { status: 400 });
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
  const since = WINDOW_SQL[period];

  // Métrica: mejor puntaje de examen. Histórico = exam_best del jugador;
  // por ventana = mejor evento 'exam' registrado dentro del período.
  const scoreExpr = since
    ? `COALESCE(MAX(se.points_delta), 0)::int`
    : `p.exam_best::int`;
  const joinSql = since
    ? `LEFT JOIN session_events se
         ON se.player_id = p.id AND se.kind = 'exam' AND se.created_at >= ${since}`
    : `LEFT JOIN session_events se ON false`;

  // CTE compartido: el top-N y la posicion del viewer salen del mismo calculo,
  // para que "tu posición" sea correcta aunque quede fuera del LIMIT.
  const cte = `
    WITH scored AS (
      SELECT p.id,
             p.display_name,
             p.avatar_seed,
             p.avatar_id,
             p.is_guest,
             p.streak,
             p.created_at,
             ${scoreExpr} AS score
      FROM players p
      ${joinSql}
      GROUP BY p.id
    ),
    ranked AS (
      SELECT id,
             display_name,
             avatar_seed,
             avatar_id,
             is_guest,
             streak,
             score,
             RANK() OVER (ORDER BY score DESC, created_at ASC) AS rank
      FROM scored
    )`;

  const { rows } = await query(
    `${cte}
     SELECT * FROM ranked
     ORDER BY rank, display_name
     LIMIT $1`,
    [lim]
  );

  const items = rows.map(toEntry);

  let me = null;
  if (viewerId) {
    const idx = items.findIndex((it) => it.playerId === viewerId);
    if (idx >= 0) {
      me = { ...items[idx], position: items[idx].rank };
    } else {
      // Fuera del top: su ranking se calcula igual, sin LIMIT.
      const viewer = await query(
        `${cte}
         SELECT * FROM ranked
         WHERE id = $1`,
        [viewerId]
      );
      if (viewer.rows[0]) {
        const entry = toEntry(viewer.rows[0]);
        me = { ...entry, position: entry.rank };
      }
    }
  }

  return { period, items, me };
}

module.exports = { getLeaderboard, WINDOW_SQL };
