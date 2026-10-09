const WebSocket = require('ws');
const http = require('http');

const BASE = process.env.BASE || 'http://localhost:4000';
const WS_URL = process.env.WS_URL || 'ws://localhost:4000/ws';

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(BASE + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function player(name, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    const st = { ws, name, questions: null, done: false, result: null, error: null };

    ws.on('open', () => resolve(st));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      st.last = msg;
      if (msg.type === 'created') {
        st.code = msg.code;
      } else if (msg.type === 'start') {
        st.questions = msg.questions;
        answerAll(st);
      } else if (msg.type === 'result') {
        st.result = msg.result;
        st.done = true;
      } else if (msg.type === 'error') {
        st.error = msg.message;
      }
    });
  });
}

// Responde todo con la opción 0 salvo una que acierta según el orden
function answerAll(st) {
  const me = st.name;
  let i = 0;
  const tick = () => {
    if (i >= st.questions.length) return;
    const q = st.questions[i];
    const option = me === 'Romel' ? 0 : q.opciones.length - 1;
    st.ws.send(JSON.stringify({ type: 'answer', index: q.index, option, elapsedMs: 120 + i * 7 }));
    i += 1;
    setTimeout(tick, 25);
  };
  setTimeout(tick, 30);
}

async function main() {
  const a = await post('/api/players/guest', {
    deviceId: 'duel-dev-' + Date.now() + '-a',
    name: 'Romel',
  });
  const b = await post('/api/players/guest', {
    deviceId: 'duel-dev-' + Date.now() + '-b',
    name: 'Ana',
  });
  if (a.status !== 201 && a.status !== 200) throw new Error('guest a: ' + JSON.stringify(a));
  console.log('jugadores creados');

  const p1 = await player('Romel', a.body.token);
  const p2 = await player('Ana', b.body.token);

  p1.ws.send(JSON.stringify({ type: 'create' }));
  try {
    await waitFor(() => p1.code, 5000);
  } catch (e) {
    console.error('debug p1.error=', p1.error, 'p1.last=', JSON.stringify(p1.last));
    throw e;
  }
  const code = p1.code;
  console.log('sala creada:', code);
  if (!/^\d{6}$/.test(code)) throw new Error('código inválido');

  p2.ws.send(JSON.stringify({ type: 'join', code }));
  await waitFor(() => p2.last && p2.last.type === 'room' && p2.last.room.players.length === 2, 5000);
  console.log('Ana unida:', p2.last.room.players.map((p) => p.displayName).join(', '));

  p1.ws.send(JSON.stringify({ type: 'ready' }));
  p2.ws.send(JSON.stringify({ type: 'ready' }));
  await waitFor(() => p1.questions && p2.questions, 8000);
  console.log('duelo iniciado con', p1.questions.length, 'preguntas');
  if (p1.questions.length !== 10) throw new Error('no son 10 preguntas');
  if ('correcta' in p1.questions[0]) throw new Error('¡la respuesta correcta se filtró!');
  console.log('ok: sin alternativa correcta en el payload');

  await waitFor(() => p1.done && p2.done, 15000);
  const r = p1.result;
  console.log('resultado:', JSON.stringify(r, null, 2));

  const rows = r.players.map((p) => `${p.displayName}: ${p.correct} correctas, ${p.totalMs}ms`);
  console.log(rows.join('\n'));
  console.log('ganador:', r.winnerId ? r.players.find((p) => p.playerId === r.winnerId).displayName : 'empate');

  p1.ws.close();
  p2.ws.close();
  console.log('DUELO OK');
  process.exit(0);
}

function waitFor(cond, timeoutMs) {
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
    }, 20);
  });
}

main().catch((err) => {
  console.error('FALLO:', err.message);
  process.exit(1);
});
