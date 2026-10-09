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
    const st = { ws, questions: null, done: false, result: null, error: null, code: null, room: null };

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
      } else if (msg.type === 'error') st.error = msg.message;
    });
  });
}

function answerAll(st) {
  let i = 0;
  const tick = () => {
    if (!st.questions || i >= st.questions.length) return;
    const q = st.questions[i];
    // Estrategia distinta por cliente para que los puntajes difieran
    const option = st.strategy === 'last' ? q.opciones.length - 1 : 0;
    st.ws.send(JSON.stringify({ type: 'answer', index: q.index, option, elapsedMs: 100 + i * 5 }));
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

  p1.ws.close();
  p2.ws.close();
});

test('la sala llena rechaza a un tercer jugador', async () => {
  const a = await guest('Uno');
  const b = await guest('Dos');
  const c = await guest('Tres');

  const p1 = await connect(a.token);
  const p2 = await connect(b.token);
  const p3 = await connect(c.token);

  p1.ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => p1.code);
  p2.ws.send(JSON.stringify({ type: 'join', code: p1.code }));
  await waitFor(() => p2.room && p2.room.players.length === 2);
  p3.ws.send(JSON.stringify({ type: 'join', code: p1.code }));
  await waitFor(() => p3.error);
  assert.equal(p3.error, 'La sala ya está llena');

  p1.ws.close();
  p2.ws.close();
  p3.ws.close();
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
