/**
 * Catálogo de iconos de perfil. Es la fuente de verdad del servidor:
 * valida que un jugador solo pueda elegir un icono que ya desbloqueó
 * (según su XP total, misma tabla de rangos que la app).
 *
 * Debe mantenerse en sincronía con lib/models/avatar.dart (app Flutter).
 */

// Mismos umbrales que Rank.all en lib/logic/xp.dart
const RANKS = [
  { name: 'Novato', minXp: 0 },
  { name: 'Estudiante', minXp: 300 },
  { name: 'Aprendiz', minXp: 900 },
  { name: 'Erudito', minXp: 2000 },
  { name: 'Maestro', minXp: 4000 },
];

const AVATARS = [
  // Comunes: disponibles desde el inicio
  { id: 'chick', emoji: '🐣', tier: 'common', minXp: 0 },
  { id: 'owl', emoji: '🦉', tier: 'common', minXp: 0 },
  { id: 'brain', emoji: '🧠', tier: 'common', minXp: 0 },
  { id: 'books', emoji: '📚', tier: 'common', minXp: 0 },
  { id: 'butterfly', emoji: '🦋', tier: 'common', minXp: 0 },
  { id: 'parrot', emoji: '🦜', tier: 'common', minXp: 0 },
  { id: 'hibiscus', emoji: '🌺', tier: 'common', minXp: 0 },
  { id: 'star', emoji: '⭐', tier: 'common', minXp: 0 },
  // Épicos: se desbloquean al llegar a Estudiante (300 XP)
  { id: 'fox', emoji: '🦊', tier: 'epic', minXp: 300 },
  { id: 'eagle', emoji: '🦅', tier: 'epic', minXp: 300 },
  { id: 'wolf', emoji: '🐺', tier: 'epic', minXp: 300 },
  { id: 'dolphin', emoji: '🐬', tier: 'epic', minXp: 300 },
  { id: 'dragon', emoji: '🐲', tier: 'epic', minXp: 300 },
  { id: 'phoenix', emoji: '🔥', tier: 'epic', minXp: 300 },
  // Legendarios: Erudito (2000 XP) y Maestro (4000 XP)
  { id: 'crown', emoji: '👑', tier: 'legendary', minXp: 2000 },
  { id: 'trophy', emoji: '🏆', tier: 'legendary', minXp: 2000 },
  { id: 'unicorn', emoji: '🦄', tier: 'legendary', minXp: 2000 },
  { id: 'comet', emoji: '☄️', tier: 'legendary', minXp: 4000 },
  { id: 'diamond', emoji: '💎', tier: 'legendary', minXp: 4000 },
];

const byId = new Map(AVATARS.map((a) => [a.id, a]));
const DEFAULT_AVATAR = 'chick';

function getAvatar(id) {
  return byId.get(id) || null;
}

function isUnlocked(avatar, xp) {
  return avatar.minXp <= (xp || 0);
}

function rankOf(xp) {
  let current = RANKS[0];
  for (const r of RANKS) {
    if ((xp || 0) >= r.minXp) current = r;
  }
  return current;
}

module.exports = { AVATARS, DEFAULT_AVATAR, getAvatar, isUnlocked, rankOf };
