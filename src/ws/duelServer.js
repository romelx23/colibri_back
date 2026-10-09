const { WebSocketServer } = require('ws');
const { verifyToken } = require('../middleware/auth');
const { query } = require('../config/db');
const rooms = require('../services/duelRooms');

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function otherOf(room, playerId) {
  if (room.host && room.host.playerId === playerId) return room.guest;
  return room.host;
}

function broadcastRoom(room) {
  const payload = { type: 'room', room: rooms.publicRoom(room) };
  for (const p of [room.host, room.guest]) {
    if (p) send(p.ws, payload);
  }
}

function attachDuelServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let player = null;
    let room = null;

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

    query('SELECT id, display_name, avatar_seed FROM players WHERE id = $1', [player.playerId])
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
        send(ws, { type: 'hello', player: { playerId: player.playerId, displayName: player.displayName } });
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
        switch (msg.type) {
          case 'create': {
            if (room) rooms.leaveRoom(player.playerId);
            room = rooms.createRoom(player);
            send(ws, { type: 'created', code: room.code });
            broadcastRoom(room);
            break;
          }

          case 'join': {
            const code = String(msg.code || '').trim();
            const res = rooms.joinRoom(code, player);
            if (res.error) {
              send(ws, { type: 'error', message: res.error });
              break;
            }
            room = res.room;
            broadcastRoom(room);
            break;
          }

          case 'ready': {
            if (!room) break;
            const me = room.host.playerId === player.playerId ? room.host : room.guest;
            if (!me) break;
            me.ready = true;
            broadcastRoom(room);

            const started = await rooms.startIfReady(room);
            if (started) {
              for (const p of [room.host, room.guest]) {
                send(p.ws, { type: 'start', questions: rooms.publicQuestions(room) });
              }
            }
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

            const rival = otherOf(room, player.playerId);
            send(ws, { type: 'answerAck', index: msg.index, correct: res.isCorrect });
            send(rival && rival.ws, { type: 'opponentAnswer', index: msg.index });

            if (rooms.bothDone(room)) {
              const result = await rooms.persistResult(room);
              for (const p of [room.host, room.guest]) {
                send(p.ws, { type: 'result', result });
              }
            }
            break;
          }

          case 'leave': {
            if (room) {
              const rival = otherOf(room, player.playerId);
              send(rival && rival.ws, { type: 'opponentLeft' });
              rooms.leaveRoom(player.playerId);
              room = null;
            }
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
      if (room) {
        const rival = otherOf(room, player.playerId);
        send(rival && rival.ws, { type: 'opponentLeft' });
        rooms.leaveRoom(player.playerId);
      }
    });
  });

  return wss;
}

module.exports = { attachDuelServer };
