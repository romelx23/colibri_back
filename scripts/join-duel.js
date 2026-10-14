const WebSocket = require('ws');
const http = require('http');

const BASE = process.env.BASE || 'http://localhost:4000';
const WS_URL = process.env.WS_URL || 'ws://localhost:4000/ws';
const CODE = process.argv[2];
const NAME = process.argv[3] || 'Rival Bot';

if (!CODE) {
  console.error('uso: node scripts/join-duel.js <codigo6> [nombre]');
  process.exit(1);
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(BASE + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function waitFor(cond, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        reject(new Error('timeout: ' + what));
      }
    }, 20);
  });
}

async function main() {
  const guest = await post('/api/players/guest', {
    deviceId: 'rival-bot-' + Date.now(),
    name: NAME,
  });
  if (guest.status !== 201 && guest.status !== 200) {
    throw new Error('guest: ' + JSON.stringify(guest));
  }
  console.log('rival conectado como', guest.body.player.displayName);

  const ws = new WebSocket(`${WS_URL}?token=${guest.body.token}`);
  let questions = null;
  let joined = false;
  let result = null;

  ws.on('open', () => {
    console.log('ws abierto, esperando hello del servidor…');
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'hello') {
      ws.send(JSON.stringify({ type: 'join', code: CODE }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'ready' })), 300);
      console.log('unido a la sala', CODE);
    } else if (msg.type === 'room') {
      joined = msg.room.players.length >= 2;
      console.log('sala:', msg.room.players.map((p) => p.displayName).join(', '));
    } else if (msg.type === 'start') {
      questions = msg.questions;
      console.log('duelo iniciado con', questions.length, 'preguntas');
      responder(ws, questions);
    } else if (msg.type === 'result') {
      result = msg.result;
      console.log('resultado:', JSON.stringify(result));
      ws.close();
    } else if (msg.type === 'error') {
      console.log('error del servidor:', msg.message);
    }
  });

  await waitFor(() => joined, 6000, 'que el rival entre a la sala');
  console.log('OK: rival en sala');
  await waitFor(() => questions, 15000, 'inicio del duelo');
  await waitFor(() => result, 20000, 'resultado');
  console.log('DUELO E2E OK');
  process.exit(0);
}

function responder(ws, questions) {
  let i = 0;
  const tick = () => {
    if (i >= questions.length) return;
    const q = questions[i];
    ws.send(
      JSON.stringify({
        type: 'answer',
        index: q.index,
        option: q.opciones.length - 1,
        elapsedMs: 400 + i * 30,
      }),
    );
    i += 1;
    setTimeout(tick, 400);
  };
  setTimeout(tick, 300);
}

main().catch((err) => {
  console.error('FALLO:', err.message);
  process.exit(1);
});
