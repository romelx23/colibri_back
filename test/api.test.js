const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { prepare } = require('./helpers/bootstrap');
const { pointsFor } = require('../src/services/examScoring');

let app;
let closePool;

// Preguntas reales del seed, con su respuesta correcta (el servidor es quien
// conoce `correcta`; el cliente solo manda sus índices elegidos).
async function takeQuestions(n) {
  const { query } = require('../src/config/db');
  const { rows } = await query(
    'SELECT id, correcta, dificultad, fuente FROM questions ORDER BY id LIMIT $1',
    [n]
  );
  assert.ok(rows.length === n, `se esperaban ${n} preguntas del seed`);
  return rows;
}

function wrongIndex(q) {
  return q.correcta === 0 ? 1 : q.correcta - 1;
}

async function submitExam(token, answers, extra = {}) {
  return request(app)
    .post('/api/exams/submit')
    .set('Authorization', `Bearer ${token}`)
    .send({ answers, ...extra });
}

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
let betoToken;
let examBestRomel;

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

test('examen: el servidor calcula el puntaje ponderado y aprueba con corte', async () => {
  const qs = await takeQuestions(5);
  const expected = qs.reduce((sum, q) => sum + pointsFor(q), 0);
  const res = await submitExam(
    token1,
    qs.map((q) => ({ questionId: q.id, answerIndex: q.correcta, elapsedMs: 4000 }))
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.correct, 5);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.percent, 100);
  assert.equal(res.body.passed, true);
  assert.equal(res.body.score, expected);
  assert.equal(res.body.examBest, expected);
  examBestRomel = expected;
});

test('examen: incorrectas y en blanco suman 0 y exam_best no baja', async () => {
  const qs = await takeQuestions(4);
  const res = await submitExam(token1, [
    { questionId: qs[0].id, answerIndex: qs[0].correcta },
    { questionId: qs[1].id, answerIndex: wrongIndex(qs[1]) },
    { questionId: qs[2].id, answerIndex: -1 },
    { questionId: qs[3].id, answerIndex: wrongIndex(qs[3]) },
  ]);
  assert.equal(res.status, 201);
  assert.equal(res.body.correct, 1);
  assert.equal(res.body.unanswered, 1);
  assert.equal(res.body.percent, 25);
  assert.equal(res.body.passed, false);
  assert.equal(res.body.score, pointsFor(qs[0]));
  assert.equal(res.body.examBest, examBestRomel, 'un examen malo no debe bajar el mejor puntaje');
});

test('examen: rechaza preguntas que no existen', async () => {
  const res = await submitExam(token1, [{ questionId: 'no-existe', answerIndex: 0 }]);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'Algunas preguntas no existen');
});

test('examen: requiere token', async () => {
  const res = await request(app)
    .post('/api/exams/submit')
    .send({ answers: [{ questionId: 'x', answerIndex: 0 }] });
  assert.equal(res.status, 401);
});

test('ranking global: ordena por mejor puntaje de examen e incluye tu fila', async () => {
  const other = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: 'test-device-0002', name: 'Ana' });
  // Ana hace un examen de 8 preguntas perfecto: supera a Romel (mejor = 5 perfectas)
  const qs = await takeQuestions(8);
  const anaExam = await submitExam(
    other.body.token,
    qs.map((q) => ({ questionId: q.id, answerIndex: q.correcta }))
  );
  assert.equal(anaExam.status, 201);
  assert.ok(anaExam.body.score > examBestRomel);

  const res = await request(app)
    .get('/api/leaderboard?period=all')
    .set('Authorization', `Bearer ${token1}`);
  assert.equal(res.status, 200);
  const names = res.body.items.map((i) => i.displayName);
  assert.deepEqual(names, ['Ana', 'Romel']);
  assert.equal(res.body.items[0].rank, 1);
  assert.equal(res.body.items[0].score, anaExam.body.examBest);
  assert.equal(res.body.items[1].rank, 2);
  assert.equal(res.body.me.displayName, 'Romel');
  assert.equal(res.body.me.position, 2);
  assert.ok(token2);
  anaToken = other.body.token;
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

test('ranking por ventana (week) refleja el examen del período', async () => {
  const res = await request(app).get('/api/leaderboard?period=week');
  assert.equal(res.status, 200);
  assert.equal(res.body.period, 'week');
  assert.ok(res.body.items.length >= 2);
  assert.ok(res.body.items[0].score >= res.body.items[1].score);
  assert.ok(
    res.body.items.every((i) => i.score > 0),
    'todos los activos esta semana rinden con examenes, no con XP crudo'
  );
});

test('identidad: el icono legendario exige el rango de XP', async () => {
  const beto = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: 'test-device-0003', name: 'Beto' });
  betoToken = beto.body.token;

  const res = await request(app)
    .put('/api/players/me')
    .set('Authorization', `Bearer ${betoToken}`)
    .send({ displayName: 'Beto', avatarId: 'crown' }); // legendario: 2000 XP
  assert.equal(res.status, 403);
  assert.match(res.body.error, /se desbloquea/);

  const invalid = await request(app)
    .put('/api/players/me')
    .set('Authorization', `Bearer ${betoToken}`)
    .send({ displayName: 'Beto', avatarId: 'no-existe' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error, 'Icono de perfil no válido');
});

test('identidad: el nickname ofensivo se rechaza', async () => {
  const res = await request(app)
    .put('/api/players/me')
    .set('Authorization', `Bearer ${betoToken}`)
    .send({ displayName: 'pendejo123', avatarId: 'chick' });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /no permitidos/);
});

test('identidad: el nickname tomado responde 409 con sugerencia', async () => {
  const res = await request(app)
    .put('/api/players/me')
    .set('Authorization', `Bearer ${betoToken}`)
    .send({ displayName: 'Romel', avatarId: 'chick' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Ese nombre ya está en uso');
  assert.match(res.body.suggestion, /^Romel\d+$/);
});

test('identidad: con XP suficiente elige icono épico y renombra', async () => {
  await request(app)
    .post('/api/progress/sync')
    .set('Authorization', `Bearer ${betoToken}`)
    .send({ xp: 300, points: 0, streak: 1, bestStreak: 1, sessions: 1, xpDelta: 300, pointsDelta: 0 });

  const res = await request(app)
    .put('/api/players/me')
    .set('Authorization', `Bearer ${betoToken}`)
    .send({ displayName: 'Beto2026', avatarId: 'fox' }); // épico: 300 XP
  assert.equal(res.status, 200);
  assert.equal(res.body.player.displayName, 'Beto2026');
  assert.equal(res.body.player.avatarId, 'fox');

  const me = await request(app)
    .get('/api/players/me')
    .set('Authorization', `Bearer ${betoToken}`);
  assert.equal(me.body.player.avatarId, 'fox');
  assert.equal(me.body.player.displayName, 'Beto2026');
});

test('guest: un nombre ofensivo degrada a Jugador en lugar de guardarlo', async () => {
  const res = await request(app)
    .post('/api/players/guest')
    .send({ deviceId: 'test-device-0004', name: 'puto feo' });
  assert.equal(res.status, 201);
  assert.equal(res.body.player.displayName, 'Jugador');
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
