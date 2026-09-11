# La passe de lecture en mode lecteur — analyse

Signalé par le propriétaire du projet : « en mode lecteur, quand le lecteur désigné
ne peut pas lire la carte à voix haute — quelqu'un qui ne sait pas bien lire, ou ne
veut pas parler — et qu'il laisse la main à quelqu'un d'autre pour lire la question,
c'est assez mal fait pour l'instant, le switch. »

Le constat est exact, et il est même en dessous de la réalité : en multijoueur à
distance, **le switch n'existe pas**. Tout ce qui suit est mesuré sur le vrai
serveur, avec trois clients socket.io distincts, pas seulement lu dans le code.

## Ce que fait le jeu aujourd'hui

Le lecteur est **résolu**, jamais choisi : c'est le joueur connecté précédent du
joueur actif (`resolveReaderIndex`, qui remonte la table en sautant les
déconnectés). Cette résolution unique est dérivée aux quatre endroits qui comptent —
la solution (`gameStateView`), le droit de trancher une réponse
(`isPlayerAllowedToAnswer`), le duo caméra/micro (`resolveOnAirIds`) et l'affichage
(`QuestionModal`, `LiveCameraOverlay`). Mesuré à trois joueurs, question en cours :

| Écran | Rôle | Solution reçue | Carte masquée | À l'antenne |
| --- | --- | --- | --- | --- |
| Bruno (actif) | répond | non | **oui** | oui |
| Alice (précédent) | lit | **oui** (`correctAnswerIndex`) | non | oui |
| Chloe | spectatrice | non | non | non |

À partir de là, quatre constats.

**1. Aucun mécanisme de passage, ni serveur ni client.** Le serveur n'a aucun
handler pour réassigner la lecture (vérifié en émettant `pass-reader`,
`change-reader`, `set-reader`, `reader-handoff` : état strictement inchangé), et
l'interface n'a aucun bouton. Le « switch » vécu en partie est donc un bricolage
oral : un spectateur lit l'énoncé (il le voit, seule la solution lui manque), mais
**la solution, le maintien-pour-révéler, le jugement des cartes ouvertes et le micro
restent chez le lecteur désigné**, et le bandeau continue d'annoncer le mauvais nom.
Pour une carte ouverte, personne d'autre ne peut juger : la table est suspendue à
quelqu'un qui ne peut pas lire.

**2. Le seul « passage » possible est de fermer l'application.** Mesuré : quand le
lecteur se déconnecte en pleine question, la résolution bascule vers le joueur
connecté précédent, qui reçoit la solution en cours de route — c'est le filet
voulu. Mais c'est un filet de déconnexion, pas un geste de jeu : demander à un
enfant de tuer l'application pour passer la lecture n'est pas un switch.

**3. Et il ne tient même pas : la lecture revient de force.** Mesuré : le lecteur
d'origine qui se reconnecte (reprise par prénom) **reprend le rôle en pleine
question** — le remplaçant perd la solution sans un mot, le bandeau change de nom
sous les yeux de la table. La résolution étant purement positionnelle, rien ne
retient que cette personne ne veut pas lire.

**4. Le minuteur ignore tout de l'affaire.** `questionStartTime` ne bouge ni à la
déconnexion du lecteur ni à son retour (mesuré : identique avant/après) : le temps
du joueur interrogé s'écoule pendant que la table s'organise.

Reprise du disque, mesurée aussi : le joueur actif qui revient seul n'a pas de
lecteur, sa carte s'affiche **en clair** (repli existant, la solution ne part chez
personne) ; dès que les autres reviennent, elle se re-masque et la lecture retombe
sur le même joueur précédent — y compris s'il était celui qui ne peut pas lire.
En mode local, la passe est physique : l'écran-porte nomme un lecteur mais
n'importe qui peut appuyer sur « Je suis X, afficher la carte » ; la solution est de
toute façon sur l'appareil partagé.

## La correction : rendre la lecture, un état du joueur

Un joueur peut désormais **rendre la lecture** : le serveur pose `declinesReading`
sur son siège, et `resolveReaderIndex` le saute exactement comme un déconnecté. On
ne stocke jamais « qui lit » — le lecteur reste résolu — on stocke « qui ne lit
pas », sur le joueur lui-même. C'est ce qui donne toutes les propriétés demandées
sans un seul cas particulier :

- la solution, l'antenne et le bandeau suivent le remplaçant d'un même mouvement,
  puisque tous dérivent de la même résolution ;
- le joueur actif ne peut jamais être désigné : la résolution ne le rend jamais ;
- l'état survit au changement de tour et aux manches (il vit sur le joueur), et à
  la reprise du disque (le joueur est persisté tel quel, rien à ajouter à
  `roomStore`) ;
- l'enfant qui ne sait pas lire n'est pas re-désigné au tour suivant — c'était le
  défaut du modèle « passer cette carte-ci », qui aurait reposé la question à
  chaque tour ;
- s'il ne reste personne pour lire, on retombe sur le repli existant : carte
  affichée au joueur actif, solution envoyée à personne, cartes ouvertes non
  servies (`questionSelection` dérive de la même résolution).

Le point d'entrée est un seul événement, `set-reading-preference`, validé serveur :
un joueur ne règle que sa propre lecture, l'organisateur celle de n'importe qui —
c'est lui qui dépanne l'enfant perdu devant sa carte, et les sièges du pass & play
qui n'ont pas de socket. Quand la main passe en pleine question, le **décompte
repart de zéro** : le nouveau lecteur reprend la carte du début, le joueur
interrogé ne paie pas la passe en secondes (un minuteur qui attendait encore la
roue surprise continue d'attendre).

Côté interface : le lecteur a un bouton « Passer la lecture » dans son bandeau ;
l'organisateur y voit « Changer de lecteur » ; celui qui a rendu la lecture garde un
rappel discret « Relire les cartes » pour la reprendre ; en pass & play, la passe
vit sur l'écran « passez l'appareil ».

## Mesures qui valident la correction

Rejouées sur le vrai serveur, trois clients (19 vérifications, toutes passées) :

- passe en pleine question : la solution quitte l'ancien lecteur, arrive chez le
  remplaçant, ne touche jamais le joueur actif ; l'antenne suit ; le décompte
  repart ;
- gardes : un non-organisateur ne règle pas la lecture d'un autre ; le joueur
  actif peut rendre la sienne sans jamais devenir lecteur ; tous passeurs →
  aucun lecteur, solution chez personne ;
- la passe survit au changement de tour (le passeur est sauté quand son tour de
  lire revient) et à l'arrêt/reprise du serveur (drapeaux relus du disque) ;
- reprendre la lecture rend le rôle et la solution ;
- en local, l'écran-porte se renomme et la solution reste sur l'appareil partagé.

## Ce qui reste ouvert (décisions de jeu, pas de code)

1. **La passe doit-elle être durable ou par carte ?** Le choix fait ici : durable
   (on ne re-désigne pas un enfant qui ne sait pas lire), réversible par « Relire
   les cartes ». Si le propriétaire préfère une passe « pour cette carte
   seulement », c'est un second état, à durée de question, qui peut s'ajouter sans
   toucher au premier.
2. **Où régler la préférence hors d'une question ?** Aujourd'hui elle se règle sur
   la carte (bandeau et écran-porte). Un interrupteur « lit les cartes à voix
   haute » dans le salon ou la liste des joueurs éviterait la première passe en
   pleine partie.
3. **Faut-il annoncer la passe à toute la table ?** Le bandeau change de nom sur
   tous les écrans, mais sans message. Un mot dans le journal (« Chloe passe la
   lecture à Bruno ») rendrait le moment lisible — au prix d'exposer un enfant qui
   ne sait pas lire, ce qui est peut-être exactement ce qu'on veut éviter.
4. **Le remplaçant est-il le bon ?** La passe suit l'ordre de la table (joueur
   connecté précédent suivant). Laisser choisir la cible (« confier la lecture à
   Papa ») serait plus contrôlable mais ajoute un écran de choix au milieu d'une
   question ; l'ordre de table a le mérite d'être prévisible et sans latence.
5. **Le redémarrage du décompte est-il le bon réglage ?** Alternative : ne pas y
   toucher (plus simple, mais le joueur interrogé paie la passe), ou geler le
   temps restant (plus juste, mais demande un nouvel état). Le choix fait ici —
   repartir de zéro — est celui de la pause (`togglePauseState`), qui redonne du
   temps plutôt qu'en voler.
