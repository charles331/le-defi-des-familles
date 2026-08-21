import { Question } from '../../types';
import { CardRewrite, applyCardRewrites } from './cardRewrites';

/**
 * Passe « chemin de raisonnement » : les cartes qu'on sait ou qu'on tire au sort.
 *
 * `npm run score:fun` remonte soixante-seize cartes sous les 50 %, concentrées
 * sur quatre blocs adultes — histoire, art, pop culture, cinéma. Toutes ont été
 * relues une à une, parce que le barème produit aussi des faux positifs qu'il
 * ne faut surtout pas « corriger » : « le sanctuaire **hindou** de Prambanan »
 * se résout par élimination, l'héroïne « de **Flaubert** » se déduit du nom de
 * l'auteur, van Gogh et son oreille se savent. Ces cartes-là restent en l'état.
 *
 * Les trente-quatre réécrites ici partagent le même défaut, sous quatre formes :
 *
 * - **l'attribution nue et son miroir, le catalogue** — « Quel roi d'Angleterre
 *   fut exécuté en 1649 ? » entre quatre rois, « Qui dirigea les fouilles de
 *   Jéricho ? » entre quatre archéologues. L'énoncé ne dit rien de la personne ;
 *   le nom passe donc dans l'énoncé et la carte interroge le fait lui-même,
 *   qui se déduit ou se raconte ;
 * - **le millésime à quatre chiffres** — l'instruction obligatoire belge entre
 *   1830, 1884, 1914 et 1958. L'année remonte dans l'énoncé, comme le veut la
 *   règle, et la question porte sur ce que la loi a changé ;
 * - **la réponse dans la question** — « Quelle révolte paysanne anglaise… ? »
 *   → « La révolte des paysans ». Passée entre les mailles du détecteur parce
 *   qu'aucun nom propre n'y figurait ;
 * - **les distracteurs cassés** — « quelle chanteuse belge » face à Madonna et
 *   Daft Punk, « quel acteur belge » face à Stallone : le filtre de l'énoncé
 *   éliminait tout, la carte se jouait toute seule.
 *
 * Deux quasi-jumeaux dissous au passage, que l'audit ne pouvait pas voir parce
 * qu'ils enjambent les catégories ou les niveaux : Jenner posé en sciences
 * *et* en histoire (l'histoire passe à Semmelweis), et Van Damme répondu deux
 * fois en cinéma adulte (« acteur belge d'Universal Soldier » et « acteur
 * bruxellois surnommé les muscles de Bruxelles ») — la première carte interroge
 * désormais son grand écart entre deux camions.
 *
 * Chaque fait neuf a été vérifié contre le corpus entier, puis en ligne pour
 * les moins sûrs : la loi Poullet votée en mai 1914 et reportée à 1919 par la
 * guerre, le « ahoy » que Bell défendit toute sa vie contre le « hello »
 * d'Edison, le bonbon Mistral gagnant au sachet parfois marqué « gagnant »,
 * la chanson des Copains d'abord écrite pour un film d'Yves Robert, la
 * déclaration de Charles II d'octobre 1666 notée par Pepys, et l'écran carré
 * de Mommy qui s'élargit aux instants de liberté. Trois premières idées de
 * remplacement — le Marsupilami, l'alexandrin, le haïku — étaient déjà posées
 * ailleurs et ont été abandonnées.
 */
const REWRITES: CardRewrite[] = [
  /* ------------------------------------------------------------------ *
   * Histoire, niveau adulte.
   * ------------------------------------------------------------------ */
  {
    id: 'his_adulte_editorial_020',
    question: 'Qu’a fait le Parlement anglais de son roi, Charles Ier, en 1649 — une première en Europe ?',
    answer: 'Il l’a jugé, condamné à mort et décapité',
    distractors: [
      'Il l’a exilé à vie sur une île',
      'Il l’a enfermé à la Tour jusqu’à sa mort',
      'Il l’a contraint d’abdiquer pour son fils',
    ],
    explanation: 'Un roi jugé par son propre Parlement : l’Europe des monarchies en resta sidérée. La royauté restaurée fit condamner à leur tour les juges du roi, onze ans plus tard.',
  },
  {
    id: 'his_adulte_editorial_014',
    question: 'Que réclamaient les paysans anglais soulevés derrière Wat Tyler, en 1381 ?',
    answer: 'La fin du servage et d’un impôt levé sur chaque tête',
    distractors: [
      'Le retour de l’ancien roi sur le trône',
      'La fermeture des monastères',
      'Le droit de chasse dans les forêts royales',
    ],
    explanation: 'Le jeune Richard II reçut les rebelles, promit tout, puis fit tout reprendre une fois la foule rentrée — Wat Tyler, lui, fut tué pendant la rencontre.',
  },
  {
    id: 'his_adulte_editorial_04_001',
    question: 'Par quel mot Graham Bell voulait-il qu’on réponde au téléphone — il l’employa toute sa vie ?',
    answer: '« Ahoy », un salut de marins',
    distractors: [
      '« Watson », le nom de son assistant',
      '« Parlez », hérité du télégraphe',
      '« Qui demande ? », comme aux standards',
    ],
    explanation: 'C’est Edison qui imposa « hello » — devenu notre « allô » — par les premiers annuaires, qui apprenaient aux abonnés comment répondre à cette machine toute neuve.',
  },
  {
    id: 'his_adulte_editorial_04_009',
    question: 'Quel geste de Rosa Parks a lancé, en 1955, le boycott des bus de Montgomery ?',
    answer: 'Refuser de céder sa place à un passager blanc',
    distractors: [
      'Monter par la porte avant réservée aux Blancs',
      'Conduire elle-même un bus de la compagnie',
      'Déchirer son ticket devant le chauffeur',
    ],
    explanation: 'Le boycott tint 381 jours, mené par un pasteur de vingt-six ans encore inconnu : Martin Luther King.',
  },
  {
    id: 'his_adulte_editorial_04_027',
    question: 'Comment le médecin John Snow a-t-il stoppé le choléra d’un quartier de Londres, en 1854 ?',
    answer: 'En faisant ôter la poignée d’une pompe à eau',
    distractors: [
      'En faisant fermer le marché aux poissons',
      'En faisant bouillir l’eau de tout le quartier',
      'En faisant chauler les maisons touchées',
    ],
    explanation: 'Il avait pointé chaque mort sur une carte : les croix se serraient autour de la pompe de Broad Street. L’épidémiologie moderne était née.',
  },
  {
    id: 'his_adulte_editorial_05_005',
    question: 'Qu’ont mis au jour les fouilles de Kathleen Kenyon à Jéricho, dans les années 1950 ?',
    answer: 'Des murailles élevées des millénaires avant les pyramides',
    distractors: [
      'Le tombeau intact d’un roi cananéen',
      'Les trompettes de bronze du récit biblique',
      'Une bibliothèque de tablettes d’argile',
    ],
    explanation: 'La tour de pierre de Jéricho a quelque dix mille ans : la ville est l’une des plus anciennement habitées du monde.',
  },
  {
    id: 'his_adulte_editorial_05_019',
    question: 'Quelle route Vasco de Gama a-t-il ouverte en 1498, après dix mois de mer ?',
    answer: 'La route des Indes par le sud de l’Afrique',
    distractors: [
      'La route du Brésil par les alizés',
      'La route de la Chine par le nord de la Sibérie',
      'La route des épices par le cap Horn',
    ],
    explanation: 'Les épices rapportées de Calicut couvrirent plusieurs fois le prix de l’expédition : le Portugal tenait la clé d’un empire.',
  },
  {
    id: 'his_adulte_editorial_05_020',
    question: 'Pourquoi Magellan a-t-il baptisé « Pacifique » le plus grand océan du monde ?',
    answer: 'Il le trouva d’un calme parfait après les tempêtes du détroit',
    distractors: [
      'Il espérait y apaiser son équipage mutiné',
      'Il honorait une trêve signée avec le Portugal',
      'Il traduisait le nom que lui donnaient ses pilotes',
    ],
    explanation: 'La traversée fut pourtant un enfer de faim et de scorbut : plus de trois mois sans terre, à mâcher du cuir bouilli, raconte le chroniqueur Pigafetta.',
  },
  {
    id: 'his_adulte_editorial_05_031',
    question: 'Qui orchestra le sauvetage des banques new-yorkaises pendant la panique de 1907 ?',
    answer: 'Le banquier J. P. Morgan, en personne',
    distractors: [
      'Le président Theodore Roosevelt',
      'La toute jeune Réserve fédérale',
      'Un consortium de banques anglaises',
    ],
    explanation: 'Il enferma ses confrères dans sa bibliothèque jusqu’à l’accord. Refusant de dépendre encore d’un seul homme, l’Amérique créa la Réserve fédérale en 1913.',
  },
  {
    id: 'his_adulte_editorial_06_021',
    question: 'Quelle grande loi la Belgique vote-t-elle en mai 1914, que la guerre reportera de cinq ans ?',
    answer: 'L’école obligatoire, de 6 à 14 ans',
    distractors: [
      'Le suffrage universel des hommes',
      'La journée de travail de huit heures',
      'La pension de vieillesse ouvrière',
    ],
    explanation: 'Votée quelques semaines avant l’invasion, la loi Poullet n’entra en classe qu’en 1919 — elle fermait aussi la porte des usines aux enfants.',
  },
  {
    id: 'his_adulte_editorial_02_021',
    question: 'Pour qui l’empereur moghol Shah Jahan fit-il élever le Taj Mahal ?',
    answer: 'Pour son épouse, morte en mettant au monde leur quatorzième enfant',
    distractors: [
      'Pour sa mère, régente pendant ses campagnes',
      'Pour lui-même, en prévision de sa propre mort',
      'Pour un saint soufi vénéré à Agra',
    ],
    explanation: 'Mumtaz Mahal mourut en 1631. Détrôné par son fils, Shah Jahan finit ses jours prisonnier du fort d’Agra, la vue posée sur le mausolée blanc.',
  },
  {
    id: 'his_adulte_editorial_07_015',
    question: 'Quelle consigne le médecin Semmelweis imposa-t-il en 1847 à ses étudiants accoucheurs ?',
    answer: 'Se laver les mains avant de toucher les patientes',
    distractors: [
      'Porter un tablier bouilli chaque matin',
      'Aérer les salles entre deux naissances',
      'Raser leur barbe et leurs favoris',
    ],
    explanation: 'Les fièvres mortelles chutèrent aussitôt, mais ses confrères, vexés d’être désignés coupables, le firent taire — Pasteur ne lui donnera raison que vingt ans plus tard.',
  },

  /* ------------------------------------------------------------------ *
   * Sciences, niveau adulte.
   * ------------------------------------------------------------------ */
  {
    id: 'sci_adulte_editorial_03_010',
    // Les quatre choix sont les trois lois de Newton plus la gravitation : la
    // carte ne demande plus « qui ? » mais « laquelle ? », et le mot « inertie »
    // de l'énoncé guide vers la bonne.
    question: 'Que dit la première loi de Newton, celle qu’on nomme le principe d’inertie ?',
    answer: 'Sans force extérieure, un corps garde sa vitesse et sa trajectoire',
    distractors: [
      'Toute action entraîne une réaction opposée et de même force',
      'La force égale la masse multipliée par l’accélération',
      'Deux corps s’attirent selon leurs masses et leur distance',
    ],
    explanation: 'C’est pourquoi une sonde spatiale file pendant des années moteur éteint : rien ne la freine, rien n’a besoin de la pousser.',
  },
  {
    id: 'sci_adulte_complement_091',
    question: 'Quel animal se cache dans le mot « vaccin », forgé lors de la découverte d’Edward Jenner ?',
    answer: 'La vache — sa variole bénigne protégeait de la variole humaine',
    distractors: [
      'Le cheval — son sérum soignait déjà le tétanos',
      'Le mouton — Pasteur vaccina ensuite des troupeaux entiers',
      'La poule — ses œufs incuberont plus tard les vaccins',
    ],
    explanation: 'Jenner avait remarqué que les trayeuses, contaminées au contact des vaches, n’attrapaient jamais la variole : « vacca », la vache en latin, est restée dans le mot.',
  },

  /* ------------------------------------------------------------------ *
   * Art & Littérature, niveau adulte.
   * ------------------------------------------------------------------ */
  {
    id: 'art_adulte_grand_public_001',
    question: 'Que montre « Les Fusillades du 3 mai 1808 », la toile la plus sombre de Goya ?',
    answer: 'Des insurgés madrilènes exécutés par les soldats de Napoléon',
    distractors: [
      'Des déserteurs espagnols fusillés par leur propre armée',
      'Des otages français abattus par la guérilla',
      'Des condamnés de l’Inquisition menés au bûcher',
    ],
    explanation: 'L’homme à la chemise blanche, bras ouverts face aux fusils, a fait de cette toile la mère des images de guerre modernes — Picasso s’en souviendra pour Guernica.',
  },
  {
    id: 'art_adulte_editorial_04_011',
    question: 'Pourquoi la place de l’Arc de Triomphe, à Paris, s’appelle-t-elle place de l’Étoile ?',
    answer: 'Douze avenues y rayonnent comme les branches d’une étoile',
    distractors: [
      'Une étoile de bronze y est scellée sous l’Arc',
      'Napoléon y passait ses troupes en revue à la nuit tombée',
      'Les rois y allumaient un feu la nuit de l’Épiphanie',
    ],
    explanation: 'L’Étoile ne comptait que cinq branches sous Napoléon ; Haussmann en ajouta sept, et la place porte officiellement aujourd’hui le nom de Charles de Gaulle.',
  },
  {
    id: 'art_adulte_editorial_final_001',
    question: 'Quelle tenue, toujours portée aujourd’hui, naît d’une déclaration de Charles II en 1666 ?',
    answer: 'Le costume trois-pièces — veste, gilet et culotte assortis',
    distractors: [
      'Le smoking des soirées',
      'La queue-de-pie des chefs d’orchestre',
      'Le duffel-coat des marins',
    ],
    explanation: 'Le roi voulait affranchir sa cour des modes françaises et vendre la laine anglaise ; Pepys nota dans son journal « une mode qu’il ne changera jamais ».',
  },
  {
    id: 'art_adulte_editorial_05_029',
    question: 'Quel détail des « Époux Arnolfini » émerveille les visiteurs depuis près de six siècles ?',
    answer: 'Un miroir minuscule où le peintre se reflète, signature au mur',
    distractors: [
      'Un chat endormi sous le lit du couple',
      'Une fenêtre ouverte sur Bruges enneigée',
      'Un crâne dissimulé dans les plis de la robe',
    ],
    explanation: 'Au-dessus du miroir, on lit « Jan van Eyck fut ici, 1434 » : le peintre flamand signe comme un témoin paraphe un registre de mariage.',
  },
  {
    id: 'art_adulte_editorial_04_019',
    question: 'Qu’ont perdu les statues de la Grèce antique, que nous admirons aujourd’hui en marbre nu ?',
    answer: 'Leurs couleurs : elles étaient peintes des pieds à la tête',
    distractors: [
      'Leur revêtement de feuilles d’argent',
      'Leurs perruques de cheveux véritables',
      'Leurs drapés de tissu amidonné',
    ],
    explanation: 'Bleu égyptien, ocres et cinabre subsistent au microscope. Le blanc « classique » est une illusion de la Renaissance, qui déterrait des marbres déjà délavés.',
  },
  {
    id: 'art_adulte_editorial_07_001',
    question: 'Quel gros chien blanc de la BD belge porte le nom d’un os de l’avant-bras ?',
    answer: 'Cubitus',
    distractors: ['Bill', 'Idéfix', 'Rantanplan'],
    explanation: 'Créé par Dupa dans le journal Tintin, il philosophe aux côtés du vieux Sémaphore — et l’os, lui, s’appelle désormais « ulna » dans les manuels d’anatomie.',
  },

  /* ------------------------------------------------------------------ *
   * Cinéma & Séries, niveau adulte.
   * ------------------------------------------------------------------ */
  {
    id: 'cin_adulte_editorial_018',
    question: 'Dans quelle Espagne la petite Ofelia rencontre-t-elle le faune du Labyrinthe de Pan ?',
    answer: 'L’Espagne franquiste de 1944, qui traque ses derniers maquisards',
    distractors: [
      'L’Espagne des rois catholiques et de l’Inquisition',
      'L’Espagne napoléonienne des guérillas',
      'L’Espagne des années 1980, libérée de la censure',
    ],
    explanation: 'Guillermo del Toro y tresse conte de fées et guerre bien réelle : son monstre aux yeux plantés dans les paumes est devenu une icône du fantastique.',
  },
  {
    id: 'cin_adulte_editorial_04_025',
    question: 'Quelle audace de construction a fait de Pulp Fiction la sensation de Cannes en 1994 ?',
    answer: 'Ses histoires s’entrecroisent hors de l’ordre chronologique',
    distractors: [
      'Un unique plan-séquence de deux heures et demie',
      'Un noir et blanc intégral, hors une robe rouge',
      'Une improvisation totale, sans scénario écrit',
    ],
    explanation: 'Le film s’ouvre et se referme sur le même braquage de cafétéria ; Tarantino, ancien vendeur de vidéoclub, y recycle tout ce que le cinéma lui avait appris.',
  },
  {
    id: 'cin_adulte_editorial_04_011',
    question: 'Quelle prouesse Jean-Claude Van Damme réalise-t-il en 2013 entre deux camions en marche ?',
    answer: 'Un grand écart, un pied posé sur chaque rétroviseur',
    distractors: [
      'Un saut périlleux d’une cabine à l’autre',
      'Une traversée sur un fil tendu entre les remorques',
      'Une série de coups de pied retournés sur les toits',
    ],
    explanation: 'La publicité « Epic Split » de Volvo, tournée à l’aube et sans trucage, fut vue cent millions de fois en quelques semaines — l’acteur avait cinquante-trois ans.',
  },
  {
    id: 'cin_adulte_editorial_02_036',
    question: 'Quel instrument le héros de Whiplash travaille-t-il jusqu’au sang, sous les cris de son professeur ?',
    answer: 'La batterie',
    distractors: ['Le piano', 'La trompette', 'La contrebasse'],
    explanation: 'Miles Teller tenait vraiment les baguettes ; J. K. Simmons, lui, a gagné un Oscar pour son professeur tortionnaire.',
  },
  {
    id: 'cin_adulte_editorial_034',
    question: 'Qui était le vrai « Lawrence d’Arabie », que David Lean porta à l’écran en 1962 ?',
    answer: 'Un officier britannique rallié à la révolte arabe de 1916',
    distractors: [
      'Un archéologue français converti à l’islam',
      'Un aventurier américain marchand de chevaux',
      'Un diplomate ottoman passé aux Anglais',
    ],
    explanation: 'T. E. Lawrence fut d’abord archéologue au Proche-Orient ; Peter O’Toole, qui l’incarne, fut nommé huit fois aux Oscars sans jamais en gagner un seul.',
  },
  {
    id: 'cin_adulte_editorial_05_024',
    question: 'Quelle audace visuelle a marqué « Mommy », du Québécois Xavier Dolan ?',
    answer: 'Une image carrée, qui s’élargit aux rares instants de liberté',
    distractors: [
      'Une image renversée pendant les disputes',
      'Un écran coupé en deux, la mère d’un côté, le fils de l’autre',
      'Un noir et blanc qui se colore au dénouement',
    ],
    explanation: 'Le héros écarte lui-même les bords du cadre avec les mains, lancé en skate sur sa rue : l’écran respire tant que dure l’embellie, puis se referme.',
  },
  {
    id: 'cinema_adulte_editorial_final_02_026',
    question: 'Pourquoi dit-on d’un film achevé qu’il est « mis en boîte » ?',
    answer: 'Les bobines de pellicule se rangeaient dans des boîtes rondes',
    distractors: [
      'Les caméras se verrouillaient dans des coffres scellés',
      'Les décors partaient en caisses vers le studio suivant',
      'La recette du tournage se comptait dans une cassette',
    ],
    explanation: 'Ces boîtes plates en métal protégeaient un négatif parfois redoutable : le film nitrate des débuts pouvait brûler même sous l’eau.',
  },

  /* ------------------------------------------------------------------ *
   * Pop Culture & Musique, niveau adulte.
   * ------------------------------------------------------------------ */
  {
    id: 'pop_adulte_editorial_04_003',
    // Le fait était bon, les distracteurs cassés : face à Madonna, Daft Punk et
    // Adamo, « quelle chanteuse belge » éliminait tout le monde d'office.
    question: 'Quelle chanteuse belge interprète « Balance ton quoi » ?',
    answer: 'Angèle',
    distractors: ['Blanche', 'Alice on the Roof', 'Lous and the Yakuza'],
    explanation: 'Parue sur l’album Brol, la chanson est devenue un hymne féministe repris dans les manifestations francophones.',
  },
  {
    id: 'pop_adulte_editorial_03_010',
    question: 'Quel prodige de la Motown, aveugle depuis ses premiers jours, a enregistré « Superstition » ?',
    answer: 'Stevie Wonder',
    distractors: ['Curtis Mayfield', 'Isaac Hayes', 'Marvin Gaye'],
    explanation: 'Signé à onze ans sous le nom de Little Stevie Wonder, il joue lui-même presque tous les instruments de « Superstition », batterie comprise.',
  },
  {
    id: 'pop_adulte_complement_007',
    question: 'Quel argot, qui glisse la syllabe « av » au cœur des mots, a donné son titre à une chanson de Gainsbourg ?',
    answer: 'Le javanais',
    distractors: ['Le verlan', 'Le louchébem', 'L’argot des Halles'],
    explanation: '« J’avoue, j’en ai bavé, pas vous ? » : La Javanaise sème le son « av » dans chaque vers, et son titre salue aussi la java des bals musette.',
  },
  {
    id: 'pop_adulte_complement_008',
    question: 'D’où vient le titre des « Copains d’abord », que Brassens écrivit pour un film d’Yves Robert ?',
    answer: 'C’est le nom d’un bateau — jeu de mots sur « copains de bord »',
    distractors: [
      'C’est la devise d’un régiment dissous',
      'C’est le cri des jouteurs sétois',
      'C’est l’enseigne d’un café de Montmartre',
    ],
    explanation: 'Brassens aima tant ce navire de chanson qu’il baptisa ainsi son propre bateau, sur l’étang de Thau — la chanson, elle, a survécu au film.',
  },
  {
    id: 'pop_adulte_francophone_007',
    question: 'Qu’était un « mistral gagnant », que Renaud regrette dans sa chanson la plus aimée ?',
    answer: 'Un bonbon en poudre, gratuit quand le sachet était marqué',
    distractors: [
      'Un billet de la Loterie nationale',
      'Un vent qui faisait gagner les régates',
      'Un flipper des cafés du Nord',
    ],
    explanation: 'La poudre s’aspirait par une paille de réglisse ; la confiserie disparut dans les années 1970, et Renaud écrivit la chanson pour sa fille Lolita.',
  },

  /* ------------------------------------------------------------------ *
   * Histoire, niveau enfant : deux cartes sans prise pour un enfant d'ici.
   * ------------------------------------------------------------------ */
  {
    id: 'his_103',
    // « Qui a été le premier président des États-Unis ? » sans autre indice :
    // un enfant belge sait ou tire au sort. Le billet donne la prise, et les
    // trois distracteurs figurent eux aussi sur de vrais billets.
    question: 'Quel premier président des États-Unis voit-on sur le billet de 1 dollar ?',
    answer: 'George Washington',
    distractors: ['Abraham Lincoln', 'Thomas Jefferson', 'Benjamin Franklin'],
    explanation: 'La capitale du pays porte aussi son nom, comme un État de la côte ouest — pas mal, pour un ancien planteur de Virginie !',
  },
  {
    id: 'his_062',
    // Newton et Léonard de Vinci comme distracteurs d'une invention de 1876 :
    // l'anachronisme se voyait. Les remplaçants sont de la bonne époque.
    question: 'Quel inventeur a fait breveter le téléphone en 1876 ?',
    answer: 'Alexander Graham Bell',
    distractors: ['Thomas Edison', 'Gustave Eiffel', 'Les frères Lumière'],
    explanation: 'La toute première phrase au téléphone fut pour son assistant : « M. Watson, venez ici, j’ai besoin de vous ! »',
  },
];

export function applyCheminDeRaisonnementRewrites(questions: Question[]): Question[] {
  return applyCardRewrites(questions, REWRITES);
}
