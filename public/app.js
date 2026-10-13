import { Voice } from './voice.js';

const ROLES = {
  werewolf: { name: 'Loup-Garou', icon: '🐺', team: 'wolves', desc: 'Chaque nuit, mets-toi d\'accord avec les autres loups pour dévorer un villageois. Le jour, fais-toi passer pour un innocent.' },
  villager: { name: 'Villageois', icon: '🧑‍🌾', team: 'village', desc: 'Tu n\'as pas de pouvoir, mais ta voix compte : démasque les loups et vote contre eux.' },
  seer: { name: 'Voyante', icon: '🔮', team: 'village', desc: 'Chaque nuit, découvre le vrai rôle d\'un joueur. Aide le village sans te faire repérer.' },
  witch: { name: 'Sorcière', icon: '🧪', team: 'village', desc: 'Tu possèdes une potion de vie (sauver la victime des loups) et une potion de mort. Une seule utilisation chacune.' },
  hunter: { name: 'Chasseur', icon: '🏹', team: 'village', desc: 'Si tu meurs, tu emportes immédiatement un joueur de ton choix avec toi.' },
};

const PHASES = {
  lobby: 'Salon',
  night: '🌙 Nuit',
  witch: '🌙 Nuit — la sorcière',
  day: '☀️ Jour — débat',
  vote: '⚖️ Vote du village',
  hunter: '🏹 Le chasseur',
  ended: '🏁 Fin de partie',
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

// Identifiant persistant : permet de revenir dans la partie après une coupure.
const playerId = localStorage.getItem('lg-id') || crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
localStorage.setItem('lg-id', playerId);

const socket = io({ transports: ['websocket', 'polling'] });
const voice = new Voice({
  socket,
  onSpeaking: () => renderSpeaking(),
  onLevel: (v) => $('#mic').style.setProperty('--level', v.toFixed(2)),
  onStatus: (s) => {
    if (s === 'mic-denied') toast('Micro refusé : tu peux écouter et utiliser le chat écrit.');
    if (s === 'needs-gesture') $('#voice-status').textContent = 'Touche l\'écran pour activer le son';
    renderVoiceBar();
  },
});

(function makeStars() {
  const box = $('#stars');
  for (let i = 0; i < 70; i++) {
    const star = el('div', { className: i % 9 === 0 ? 'star big' : 'star' });
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.animationDelay = `${Math.random() * 3}s`;
    star.style.animationDuration = `${2 + Math.random() * 3}s`;
    box.append(star);
  }
})();

window.loupDebug = { voice }; // utile pour les tests et le débogage

let state = null;
let clockOffset = 0;
let witchChoice = { heal: false, poison: null };
let lastPhaseKey = '';
let wakeLock = null;

// ---------- Accueil ----------

$('#name').value = localStorage.getItem('lg-name') || '';
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('#code').value = urlCode.toUpperCase();

function homeError(msg) {
  $('#home-error').textContent = msg || '';
}

async function enter(event, payload) {
  const name = $('#name').value.trim();
  if (!name) return homeError('Choisis un pseudo.');
  localStorage.setItem('lg-name', name);
  voice.ensureAudioContext();
  const res = await emit(event, { playerId, name, ...payload });
  if (!res.ok) return homeError(res.error);
  homeError();
  sessionStorage.setItem('lg-room', res.code);
  history.replaceState(null, '', `?code=${res.code}`);
  voice.enableMic();
  keepAwake();
}

$('#create').onclick = () => enter('create');
$('#join').onclick = () => enter('join', { code: $('#code').value });
$('#code').addEventListener('keydown', (e) => e.key === 'Enter' && $('#join').click());
$('#name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('#code').value ? $('#join') : $('#create')).click());

function emit(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'Serveur injoignable.' } : res));
  });
}

async function act(action) {
  const res = await emit('action', action);
  if (!res.ok) toast(res.error);
}

// Reconnexion automatique (rafraîchissement de page, réseau mobile instable…).
socket.on('connect', async () => {
  const code = sessionStorage.getItem('lg-room');
  const name = localStorage.getItem('lg-name');
  if (code && name) {
    const res = await emit('join', { playerId, name, code });
    if (!res.ok) {
      sessionStorage.removeItem('lg-room');
      showScreen('home');
      if (state) homeError(res.error);
      state = null;
    }
  }
});

socket.on('disconnect', () => toast('Connexion perdue, reconnexion…'));

socket.on('state', (s) => {
  clockOffset = s.serverNow - Date.now();
  const previous = state;
  state = s;
  showScreen('game');
  voice.update(s);
  onPhaseChange(previous, s);
  render();
});

socket.on('chat', (m) => addChat(m));

// ---------- Rendu ----------

function showScreen(name) {
  document.body.dataset.screen = name;
  $('#home').classList.toggle('hidden', name !== 'home');
  $('#game').classList.toggle('hidden', name !== 'game');
}

// Ambiance visuelle : crépuscule au salon, nuit bleutée, jour orangé.
function ambiance(phase) {
  if (phase === 'night' || phase === 'witch') return 'night';
  if (phase === 'lobby' || phase === 'ended') return 'dusk';
  return 'day';
}

function playTransition(to, round) {
  const box = $('#phase-transition');
  box.className = `phase-transition to-${to}`;
  box.querySelector('.pt-icon').textContent = to === 'night' ? '🌕' : '☀️';
  box.querySelector('.pt-text').textContent = to === 'night' ? 'La nuit tombe…' : 'Le jour se lève';
  box.querySelector('.pt-sub').textContent = to === 'night' ? `Nuit ${round} · le village s'endort` : 'Le village se réveille';
  void box.offsetWidth; // relance l'animation
  box.classList.add('show');
}

function onPhaseChange(prev, s) {
  const key = `${s.phase}-${s.round}`;
  if (key === lastPhaseKey) return;
  lastPhaseKey = key;
  const from = prev ? ambiance(prev.phase) : null;
  const to = ambiance(s.phase);
  if (from && from !== to && to !== 'dusk' && !(s.phase === 'night' && s.round === 1)) playTransition(to, s.round);
  if (s.phase !== 'witch') witchChoice = { heal: false, poison: null };
  navigator.vibrate?.(120);
  if (s.phase === 'night' && s.round === 1 && s.me?.role) showRoleReveal(s.me.role);
  if (s.phase === 'ended') showEnd(s);
  if (prev && prev.phase === 'lobby' && s.phase !== 'lobby') $('#chat').innerHTML = '';
}

function render() {
  const s = state;
  const me = s.me || {};
  const isNight = s.phase === 'night' || s.phase === 'witch';
  document.body.className = ambiance(s.phase);
  document.body.classList.toggle('dead', me.alive === false && s.phase !== 'lobby');

  $('#room-code').textContent = s.code;
  $('#phase-label').textContent = (s.round && s.phase !== 'ended' ? `${PHASES[s.phase]} · ${s.round}` : PHASES[s.phase]) || s.phase;

  loadNotes();
  renderRoleCard();
  renderPrompt();
  renderPlayers();
  renderControls();
  renderLog();
  renderNotes();
  renderVoiceBar();
  renderSpeaking();

  const canChat = s.phase === 'lobby' || s.phase === 'ended' || me.alive === false || s.voice.talkTo.length > 0;
  $('#chat-input').disabled = !canChat;
  $('#chat-input').placeholder = canChat ? (me.alive === false && s.phase !== 'lobby' && s.phase !== 'ended' ? 'Message aux morts…' : isNight ? 'Message aux loups…' : 'Écrire un message…') : 'Chut… le village dort.';
}

function renderRoleCard() {
  const role = ROLES[state.me?.role];
  const card = $('#role-card');
  card.classList.toggle('hidden', !role);
  if (!role) return;
  card.innerHTML = '';
  card.className = `role-card team-${role.team}${state.me.alive ? '' : ' is-dead'}`;
  card.append(
    el('div', { className: 'role-icon', textContent: role.icon }),
    el('div', {}, el('div', { className: 'role-name', textContent: `Tu es ${role.name}${state.me.alive ? '' : ' (mort)'}` }), el('div', { className: 'role-desc', textContent: role.desc })),
  );
}

function playerName(id) {
  return state.players.find((p) => p.id === id)?.name || '?';
}

function renderPrompt() {
  const s = state;
  const a = s.actions;
  const me = s.me || {};
  let text = '';
  if (s.phase === 'lobby') {
    const n = s.players.length;
    text = n < s.minPlayers ? `En attente de joueurs (${n}/${s.minPlayers} minimum). Partage le code ${s.code} !` : `${n} joueurs prêts. ${s.hostId === me.id ? 'Lance la partie quand tout le monde est là.' : 'L\'hôte va lancer la partie.'}`;
  } else if (s.phase === 'ended') {
    text = s.winner === 'village' ? '🎉 Le village l\'emporte !' : '🐺 Les loups-garous l\'emportent !';
  } else if (!me.alive && s.phase !== 'hunter') {
    text = '👻 Tu es mort. Tu peux tout voir et tout entendre, mais seuls les morts t\'entendent.';
  } else if (a.wolfVote) {
    text = 'Choisis votre victime. Il faut que tous les loups votent pour la même personne.';
  } else if (a.seerInspect) {
    text = 'Touche un joueur pour découvrir son rôle.';
  } else if (a.witch) {
    text = a.witch.victim ? `Les loups ont attaqué ${playerName(a.witch.victim)}.` : 'Les loups n\'ont tué personne cette nuit.';
    if (a.witch.canPoison) text += ' Touche un joueur pour l\'empoisonner.';
  } else if (a.hunterShoot) {
    text = 'Tu meurs… Touche le joueur que tu emportes avec toi !';
  } else if (s.phase === 'night' || s.phase === 'witch') {
    text = '😴 Tu dors. Ferme les yeux et attends le lever du jour…';
  } else if (s.phase === 'day') {
    text = 'Débattez ! Qui sont les loups ? Le vote arrive bientôt.';
  } else if (s.phase === 'vote') {
    text = a.vote?.current !== undefined ? 'Vote enregistré. Tu peux encore le changer.' : 'Touche le joueur que tu veux éliminer.';
  } else if (s.phase === 'hunter') {
    text = 'Le chasseur choisit sa cible…';
  }
  $('#prompt').textContent = text;
}

function targetAction(p) {
  const s = state;
  const a = s.actions;
  const me = s.me || {};
  if (!p.alive) return null;
  if (a.wolfVote && p.role !== 'werewolf') return () => act({ type: 'wolfVote', target: p.id });
  if (a.seerInspect && p.id !== me.id) return () => act({ type: 'seerInspect', target: p.id });
  if (a.witch?.canPoison && p.id !== me.id) return () => {
    witchChoice.poison = witchChoice.poison === p.id ? null : p.id;
    render();
  };
  if (a.hunterShoot && p.id !== me.id) return () => act({ type: 'hunterShoot', target: p.id });
  if (a.vote) return () => act({ type: 'vote', target: p.id });
  return null;
}

function renderPlayers() {
  const s = state;
  const a = s.actions;
  const list = $('#players');
  list.innerHTML = '';
  const tally = (votes) => {
    const t = {};
    for (const target of Object.values(votes || {})) if (target) t[target] = (t[target] || 0) + 1;
    return t;
  };
  const wolfTally = tally(a.wolfVote?.votes);
  const voteTally = tally(a.votes);
  const myVote = a.wolfVote?.votes?.[s.me?.id] ?? a.vote?.current;

  for (const p of s.players) {
    const role = ROLES[p.role];
    const onClick = targetAction(p);
    const count = (wolfTally[p.id] || 0) + (voteTally[p.id] || 0);
    const classes = ['player'];
    if (!p.alive) classes.push('is-dead');
    if (!p.connected) classes.push('offline');
    if (onClick) classes.push('clickable');
    if (myVote === p.id || witchChoice.poison === p.id) classes.push('selected');
    if (p.id === s.me?.id) classes.push('is-me');
    if (p.id === a.witch?.victim) classes.push('victim');

    const node = el(
      onClick ? 'button' : 'div',
      { className: classes.join(' '), onclick: onClick || null },
      el('div', { className: 'avatar', textContent: !p.alive ? '💀' : role ? role.icon : p.name.slice(0, 1).toUpperCase() }),
      el('div', { className: 'pname', textContent: p.name + (p.id === s.me?.id ? ' (toi)' : '') }),
      el('div', { className: 'pmeta', textContent: [p.isHost ? '👑' : '', role ? role.name : '', !p.connected ? 'hors ligne' : ''].filter(Boolean).join(' · ') }),
      count ? el('div', { className: 'votes', textContent: count }) : null,
      el('div', { className: 'talk-badge', textContent: '🔊', title: 'Parle' }),
    );
    const note = notes.players[p.id];
    if (note?.tag && NOTE_TAGS[note.tag]) node.append(el('div', { className: `note-tag tag-${note.tag}`, textContent: NOTE_TAGS[note.tag].icon, title: note.text || NOTE_TAGS[note.tag].label }));
    else if (note?.text) node.append(el('div', { className: 'note-tag', textContent: '📝', title: note.text }));
    node.dataset.id = p.id;
    list.append(node);
  }
}

function renderControls() {
  const s = state;
  const a = s.actions;
  const me = s.me || {};
  const box = $('#controls');
  box.innerHTML = '';
  const btn = (label, onclick, cls = '') => box.append(el('button', { className: `btn ${cls}`, textContent: label, onclick }));

  if (s.phase === 'lobby') {
    if (s.composition) {
      const counts = {};
      for (const r of s.composition) counts[r] = (counts[r] || 0) + 1;
      box.append(el('div', { className: 'composition' }, ...Object.entries(counts).map(([r, n]) => el('span', { className: 'chip', textContent: `${ROLES[r].icon} ${ROLES[r].name}${n > 1 ? ' ×' + n : ''}` }))));
    }
    if (s.hostId === me.id) {
      const b = el('button', { className: 'btn primary', textContent: 'Lancer la partie', disabled: s.players.length < s.minPlayers });
      b.onclick = async () => {
        const res = await emit('start');
        if (!res.ok) toast(res.error);
      };
      box.append(b);
    }
    btn('📨 Inviter des amis', share, 'ghost');
  }
  if (s.phase === 'ended' && s.hostId === me.id) {
    btn('🔁 Rejouer', async () => {
      const res = await emit('start');
      if (!res.ok) toast(res.error);
    }, 'primary');
  }
  if (a.witch) {
    if (a.witch.canHeal) {
      btn(witchChoice.heal ? `✅ ${playerName(a.witch.victim)} sera sauvé(e)` : `🧪 Sauver ${playerName(a.witch.victim)}`, () => {
        witchChoice.heal = !witchChoice.heal;
        render();
      }, witchChoice.heal ? 'selected' : '');
    }
    if (witchChoice.poison) box.append(el('div', { className: 'hint', textContent: `☠️ Poison sur ${playerName(witchChoice.poison)}` }));
    btn(witchChoice.heal || witchChoice.poison ? 'Valider mes potions' : 'Ne rien faire', () => act({ type: 'witch', ...witchChoice }), 'primary');
  }
  if (a.vote) btn(a.vote.current === null ? '✋ Abstention enregistrée' : '✋ S\'abstenir', () => act({ type: 'vote', target: null }), 'ghost');
  if (a.skipDay) btn('⏩ Passer au vote', () => act({ type: 'skipDay' }), 'ghost');
}

function renderLog() {
  const list = $('#log');
  list.innerHTML = '';
  for (const entry of state.log) list.append(el('li', { className: `log-${entry.type}`, textContent: entry.text }));
  list.scrollTop = list.scrollHeight;
}

function addChat(m) {
  const list = $('#chat');
  const channel = { wolves: '🐺 ', dead: '👻 ', village: '' }[m.channel] || '';
  list.append(el('li', { className: `chat-${m.channel}` }, el('b', { textContent: `${channel}${m.name} : ` }), m.text));
  while (list.children.length > 150) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
  if (!$('#tab-chat').classList.contains('hidden')) return;
  document.querySelector('[data-tab="chat"]').classList.add('unread');
}

$('#chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  if (!input.value.trim()) return;
  const res = await emit('chat', { text: input.value });
  if (!res.ok) return toast(res.error);
  input.value = '';
};

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    tab.classList.remove('unread');
    for (const name of ['chat', 'notes', 'log']) $(`#tab-${name}`).classList.toggle('hidden', tab.dataset.tab !== name);
  };
});

// ---------- Calepin (notes personnelles, stockées sur l'appareil) ----------

const NOTE_TAGS = {
  wolf: { icon: '🐺', label: 'Suspect' },
  doubt: { icon: '❓', label: 'Doute' },
  trust: { icon: '✅', label: 'Confiance' },
};

let notes = { players: {}, free: '' };
let notesKey = null;
let notesListKey = '';

function loadNotes() {
  const key = state.gameId ? `lg-notes-${state.code}-${state.gameId}` : null;
  if (key === notesKey) return;
  notesKey = key;
  notesListKey = '';
  try {
    notes = (key && JSON.parse(localStorage.getItem(key))) || { players: {}, free: '' };
  } catch {
    notes = { players: {}, free: '' };
  }
  $('#notes-free').value = notes.free || '';
  // On ne garde que les 5 dernières parties.
  try {
    const old = Object.keys(localStorage).filter((k) => k.startsWith('lg-notes-') && k !== key).sort();
    old.slice(0, Math.max(0, old.length - 4)).forEach((k) => localStorage.removeItem(k));
  } catch {}
}

function saveNotes() {
  if (!notesKey) return;
  try {
    localStorage.setItem(notesKey, JSON.stringify(notes));
  } catch {}
}

function renderNotes() {
  loadNotes();
  const inGame = !!state.gameId;
  $('#notes-free').disabled = !inGame;
  $('#notes-free').placeholder = inGame ? 'ex : Bob a défendu Chloé trop vite…' : 'Le calepin s\'ouvre au début de la partie.';
  const others = state.players.filter((p) => p.id !== state.me?.id);
  // On ne reconstruit la liste que si les joueurs changent, pour ne pas perdre la saisie en cours.
  const listKey = notesKey + others.map((p) => `${p.id}:${p.alive}:${p.role}`).join(',');
  if (listKey === notesListKey) return;
  notesListKey = listKey;
  const list = $('#note-players');
  list.innerHTML = '';
  if (!inGame) return;
  for (const p of others) {
    const entry = (notes.players[p.id] ||= { tag: null, text: '' });
    const tags = el('div', { className: 'note-tags' });
    for (const [key, t] of Object.entries(NOTE_TAGS)) {
      const b = el('button', { className: `tag-btn${entry.tag === key ? ' active' : ''}`, textContent: t.icon, title: t.label, type: 'button' });
      b.onclick = () => {
        entry.tag = entry.tag === key ? null : key;
        saveNotes();
        notesListKey = '';
        render();
      };
      tags.append(b);
    }
    const input = el('input', { className: 'note-input', value: entry.text || '', placeholder: 'Note…', maxLength: 120 });
    input.oninput = () => {
      entry.text = input.value;
      saveNotes();
    };
    input.onchange = () => renderPlayers();
    const role = ROLES[p.role];
    list.append(
      el('li', { className: `note-row${p.alive ? '' : ' is-dead'}` },
        el('div', { className: 'note-name', textContent: `${p.alive ? '' : '💀 '}${p.name}${role ? ' · ' + role.icon : ''}` }),
        tags,
        input,
      ),
    );
  }
}

$('#notes-free').oninput = (e) => {
  notes.free = e.target.value;
  saveNotes();
};

// ---------- Qui parle ----------

function renderSpeaking() {
  const ids = voice.speaking;
  document.querySelectorAll('.player').forEach((n) => n.classList.toggle('speaking', ids.has(n.dataset.id)));
  const box = $('#speakers');
  if (!box || !state) return;
  const names = state.players.filter((p) => ids.has(p.id)).map((p) => (p.id === state.me?.id ? 'Toi' : p.name));
  let text = names.length === 1 && names[0] === 'Toi' ? 'Tu parles' : names.join(', ') + (names.length > 1 ? ' parlent' : ' parle');
  if (names.length === 1 && names[0] === 'Toi' && state.voice.talkTo.length === 0) text += ' (personne ne t\'entend)';
  box.innerHTML = '';
  if (names.length) box.append(el('span', { className: 'speaker-dot' }), text);
  $('#voice-status').classList.toggle('hidden', names.length > 0);
}

// ---------- Vocal ----------

function renderVoiceBar() {
  const mic = $('#mic');
  const hasMic = !!voice.localTrack;
  mic.classList.toggle('off', !hasMic || voice.muted);
  mic.firstChild.textContent = hasMic && !voice.muted ? '🎙️' : '🔇';
  mic.querySelector('span').textContent = !hasMic ? 'Activer' : voice.muted ? 'Muet' : 'Micro';
  $('#deafen').classList.toggle('off', voice.deafened);
  $('#deafen').firstChild.textContent = voice.deafened ? '🔈' : '🔊';
  if (!state) return;
  const status = $('#voice-status');
  if (status.textContent.startsWith('Touche')) return;
  const talking = state.voice.talkTo.length;
  status.textContent = state.phase === 'lobby' || state.phase === 'ended' ? 'Vocal ouvert à tous' : !state.me?.alive ? 'Vocal : canal des morts' : talking === 0 ? 'Vocal coupé' : state.phase === 'night' || state.phase === 'witch' ? 'Vocal : canal des loups' : 'Vocal : tout le village';
}

$('#mic').onclick = async () => {
  voice.ensureAudioContext();
  if (!voice.localTrack) await voice.enableMic();
  else voice.setMuted(!voice.muted);
  renderVoiceBar();
};

$('#deafen').onclick = () => {
  voice.ensureAudioContext();
  voice.setDeafened(!voice.deafened);
  renderVoiceBar();
};

// Débloque l'audio sur mobile au premier geste.
document.addEventListener('pointerdown', () => {
  voice.ensureAudioContext();
  if ($('#voice-status').textContent.startsWith('Touche')) {
    $('#voice-status').textContent = '';
    renderVoiceBar();
  }
});

// ---------- Divers ----------

function tick() {
  const t = $('#timer');
  if (!state?.deadline) {
    t.textContent = '';
    return;
  }
  const left = Math.max(0, Math.round((state.deadline - (Date.now() + clockOffset)) / 1000));
  t.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  t.classList.toggle('urgent', left <= 10);
}
setInterval(tick, 500);

async function share() {
  const url = `${location.origin}${location.pathname}?code=${state.code}`;
  const text = `Rejoins ma partie de Loup-Garou ! Code : ${state.code}`;
  if (navigator.share) {
    navigator.share({ title: 'Loup-Garou', text, url }).catch(() => {});
  } else {
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast('Lien d\'invitation copié !');
  }
}
$('#share').onclick = share;

$('#leave').onclick = async () => {
  if (state?.phase !== 'lobby' && state?.phase !== 'ended' && !confirm('Quitter la partie en cours ?')) return;
  await emit('leave');
  sessionStorage.removeItem('lg-room');
  state = null;
  lastPhaseKey = '';
  voice.closeAll();
  document.body.className = 'dusk';
  history.replaceState(null, '', location.pathname);
  showScreen('home');
};

function showRoleReveal(roleKey) {
  const role = ROLES[roleKey];
  const o = $('#overlay');
  o.innerHTML = '';
  o.append(
    el('div', { className: `reveal team-${role.team}` },
      el('div', { className: 'reveal-icon', textContent: role.icon }),
      el('h2', { textContent: `Tu es ${role.name}` }),
      el('p', { textContent: role.desc }),
      el('button', { className: 'btn primary', textContent: 'Compris !', onclick: () => o.classList.add('hidden') }),
    ),
  );
  o.classList.remove('hidden');
}

function showEnd(s) {
  const o = $('#overlay');
  o.innerHTML = '';
  const village = s.winner === 'village';
  o.append(
    el('div', { className: `reveal team-${village ? 'village' : 'wolves'}` },
      el('div', { className: 'reveal-icon', textContent: village ? '🏡' : '🐺' }),
      el('h2', { textContent: village ? 'Victoire du village !' : 'Victoire des loups !' }),
      el('ul', { className: 'final-roles' }, ...s.players.map((p) => el('li', { textContent: `${ROLES[p.role]?.icon || ''} ${p.name} — ${ROLES[p.role]?.name || '?'}${p.alive ? '' : ' 💀'}` }))),
      el('button', { className: 'btn primary', textContent: 'Fermer', onclick: () => o.classList.add('hidden') }),
    ),
  );
  o.classList.remove('hidden');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state) keepAwake();
});

// ---------- PWA ----------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install').classList.remove('hidden');
});
$('#install').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#install').classList.add('hidden');
};
