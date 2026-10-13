'use strict';

// Moteur de jeu Loup-Garou : logique pure, sans réseau.
// Le serveur appelle les méthodes publiques et diffuse `view(playerId)` après chaque `onChange`.

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 18;

const DEFAULT_TIMERS = { night: 75, witch: 30, day: 150, vote: 60, hunter: 30 }; // secondes

const NIGHT_PHASES = new Set(['night', 'witch']);

function composeRoles(n) {
  const wolves = n <= 5 ? 1 : n <= 8 ? 2 : n <= 12 ? 3 : 4;
  const roles = Array(wolves).fill('werewolf');
  roles.push('seer');
  if (n >= 6) roles.push('witch');
  if (n >= 7) roles.push('hunter');
  while (roles.length < n) roles.push('villager');
  return roles;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class GameError extends Error {}

class Game {
  constructor({ code, rng = Math.random, timers = DEFAULT_TIMERS, scheduler, onChange } = {}) {
    this.code = code;
    this.rng = rng;
    this.timers = { ...DEFAULT_TIMERS, ...timers };
    this.scheduler = scheduler || { set: setTimeout, clear: clearTimeout };
    this.onChange = onChange || (() => {});
    this.players = new Map(); // id -> { id, name, role, alive, connected, epoch }
    this.order = []; // ordre d'arrivée
    this.hostId = null;
    this.phase = 'lobby';
    this.round = 0;
    this.deadline = null;
    this.timer = null;
    this.winner = null;
    this.log = []; // événements publics
    this.privateLog = new Map(); // id -> [messages]
    this.resetNight();
    this.witch = { healUsed: false, poisonUsed: false };
    this.votes = new Map();
    this.hunter = null; // { id, then }
  }

  // ---------- Joueurs ----------

  addPlayer(id, name) {
    name = String(name || '').trim().slice(0, 20);
    if (!name) throw new GameError('Choisis un pseudo.');
    const existing = this.players.get(id);
    if (existing) {
      existing.connected = true;
      existing.epoch++;
      if (this.phase === 'lobby') existing.name = name;
      this.changed();
      return existing;
    }
    if (this.phase !== 'lobby') throw new GameError('La partie a déjà commencé.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('La partie est complète.');
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new GameError('Ce pseudo est déjà pris.');
    const player = { id, name, role: null, alive: true, connected: true, epoch: 1 };
    this.players.set(id, player);
    this.order.push(id);
    if (!this.hostId) this.hostId = id;
    this.changed();
    return player;
  }

  disconnect(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(id);
      this.order = this.order.filter((x) => x !== id);
    } else {
      p.connected = false;
    }
    if (this.hostId === id) {
      const next = this.order.find((x) => x !== id && this.players.get(x)?.connected);
      this.hostId = next || this.order.find((x) => x !== id) || null;
    }
    this.changed();
  }

  get connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  alive() {
    return this.order.map((id) => this.players.get(id)).filter((p) => p && p.alive);
  }

  aliveWith(role) {
    return this.alive().filter((p) => p.role === role);
  }

  // ---------- Déroulement ----------

  start(byId) {
    if (byId !== this.hostId) throw new GameError("Seul l'hôte peut lancer la partie.");
    if (this.phase !== 'lobby' && this.phase !== 'ended') throw new GameError('Partie déjà en cours.');
    if (this.phase === 'ended') {
      // Les joueurs déconnectés pendant la partie précédente sont retirés.
      for (const id of [...this.order]) if (!this.players.get(id).connected) this.players.delete(id);
      this.order = this.order.filter((id) => this.players.has(id));
    }
    if (this.players.size < MIN_PLAYERS) throw new GameError(`Il faut au moins ${MIN_PLAYERS} joueurs.`);
    const roles = shuffle(composeRoles(this.players.size), this.rng);
    this.order.forEach((id, i) => {
      const p = this.players.get(id);
      p.role = roles[i];
      p.alive = true;
    });
    this.gameId = Date.now().toString(36);
    this.round = 0;
    this.winner = null;
    this.log = [];
    this.privateLog = new Map();
    this.witch = { healUsed: false, poisonUsed: false };
    this.addLog('start', 'La partie commence. Chacun découvre son rôle...');
    this.startNight();
  }

  resetNight() {
    this.night = { wolfVotes: new Map(), victim: null, seerDone: false, witchDone: false, heal: false, poison: null };
  }

  setPhase(phase, seconds) {
    this.clearTimer();
    this.phase = phase;
    this.duration = seconds || null;
    if (seconds) {
      this.deadline = Date.now() + seconds * 1000;
      this.timer = this.scheduler.set(() => {
        this.timer = null;
        this.onTimeout();
      }, seconds * 1000);
    } else {
      this.deadline = null;
    }
  }

  clearTimer() {
    if (this.timer) this.scheduler.clear(this.timer);
    this.timer = null;
  }

  onTimeout() {
    switch (this.phase) {
      case 'night':
        return this.endWolves();
      case 'witch':
        return this.resolveNight();
      case 'day':
        return this.startVote();
      case 'vote':
        return this.resolveVote();
      case 'hunter':
        return this.finishHunter(null);
    }
  }

  startNight() {
    this.round++;
    this.resetNight();
    this.night.seerDone = this.aliveWith('seer').length === 0;
    this.addLog('night', `Nuit ${this.round} : le village s'endort.`);
    this.setPhase('night', this.timers.night);
    this.changed();
  }

  endWolves() {
    const target = this.pickFromVotes(this.night.wolfVotes, true);
    this.night.victim = target;
    const witch = this.aliveWith('witch')[0];
    const canAct = witch && (!this.witch.healUsed || !this.witch.poisonUsed);
    if (canAct) {
      this.setPhase('witch', this.timers.witch);
      this.changed();
    } else {
      this.resolveNight();
    }
  }

  resolveNight() {
    const deaths = [];
    if (this.night.victim && !this.night.heal) deaths.push(this.night.victim);
    if (this.night.poison && !deaths.includes(this.night.poison)) deaths.push(this.night.poison);
    this.clearTimer();
    if (deaths.length === 0) this.addLog('dawn', 'Le jour se lève : personne n\'est mort cette nuit.', { count: 0 });
    else this.addLog('dawn', 'Le jour se lève.', { count: deaths.length });
    this.kill(deaths, 'night', () => this.startDay());
  }

  startDay() {
    this.addLog('day', 'Le village se réveille et débat.');
    this.setPhase('day', this.timers.day);
    this.changed();
  }

  startVote() {
    this.votes = new Map();
    this.addLog('vote', 'Place au vote ! Qui sera éliminé ?');
    this.setPhase('vote', this.timers.vote);
    this.changed();
  }

  resolveVote() {
    const target = this.pickFromVotes(this.votes, false);
    this.clearTimer();
    if (!target) {
      this.addLog('vote-result', 'Égalité ou abstention : personne n\'est éliminé.');
      this.startNight();
      return;
    }
    this.kill([target], 'vote', () => this.startNight());
  }

  // Majorité relative. Pour les loups, une égalité est tranchée au hasard ; pour le village, personne ne meurt.
  pickFromVotes(votes, breakTies) {
    const counts = new Map();
    for (const t of votes.values()) {
      if (!t) continue; // abstention
      if (!this.players.get(t)?.alive) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    let max = 0;
    let best = [];
    for (const [t, c] of counts) {
      if (c > max) {
        max = c;
        best = [t];
      } else if (c === max) best.push(t);
    }
    const abstentions = [...votes.values()].filter((t) => !t).length;
    if (best.length === 0) return null;
    if (!breakTies && abstentions > max) return null;
    if (best.length === 1) return best[0];
    return breakTies ? best[Math.floor(this.rng() * best.length)] : null;
  }

  kill(ids, cause, then) {
    let hunterDied = null;
    for (const id of ids) {
      const p = this.players.get(id);
      if (!p || !p.alive) continue;
      p.alive = false;
      const how = cause === 'night' ? 'a été retrouvé(e) mort(e)' : cause === 'vote' ? 'a été éliminé(e) par le village' : 'a été abattu(e) par le chasseur';
      this.addLog('death', `${p.name} ${how}. C'était ${roleLabel(p.role)}.`, { playerId: id, role: p.role, name: p.name, cause });
      if (p.role === 'hunter') hunterDied = id;
    }
    if (hunterDied && this.alive().length > 0) {
      this.hunter = { id: hunterDied, then };
      this.addLog('hunter', 'Le chasseur, dans un dernier souffle, choisit sa cible...');
      this.setPhase('hunter', this.timers.hunter);
      this.changed();
      return;
    }
    if (this.checkWin()) return;
    then();
  }

  finishHunter(target) {
    const { then } = this.hunter;
    this.hunter = null;
    this.clearTimer();
    if (target) this.kill([target], 'hunter', then);
    else {
      this.addLog('hunter', 'Le chasseur meurt sans tirer.', { missed: true });
      if (!this.checkWin()) then();
    }
  }

  checkWin() {
    const alive = this.alive();
    const wolves = alive.filter((p) => p.role === 'werewolf').length;
    const others = alive.length - wolves;
    let winner = null;
    if (wolves === 0) winner = 'village';
    else if (wolves >= others) winner = 'wolves';
    if (!winner) return false;
    this.winner = winner;
    this.addLog('end', winner === 'village' ? 'Les villageois ont éliminé tous les loups. Victoire du village !' : 'Les loups-garous ont dévoré le village. Victoire des loups !', { winner });
    this.setPhase('ended');
    this.changed();
    return true;
  }

  // ---------- Actions des joueurs ----------

  act(playerId, action = {}) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('Joueur inconnu.');
    const { type } = action;

    if (type === 'skipDay') {
      if (playerId !== this.hostId) throw new GameError("Seul l'hôte peut passer au vote.");
      if (this.phase !== 'day') throw new GameError('Pas maintenant.');
      return this.startVote();
    }

    if (!p.alive && type !== 'hunterShoot') throw new GameError('Les morts ne peuvent plus agir.');

    switch (type) {
      case 'wolfVote': {
        this.expect(p, 'night', 'werewolf');
        const target = this.aliveTarget(action.target);
        if (target.role === 'werewolf') throw new GameError('Un loup ne dévore pas un loup.');
        this.night.wolfVotes.set(p.id, target.id);
        this.changed();
        return this.checkNightProgress();
      }
      case 'seerInspect': {
        this.expect(p, 'night', 'seer');
        if (this.night.seerDone) throw new GameError('Tu as déjà sondé quelqu\'un cette nuit.');
        const target = this.aliveTarget(action.target);
        if (target.id === p.id) throw new GameError('Choisis un autre joueur.');
        this.night.seerDone = true;
        this.privateMessage(p.id, `🔮 Nuit ${this.round} : ${target.name} est ${roleLabel(target.role)}.`, { playerId: target.id, role: target.role });
        this.changed();
        return this.checkNightProgress();
      }
      case 'witch': {
        this.expect(p, 'witch', 'witch');
        if (action.heal) {
          if (this.witch.healUsed) throw new GameError('Potion de vie déjà utilisée.');
          if (!this.night.victim) throw new GameError('Personne à sauver.');
          this.witch.healUsed = true;
          this.night.heal = true;
        }
        if (action.poison) {
          if (this.witch.poisonUsed) throw new GameError('Potion de mort déjà utilisée.');
          const target = this.aliveTarget(action.poison);
          if (target.id === p.id) throw new GameError('Choisis un autre joueur.');
          this.witch.poisonUsed = true;
          this.night.poison = target.id;
        }
        return this.resolveNight();
      }
      case 'vote': {
        if (this.phase !== 'vote') throw new GameError('Ce n\'est pas l\'heure du vote.');
        const target = action.target ? this.aliveTarget(action.target).id : null;
        this.votes.set(p.id, target);
        this.changed();
        if (this.alive().every((x) => this.votes.has(x.id))) this.resolveVote();
        return;
      }
      case 'hunterShoot': {
        if (this.phase !== 'hunter' || this.hunter?.id !== p.id) throw new GameError('Pas maintenant.');
        const target = this.aliveTarget(action.target);
        return this.finishHunter(target.id);
      }
      default:
        throw new GameError('Action inconnue.');
    }
  }

  expect(p, phase, role) {
    if (this.phase !== phase || p.role !== role) throw new GameError('Pas maintenant.');
  }

  aliveTarget(id) {
    const t = this.players.get(id);
    if (!t || !t.alive) throw new GameError('Cible invalide.');
    return t;
  }

  checkNightProgress() {
    if (this.phase !== 'night') return;
    const wolves = this.aliveWith('werewolf');
    const votes = wolves.map((w) => this.night.wolfVotes.get(w.id));
    const unanimous = votes.every((v) => v && v === votes[0]);
    if (unanimous && this.night.seerDone) this.endWolves();
  }

  // ---------- Communication ----------

  // L'auditeur `l` peut-il entendre/lire le joueur `s` ? Règle unique pour le vocal et le chat.
  canHear(l, s) {
    if (l.id === s.id) return false;
    if (this.phase === 'lobby' || this.phase === 'ended') return true;
    if (!s.alive) return !l.alive; // les morts ne parlent qu'entre eux
    if (!l.alive) return true; // les morts écoutent tout
    if (NIGHT_PHASES.has(this.phase)) return s.role === 'werewolf' && l.role === 'werewolf';
    return true;
  }

  chat(playerId, text) {
    const s = this.players.get(playerId);
    text = String(text || '').trim().slice(0, 300);
    if (!s || !text) return null;
    const recipients = [...this.players.values()].filter((l) => this.canHear(l, s)).map((l) => l.id);
    let channel = 'village';
    if (this.phase !== 'lobby' && this.phase !== 'ended') {
      if (!s.alive) channel = 'dead';
      else if (NIGHT_PHASES.has(this.phase)) channel = 'wolves';
    }
    if (recipients.length === 0 && channel !== 'dead') throw new GameError('Personne ne peut t\'entendre maintenant.');
    return { recipients: [...recipients, s.id], message: { from: s.id, name: s.name, text, channel, at: Date.now() } };
  }

  // ---------- Vues ----------

  addLog(type, text, extra = {}) {
    this.log.push({ type, text, at: Date.now(), ...extra });
    if (this.log.length > 200) this.log.shift();
  }

  privateMessage(id, text, extra = {}) {
    if (!this.privateLog.has(id)) this.privateLog.set(id, []);
    this.privateLog.get(id).push({ type: 'private', text, at: Date.now(), ...extra });
  }

  changed() {
    this.onChange(this);
  }

  view(playerId) {
    const me = this.players.get(playerId);
    const inGame = this.phase !== 'lobby';
    const ended = this.phase === 'ended';
    const known = new Map(); // id -> rôle révélé à ce joueur
    if (me && inGame) {
      if (me.role) known.set(me.id, me.role);
      if (me.role === 'werewolf') for (const p of this.players.values()) if (p.role === 'werewolf') known.set(p.id, p.role);
      for (const m of this.privateLog.get(me.id) || []) if (m.playerId) known.set(m.playerId, m.role);
    }
    const players = this.order.map((id) => {
      const p = this.players.get(id);
      // Les morts voient tous les rôles, sauf le chasseur tant qu'il n'a pas tiré.
      const spectator = me && !me.alive && inGame && this.hunter?.id !== me.id;
      const revealed = ended || (inGame && !p.alive) || known.has(id) || spectator;
      return {
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        epoch: p.epoch,
        role: revealed ? p.role : null,
        isHost: p.id === this.hostId,
      };
    });

    const view = {
      code: this.code,
      gameId: this.gameId || null,
      phase: this.phase,
      round: this.round,
      deadline: this.deadline,
      duration: this.duration || null,
      serverNow: Date.now(),
      hostId: this.hostId,
      winner: this.winner,
      players,
      log: [...this.log, ...(this.privateLog.get(playerId) || [])].sort((a, b) => a.at - b.at),
      me: me ? { id: me.id, role: inGame ? me.role : null, alive: me.alive } : null,
      minPlayers: MIN_PLAYERS,
      composition: this.players.size >= MIN_PLAYERS ? composeRoles(this.players.size) : null,
      voice: { talkTo: [], hearFrom: [] },
      actions: {},
    };

    if (me) {
      for (const o of this.players.values()) {
        if (o.id === me.id || !o.connected) continue;
        if (this.canHear(o, me)) view.voice.talkTo.push(o.id);
        if (this.canHear(me, o)) view.voice.hearFrom.push(o.id);
      }
      this.fillActions(view, me);
    }
    return view;
  }

  fillActions(view, me) {
    const a = view.actions;
    if (this.phase === 'vote') {
      a.votes = Object.fromEntries(this.votes);
      if (me.alive) a.vote = { current: this.votes.has(me.id) ? this.votes.get(me.id) : undefined };
    }
    if (!me.alive && this.phase !== 'hunter') return;
    if (this.phase === 'night' && me.role === 'werewolf') {
      a.wolfVote = { votes: Object.fromEntries(this.night.wolfVotes) };
    }
    if (this.phase === 'night' && me.role === 'seer' && !this.night.seerDone) a.seerInspect = true;
    if (this.phase === 'witch' && me.role === 'witch') {
      a.witch = {
        victim: this.night.victim,
        canHeal: !this.witch.healUsed && !!this.night.victim,
        canPoison: !this.witch.poisonUsed,
      };
    }
    if (this.phase === 'hunter' && this.hunter?.id === me.id) a.hunterShoot = true;
    if (this.phase === 'day' && me.id === this.hostId) a.skipDay = true;
  }

  destroy() {
    this.clearTimer();
  }
}

const ROLE_LABELS = {
  werewolf: 'un Loup-Garou',
  villager: 'un Simple Villageois',
  seer: 'la Voyante',
  witch: 'la Sorcière',
  hunter: 'le Chasseur',
};

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

module.exports = { Game, GameError, composeRoles, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_TIMERS };
