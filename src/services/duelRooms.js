const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');

const ROOM_TTL_MS = 10 * 60 * 1000;
const QUESTION_COUNT = 10;
const MAX_PLAYERS = 8;

/** @type {Map<string, Room>} */
const rooms = new Map();

/** playerId -> code de la sala en la que está (evita escanear todas las salas). */
const playerRoom = new Map();

function makeCode() {
  let code;
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (rooms.has(code));
  return code;
}

function isHost(room, playerId) {
  return room.players.length > 0 && room.players[0].playerId === playerId;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    maxPlayers: room.maxPlayers,
    players: room.players.map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      avatarSeed: p.avatarSeed,
      ready: p.ready,
      connected: p.connected !== false,
    })),
  };
}

function createRoom(player) {
  detach(player.playerId);
  const code = makeCode();
  const room = {
    code,
    maxPlayers: MAX_PLAYERS,
    players: [{ ...player, ready: false, connected: true, ws: player.ws }],
    questions: null,
    correct: null,
    answers: new Map(),
    status: 'waiting',
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  playerRoom.set(player.playerId, code);
  return room;
}

function getRoom(code) {
  return rooms.get(code) || null;
}

function joinRoom(code, player) {
  const room = rooms.get(code);
  if (!room) return { error: 'Sala no encontrada' };
  if (room.status !== 'waiting') return { error: 'La partida ya empezó' };
  if (room.players.some((p) => p.playerId === player.playerId)) {
    return { error: 'Ya estás en la sala' };
  }
  if (room.players.length >= room.maxPlayers) {
    return { error: `La sala está llena (${room.maxPlayers}/8)` };
  }
  detach(player.playerId);
  room.players.push({ ...player, ready: false, connected: true, ws: player.ws });
  playerRoom.set(player.playerId, room.code);
  return { room };
}

function setReady(room, playerId) {
  const me = room.players.find((p) => p.playerId === playerId);
  if (!me) return null;
  me.ready = true;
  return me;
}

/**
 * Arranca cuando todos están listos o cuando el anfitrión lo fuerza
 * (`force`) con al menos 2 listos; en ese caso los que no marcaron listo
 * quedan fuera de la partida. Devuelve { included, excluded } o null.
 */
async function startIfReady(room, { force = false } = {}) {
  if (room.status !== 'waiting') return null;
  if (room.players.length < 2) return null;

  const ready = room.players.filter((p) => p.ready);
  const allReady = ready.length === room.players.length;

  let included = null;
  if (allReady) included = room.players;
  else if (force && ready.length >= 2) included = ready;
  if (!included) return null;

  // Bloquea arranques concurrentes mientras se cargan las preguntas.
  room.status = 'starting';
  try {
    return await prepareStart(room, included);
  } catch (err) {
    room.status = 'waiting';
    throw err;
  }
}

async function prepareStart(room, included) {
  if (included.length < 2) return null;

  const { rows } = await query(
    `SELECT id, categoria, dificultad, enunciado, opciones, correcta, referencia
       FROM questions
      ORDER BY random()
      LIMIT $1`,
    [QUESTION_COUNT]
  );
  if (rows.length < QUESTION_COUNT) {
    throw new Error('No hay suficientes preguntas en la DB');
  }

  const excluded = room.players.filter((p) => !included.some((i) => i.playerId === p.playerId));

  room.players = included;
  room.questions = rows;
  room.correct = rows.map((r) => r.correcta);
  room.answers = new Map(included.map((p) => [p.playerId, new Map()]));
  room.status = 'playing';

  for (const p of excluded) playerRoom.delete(p.playerId);

  return { included, excluded };
}

// Las preguntas se envían SIN la respuesta correcta: el servidor es quien valida.
function publicQuestions(room) {
  return room.questions.map((q, index) => ({
    index,
    id: q.id,
    categoria: q.categoria,
    dificultad: q.dificultad,
    enunciado: q.enunciado,
    opciones: q.opciones,
    referencia: q.referencia,
  }));
}

function recordAnswer(room, playerId, qIndex, answer, elapsedMs) {
  const byPlayer = room.answers.get(playerId);
  if (!byPlayer) return { error: 'No estás jugando esta sala' };
  if (byPlayer.has(qIndex)) return { error: 'Pregunta ya respondida' };
  if (qIndex < 0 || qIndex >= room.questions.length) return { error: 'Índice inválido' };

  const isCorrect = answer === room.correct[qIndex];
  byPlayer.set(qIndex, { answer, elapsedMs, isCorrect });

  const done = byPlayer.size === room.questions.length;
  const answered = byPlayer.size;
  let correct = 0;
  for (const a of byPlayer.values()) {
    if (a.isCorrect) correct += 1;
  }
  return { isCorrect, done, answered, correct };
}

function scoreOf(room, playerId) {
  const byPlayer = room.answers.get(playerId);
  if (!byPlayer) return { correct: 0, totalMs: 0 };
  let correct = 0;
  let totalMs = 0;
  for (const a of byPlayer.values()) {
    if (a.isCorrect) correct += 1;
    totalMs += a.elapsedMs || 0;
  }
  return { correct, totalMs };
}

function allDone(room) {
  if (!room.questions) return false;
  return room.players.every((p) => {
    const byPlayer = room.answers.get(p.playerId);
    return byPlayer && byPlayer.size >= room.questions.length;
  });
}

function playersDone(room) {
  if (!room.questions) return 0;
  return room.players.filter((p) => {
    const byPlayer = room.answers.get(p.playerId);
    return byPlayer && byPlayer.size >= room.questions.length;
  }).length;
}

/** Ranking: más aciertos primero, a igualdad el más rápido. */
function result(room) {
  const scored = room.players.map((p) => ({
    playerId: p.playerId,
    displayName: p.displayName,
    connected: p.connected !== false,
    ...scoreOf(room, p.playerId),
  }));

  scored.sort((a, b) => b.correct - a.correct || a.totalMs - b.totalMs);
  const players = scored.map((s, i) => ({ ...s, position: i + 1, isWinner: false }));

  let winnerId = null;
  const first = players[0];
  const second = players[1];
  const clearWinner = players.length === 1 ||
    first.correct !== second.correct ||
    first.totalMs !== second.totalMs;
  if (first && clearWinner) {
    winnerId = first.playerId;
    first.isWinner = true;
  }

  return { code: room.code, winnerId, players };
}

async function persistResult(room) {
  const res = result(room);
  room.status = 'finished';

  const questionIds = room.questions.map((q) => q.id);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO duels (code, host_id, status, questions, winner_id, finished_at, max_players)
       VALUES ($1, $2, 'finished', $3, $4, now(), $5)
       ON CONFLICT (code) DO UPDATE SET
         status = 'finished',
         winner_id = EXCLUDED.winner_id,
         finished_at = EXCLUDED.finished_at,
         max_players = EXCLUDED.max_players`,
      [room.code, room.players[0].playerId, JSON.stringify(questionIds), res.winnerId, room.maxPlayers]
    );

    if (res.players.length) {
      // $1 = code (via dpParams); cada fila ocupa los 6 parámetros siguientes.
      const dpParams = [room.code];
      const dpValues = [];
      for (const p of res.players) {
        dpValues.push(`($${dpParams.length + 1}::uuid, $${dpParams.length + 2}::int, $${dpParams.length + 3}::int, $${dpParams.length + 4}::int, $${dpParams.length + 5}::boolean, $${dpParams.length + 6}::boolean)`);
        dpParams.push(p.playerId, p.position, p.correct, p.totalMs, p.isWinner, p.connected);
      }
      await client.query(
        `INSERT INTO duel_players (duel_id, player_id, position, correct, total_ms, is_winner, connected)
         SELECT d.id, v.player_id, v.position, v.correct, v.total_ms, v.is_winner, v.connected
           FROM duels d
           JOIN (VALUES ${dpValues.join(', ')})
                AS v(player_id, position, correct, total_ms, is_winner, connected) ON true
          WHERE d.code = $1
          ON CONFLICT (duel_id, player_id) DO UPDATE SET
            position = EXCLUDED.position,
            correct = EXCLUDED.correct,
            total_ms = EXCLUDED.total_ms,
            is_winner = EXCLUDED.is_winner,
            connected = EXCLUDED.connected`,
        dpParams
      );
    }

    const ansParams = [room.code];
    const ansValues = [];
    for (const p of room.players) {
      const byPlayer = room.answers.get(p.playerId) || new Map();
      for (const [qIndex, a] of byPlayer) {
        ansValues.push(
          `($${ansParams.length + 1}::uuid, $${ansParams.length + 2}::int, $${ansParams.length + 3}::int, $${ansParams.length + 4}::boolean, $${ansParams.length + 5}::int)`
        );
        ansParams.push(p.playerId, qIndex, a.answer, a.isCorrect, a.elapsedMs || 0);
      }
    }
    if (ansValues.length) {
      await client.query(
        `INSERT INTO duel_answers (duel_id, player_id, q_index, answer, is_correct, elapsed_ms)
         SELECT d.id, v.player_id, v.q_index, v.answer, v.is_correct, v.elapsed_ms
           FROM duels d
           JOIN (VALUES ${ansValues.join(', ')})
                AS v(player_id, q_index, answer, is_correct, elapsed_ms) ON true
          WHERE d.code = $1
          ON CONFLICT (duel_id, player_id, q_index) DO NOTHING`,
        ansParams
      );
    }
  });

  return res;
}

/**
 * Saca a un jugador de su sala. Borra la sala si queda vacía y avisa si hay
 * que cerrar la partida (quedan 0 o 1 jugadores en curso).
 */
function removeFromRoom(room, playerId) {
  const res = detach(playerId);
  if (!res || res.room !== room) return { room: rooms.get(room.code) || null, removed: null, finish: false };

  const alive = rooms.get(room.code) || null;
  if (!alive) return { room: null, removed: res.removed, finish: false, deleted: true };

  const finish =
    alive.status === 'playing' && Boolean(alive.questions) && alive.players.length <= 1;

  return { room: alive, removed: res.removed, finish };
}

function detach(playerId) {
  const code = playerRoom.get(playerId);
  playerRoom.delete(playerId);
  if (!code) return null;

  const room = rooms.get(code);
  if (!room) return null;

  const idx = room.players.findIndex((p) => p.playerId === playerId);
  if (idx < 0) return null;

  const [removed] = room.players.splice(idx, 1);
  room.answers.delete(playerId);

  if (room.players.length === 0) rooms.delete(room.code);

  return { room, removed };
}

function roomOf(playerId) {
  const code = playerRoom.get(playerId);
  return code ? rooms.get(code) || null : null;
}

function sweepExpired() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      for (const p of room.players) playerRoom.delete(p.playerId);
      rooms.delete(code);
    }
  }
}

setInterval(sweepExpired, 60 * 1000).unref();

module.exports = {
  createRoom,
  getRoom,
  joinRoom,
  setReady,
  startIfReady,
  recordAnswer,
  allDone,
  playersDone,
  result,
  persistResult,
  removeFromRoom,
  roomOf,
  isHost,
  publicRoom,
  publicQuestions,
  QUESTION_COUNT,
  MAX_PLAYERS,
};
