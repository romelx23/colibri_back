const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query } = require('../config/db');
const { signToken } = require('../middleware/auth');
const { validateName } = require('../utils/sanitizeName');
const {
  DEFAULT_AVATAR,
  getAvatar,
  isUnlocked,
  rankOf,
} = require('../config/avatars');

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

const updateMeSchema = z.object({
  displayName: z.string().trim().min(2).max(24),
  avatarId: z.string().min(1).max(40),
});

function publicPlayer(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    displayName: row.display_name,
    avatarSeed: row.avatar_seed,
    avatarId: row.avatar_id || DEFAULT_AVATAR,
    isGuest: row.is_guest,
    email: row.email,
    xp: row.xp,
    points: row.points,
    examBest: row.exam_best,
    streak: row.streak,
    bestStreak: row.best_streak,
    sessions: row.sessions,
    createdAt: row.created_at,
  };
}

exports.schemas = { guestSchema, registerSchema, loginSchema, updateMeSchema };
exports.publicPlayer = publicPlayer;

// POST /api/players/guest — crea o recupera el invitado por deviceId
exports.guest = async (req, res, next) => {
  try {
    const { deviceId } = req.body;
    // El nombre pasará el filtro: si viene ofensivo, se degrada a "Jugador"
    // (el jugador podrá elegir otro desde la pantalla de identidad).
    const check = validateName(req.body.name);
    const name = check.ok ? check.name : 'Jugador';

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
      `INSERT INTO players (device_id, display_name, avatar_seed, avatar_id, is_guest)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (device_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [deviceId, name, Math.floor(Math.random() * 1000000), DEFAULT_AVATAR]
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

// PUT /api/players/me — cambia nickname e icono de perfil
// - El nombre pasa el filtro de ofensas (422 si lo viola)
// - Debe ser único: si existe, responde 409 con una sugerencia "nombreN"
// - El icono debe estar desbloqueado según el XP del jugador (403 si no)
exports.update = async (req, res, next) => {
  try {
    const playerId = req.player.id;
    const { avatarId } = req.body;

    const check = validateName(req.body.displayName);
    if (!check.ok) {
      return res.status(422).json({ error: check.reason });
    }
    const displayName = check.name;

    const avatar = getAvatar(avatarId);
    if (!avatar) {
      return res.status(422).json({ error: 'Icono de perfil no válido' });
    }
    if (!isUnlocked(avatar, req.player.xp)) {
      const rank = rankOf(req.player.xp);
      return res.status(403).json({
        error: `Ese icono se desbloquea al llegar al rango con ${avatar.minXp} XP (vas en ${rank.name}: ${req.player.xp} XP)`,
      });
    }

    // Unicidad (case-insensitive), excluyendo al propio jugador.
    const dupe = await query(
      'SELECT id FROM players WHERE lower(display_name) = lower($1) AND id <> $2',
      [displayName, playerId]
    );
    if (dupe.rows[0]) {
      const suggestion = await freeName(displayName, playerId);
      return res.status(409).json({
        error: 'Ese nombre ya está en uso',
        suggestion,
      });
    }

    const updated = await query(
      `UPDATE players
         SET display_name = $2, avatar_id = $3, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [playerId, displayName, avatarId]
    );
    res.json({ player: publicPlayer(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
};

// Busca la primera variante "nombre2", "nombre3"... libre para este jugador.
async function freeName(base, playerId) {
  const trimmed = base.slice(0, 19); // deja sitio para el sufijo dentro de 24
  for (let n = 2; n <= 99; n++) {
    const candidate = `${trimmed}${n}`;
    const { rows } = await query(
      'SELECT id FROM players WHERE lower(display_name) = lower($1) AND id <> $2',
      [candidate, playerId]
    );
    if (!rows[0]) return candidate;
  }
  return `${trimmed}${Math.floor(100 + Math.random() * 900)}`;
}
