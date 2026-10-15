const { WebSocketServer } = require('ws');
const { verifyToken } = require('../middleware/auth');
const { query } = require('../config/db');
const rooms = require('../services/duelRooms');

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastRoom(room) {
  const payload = { type: 'room', room: rooms.publicRoom(room) };
  for (const p of room.players) send(p.ws, payload);
}

function broadcastExcept(room, playerId, msg) {
  for (const p of room.players) {
    if (p.playerId !== playerId) send(p.ws, msg);
  }
}

async function finish(room) {
  const result = await rooms.persistResult(room);
  for (const p of room.players) send(p.ws, { type: 'result', result });
}

function dispatchStart(room, { included, excluded }) {
  const questions = rooms.publicQuestions(room);
  for (const p of included) send(p.ws, { type: 'start', questions });
  for (const p of excluded) {
    send(p.ws, { type: 'excluded', message: 'La partida empezó sin ti.' });
  }
  broadcastRoom(room);
}

function afterLeave(ws, res, { notify }) {
  if (res.finish && res.room) {
    finish(res.room).catch((err) => {
      send(ws, { type: 'error', message: err.message || 'No se pudo guardar el duelo' });
    });
    return res.room;
  }
  if (!res.room) return null;

  broadcastRoom(res.room);
  if (notify && res.removed) {
    broadcastExcept(res.room, res.removed.playerId, {
      type: 'playerLeft',
      playerId: res.removed.playerId,
      displayName: res.removed.displayName,
    });
  }
  return res.room;
}

function attachDuelServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Si al salir alguien quedaron todos los restantes listos, arranca solo.
  async function resumeStart(room, ws) {
    if (!room || room.status !== 'waiting') return;
    try {
      const started = await rooms.startIfReady(room);
      if (started) dispatchStart(room, started);
    } catch (err) {
      send(ws, { type: 'error', message: err.message || 'No se pudo iniciar' });
    }
  }

  wss.on('connection', (ws, req) => {
    let player = null;
    let room = null;
    let playerLoaded;

    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const decoded = verifyToken(token);
      player = { playerId: decoded.sub, name: decoded.device || 'jugador' };
    } catch {
      send(ws, { type: 'error', message: 'Token inválido' });
      ws.close(4001, 'unauthorized');
      return;
    }

    playerLoaded = query('SELECT id, display_name, avatar_seed FROM players WHERE id = $1', [
      player.playerId,
    ])
      .then(({ rows }) => {
        const row = rows[0];
        if (!row) {
          send(ws, { type: 'error', message: 'Jugador no encontrado' });
          ws.close(4004, 'unknown player');
          return;
        }
        player = {
          playerId: row.id,
          displayName: row.display_name,
          avatarSeed: row.avatar_seed,
          ws,
        };
        send(ws, {
          type: 'hello',
          player: { playerId: player.playerId, displayName: player.displayName },
        });
      })
      .catch(() => send(ws, { type: 'error', message: 'Error interno' }));

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: 'Mensaje inválido' });
        return;
      }

      try {
        // Los mensajes se procesan solo cuando el jugador ya tiene su ws
        // asignada; si no, los broadcasts saldrían hacia `undefined`.
        await playerLoaded;
        if (ws.readyState !== 1) return;

        const liveRoom = room && rooms.getRoom(room.code);

        switch (msg.type) {
          case 'create': {
            const prev = liveRoom;
            room = rooms.createRoom(player);
            if (prev && prev !== room) broadcastRoom(prev);
            send(ws, { type: 'created', code: room.code });
            broadcastRoom(room);
            break;
          }

          case 'join': {
            const code = String(msg.code || '').trim();
            const prev = liveRoom;
            const res = rooms.joinRoom(code, player);
            if (res.error) {
              send(ws, { type: 'error', message: res.error });
              break;
            }
            if (prev && prev !== res.room) broadcastRoom(prev);
            room = res.room;
            broadcastRoom(room);
            break;
          }

          case 'ready': {
            if (!liveRoom) break;
            if (!rooms.setReady(room, player.playerId)) break;
            broadcastRoom(room);

            const started = await rooms.startIfReady(room);
            if (started) dispatchStart(room, started);
            break;
          }

          case 'startNow': {
            if (!liveRoom) break;
            if (!rooms.isHost(room, player.playerId)) {
              send(ws, { type: 'error', message: 'Solo el anfitrión puede empezar' });
              break;
            }
            rooms.setReady(room, player.playerId);
            broadcastRoom(room);

            const started = await rooms.startIfReady(room, { force: true });
            if (started) dispatchStart(room, started);
            else send(ws, { type: 'error', message: 'Se necesitan al menos 2 jugadores listos' });
            break;
          }

          case 'answer': {
            if (!room || room.status !== 'playing') break;
            const res = rooms.recordAnswer(
              room,
              player.playerId,
              Number(msg.index),
              Number(msg.option),
              Number(msg.elapsedMs) || 0
            );
            if (res.error) {
              send(ws, { type: 'error', message: res.error });
              break;
            }

            send(ws, {
              type: 'answerAck',
              index: msg.index,
              correct: res.isCorrect,
              answered: res.answered,
            });
            broadcastExcept(room, player.playerId, {
              type: 'peerProgress',
              playerId: player.playerId,
              answered: res.answered,
              correct: res.correct,
            });

            if (rooms.allDone(room)) await finish(room);
            break;
          }

          case 'leave': {
            if (!room) break;
            const res = rooms.removeFromRoom(room, player.playerId);
            room = afterLeave(ws, res, { notify: true });
            await resumeStart(room, ws);
            break;
          }

          default:
            send(ws, { type: 'error', message: `Tipo desconocido: ${msg.type}` });
        }
      } catch (err) {
        send(ws, { type: 'error', message: err.message || 'Error interno' });
      }
    });

    ws.on('close', () => {
      if (!room) return;
      try {
        const res = rooms.removeFromRoom(room, player.playerId);
        room = null;
        if (res.room) {
          afterLeave(ws, res, { notify: true });
          resumeStart(res.room, ws);
        }
      } catch {
        // sin sesión que avisar: la sala ya quedó limpia
      }
    });
  });

  return wss;
}

module.exports = { attachDuelServer };
