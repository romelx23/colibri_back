const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const request = require('supertest');

const { prepare } = require('./helpers/bootstrap');

let server;
let app;
let port;
let closePool;

async function guest(name) {
  const res = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: `duel-${name}-${Date.now()}-${Math.random()}`, name });
  assert.ok(res.body.token, `sin token para ${name}`);
  return res.body;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
    const st = { ws, questions: null, done: false, result: null, error: null, code: null, room: null, excluded: null, lefts: [], peers: [] };

    ws.on('open', () => resolve(st));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      st.last = msg;
      if (msg.type === 'created') st.code = msg.code;
      else if (msg.type === 'room') st.room = msg.room;
      else if (msg.type === 'start') {
        st.questions = msg.questions;
        answerAll(st);
      } else if (msg.type === 'result') {
        st.result = msg.result;
        st.done = true;
      }       else if (msg.type === 'excluded') st.excluded = msg;
      else if (msg.type === 'playerLeft') st.lefts.push(msg);
      else if (msg.type === 'peerProgress') st.peers.push(msg);
      else if (msg.type === 'error') st.error = msg.message;
    });
  });
}

function answerAll(st) {
  let i = 0;
  const tick = () => {
    if (!st.questions || i >= st.questions.length) return;
    const q = st.questions[i];
    // Estrategia distinta por cliente: opción y tiempo diferentes, para que
    // nunca haya empate exacto (correct + totalMs) y el test sea determinista.
    const last = st.strategy === 'last';
    const option = last ? q.opciones.length - 1 : 0;
    const base = last ? 200 : 100;
    st.ws.send(JSON.stringify({ type: 'answer', index: q.index, option, elapsedMs: base + i * 5 }));
    i += 1;
    setTimeout(tick, 10);
  };
  setTimeout(tick, 20);
}

function waitFor(cond, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        reject(new Error('timeout esperando condición'));
      }
    }, 15);
  });
}

before(async () => {
  await prepare();
  app = require('../src/app').createApp();
  ({ closePool } = require('../src/config/db'));

  server = http.createServer(app);
  require('../src/ws/duelServer').attachDuelServer(server);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (closePool) await closePool();
});

test('conexión sin token se rechaza con 4001', async () => {
  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('close', (c) => resolve(c));
    ws.on('error', () => resolve(-1));
    setTimeout(() => reject(new Error('no cerró')), 3000);
  });
  assert.equal(code, 4001);
});

test('duelo completo: crea, une, juega 10 preguntas y persiste', async () => {
  const a = await guest('Romel');
  const b = await guest('Ana');

  const p1 = await connect(a.token);
  p1.strategy = 'first';
  const p2 = await connect(b.token);
  p2.strategy = 'last';

  p1.ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => p1.code);
  assert.match(p1.code, /^\d{6}$/);

  p2.ws.send(JSON.stringify({ type: 'join', code: p1.code }));
  await waitFor(() => p2.room && p2.room.players.length === 2);
  assert.equal(p2.room.players.length, 2);

  p1.ws.send(JSON.stringify({ type: 'ready' }));
  p2.ws.send(JSON.stringify({ type: 'ready' }));
  await waitFor(() => p1.questions && p2.questions);

  assert.equal(p1.questions.length, 10);
  assert.equal(p2.questions.length, 10);
  assert.equal(p1.questions[0].correcta, undefined, 'la respuesta no puede ir en el payload');
  assert.equal(typeof p1.questions[0].opciones, 'object');

  await waitFor(() => p1.done && p2.done, 20000);

  const result = p1.result;
  assert.equal(result.players.length, 2);
  const total = result.players.reduce((s, p) => s + p.correct, 0);
  assert.ok(total >= 1, 'alguien debe haber acertado');
  assert.ok(result.winnerId || total === 0);

  assert.ok(p2.peers.length >= 1, 'los rivales reciben el avance en vivo');
  assert.ok(
    p2.peers.every((m) => typeof m.answered === 'number' && typeof m.correct === 'number'),
    'peerProgress lleva respondidas y aciertos'
  );

  p1.ws.close();
  p2.ws.close();
});

test('la sala acepta hasta 8 jugadores y rechaza al noveno', async () => {
  const seats = [];
  for (let i = 0; i < 9; i += 1) {
    const g = await guest(`J${i}`);
    seats.push(await connect(g.token));
  }

  seats[0].ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => seats[0].code);
  for (let i = 1; i < 8; i += 1) {
    seats[i].ws.send(JSON.stringify({ type: 'join', code: seats[0].code }));
    await waitFor(() => seats[i].room && seats[i].room.players.length === i + 1);
  }
  assert.equal(seats[7].room.players.length, 8);
  assert.equal(seats[7].room.maxPlayers, 8);

  seats[8].ws.send(JSON.stringify({ type: 'join', code: seats[0].code }));
  await waitFor(() => seats[8].error);
  assert.equal(seats[8].error, 'La sala está llena (8/8)');

  for (const s of seats) s.ws.close();
});

test('el anfitrión puede empezar con al menos 2 listos', async () => {
  const a = await guest('Anfitrion');
  const b = await guest('Listo');
  const c = await guest('Tardio');

  const p1 = await connect(a.token);
  const p2 = await connect(b.token);
  const p3 = await connect(c.token);
  p2.strategy = 'last';

  p1.ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => p1.code);
  p2.ws.send(JSON.stringify({ type: 'join', code: p1.code }));
  await waitFor(() => p2.room && p2.room.players.length === 2);
  p3.ws.send(JSON.stringify({ type: 'join', code: p1.code }));
  await waitFor(() => p3.room && p3.room.players.length === 3);

  p2.ws.send(JSON.stringify({ type: 'ready' }));
  await waitFor(() => p1.room && p1.room.players.filter((p) => p.ready).length === 1);

  p1.ws.send(JSON.stringify({ type: 'startNow' }));
  await waitFor(() => p1.questions && p2.questions);
  await waitFor(() => p3.excluded);
  assert.equal(p3.excluded.message, 'La partida empezó sin ti.');

  await waitFor(() => p1.done && p2.done, 20000);
  assert.equal(p1.result.players.length, 2);
  assert.ok(p1.result.winnerId || p1.result.players[0].correct === p1.result.players[1].correct);

  for (const p of [p1, p2, p3]) p.ws.close();
});

test('si un jugador se va, los demás siguen y terminan', async () => {
  const a = await guest('Queda');
  const b = await guest('Sigue');
  const c = await guest('SeVa');

  const p1 = await connect(a.token);
  const p2 = await connect(b.token);
  const p3 = await connect(c.token);
  p1.strategy = 'first';
  p2.strategy = 'last';

  p1.ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => p1.code);
  for (const [p, code] of [[p2, p1.code], [p3, p1.code]]) {
    p.ws.send(JSON.stringify({ type: 'join', code }));
    await waitFor(() => p.room && p.room.players.length >= 2);
  }
  await waitFor(() => p1.room.players.length === 3);

  p1.ws.send(JSON.stringify({ type: 'ready' }));
  p2.ws.send(JSON.stringify({ type: 'ready' }));
  await waitFor(() => p1.room.players.filter((p) => p.ready).length === 2);

  p3.ws.send(JSON.stringify({ type: 'leave' }));
  await waitFor(() => p1.questions && p2.questions, 15000);
  assert.ok(p1.lefts.some((m) => m.displayName === 'SeVa'), 'avisa quién salió');

  await waitFor(() => p1.done && p2.done, 20000);
  assert.equal(p1.result.players.length, 2, 'la sala sigue con los2 restantes');

  for (const p of [p1, p2, p3]) p.ws.close();
});

test('duelo de 8 jugadores: ranking ordenado y fila por jugador', async () => {
  const { query } = require('../src/config/db');
  const seats = [];
  for (let i = 0; i < 8; i += 1) {
    const g = await guest(`Ocho${i}`);
    const c = await connect(g.token);
    c.strategy = i % 2 ? 'last' : 'first';
    seats.push(c);
  }

  seats[0].ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => seats[0].code);
  for (let i = 1; i < 8; i += 1) {
    seats[i].ws.send(JSON.stringify({ type: 'join', code: seats[0].code }));
    await waitFor(() => seats[i].room && seats[i].room.players.length === i + 1);
  }

  for (const s of seats) s.ws.send(JSON.stringify({ type: 'ready' }));
  await waitFor(() => seats.every((s) => s.questions), 20000);
  await waitFor(() => seats.every((s) => s.done), 30000);

  const result = seats[0].result;
  assert.equal(result.players.length, 8, 'los8 deben aparecer en el resultado');
  assert.deepEqual(
    result.players.map((p) => p.position),
    [1, 2, 3, 4, 5, 6, 7, 8],
    'posiciones correlativas'
  );
  for (let i = 1; i < result.players.length; i += 1) {
    assert.ok(
      result.players[i - 1].correct >= result.players[i].correct,
      'el ranking ordena por aciertos'
    );
  }

  const rows = await query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE is_winner)::int AS winners
       FROM duel_players dp
       JOIN duels d ON d.id = dp.duel_id
      WHERE d.code = $1`,
    [result.code]
  );
  assert.equal(rows.rows[0].n, 8, 'una fila por participante en duel_players');
  assert.ok(rows.rows[0].winners <= 1, 'como mucho un ganador marcado');

  for (const s of seats) s.ws.close();
});

test('unirse a una sala inexistente da error', async () => {
  const a = await guest('Solo');
  const p1 = await connect(a.token);
  p1.ws.send(JSON.stringify({ type: 'join', code: '999999' }));
  await waitFor(() => p1.error);
  assert.equal(p1.error, 'Sala no encontrada');
  p1.ws.close();
});

test('los duelos terminados quedan en Postgres', async () => {
  const { query } = require('../src/config/db');
  const { rows } = await query(
    "SELECT code, status, jsonb_array_length(questions) AS n FROM duels WHERE status = 'finished'"
  );
  assert.ok(rows.length >= 1, 'debe haber al menos un duelo guardado');
  assert.equal(rows[0].n, 10);

  const answers = await query('SELECT count(*)::int AS n FROM duel_answers');
  assert.ok(answers.rows[0].n >= 20, 'debe haber respuestas persistidas');
});
