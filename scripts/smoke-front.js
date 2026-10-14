// Smoke test: replica exactamente las llamadas que hace el front Flutter (colibri)
const base = 'http://127.0.0.1:4000';
const results = [];

function log(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ->  ' + detail);
}

async function call(name, method, path, body, token) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    log(name, res.status < 400, 'HTTP ' + res.status + ' ' + JSON.stringify(json || text).slice(0, 220));
    return { status: res.status, json };
  } catch (e) {
    log(name, false, 'EXCEPCION: ' + e.message);
    return { status: 0, json: null };
  }
}

(async () => {
  const deviceId = 'dev_' + Array.from({ length: 16 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, '0')).join('');

  await call('1 health', 'GET', '/api/health');

  // front: session_provider.dart L70  api.post('/api/players/guest', {deviceId, name}, auth:false)
  const guest = await call('2 POST /api/players/guest', 'POST', '/api/players/guest',
    { deviceId, name: 'Jugador' }, null);
  const token = guest.json && guest.json.token;
  const player = guest.json && guest.json.player;
  log('2b token + player devueltos', Boolean(token && player),
    token ? 'token len=' + token.length + ' player.id=' + (player && player.id) : 'sin token/player');

  // front: session_provider.dart L100  api.get('/api/players/me')
  await call('3 GET /api/players/me', 'GET', '/api/players/me', null, token);

  // front: session_provider.dart L171  api.post('/api/progress/sync', {...})
  await call('4 POST /api/progress/sync', 'POST', '/api/progress/sync', {
    xp: 120, points: 45, streak: 3, bestStreak: 7, sessions: 4,
    xpDelta: 120, pointsDelta: 45, dailyXp: 30,
  }, token);

  // front: leaderboard_page.dart L89  api.get('/api/leaderboard', query:{period,limit}, auth:false)
  await call('5 GET /api/leaderboard?period=week', 'GET', '/api/leaderboard?period=week&limit=100', null, null);
  await call('5b GET /api/leaderboard?period=all', 'GET', '/api/leaderboard?period=all&limit=100', null, null);

  // front: session_provider.dart L215  api.delete('/api/progress')
  await call('6 DELETE /api/progress', 'DELETE', '/api/progress', null, token);

  // front: duel_state.dart L161  WebSocketChannel.connect('$wsBase/ws?token=$token')
  await new Promise((resolve) => {
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      log('7 WS /ws?token= + {type:"create"}', ok, detail);
      try { ws.close(); } catch (_) {}
      resolve();
    };
    const ws = new WebSocket('ws://127.0.0.1:4000/ws?token=' + token);
    const t = setTimeout(() => finish(false, 'timeout 4s sin hello/created'), 4000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'create' }));
    ws.onmessage = (ev) => {
      clearTimeout(t);
      let m = {};
      try { m = JSON.parse(ev.data); } catch (_) {}
      if (m.type === 'hello') return; // esperar el 'created'
      finish(m.type === 'created', 'recibido type=' + m.type + ' code=' + (m.code || '-'));
    };
    ws.onerror = () => { clearTimeout(t); finish(false, 'error de socket'); };
    ws.onclose = (ev) => { clearTimeout(t); finish(false, 'cerrado code=' + ev.code + ' reason=' + (ev.reason || '')); };
  });

  const fails = results.filter((r) => !r.ok);
  console.log('\nRESUMEN: ' + (results.length - fails.length) + '/' + results.length + ' OK');
  if (fails.length) fails.forEach((f) => console.log('  FALLO: ' + f.name + ' -> ' + f.detail));
  process.exit(fails.length ? 1 : 0);
})();
