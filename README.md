# 🐺 Loup-Garou en ligne

Le jeu du Loup-Garou entre amis, **avec chat vocal intégré**, jouable :

- 🌐 **dans le navigateur** (PC, Mac, Linux) ;
- 📱 **sur smartphone** (Android et iPhone), installable comme une application (PWA) ;
- 🪟 **sur Windows**, avec un installateur `.exe`.

## Fonctionnalités

- Parties privées avec un code à 5 lettres et un lien d'invitation, de 4 à 18 joueurs
- Rôles : **Loup-Garou, Villageois, Voyante, Sorcière, Chasseur**, répartis automatiquement selon le nombre de joueurs
- Déroulement automatique avec minuteurs : nuit → sorcière → jour (débat) → vote
- **Chat vocal WebRTC** qui suit les règles du jeu :
  | Moment | Qui parle à qui |
  |---|---|
  | Salon / fin de partie | tout le monde |
  | Nuit | seuls les loups s'entendent entre eux |
  | Jour / vote | tous les vivants |
  | Morts | ils entendent tout, mais ne parlent qu'aux autres morts |
- Indicateur « qui parle », bouton muet et bouton pour couper le son
- Chat écrit qui suit les mêmes règles (canal village, loups, morts)
- Reconnexion automatique après une coupure ou un rechargement de la page
- Thème nuit/jour, vibration au changement de phase, écran maintenu allumé sur mobile

Toute la logique du jeu tourne sur le serveur : un joueur ne reçoit jamais le rôle des autres.

## Lancer le serveur

```bash
npm install
npm start          # http://localhost:3000
npm test           # tests du moteur de jeu et du serveur
```

Avec Docker :

```bash
docker build -t loup-garou .
docker run -p 3000:3000 loup-garou
```

### Mettre le jeu en ligne gratuitement (Render)

1. Crée un compte sur [render.com](https://render.com) avec ton compte GitHub.
2. *New* → *Blueprint* → choisis le dépôt `LOUP` : Render lit `render.yaml` et déploie tout seul.
3. Au bout de 2–3 minutes tu obtiens une adresse `https://loup-garou-xxxx.onrender.com` (HTTPS inclus) : c'est le lien à envoyer à tes amis.

Le plan gratuit met le serveur en veille après 15 min sans visite : le premier chargement prend alors ~1 min.

### Mise en ligne (important pour le vocal)

- Le micro ne fonctionne qu'en **HTTPS** (sauf sur `localhost`). Héberge le serveur derrière un certificat, par exemple sur Render, Railway, Fly.io ou un VPS avec Caddy ou Nginx.
- Le vocal est en pair-à-pair. Sur les réseaux mobiles (4G/5G) et certains Wi-Fi d'entreprise, les connexions directes échouent : il faut alors un **serveur TURN**, par exemple [coturn](https://github.com/coturn/coturn) ou un service comme Metered ou Twilio. Configure-le avec les variables d'environnement :

| Variable | Exemple |
|---|---|
| `PORT` | `3000` |
| `STUN_URLS` | `stun:stun.l.google.com:19302` |
| `TURN_URLS` | `turn:turn.mondomaine.fr:3478,turns:turn.mondomaine.fr:5349` |
| `TURN_USERNAME` | `loup` |
| `TURN_CREDENTIAL` | `motdepasse` |

- En pair-à-pair, chaque joueur envoie son audio à chacun des autres. C'est très bien jusqu'à environ 12 joueurs. Au-delà, il faudra passer à un serveur média (SFU) comme LiveKit ou mediasoup.

## Smartphone

Ouvre l'adresse du serveur dans le navigateur, puis :

- **Android (Chrome)** : bouton « 📲 Installer l'application » sur l'accueil, ou menu ⋮ → *Installer l'application* ;
- **iPhone (Safari)** : bouton Partager → *Sur l'écran d'accueil*.

## Application Windows

Le dossier `desktop/` contient une application Electron qui ouvre le serveur de jeu, avec l'autorisation du micro déjà gérée. Au premier lancement, elle demande l'adresse du serveur, modifiable ensuite via *Partie → Changer de serveur…*.

- **Tester en local** : `cd desktop && npm install && npm start`
- **Créer l'installateur** : `cd desktop && npm run dist:win` (sous Windows), ce qui produit `desktop/dist/Loup-Garou Setup x.y.z.exe`
- **Via GitHub Actions** : onglet *Actions* → *Application Windows* → *Run workflow*. Tu peux y indiquer l'adresse du serveur, qui sera alors intégrée par défaut. L'installateur est disponible en téléchargement dans les artefacts du workflow. Le workflow se lance aussi à chaque tag `v*`.

L'installateur n'est pas signé : Windows SmartScreen affichera un avertissement (*Informations complémentaires → Exécuter quand même*).

## Structure

```
server/game.js      moteur de jeu (règles, phases, qui entend qui)
server/index.js     serveur Express + Socket.IO + signalisation WebRTC
public/             client web / PWA (HTML, CSS, JS sans framework)
public/voice.js     chat vocal WebRTC
desktop/            application Windows (Electron)
test/               tests (node --test)
```

## Idées pour la suite

- Rôles supplémentaires : Cupidon, Petite Fille, Salvateur, Ancien…
- Composition des rôles et durées des phases réglables par l'hôte
- Élection du maire
- Narrateur vocal (synthèse vocale) pour annoncer les phases
- Serveur média (SFU) pour les grosses parties
- Applications mobiles natives (Capacitor) pour les stores
