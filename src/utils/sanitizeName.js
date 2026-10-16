/**
 * Filtro de nicknames: normaliza, detecta evasión (leet/repeticiones) y
 * bloquea términos ofensivos o malintencionados.
 *
 * Uso: const { validateName } = require('../utils/sanitizeName');
 *      const r = validateName('  P.e.n.d.e.J0  ');  // { ok: false, ... }
 *
 * Se comparan dos claves del nickname:
 *   - keyRaw:      solo letras (leet resuelto), SIN colapsar repetidos.
 *                  Detecta "Puut0", "www", "PussyCat".
 *   - keyCollapsed: igual pero con letras repetidas colapsadas.
 *                  Detecta "puuuuto" → "puto".
 * El puntapié: cada término se compara en su propia forma (también sin
 * colapsar), nunca colapsado, porque "www" colapsado sería "w" y bloquearía
 * cualquier nick con esa letra.
 */

// Mapeo leet → letra. Se aplica sobre el texto ya en minúsculas.
const LEET = {
  '@': 'a', '4': 'a',
  '8': 'b',
  '(': 'c',
  '3': 'e',
  '6': 'g', '9': 'g',
  '1': 'i', '!': 'i', '|': 'i',
  '0': 'o',
  '$': 's', '5': 's',
  '7': 't',
  '+': 't',
  '2': 'z',
};

// Términos ofensivos en forma base (minúsculas, sin tildes, leet ya resuelto).
// Se comparan como subcadena contra las claves del nickname.
// Nota: se evitan términos cortos que colisionen con palabras comunes
// (p. ej. no está "down" por "Download", ni "bot" por "Robot").
const BLOCKED = [
  // español - groserías
  'puto', 'puta', 'putit', 'pendej', 'cabron', 'mamarrach', 'imbecil', 'idiota',
  'estupid', 'subnormal', 'mongol', 'retrasad', 'malparid', 'hijueputa',
  'hijoputa', 'gonorrea', 'malnacido', 'malnacida', 'menso',
  // español - vulgar / sexual
  'maricon', 'marica', 'joto', 'coger', 'coño', 'cono', 'teton', 'nalgada',
  'pedo', 'mierd', 'bosta', 'caca', 'orina', 'viada',
  // español - odio / delito
  'nazi', 'hitler', 'negrata', 'terroris', 'asesin', 'violador',
  // inglés
  'fuck', 'faggot', 'nigger', 'bitch', 'whore', 'slut', 'dick', 'cunt',
  'asshole', 'bastard', 'retard', 'shit', 'pussy', 'wanker',
  // spam / malintencionado
  'http', 'www', 'onlyfans', 'facebook', 'instagram', 'tiktok', 'spam',
  'hack', 'hacker', 'freefire',
];

// Palabras inocentes que contienen un término prohibido como subcadena.
// Se eliminan de la clave ANTES de comparar, para no bloquear nicks legítimos
// ("Computo" lleva "puto", "Icono" lleva "cono", "Classic" lleva "ass").
const SAFE_WORDS = [
  'computa', 'computo', 'compu', 'input', 'output', 'disput', 'icono',
  'cacatua', 'cacahuate',
];

function lettersOnly(value) {
  const lowered = String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // quita tildes y la virgulilla de la ñ
  let out = '';
  for (const ch of lowered) out += LEET[ch] ?? ch;
  return out.replace(/[^a-z]/g, '');
}

const COLLAPSED = /([a-z])\1+/g;

function keysOf(value) {
  const raw = lettersOnly(value);
  return { raw, collapsed: raw.replace(COLLAPSED, '$1') };
}

function hasBlockedTerm(name) {
  const { raw, collapsed } = keysOf(name);
  if (!raw) return null;
  const scrub = (s) =>
    SAFE_WORDS.reduce((acc, w) => acc.split(w).join(''), s);
  const rawClean = scrub(raw);
  const collapsedClean = scrub(collapsed);
  if (!rawClean && !collapsedClean) return null;
  for (const term of BLOCKED) {
    const t = lettersOnly(term);
    if (!t) continue;
    if (rawClean.includes(t) || collapsedClean.includes(t)) return term;
    // "puuuuto": el nick colapsado "puto" compara contra el término colapsado.
    // Se exige longitud >= 4 para no colapsar "www" a "w" (bloquearía todo).
    const tc = t.replace(COLLAPSED, '$1');
    if (tc.length >= 4 && collapsedClean.includes(tc)) return term;
  }
  return null;
}

/**
 * Valida y limpia un nickname.
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 */
function validateName(raw) {
  const name = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ') // colapsa espacios
    .replace(/[\u200B-\u200D\uFEFF]/g, ''); // cero-anchos

  if (name.length < 2 || name.length > 24) {
    return { ok: false, reason: 'El nombre debe tener entre 2 y 24 caracteres' };
  }
  // Letras (incluye tildes y ñ), números y espacios. Nada de puntuación.
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 ]+$/.test(name)) {
    return { ok: false, reason: 'Usa solo letras, números y espacios' };
  }
  const term = hasBlockedTerm(name);
  if (term) {
    return { ok: false, reason: 'Ese nombre contiene términos no permitidos' };
  }
  return { ok: true, name };
}

module.exports = { validateName, keysOf };
