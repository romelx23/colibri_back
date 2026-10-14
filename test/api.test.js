const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { prepare } = require('./helpers/bootstrap');

let app;
let closePool;

before(async () => {
  await prepare();
  app = require('../src/app').createApp();
  ({ closePool } = require('../src/config/db'));
});

after(async () => {
  if (closePool) await closePool();
});

let token1;
let token2;

test('health responde ok', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.app, 'colibri');
});

test('CORS por defecto permite cualquier origen', async () => {
  const res = await request(app)
    .get('/api/health')
    .set('Origin', 'https://cualquiera.com');
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('CORS acepta una lista de orígenes separada por coma', async () => {
  const previous = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://a.com, https://b.com';
  const appWithList = require('../src/app').createApp();
  if (previous === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = previous;

  const permitido = await request(appWithList)
    .get('/api/health')
    .set('Origin', 'https://b.com');
  assert.equal(permitido.status, 200);
  assert.equal(permitido.headers['access-control-allow-origin'], 'https://b.com');

  const bloqueado = await request(appWithList)
    .get('/api/health')
    .set('Origin', 'https://otro.com');
  assert.equal(bloqueado.status, 200);
  assert.equal(bloqueado.headers['access-control-allow-origin'], undefined);
});

test('crea jugador invitado y devuelve token', async () => {
  const res = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: 'test-device-0001', name: 'Romel' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.player.displayName, 'Romel');
  assert.equal(res.body.player.isGuest, true);
  token1 = res.body.token;
});

test('el mismo deviceId recupera al mismo jugador', async () => {
  const res = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: 'test-device-0001', name: 'Romel' });
  assert.equal(res.status, 200);
  assert.equal(res.body.player.displayName, 'Romel');
});

test('rechaza un nombre demasiado corto', async () => {
  const res = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: 'test-device-9999', name: 'A' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Datos inválidos');
});

test('GET /players/me requiere token', async () => {
  const res = await request(app).get('/api/players/me');
  assert.equal(res.status, 401);
});

test('GET /players/me con token devuelve el perfil', async () => {
  const res = await request(app)
    .get('/api/players/me')
    .set('Authorization', `Bearer ${token1}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.player.xp, 0);
});

test('sync sube el progreso', async () => {
  const res = await request(app)
    .post('/api/progress/sync')
    .set('Authorization', `Bearer ${token1}`)
    .send({
      xp: 500,
      points: 25,
      streak: 3,
      bestStreak: 7,
      sessions: 8,
      xpDelta: 500,
      pointsDelta: 25,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.player.xp, 500);
  assert.equal(res.body.player.points, 25);
});

test('anti-cheat: el progreso no puede retroceder', async () => {
  const res = await request(app)
    .post('/api/progress/sync')
    .set('Authorization', `Bearer ${token1}`)
    .send({
      xp: 10,
      points: 0,
      streak: 1,
      bestStreak: 7,
      sessions: 1,
      xpDelta: 10,
      pointsDelta: 0,
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'El progreso no puede retroceder');
});

test('anti-cheat: delta gigante en sync posterior se rechaza', async () => {
  const res = await request(app)
    .post('/api/progress/sync')
    .set('Authorization', `Bearer ${token1}`)
    .send({
      xp: 99999,
      points: 25,
      streak: 1,
      bestStreak: 7,
      sessions: 1,
      xpDelta: 9000,
      pointsDelta: 0,
    });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'Valores de sesión fuera de rango');
});

test('sync acepta valores negativos o no enteros? no: valida esquema', async () => {
  const res = await request(app)
    .post('/api/progress/sync')
    .set('Authorization', `Bearer ${token1}`)
    .send({ xp: -5, points: 0, streak: 0, bestStreak: 0, sessions: 0, xpDelta: 0, pointsDelta: 0 });
  assert.equal(res.status, 400);
});

test('registro convierte al invitado en cuenta', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${token1}`)
    .send({ email: 'romel@test.com', password: 'secreto123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.player.isGuest, false);
  assert.equal(res.body.player.email, 'romel@test.com');
});

test('login con credenciales correctas', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'romel@test.com', password: 'secreto123' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  token2 = res.body.token;
});

test('login con credenciales incorrectas', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'romel@test.com', password: 'mala' });
  assert.equal(res.status, 401);
});

test('ranking ordena por xp descendente e incluye tu fila', async () => {
  const other = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: 'test-device-0002', name: 'Ana' });
  await request(app)
    .post('/api/progress/sync')
    .set('Authorization', `Bearer ${other.body.token}`)
    .send({
      xp: 1200,
      points: 60,
      streak: 4,
      bestStreak: 9,
      sessions: 20,
      xpDelta: 1200,
      pointsDelta: 60,
    });

  const res = await request(app)
    .get('/api/leaderboard?period=all')
    .set('Authorization', `Bearer ${token1}`);
  assert.equal(res.status, 200);
  const names = res.body.items.map((i) => i.displayName);
  assert.deepEqual(names, ['Ana', 'Romel']);
  assert.equal(res.body.items[0].rank, 1);
  assert.equal(res.body.items[1].rank, 2);
  assert.equal(res.body.me.displayName, 'Romel');
  assert.equal(res.body.me.position, 2);
  assert.ok(token2);
});

test('tu posición se calcula aunque quedes fuera del top N', async () => {
  const res = await request(app)
    .get('/api/leaderboard?period=all&limit=1')
    .set('Authorization', `Bearer ${token1}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].displayName, 'Ana');
  // Romel queda fuera del LIMIT pero su puesto real debe venir igual
  assert.ok(res.body.me, 'me debe venir aunque el jugador no este en items');
  assert.equal(res.body.me.displayName, 'Romel');
  assert.equal(res.body.me.rank, 2);
  assert.equal(res.body.me.position, 2);
  assert.ok(!res.body.items.some((i) => i.playerId === res.body.me.playerId));
});

test('ranking por ventana (week) usa session_events', async () => {
  const res = await request(app).get('/api/leaderboard?period=week');
  assert.equal(res.status, 200);
  assert.equal(res.body.period, 'week');
  assert.ok(res.body.items.length >= 2);
  assert.ok(res.body.items[0].score >= res.body.items[1].score);
});

test('periodo inválido da 400', async () => {
  const res = await request(app).get('/api/leaderboard?period=otra');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'periodo inválido');
});

test('rutas desconocidas dan 404', async () => {
  const res = await request(app).get('/api/noexiste');
  assert.equal(res.status, 404);
});
