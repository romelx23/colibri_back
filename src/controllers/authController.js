const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query } = require('../config/db');
const { signToken } = require('../middleware/auth');

const guestSchema = z.object({
  deviceId: z.string().min(8).max(128),
  name: z.string().trim().min(2).max(24),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(72),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(72),
});

function publicPlayer(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    displayName: row.display_name,
    avatarSeed: row.avatar_seed,
    isGuest: row.is_guest,
    email: row.email,
    xp: row.xp,
    points: row.points,
    streak: row.streak,
    bestStreak: row.best_streak,
    sessions: row.sessions,
    createdAt: row.created_at,
  };
}

exports.schemas = { guestSchema, registerSchema, loginSchema };
exports.publicPlayer = publicPlayer;

// POST /api/players/guest — crea o recupera el invitado por deviceId
exports.guest = async (req, res, next) => {
  try {
    const { deviceId, name } = req.body;

    const existing = await query('SELECT * FROM players WHERE device_id = $1', [deviceId]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.display_name !== name && row.is_guest) {
        const updated = await query(
          'UPDATE players SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [row.id, name]
        );
        return res.json({ player: publicPlayer(updated.rows[0]), token: signToken(updated.rows[0]) });
      }
      return res.json({ player: publicPlayer(row), token: signToken(row) });
    }

    const inserted = await query(
      `INSERT INTO players (device_id, display_name, avatar_seed, is_guest)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (device_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [deviceId, name, Math.floor(Math.random() * 1000000)]
    );
    const row = inserted.rows[0];
    res.status(201).json({ player: publicPlayer(row), token: signToken(row) });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/register — convierte el invitado actual en cuenta
exports.register = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const playerId = req.player.id;

    const dupe = await query('SELECT id FROM players WHERE lower(email) = lower($1)', [email]);
    if (dupe.rows[0] && dupe.rows[0].id !== playerId) {
      return res.status(409).json({ error: 'Ese correo ya está registrado' });
    }

    const hash = await bcrypt.hash(password, 10);
    const updated = await query(
      `UPDATE players
         SET email = lower($2), password_hash = $3, is_guest = false, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [playerId, email, hash]
    );
    res.json({ player: publicPlayer(updated.rows[0]), token: signToken(updated.rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya está registrado' });
    next(err);
  }
};

// POST /api/auth/login
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { rows } = await query('SELECT * FROM players WHERE lower(email) = lower($1)', [email]);
    const player = rows[0];
    if (!player || !player.password_hash) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const ok = await bcrypt.compare(password, player.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    res.json({ player: publicPlayer(player), token: signToken(player) });
  } catch (err) {
    next(err);
  }
};

// GET /api/players/me
exports.me = async (req, res) => {
  res.json({ player: publicPlayer(req.player) });
};
