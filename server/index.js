'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 10 * 60 * 1000; // une salle vide est supprimée après 10 min

function iceServers() {
  const servers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
  if (process.env.TURN_URLS) {
    servers.push({
      urls: process.env.TURN_URLS.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

function createServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  app.get('/config', (_req, res) => res.json({ iceServers: iceServers() }));
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const rooms = new Map(); // code -> { game, sockets: Map<playerId, socket>, emptySince }

  function newCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  function broadcast(room) {
    for (const [playerId, socket] of room.sockets) socket.emit('state', room.game.view(playerId));
  }

  function createRoom() {
    const code = newCode();
    const room = { sockets: new Map(), emptySince: null };
    room.game = new Game({ code, onChange: () => scheduleBroadcast(room) });
    rooms.set(code, room);
    return room;
  }

  // Regroupe les changements d'état d'un même tick en un seul envoi.
  function scheduleBroadcast(room) {
    if (room.pending) return;
    room.pending = true;
    process.nextTick(() => {
      room.pending = false;
      broadcast(room);
    });
  }

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.sockets.size === 0 && room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
        room.game.destroy();
        rooms.delete(code);
      }
    }
  }, 60 * 1000).unref();

  io.on('connection', (socket) => {
    let room = null;
    let playerId = null;

    const guard = (fn) => (payload = {}, ack = () => {}) => {
      try {
        const result = fn(payload);
        ack({ ok: true, ...result });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(err);
        ack({ ok: false, error: err instanceof GameError ? err.message : 'Erreur serveur.' });
      }
    };

    function join(target, id, name) {
      if (typeof id !== 'string' || id.length < 8 || id.length > 64) throw new GameError('Identifiant invalide.');
      if (room) leave();
      target.game.addPlayer(id, name);
      const previous = target.sockets.get(id);
      room = target;
      playerId = id;
      room.sockets.set(id, socket);
      room.emptySince = null;
      // Ancien onglet du même joueur : on le coupe (son `leave` verra qu'il n'est plus le socket actif).
      if (previous && previous !== socket) {
        previous.emit('replaced');
        previous.disconnect(true);
      }
      return { code: room.game.code };
    }

    function leave() {
      if (!room) return;
      if (room.sockets.get(playerId) === socket) {
        room.sockets.delete(playerId);
        room.game.disconnect(playerId);
        if (room.sockets.size === 0) room.emptySince = Date.now();
      }
      room = null;
      playerId = null;
    }

    socket.on('create', guard(({ playerId: id, name }) => join(createRoom(), id, name)));

    socket.on('join', guard(({ playerId: id, name, code }) => {
      const target = rooms.get(String(code || '').toUpperCase().trim());
      if (!target) throw new GameError('Partie introuvable.');
      return join(target, id, name);
    }));

    socket.on('leave', guard(() => leave()));

    socket.on('start', guard(() => {
      if (!room) throw new GameError('Pas de partie.');
      room.game.start(playerId);
    }));

    socket.on('action', guard((action) => {
      if (!room) throw new GameError('Pas de partie.');
      room.game.act(playerId, action);
    }));

    socket.on('chat', guard(({ text, channel }) => {
      if (!room) throw new GameError('Pas de partie.');
      const out = room.game.chat(playerId, text, channel);
      if (!out) return;
      for (const id of out.recipients) room.sockets.get(id)?.emit('chat', out.message);
    }));

    // Signalisation WebRTC : relayée uniquement entre joueurs d'une même salle.
    socket.on('signal', ({ to, data } = {}) => {
      if (!room || typeof to !== 'string') return;
      room.sockets.get(to)?.emit('signal', { from: playerId, data });
    });

    socket.on('disconnect', () => leave());
  });

  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createServer();
  server.listen(PORT, () => console.log(`🐺 Loup-Garou en ligne sur http://localhost:${PORT}`));
}

module.exports = { createServer };
