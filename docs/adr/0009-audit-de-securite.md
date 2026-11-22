# ADR 0009 — Audit de sécurité : le client envoie ce qu'il veut

- Statut : accepté
- Date : 2026-11-20
- Portée : serveur temps réel, surface HTTP, client, dépendances, CI

## Contexte

Demandé par le propriétaire du projet : analyser toutes les failles de sécurité
et tout ce qui doit être mis à jour, puis corriger et tester. Le jeu tourne sur
un serveur public, se joue avec des enfants, filme parfois la table et appelle
des modèles de langage payants.

L'audit a couvert trois surfaces en parallèle — serveur socket.io, HTTP et
déploiement, client React — puis les dépendances. Les constats qui ont fixé les
décisions, tous reproduits :

- **Un seul message tuait le serveur.** `emit('create-room')` sans argument
  levait une TypeError hors de tout `try`, et le processus mourait avec toutes
  les parties en cours. Aucun salon à connaître, aucun compte.
- **Une donnée invalide se rejouait.** Un prénom objet ou une carte `null` était
  persisté dans `rooms.json`, puis faisait planter le serveur à chaque
  redémarrage pendant douze heures.
- **Un prénom suffisait à prendre une place**, y compris celle de
  l'organisateur et son jeton de génération IA, dès que la personne perdait le
  réseau. Les codes de salon (4 caractères, `Math.random`) se trouvaient par
  force brute en quelques secondes, sans limite d'essais.
- **Les questions d'un pack venaient du client.** La route de génération
  validait la sortie du modèle, puis la renvoyait au navigateur, qui la
  redonnait au serveur par socket — n'importe quoi passait, jusqu'aux enfants.
- **Une couleur de pion était du CSS.** `red),url(https://…)` faisait charger
  une image externe à toute la table, et donc fuiter les adresses IP.
- **Le code serveur et sa source map étaient publics** dans `dist/`, avec la
  banque de questions et ses réponses.
- **Le lockfile de production portait treize vulnérabilités**, dont une
  critique, que `npm audit` ne voyait pas : il résolvait des versions récentes,
  pas celles de `bun.lock`. La CI lançait `npm ci` sans `package-lock.json` et
  échouait en dix secondes sur toutes les branches depuis des semaines.

## Décision

1. **Défense à l'entrée, pas au rendu.** Chaque handler passe par un `on()`
   commun qui écarte ce qui n'est pas un objet et attrape toute exception ;
   chaque champ est validé par `src/server/inputValidation.ts` avant d'entrer
   dans l'état ; `roomStore` revalide ce qu'il relit. Messages limités à 64 kio.
2. **Le siège se reprend par jeton ; au prénom, l'organisateur décide.** La
   reprise par prénom est gardée — elle existe parce que le jeton ne survit pas
   à un changement de navigateur — mais devient une demande que l'organisateur
   accepte ou refuse quand il est connecté. Sans lui, une place ordinaire se
   reprend comme avant, pour ne pas bloquer une famille ; la sienne jamais.
3. **Codes de salon à six caractères tirés par `crypto`**, essais limités par
   connexion et par adresse, trois salons actifs par adresse, débit
   d'événements borné par connexion.
4. **Le pack généré ne quitte pas le serveur.** La route le range elle-même ;
   le client n'apprend que son nom et son nombre de cartes. Génération plafonnée
   par adresse (/64 en IPv6), par salon et par jour, avec un délai d'appel.
5. **Le serveur, seul juge.** Une carte ouverte ne se valide que par le
   lecteur ; une réponse arrivée après le minuteur compte comme un temps écoulé.
6. **Surface HTTP fermée par défaut** : production sauf `NODE_ENV=development`
   explicite, bundle serveur dans `build/`, CSP et en-têtes posés à la main
   (sans dépendance), erreurs génériques.
7. **Une seule source de versions** : `bun.lock`. La CI installe depuis lui,
   bloque sur `bun audit`, épingle ses actions par empreinte. Toutes les
   dépendances sont montées à leur dernière version majeure (Express 5, Vite 8,
   TypeScript 7…), `@types/node` restant sur la ligne 22 du runtime.

## Conséquences

- Visibles par les joueurs : codes `FAM-XXXXXX` (les anciens à quatre
  caractères restent valables) ; revenir au prénom ou arriver en cours de partie
  passe par l'organisateur ; en partie, seul l'avatar se change ; une réaction
  par seconde ; une pause sans aucun appareil connecté ferme le salon au bout de
  trente minutes au lieu de quatre heures ; un écran de secours remplace l'écran
  blanc ; la personne filmée voit qui la regarde.
- Déploiement : définir `PUBLIC_ORIGIN` (contrôle d'origine des connexions et
  balises d'aperçu) ; `DATA_DIR` sur un volume garde aussi le budget de
  génération du jour ; `NODE_ENV` ne doit jamais valoir `development`.
- TypeScript 7 rend `strict` actif par défaut : `strict: false` garde le
  comportement d'avant. `@types/react` n'est pas installé, si bien que le JSX est
  typé `any` depuis toujours — chantier séparé.
- Reste ouvert, par choix : tant que l'organisateur est déconnecté — et après
  chaque redémarrage, jusqu'à son retour —, une place ordinaire se reprend au
  prénom sans accord. Fermer cette fenêtre bloquerait une famille dont
  l'organisateur a perdu le réseau ; le siège de l'organisateur, lui, n'est
  jamais exposé.
- Reste ouvert : les identifiants TURN `VITE_TURN_*` seraient compilés dans le
  bundle public. Le client sait déjà recevoir des serveurs ICE à l'exécution ;
  il manque la route d'identifiants éphémères, à écrire avant d'activer un
  relais TURN.
