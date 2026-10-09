const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const SECRET = () => process.env.JWT_SECRET;

function signToken(player) {
  return jwt.sign(
    { sub: player.id, device: player.device_id, guest: player.is_guest },
    SECRET(),
    { expiresIn: '365d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET());
}

async function authRequired(req, res, next) {
  try {
    const header = req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Autenticación requerida' });

    const decoded = verifyToken(token);
    const { rows } = await query('SELECT * FROM players WHERE id = $1', [decoded.sub]);
    if (!rows[0]) return res.status(401).json({ error: 'Jugador no encontrado' });

    req.player = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

async function authOptional(req, res, next) {
  try {
    const header = req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      const decoded = verifyToken(token);
      const { rows } = await query('SELECT * FROM players WHERE id = $1', [decoded.sub]);
      if (rows[0]) req.player = rows[0];
    }
  } catch {
    // sin token el endpoint sigue siendo público
  }
  next();
}

module.exports = { signToken, verifyToken, authRequired, authOptional };
