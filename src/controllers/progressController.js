const { z } = require('zod');
const { withTransaction, query } = require('../config/db');
const { publicPlayer } = require('./authController');

const syncSchema = z.object({
  xp: z.number().int().min(0),
  points: z.number().int().min(0),
  streak: z.number().int().min(0),
  bestStreak: z.number().int().min(0),
  sessions: z.number().int().min(0),
  xpDelta: z.number().int().min(0).max(10000),
  pointsDelta: z.number().int().min(0).max(10000),
  dailyXp: z.number().int().min(0).nullish(),
});

exports.syncSchema = syncSchema;

// Topes de XP/puntos que un solo sync puede aportar al ranking (anti-cheat básico).
// La primera sincronización de un dispositivo puede traer el progreso acumulado offline.
const MAX_XP_PER_SYNC = 5000;
const MAX_POINTS_PER_SYNC = 1000;
const MAX_XP_FIRST_SYNC = 100000;

// POST /api/progress/sync
exports.sync = async (req, res, next) => {
  try {
    const { xp, points, streak, bestStreak, sessions, xpDelta, pointsDelta } = req.body;
    const playerId = req.player.id;

    if (xpDelta > MAX_XP_FIRST_SYNC || pointsDelta > MAX_POINTS_PER_SYNC * 2) {
      return res.status(422).json({ error: 'Valores de sesión fuera de rango' });
    }

    const player = await withTransaction(async (client) => {
      const cur = await client.query('SELECT xp, points FROM players WHERE id = $1 FOR UPDATE', [
        playerId,
      ]);
      const row = cur.rows[0];
      if (!row) throw Object.assign(new Error('Jugador no encontrado'), { status: 404 });
      if (xp < row.xp || points < row.points) {
        throw Object.assign(new Error('El progreso no puede retroceder'), { status: 409 });
      }
      // Primera sincronización del dispositivo: admite el acumulado offline.
      // Después, cada sync queda limitado a una sesión razonable.
      if (row.xp > 0 && xpDelta > MAX_XP_PER_SYNC) {
        throw Object.assign(new Error('Valores de sesión fuera de rango'), { status: 422 });
      }
      if (row.points > 0 && pointsDelta > MAX_POINTS_PER_SYNC) {
        throw Object.assign(new Error('Valores de sesión fuera de rango'), { status: 422 });
      }

      const effectiveXpDelta = Math.min(xpDelta, Math.max(0, xp - row.xp));
      const effectivePointsDelta = Math.min(pointsDelta, Math.max(0, points - row.points));

      await client.query(
        `UPDATE players
           SET xp = $2, points = $3, streak = $4, best_streak = $5, sessions = $6, updated_at = now()
         WHERE id = $1`,
        [playerId, xp, points, streak, bestStreak, sessions]
      );

      if (effectiveXpDelta > 0 || effectivePointsDelta > 0) {
        await client.query(
          `INSERT INTO session_events (player_id, kind, xp_delta, points_delta, payload)
           VALUES ($1, 'session', $2, $3, $4)`,
          [
            playerId,
            effectiveXpDelta,
            effectivePointsDelta,
            JSON.stringify({ streak, sessions, dailyXp: req.body.dailyXp ?? null }),
          ]
        );
      }

      const updated = await client.query('SELECT * FROM players WHERE id = $1', [playerId]);
      return updated.rows[0];
    });

    res.json({ player: publicPlayer(player) });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/progress — reinicia el progreso del jugador en el servidor.
// Necesario porque el anti-cheat exige que el progreso sea monótono.
exports.reset = async (req, res, next) => {
  try {
    const playerId = req.player.id;
    await query(
      `UPDATE players
          SET xp = 0, points = 0, streak = 0, best_streak = 0, sessions = 0, updated_at = now()
        WHERE id = $1`,
      [playerId]
    );
    await query('DELETE FROM session_events WHERE player_id = $1', [playerId]);
    const { rows } = await query('SELECT * FROM players WHERE id = $1', [playerId]);
    res.json({ player: publicPlayer(rows[0]) });
  } catch (err) {
    next(err);
  }
};
