const crypto = require('crypto');
const { query } = require('../config/db');

const ROOM_TTL_MS = 10 * 60 * 1000;
const QUESTION_COUNT = 10;

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    players: [room.host, room.guest].filter(Boolean).map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      avatarSeed: p.avatarSeed,
      ready: p.ready,
    })),
  };
}

function createRoom(player) {
  const code = makeCode();
  const room = {
    code,
    host: { ...player, ready: false, ws: player.ws },
    guest: null,
    questions: null,
    correct: null,
    answers: new Map(),
    status: 'waiting',
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code) || null;
}

function joinRoom(code, player) {
  const room = rooms.get(code);
  if (!room) return { error: 'Sala no encontrada' };
  if (room.guest) return { error: 'La sala ya está llena' };
  if (room.host.playerId === player.playerId) return { error: 'Ya estás en la sala' };
  room.guest = { ...player, ready: false, ws: player.ws };
  return { room };
}

async function startIfReady(room) {
  if (!room.host.ready || !room.guest || !room.guest.ready) return null;
  if (room.status !== 'waiting') return null;

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

  room.questions = rows;
  room.correct = rows.map((r) => r.correcta);
  room.answers = new Map([
    [room.host.playerId, new Map()],
    [room.guest.playerId, new Map()],
  ]);
  room.status = 'playing';
  return room;
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
  return { isCorrect, done };
}

function scoreOf(room, playerId) {
  const byPlayer = room.answers.get(playerId);
  if (!byPlayer) return { correct: 0, totalMs: 0 };
  let correct = 0;
  let totalMs = 0;
  for (const [qIndex, a] of byPlayer) {
    if (a.isCorrect) correct += 1;
    totalMs += a.elapsedMs || 0;
    void qIndex;
  }
  return { correct, totalMs };
}

function bothDone(room) {
  if (!room.host || !room.guest) return false;
  for (const p of [room.host, room.guest]) {
    const byPlayer = room.answers.get(p.playerId);
    if (!byPlayer || byPlayer.size < room.questions.length) return false;
  }
  return true;
}

function result(room) {
  const hostScore = scoreOf(room, room.host.playerId);
  const guestScore = scoreOf(room, room.guest.playerId);

  let winnerId = null;
  if (hostScore.correct !== guestScore.correct) {
    winnerId = hostScore.correct > guestScore.correct ? room.host.playerId : room.guest.playerId;
  } else if (hostScore.totalMs !== guestScore.totalMs) {
    winnerId = hostScore.totalMs < guestScore.totalMs ? room.host.playerId : room.guest.playerId;
  }

  return {
    code: room.code,
    winnerId,
    players: [
      { playerId: room.host.playerId, displayName: room.host.displayName, ...hostScore },
      { playerId: room.guest.playerId, displayName: room.guest.displayName, ...guestScore },
    ],
  };
}

async function persistResult(room) {
  const res = result(room);
  room.status = 'finished';

  await query(
    `INSERT INTO duels (code, host_id, guest_id, status, questions, host_score, guest_score, winner_id, finished_at)
     VALUES ($1, $2, $3, 'finished', $4, $5, $6, $7, now())
     ON CONFLICT (code) DO UPDATE SET
       status = 'finished',
       guest_id = EXCLUDED.guest_id,
       host_score = EXCLUDED.host_score,
       guest_score = EXCLUDED.guest_score,
       winner_id = EXCLUDED.winner_id,
       finished_at = now()`,
    [
      room.code,
      room.host.playerId,
      room.guest.playerId,
      JSON.stringify(room.questions.map((q) => q.id)),
      res.players[0].correct,
      res.players[1].correct,
      res.winnerId,
    ]
  );

  for (const p of [room.host, room.guest]) {
    const byPlayer = room.answers.get(p.playerId) || new Map();
    for (const [qIndex, a] of byPlayer) {
      await query(
        `INSERT INTO duel_answers (duel_id, player_id, q_index, answer, is_correct, elapsed_ms)
         SELECT id, $2, $3, $4, $5, $6 FROM duels WHERE code = $1
         ON CONFLICT (duel_id, player_id, q_index) DO NOTHING`,
        [room.code, p.playerId, qIndex, a.answer, a.isCorrect, a.elapsedMs || 0]
      );
    }
  }

  return res;
}

function leaveRoom(playerId) {
  const found = [];
  for (const room of rooms.values()) {
    if ((room.host && room.host.playerId === playerId) || (room.guest && room.guest.playerId === playerId)) {
      found.push(room);
    }
  }
  for (const room of found) rooms.delete(room.code);
  return found;
}

function sweepExpired() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

setInterval(sweepExpired, 60 * 1000).unref();

module.exports = {
  createRoom,
  getRoom,
  joinRoom,
  startIfReady,
  recordAnswer,
  bothDone,
  result,
  persistResult,
  leaveRoom,
  publicRoom,
  publicQuestions,
  QUESTION_COUNT,
};
