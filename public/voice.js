// Chat vocal en WebRTC maillé (chaque joueur est relié directement aux autres).
// Le serveur ne fait que relayer la signalisation. Qui parle à qui est décidé par
// la politique `voice` envoyée par le serveur à chaque changement de phase.

export class Voice {
  constructor({ socket, onSpeaking, onStatus }) {
    this.socket = socket;
    this.onSpeaking = onSpeaking || (() => {});
    this.onStatus = onStatus || (() => {});
    this.peers = new Map(); // playerId -> { pc, epoch, sender, audio, analyser, pendingIce }
    this.myId = null;
    this.localStream = null;
    this.localTrack = null;
    this.muted = false;
    this.deafened = false;
    this.policy = { talkTo: [], hearFrom: [] };
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.audioCtx = null;
    this.speaking = new Set();
    socket.on('signal', ({ from, data }) => this.handleSignal(from, data).catch((e) => console.warn('signal', e)));
    fetch('config')
      .then((r) => r.json())
      .then((c) => c.iceServers && (this.iceServers = c.iceServers))
      .catch(() => {});
    this.lastLoud = new Map(); // playerId -> dernier instant où le niveau était audible
    setInterval(() => this.detectSpeaking(), 100);
  }

  async enableMic() {
    if (this.localStream) return true;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.localTrack = this.localStream.getAudioTracks()[0];
      this.localTrack.enabled = !this.muted;
      this.attachAnalyser('me', this.localStream);
      this.applyPolicy();
      this.onStatus('mic-on');
      return true;
    } catch (e) {
      console.warn('micro refusé', e);
      this.onStatus('mic-denied');
      return false;
    }
  }

  ensureAudioContext() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this.audioCtx = new Ctx();
    }
    if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
    // Sur mobile, la lecture audio doit être relancée après un geste de l'utilisateur.
    for (const peer of this.peers.values()) peer.audio?.play().catch(() => {});
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.localTrack) this.localTrack.enabled = !muted;
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    this.applyPolicy();
  }

  // Appelé à chaque nouvel état de partie.
  update(state) {
    if (!state.me) return this.closeAll();
    this.myId = state.me.id;
    this.policy = state.voice;
    const wanted = new Map(state.players.filter((p) => p.id !== this.myId && p.connected).map((p) => [p.id, p.epoch]));
    for (const [id, peer] of this.peers) {
      // Le répondeur garde sa connexion tant que le joueur est là : l'initiateur renverra une offre si besoin.
      if (!wanted.has(id) || (peer.initiator && wanted.get(id) !== peer.epoch)) this.closePeer(id);
    }
    for (const [id, epoch] of wanted) {
      // L'identifiant le plus petit fait l'offre, pour éviter les collisions.
      if (!this.peers.has(id) && this.myId < id) this.createPeer(id, epoch, true);
    }
    this.epochs = wanted;
    this.applyPolicy();
  }

  createPeer(id, epoch, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { pc, epoch, initiator, sender: null, audio: null, pendingIce: [] };
    this.peers.set(id, peer);

    pc.onicecandidate = (e) => e.candidate && this.send(id, { candidate: e.candidate });
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (!peer.audio) {
        peer.audio = document.createElement('audio');
        peer.audio.autoplay = true;
        peer.audio.setAttribute('playsinline', '');
        document.body.appendChild(peer.audio);
      }
      peer.audio.srcObject = stream;
      peer.audio.play().catch(() => this.onStatus('needs-gesture'));
      this.attachAnalyser(id, stream);
      this.applyPolicy();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.closePeer(id);
        if (this.myId < id && this.epochs?.get(id) === epoch) this.createPeer(id, epoch, true);
      }
    };

    if (initiator) {
      const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      peer.sender = transceiver.sender;
      this.applyPolicy();
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => this.send(id, { sdp: pc.localDescription }))
        .catch((e) => console.warn('offre', e));
    }
    return peer;
  }

  async handleSignal(from, data) {
    let peer = this.peers.get(from);
    if (data.sdp?.type === 'offer') {
      // Nouvelle offre : la connexion précédente (s'il y en a une) est obsolète.
      if (peer) this.closePeer(from);
      peer = this.createPeer(from, this.epochs?.get(from), false);
      await peer.pc.setRemoteDescription(data.sdp);
      const transceiver = peer.pc.getTransceivers()[0];
      if (transceiver) {
        transceiver.direction = 'sendrecv';
        peer.sender = transceiver.sender;
      }
      this.applyPolicy();
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      this.send(from, { sdp: peer.pc.localDescription });
      await this.flushIce(peer);
    } else if (data.sdp?.type === 'answer' && peer) {
      await peer.pc.setRemoteDescription(data.sdp);
      await this.flushIce(peer);
    } else if (data.candidate && peer) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingIce.push(data.candidate);
    }
  }

  async flushIce(peer) {
    for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  send(to, data) {
    this.socket.emit('signal', { to, data });
  }

  // Envoie notre micro uniquement à ceux qui ont le droit de nous entendre,
  // et coupe le son des joueurs qu'on n'a pas le droit d'entendre.
  applyPolicy() {
    const talk = new Set(this.policy.talkTo);
    const hear = new Set(this.policy.hearFrom);
    for (const [id, peer] of this.peers) {
      const track = talk.has(id) ? this.localTrack : null;
      if (peer.sender && peer.sender.track !== track) peer.sender.replaceTrack(track).catch(() => {});
      if (peer.audio) peer.audio.muted = this.deafened || !hear.has(id);
    }
  }

  attachAnalyser(id, stream) {
    this.ensureAudioContext();
    if (!this.audioCtx) return;
    try {
      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      if (id === 'me') this.localAnalyser = { analyser, data };
      else if (this.peers.get(id)) this.peers.get(id).analyser = { analyser, data };
    } catch (e) {
      console.warn('analyseur', e);
    }
  }

  detectSpeaking() {
    const now = performance.now();
    const loud = new Set();
    const level = ({ analyser, data }) => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += (v - 128) * (v - 128);
      return Math.sqrt(sum / data.length);
    };
    if (this.localAnalyser && this.localTrack?.enabled && this.policy.talkTo.length && level(this.localAnalyser) > 6) loud.add(this.myId);
    const hear = new Set(this.policy.hearFrom);
    for (const [id, peer] of this.peers) {
      if (peer.analyser && hear.has(id) && level(peer.analyser) > 6) loud.add(id);
    }
    for (const id of loud) this.lastLoud.set(id, now);
    // On garde l'indicateur allumé 400 ms pour qu'il ne clignote pas entre deux syllabes.
    const speaking = new Set();
    for (const [id, t] of this.lastLoud) {
      if (now - t < 400) speaking.add(id);
      else this.lastLoud.delete(id);
    }
    const changed = speaking.size !== this.speaking.size || [...speaking].some((id) => !this.speaking.has(id));
    this.speaking = speaking;
    if (changed) this.onSpeaking(speaking);
  }

  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    if (peer.audio) {
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
    this.peers.delete(id);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }
}
