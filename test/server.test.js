'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createServer } = require('../server');

test('création, connexion et lancement via Socket.IO', async (t) => {
  const { server, io: ioServer, rooms } = createServer();
  await new Promise((r) => server.listen(0, r));
  t.after(() => {
    for (const room of rooms.values()) room.game.destroy();
    ioServer.close();
    server.close();
  });
  const url = `http://localhost:${server.address().port}`;
  const clients = Array.from({ length: 4 }, () => io(url, { transports: ['websocket'], forceNew: true }));
  t.after(() => clients.forEach((c) => c.close()));
  const call = (c, ev, payload) => new Promise((r) => c.emit(ev, payload, r));
  const lastState = clients.map(() => null);
  clients.forEach((c, i) => c.on('state', (s) => (lastState[i] = s)));

  const created = await call(clients[0], 'create', { playerId: 'player-aaaa-0', name: 'Alice' });
  assert.ok(created.ok);
  for (let i = 1; i < 4; i++) {
    const res = await call(clients[i], 'join', { playerId: `player-aaaa-${i}`, name: `J${i}`, code: created.code.toLowerCase() });
    assert.ok(res.ok, res.error);
  }
  assert.equal((await call(clients[1], 'start')).ok, false, "seul l'hôte lance");
  assert.ok((await call(clients[0], 'start')).ok);
  await new Promise((r) => setTimeout(r, 50));

  for (const s of lastState) {
    assert.equal(s.phase, 'night');
    assert.ok(s.me.role);
    // Aucun joueur ne voit le rôle d'un autre, sauf un loup qui voit les loups.
    const others = s.players.filter((p) => p.id !== s.me.id && p.role);
    assert.ok(others.every((p) => p.role === 'werewolf' && s.me.role === 'werewolf'));
  }
  assert.equal((await call(clients[0], 'join', { playerId: 'x'.repeat(10), name: 'Z', code: 'NOPE1' })).error, 'Partie introuvable.');
});
