'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError, composeRoles } = require('../server/game');

// Planificateur manuel : les minuteurs ne se déclenchent que si on le demande.
function fakeScheduler() {
  const timers = new Map();
  let next = 1;
  return {
    set(fn) {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    fire() {
      const [[id, fn]] = timers;
      timers.delete(id);
      fn();
    },
  };
}

// Crée une partie avec des rôles imposés (dans l'ordre des joueurs).
function setup(roles) {
  const scheduler = fakeScheduler();
  const game = new Game({ code: 'TEST', scheduler, rng: () => 0 });
  roles.forEach((_, i) => game.addPlayer(`player-${i}`, `P${i}`));
  game.start('player-0');
  roles.forEach((role, i) => (game.players.get(`player-${i}`).role = role));
  game.night.seerDone = !roles.includes('seer');
  const byRole = (role) => [...game.players.values()].filter((p) => p.role === role).map((p) => p.id);
  return { game, scheduler, byRole };
}

test('composition des rôles', () => {
  assert.deepEqual(composeRoles(4), ['werewolf', 'seer', 'villager', 'villager']);
  const eight = composeRoles(8);
  assert.equal(eight.length, 8);
  assert.equal(eight.filter((r) => r === 'werewolf').length, 2);
  assert.ok(eight.includes('witch') && eight.includes('hunter'));
});

test('lobby : pseudo unique, hôte, minimum de joueurs', () => {
  const game = new Game({ code: 'X', scheduler: fakeScheduler() });
  game.addPlayer('aaaaaaaa', 'Alice');
  assert.throws(() => game.addPlayer('bbbbbbbb', 'alice'), GameError);
  game.addPlayer('bbbbbbbb', 'Bob');
  assert.equal(game.hostId, 'aaaaaaaa');
  assert.throws(() => game.start('bbbbbbbb'), /hôte/);
  assert.throws(() => game.start('aaaaaaaa'), /au moins/);
  game.disconnect('aaaaaaaa');
  assert.equal(game.hostId, 'bbbbbbbb');
  assert.equal(game.players.size, 1);
});

test('nuit complète : loups, voyante, sorcière qui sauve', () => {
  const { game, byRole } = setup(['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager']);
  const [w1, w2] = byRole('werewolf');
  const [seer] = byRole('seer');
  const [villager] = byRole('villager');
  assert.equal(game.phase, 'night');

  assert.throws(() => game.act(w1, { type: 'wolfVote', target: w2 }), /loup/);
  game.act(w1, { type: 'wolfVote', target: villager });
  game.act(w2, { type: 'wolfVote', target: villager });
  assert.equal(game.phase, 'night', 'on attend la voyante');

  game.act(seer, { type: 'seerInspect', target: w1 });
  assert.equal(game.view(seer).players.find((p) => p.id === w1).role, 'werewolf');
  assert.equal(game.view(villager).players.find((p) => p.id === w1).role, null);

  assert.equal(game.phase, 'witch');
  const witchView = game.view(byRole('witch')[0]);
  assert.equal(witchView.actions.witch.victim, villager);
  game.act(byRole('witch')[0], { type: 'witch', heal: true });

  assert.equal(game.phase, 'day');
  assert.ok(game.players.get(villager).alive);
  assert.ok(game.witch.healUsed);
});

test('vote du village et victoire', () => {
  const { game, byRole } = setup(['werewolf', 'seer', 'villager', 'villager']);
  const [wolf] = byRole('werewolf');
  const [seer] = byRole('seer');
  game.act(seer, { type: 'seerInspect', target: wolf });
  game.act(wolf, { type: 'wolfVote', target: byRole('villager')[0] });
  assert.equal(game.phase, 'day');
  assert.equal(game.alive().length, 3);

  game.act('player-0', { type: 'skipDay' });
  assert.equal(game.phase, 'vote');
  for (const p of game.alive()) game.act(p.id, { type: 'vote', target: wolf });
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 'village');
});

test('égalité au vote : personne ne meurt', () => {
  const { game, byRole, scheduler } = setup(['werewolf', 'villager', 'villager', 'villager', 'villager']);
  game.act(byRole('werewolf')[0], { type: 'wolfVote', target: byRole('villager')[0] });
  scheduler.fire(); // fin du jour
  const alive = game.alive().map((p) => p.id);
  game.act(alive[0], { type: 'vote', target: alive[1] });
  game.act(alive[1], { type: 'vote', target: alive[0] });
  game.act(alive[2], { type: 'vote', target: null });
  game.act(alive[3], { type: 'vote', target: null });
  assert.equal(game.phase, 'night');
  assert.equal(game.alive().length, 4);
});

test('les loups gagnent à égalité numérique', () => {
  const { game, byRole } = setup(['werewolf', 'villager', 'villager', 'villager']);
  const [wolf] = byRole('werewolf');
  game.act(wolf, { type: 'wolfVote', target: byRole('villager')[0] });
  game.act('player-0', { type: 'skipDay' });
  const [, a, b] = game.alive().map((p) => p.id);
  for (const p of game.alive()) game.act(p.id, { type: 'vote', target: p.id === a ? b : a });
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 'wolves');
});

test('le chasseur tire en mourant', () => {
  const { game, byRole } = setup(['werewolf', 'werewolf', 'hunter', 'villager', 'villager', 'villager', 'villager']);
  const [w1, w2] = byRole('werewolf');
  const [hunter] = byRole('hunter');
  game.act(w1, { type: 'wolfVote', target: hunter });
  game.act(w2, { type: 'wolfVote', target: hunter });
  assert.equal(game.phase, 'hunter');
  assert.ok(game.view(hunter).actions.hunterShoot);
  // Le chasseur mort ne doit pas voir les rôles avant d'avoir tiré.
  assert.equal(game.view(hunter).players.find((p) => p.id === w1).role, null);
  game.act(hunter, { type: 'hunterShoot', target: w1 });
  assert.equal(game.phase, 'day');
  assert.equal(game.players.get(w1).alive, false);
});

test('règles de communication jour / nuit / morts', () => {
  const { game, byRole } = setup(['werewolf', 'werewolf', 'seer', 'villager', 'villager']);
  const [w1, w2] = byRole('werewolf');
  const [v1, v2] = byRole('villager');
  const P = (id) => game.players.get(id);

  // Nuit : seuls les loups s'entendent.
  assert.ok(game.canHear(P(w2), P(w1)));
  assert.ok(!game.canHear(P(v1), P(w1)));
  assert.ok(!game.canHear(P(w1), P(v1)));
  assert.deepEqual(game.view(v1).voice.talkTo, []);
  assert.throws(() => game.chat(v1, 'coucou'), GameError);
  // La nuit, un loup qui écrit parle à sa meute (canal secret).
  assert.equal(game.chat(w1, 'on mange qui ?'), null);
  assert.equal(game.wolfChat.at(-1).text, 'on mange qui ?');

  // Un mort parle aux morts uniquement, mais entend les vivants.
  P(v2).alive = false;
  assert.ok(game.canHear(P(v2), P(w1)));
  assert.ok(!game.canHear(P(w1), P(v2)));
  assert.equal(game.chat(v2, 'boo').message.channel, 'dead');

  // Jour : tous les vivants s'entendent.
  game.phase = 'day';
  assert.ok(game.canHear(P(v1), P(w1)));
  assert.ok(game.canHear(P(w1), P(v1)));
  assert.equal(game.chat(v1, 'salut').message.channel, 'village');
});

test('reconnexion pendant la partie', () => {
  const { game } = setup(['werewolf', 'seer', 'villager', 'villager']);
  game.disconnect('player-1');
  assert.equal(game.players.get('player-1').connected, false);
  assert.throws(() => game.addPlayer('nouveau-joueur', 'Zoe'), /commencé/);
  const p = game.addPlayer('player-1', 'P1');
  assert.ok(p.connected);
  assert.equal(p.epoch, 2);
});

test('chat secret de la meute', () => {
  const { game, byRole } = setup(['werewolf', 'werewolf', 'seer', 'villager', 'villager']);
  const [w1, w2] = byRole('werewolf');
  const [seer] = byRole('seer');
  const [v1] = byRole('villager');

  // Utilisable aussi en plein jour.
  game.phase = 'day';
  assert.equal(game.chat(w1, 'on accuse la voyante ?', 'wolves'), null);
  assert.deepEqual(game.view(w2).wolfChat.map((m) => m.text), ['on accuse la voyante ?']);
  // Les villageois ne voient ni ne peuvent écrire dans ce canal.
  assert.equal(game.view(v1).wolfChat, undefined);
  assert.equal(game.view(seer).wolfChat, undefined);
  assert.throws(() => game.chat(v1, 'je suis un loup', 'wolves'), /réservé/);
  // Le chat du village reste public le jour.
  assert.equal(game.chat(w1, 'bonjour').message.channel, 'village');
  // Les morts lisent la meute en spectateurs mais n'y écrivent pas.
  game.players.get(v1).alive = false;
  assert.equal(game.view(v1).wolfChat.length, 1);
  game.players.get(w2).alive = false;
  assert.throws(() => game.chat(w2, 'aouuu', 'wolves'), /morts/);
});
