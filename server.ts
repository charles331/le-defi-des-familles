import express from 'express';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { QUESTIONS_DATABASE } from './src/data/questions.js';
import { activeThemeKeys } from './src/server/questionSelection.js';
import {
  normalize as normalizeText,
} from './src/data/questionRules.js';
import { checkStore, loadRooms, startRoomPersistence, saveRooms, saveRoomsSync, ROOM_STORE_PATH } from './roomStore.js';
import {
  KnownFactIndex,
  answerKeyOf,
  assembleGeneratedPack,
  describeRejections,
  parseGeneratedCandidates,
} from './src/server/packAssembly.js';
import { previewOrigin, withAbsolutePreviewImages } from './src/server/previewMeta.js';
import { MAX_THEME_NAME_LENGTH, createQuestionGenerator, sanitizeThemeName } from './src/server/questionGenerator.js';
import {
  DailyGenerationBudget,
  SlidingWindowQuota,
  dailyBudgetStorePath,
  ipQuotaKey,
  parseDailyLimit,
} from './src/server/generationQuota.js';
import { finalErrorHandler, securityHeaders } from './src/server/httpSecurity.js';
import { negotiateEncoding } from './src/server/assetEncoding.js';
import { DEFAULT_GENERATED_PACK_COUNT } from './src/config/generatedPack.js';
import {
  MAX_CUSTOM_PACKS_PER_ROOM,
  MAX_CUSTOM_QUESTIONS_PER_ROOM,
  Room,
  attachGameSocketServer,
  shuffled,
} from './src/server/gameSocketServer.js';
import { parsePublicOrigins, safeTokenEquals } from './src/server/socketGuards.js';
import {
  Question,
} from './src/types.js';

/**
 * Le mode développement ne s'active que sur demande explicite (`npm run dev`
 * pose NODE_ENV=development). L'inverse prévalait : sans la variable — oubliée
 * sur Railway —, le serveur de production montait le middleware Vite, qui sert
 * le code source, et Express renvoyait ses piles d'appel aux clients. Le défaut
 * est posé avant `express()`, qui lit NODE_ENV à sa création.
 */
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT) || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders({ production: !isDevelopment }));
// La seule route JSON reçoit un nom de thème et un nombre : 8 ko suffisent
// largement, et bornent ce qu'un inconnu fait analyser au serveur.
app.use(express.json({ limit: '8kb' }));

// --- AI DYNAMIC PACK GENERATOR ---

/**
 * Ce que la banque rédigée sait déjà, indexé une seule fois : un pack généré ne
 * doit ni recopier une carte officielle, ni reposer le même fait autrement.
 */
let knownFacts: KnownFactIndex | null = null;
function getKnownFacts(): KnownFactIndex {
  if (!knownFacts) {
    const texts = new Set(QUESTIONS_DATABASE.map(q => normalizeText(q.question)));
    const questionsByAnswer = new Map<string, string[]>();
    for (const question of QUESTIONS_DATABASE) {
      const key = answerKeyOf(question);
      const group = questionsByAnswer.get(key);
      if (group) group.push(question.question);
      else questionsByAnswer.set(key, [question.question]);
    }
    knownFacts = {
      hasQuestionText: (normalizedQuestion: string) => texts.has(normalizedQuestion),
      questionsSharingAnswer: (answerKey: string) => questionsByAnswer.get(answerKey) ?? [],
    };
  }
  return knownFacts;
}

/**
 * Les lots partent en parallèle avec le même thème : sans consigne propre,
 * chacun ouvre par les mêmes évidences et les doublons inter-lots partent au
 * rebut (« fait déjà posé sous une autre formulation »). Un angle par lot
 * répartit le terrain d'avance.
 */
const GENERATION_BATCH_ANGLES = [
  'les personnages, créatures et figures emblématiques',
  'les lieux, objets et décors',
  'les dates, les événements et la chronologie',
  'les œuvres, les épisodes et les intrigues',
  'les coulisses, les créateurs et la fabrication',
  'les chiffres, les records et les comparaisons',
];

const GENERATION_BATCH_SIZE = 15;
const GENERATION_MAX_COUNT = 60;
// Les contrôles éditoriaux rejettent une partie des cartes : on en demande
// davantage pour livrer quand même le nombre promis à l'organisateur.
const GENERATION_OVERSHOOT = 1.5;
const GENERATION_ATTEMPT_CAP = 90;
const GENERATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_GENERATIONS_PER_IP = 6;
const generationQuotaByIp = new SlidingWindowQuota(MAX_GENERATIONS_PER_IP, GENERATION_WINDOW_MS);
const dailyGenerationBudget = new DailyGenerationBudget(
  parseDailyLimit(process.env.MAX_GENERATIONS_PER_DAY),
  dailyBudgetStorePath(),
);
/**
 * Tentatives par salon. Le plafond suit celui des thèmes (MAX_CUSTOM_PACKS_PER_ROOM),
 * doublé pour qu'une génération ratée — thème trop vague, fournisseur saturé —
 * ne coûte pas un thème à la famille. Une `WeakMap` : le compteur disparaît
 * avec le salon.
 */
const generationAttemptsByRoom = new WeakMap<object, number>();
const generationsInProgress = new Set<string>();
// Jamais le message d'un fournisseur ni le nom d'une variable de clé : le
// détail part dans les journaux, le client ne reçoit que ceci.
const GENERATION_UNAVAILABLE = 'La création de thèmes est indisponible pour le moment.';
const GENERATION_FAILED = 'La génération a échoué, réessayez.';

function maxGenerationAttemptsPerRoom(): number {
  return 2 * MAX_CUSTOM_PACKS_PER_ROOM;
}

function samePackName(left: string, right: string): boolean {
  return left.toLowerCase().trim() === right.toLowerCase().trim();
}

/**
 * Le salon peut-il encore recevoir ce pack ? Vérifié avant d'appeler le
 * fournisseur — inutile de payer une génération qui serait refusée —, puis de
 * nouveau à l'ajout.
 */
function customPackRefusal(room: Room, themeName: string, questionCount: number): string | null {
  const packs = room.gameState.customPacks ?? [];
  const currentCount = packs.reduce((total, pack) => total + pack.questions.length, 0);
  if (currentCount + questionCount > MAX_CUSTOM_QUESTIONS_PER_ROOM) {
    return 'Ce salon a atteint sa limite de questions personnalisées.';
  }
  const existing = packs.some(pack => samePackName(pack.name, themeName));
  if (!existing && packs.length >= MAX_CUSTOM_PACKS_PER_ROOM) {
    return 'Ce salon a atteint sa limite de thèmes personnalisés.';
  }
  return null;
}

/**
 * Range un pack généré dans le salon. C'était le rôle de l'événement socket
 * `add-custom-pack`, qui recevait les questions **du client** : n'importe quel
 * organisateur pouvait y glisser des cartes arbitraires, montrées ensuite à des
 * enfants. Le pack ne quitte plus le serveur entre sa validation et son ajout.
 */
function addGeneratedPackToRoom(room: Room, themeName: string, questions: Question[]): string | null {
  const refusal = customPackRefusal(room, themeName, questions.length);
  if (refusal) return refusal;
  if (!room.gameState.customPacks) room.gameState.customPacks = [];

  const existing = room.gameState.customPacks.find(pack => samePackName(pack.name, themeName));
  if (existing) existing.questions.push(...questions);
  else room.gameState.customPacks.push({ name: themeName, questions });

  // Le thème fraîchement généré rejoint les thèmes actifs, sans désactiver
  // les autres : la table peut jouer avec ses trois thèmes à la fois.
  if (!activeThemeKeys(room.settings).has(themeName.toLowerCase().trim())) {
    const activeNames = [
      ...(room.settings.customThemePackNames ?? []),
      ...(room.settings.customThemePackName ? [room.settings.customThemePackName] : []),
      themeName,
    ];
    room.settings.customThemePackNames = activeNames;
    room.settings.customThemePackName = undefined;
    room.gameState.settings.customThemePackNames = activeNames;
    room.gameState.settings.customThemePackName = undefined;
  }

  room.gameState.questionsPool = [...questions, ...room.gameState.questionsPool];
  return null;
}

app.post('/api/generate-pack', async (req, res) => {
  const roomCode = String(req.header('x-room-code') ?? '').toUpperCase().trim();
  const hostToken = req.header('x-host-token');
  const room = rooms.get(roomCode);
  if (!room || !safeTokenEquals(hostToken, room.generationToken)) {
    return res.status(403).json({ error: 'Génération réservée à l’organisateur du salon.' });
  }

  // La requête est validée avant de toucher aux quotas : une faute de frappe
  // ne doit pas consommer une génération.
  const { themeName, count = DEFAULT_GENERATED_PACK_COUNT } = req.body ?? {};
  const cleanTheme = typeof themeName === 'string' ? sanitizeThemeName(themeName) : '';
  if (cleanTheme.length < 2 || themeName.length > MAX_THEME_NAME_LENGTH) {
    return res.status(400).json({ error: `Nom de thème requis (2 à ${MAX_THEME_NAME_LENGTH} caractères).` });
  }
  const requestedCount = Math.min(
    Math.max(Number(count) || DEFAULT_GENERATED_PACK_COUNT, 5),
    GENERATION_MAX_COUNT,
  );

  let generator: ReturnType<typeof createQuestionGenerator>;
  try {
    generator = createQuestionGenerator();
  } catch (err) {
    console.error('Configuration du générateur IA invalide:', err instanceof Error ? err.message : err);
    return res.status(503).json({ error: GENERATION_UNAVAILABLE });
  }

  if (generationsInProgress.has(roomCode)) {
    return res.status(409).json({ error: 'Une génération est déjà en cours pour ce salon.' });
  }
  const refusal = customPackRefusal(room, cleanTheme, requestedCount);
  if (refusal) return res.status(409).json({ error: refusal });

  const roomAttempts = generationAttemptsByRoom.get(room) ?? 0;
  if (roomAttempts >= maxGenerationAttemptsPerRoom()) {
    return res.status(429).json({ error: 'Ce salon a atteint sa limite de générations.' });
  }
  if (!generationQuotaByIp.consume(ipQuotaKey(req.ip || req.socket.remoteAddress))) {
    return res.status(429).json({ error: 'Trop de générations récentes. Réessayez dans une heure.' });
  }
  // Dernier étage, le plus large : il borne la facture quel que soit le nombre
  // de salons et d'adresses en jeu.
  if (!dailyGenerationBudget.tryConsume()) {
    console.warn(`[Pack IA] Budget du jour épuisé (${dailyGenerationBudget.limit} générations).`);
    return res.status(503).json({ error: 'La création de thèmes a atteint sa limite du jour. Réessayez demain.' });
  }

  generationAttemptsByRoom.set(room, roomAttempts + 1);
  generationsInProgress.add(roomCode);
  try {
    const attemptCount = Math.min(
      Math.ceil(requestedCount * GENERATION_OVERSHOOT),
      GENERATION_ATTEMPT_CAP,
    );

    // Split the generation into parallel batches: small batches are far more
    // reliable than a single large one, and one failed batch doesn't sink the pack.
    const batchSizes: number[] = [];
    for (let remaining = attemptCount; remaining > 0; remaining -= GENERATION_BATCH_SIZE) {
      batchSizes.push(Math.min(GENERATION_BATCH_SIZE, remaining));
    }

    const batchResults = await Promise.allSettled(
      batchSizes.map(async (size, index) => {
        const angle = GENERATION_BATCH_ANGLES[index % GENERATION_BATCH_ANGLES.length];
        try {
          return await generator.generateBatch(cleanTheme, size, angle);
        } catch (err) {
          console.warn(
            `[Pack IA/${generator.provider}] Lot en échec, nouvelle tentative:`,
            err instanceof Error ? err.message : err,
          );
          return await generator.generateBatch(cleanTheme, size, angle);
        }
      })
    );

    const rawQuestions = batchResults
      .filter((r): r is PromiseFulfilledResult<unknown[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);

    if (rawQuestions.length === 0) {
      const firstError = batchResults.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      console.error(`[Pack IA/${generator.provider}] Tous les lots ont échoué:`, firstError?.reason);
      return res.status(502).json({ error: GENERATION_FAILED });
    }

    // Forme stricte d'abord (types, longueurs, bornes de l'index), puis contrôle
    // éditorial complet : ce sont les règles de l'ADR 0001, celles que
    // `npm run audit:questions` applique à la banque rédigée. Une carte non
    // conforme est écartée, jamais rafistolée.
    const { candidates, malformed } = parseGeneratedCandidates(rawQuestions, cleanTheme);
    const pack = assembleGeneratedPack(candidates, requestedCount, getKnownFacts());
    if (malformed > 0) pack.rejections.set('carte mal formée', malformed);

    if (pack.questions.length === 0) {
      console.warn(`[Pack IA] "${cleanTheme}" : aucune carte conforme — ${describeRejections(pack.rejections)}`);
      return res.status(422).json({ error: 'Aucune question conforme générée, réessayez avec un thème plus précis.' });
    }

    // Le salon a pu fermer pendant la minute de génération.
    if (rooms.get(roomCode) !== room) {
      return res.status(410).json({ error: 'Le salon a été fermé pendant la génération.' });
    }
    const addRefusal = addGeneratedPackToRoom(room, cleanTheme, pack.questions);
    if (addRefusal) return res.status(409).json({ error: addRefusal });
    emitGameState(room);

    console.log(
      `[Pack IA/${generator.provider}:${generator.model}] "${cleanTheme}" : ${pack.questions.length} question(s) retenue(s)`
        + ` sur ${pack.examined + malformed} générée(s) pour le salon ${roomCode} — rejets : ${describeRejections(pack.rejections)}`,
    );
    // Ni les cartes ni leurs réponses : l'organisateur joue aussi, et l'interface
    // n'a besoin que du nom et du compte.
    return res.json({
      success: true,
      themeName: cleanTheme,
      count: pack.questions.length,
      requested: requestedCount,
      examined: pack.examined + malformed,
    });
  } catch (err: unknown) {
    console.error('Erreur génération IA:', err);
    return res.status(500).json({ error: GENERATION_FAILED });
  } finally {
    generationsInProgress.delete(roomCode);
  }
});

// --- MULTIPLAYER ROOMS STORE ---
// Les parties survivent au redémarrage : sans cela, un redéploiement, un
// plantage ou un simple rechargement de tsx en développement effaçait toutes
// les salles en cours. Les salons eux-mêmes, et tout le jeu en temps réel,
// vivent dans `src/server/gameSocketServer.ts`.
const rooms: Map<string, Room> = loadRooms(QUESTIONS_DATABASE, shuffled);
const { io, emitGameState } = attachGameSocketServer(httpServer, {
  rooms,
  persist: () => saveRooms(rooms),
  publicOrigins: parsePublicOrigins(process.env.PUBLIC_ORIGIN),
});

// Dernier filet. Les handlers de socket.io attrapent déjà leurs propres
// exceptions ; ce qui arrive encore ici est un bug ailleurs, et l'état du
// processus n'est plus sûr. On écrit les parties tant qu'on le peut, puis on
// s'arrête : Railway relance le service, et le rechargement revalide chaque
// salon. Avant, le processus mourait sans rien écrire — trois secondes de
// partie perdues pour toutes les tables.
process.on('uncaughtException', (error) => {
  console.error('❌ Exception non rattrapée, sauvegarde puis arrêt :', error);
  try {
    saveRoomsSync(rooms);
  } finally {
    process.exit(1);
  }
});
// Une promesse rejetée sans gestionnaire ne compromet pas l'état : on la
// journalise et on continue, au lieu du plantage par défaut de Node.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Promesse rejetée sans gestionnaire :', reason);
});


// Vite & Static file serving
async function startServer() {
  if (isDevelopment) {
    // Import dynamique : en production, Vite n'est ni chargé ni joignable.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    // `dist/` ne contient plus que le client : le bundle serveur et sa source
    // map — toute la banque de questions, réponses comprises — sont construits
    // dans `build/`, hors de ce dossier servi tel quel.
    const distPath = path.join(process.cwd(), 'dist');
    const assetsPath = path.join(distPath, 'assets');
    const contentTypes: Record<string, string> = {
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    };

    // Vite filenames are content-hashed. Serve the precompressed variant and
    // cache it for a year; a future deployment gets a new filename.
    // Express 5 (path-to-regexp 8) refuse le joker nu `*` : il se nomme.
    app.get('/assets/{*asset}', (req, res, next) => {
      // Posé avant tout choix : la réponse dépend du codage accepté, y compris
      // quand on retombe sur le fichier d'origine. Sans cela, un cache partagé
      // pouvait resservir du Brotli à un client qui ne le lit pas.
      res.setHeader('Vary', 'Accept-Encoding');
      const relativeAsset = req.path.slice('/assets/'.length);
      const originalPath = path.resolve(assetsPath, relativeAsset);
      if (!originalPath.startsWith(`${assetsPath}${path.sep}`)) return next();

      const encoding = negotiateEncoding(req.header('accept-encoding'));
      const compressedPath = encoding === 'br'
        ? `${originalPath}.br`
        : encoding === 'gzip'
          ? `${originalPath}.gz`
          : originalPath;

      if (!existsSync(compressedPath)) return next();
      const contentType = contentTypes[path.extname(originalPath)];
      if (contentType) res.setHeader('Content-Type', contentType);
      if (encoding) res.setHeader('Content-Encoding', encoding);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(compressedPath);
    });

    app.use(express.static(distPath, {
      index: false,
      setHeaders: (res, filePath) => {
        const isHashedAsset = filePath.startsWith(`${assetsPath}${path.sep}`);
        res.setHeader(
          'Cache-Control',
          isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }));
    const indexTemplate = readFileSync(path.join(distPath, 'index.html'), 'utf-8');
    // Une route d'API inconnue, ou un fichier absent (`/server.cjs`, une
    // `.map`…), répond 404 au lieu de la page du jeu : un 200 laissait croire
    // que le fichier existait, et masquait les liens cassés.
    app.all('/api/{*route}', (_req, res) => {
      res.status(404).json({ error: 'Ressource introuvable.' });
    });
    app.get('/{*page}', (req, res) => {
      if (path.extname(req.path)) {
        res.status(404).type('text/plain; charset=utf-8').send('Fichier introuvable.');
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(withAbsolutePreviewImages(indexTemplate, previewOrigin(req)));
    });
  }
  app.use(finalErrorHandler);

  checkStore();
  // Après la sauvegarde des parties, on ferme proprement : socket.io prévient
  // les joueurs (qui se reconnecteront au nouveau conteneur) et le serveur HTTP
  // cesse d'accepter des requêtes au lieu d'être coupé au milieu d'une réponse.
  startRoomPersistence(rooms, undefined, () => new Promise<void>((resolve) => {
    // `io.close` ferme aussi le serveur HTTP auquel il est attaché.
    io.close(() => resolve());
    httpServer.closeIdleConnections?.();
  }));

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Serveur Le Défi des Familles en ligne sur http://0.0.0.0:${PORT}`);
    console.log(`💾 Parties sauvegardées dans ${ROOM_STORE_PATH}`);
  });
}

startServer().catch((error) => {
  // Sans ce filet, un échec au démarrage (dist/ absent, port pris…) n'était
  // qu'un rejet de promesse non géré : selon la version de Node, un processus
  // qui reste en vie sans rien servir.
  console.error('❌ Le serveur n’a pas pu démarrer :', error);
  process.exit(1);
});
