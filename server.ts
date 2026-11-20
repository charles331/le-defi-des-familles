import express from 'express';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { createServer as createViteServer } from 'vite';
import { QUESTIONS_DATABASE } from './src/data/questions.js';
import { normalizeCategoryId } from './src/data/categories.js';
import {
  normalize as normalizeText,
} from './src/data/questionRules.js';
import { checkStore, loadRooms, startRoomPersistence, saveRooms, saveRoomsSync, ROOM_STORE_PATH } from './roomStore.js';
import {
  KnownFactIndex,
  answerKeyOf,
  assembleGeneratedPack,
  describeRejections,
} from './src/server/packAssembly.js';
import { previewOrigin, withAbsolutePreviewImages } from './src/server/previewMeta.js';
import { createQuestionGenerator } from './src/server/questionGenerator.js';
import { DEFAULT_GENERATED_PACK_COUNT } from './src/config/generatedPack.js';
import { Room, attachGameSocketServer, shuffled } from './src/server/gameSocketServer.js';
import {
  Question,
  DifficultyLevel
} from './src/types.js';

const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT) || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// --- AI DYNAMIC PACK GENERATOR ---

function normalizeDifficulty(raw: unknown): DifficultyLevel {
  const clean = String(raw ?? '').toLowerCase().trim();
  if (clean.includes('enf') || clean.includes('facile') || clean.includes('easy')) return 'enfant';
  if (clean.includes('ado') || clean.includes('moyen') || clean.includes('medium')) return 'ado';
  return 'adulte';
}

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
const generationAttempts = new Map<string, number[]>();
const generationsInProgress = new Set<string>();

function safeTokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function consumeGenerationQuota(key: string, now = Date.now()): boolean {
  const activeAttempts = (generationAttempts.get(key) ?? [])
    .filter(timestamp => now - timestamp < GENERATION_WINDOW_MS);
  if (activeAttempts.length >= MAX_GENERATIONS_PER_IP) {
    generationAttempts.set(key, activeAttempts);
    return false;
  }
  activeAttempts.push(now);
  generationAttempts.set(key, activeAttempts);
  return true;
}

app.post('/api/generate-pack', async (req, res) => {
  const roomCode = String(req.header('x-room-code') ?? '').toUpperCase().trim();
  const hostToken = req.header('x-host-token');
  const room = rooms.get(roomCode);
  if (!room || !safeTokenEquals(hostToken, room.generationToken)) {
    return res.status(403).json({ error: 'Génération réservée à l’organisateur du salon.' });
  }

  let generator: ReturnType<typeof createQuestionGenerator>;
  try {
    generator = createQuestionGenerator();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Configuration IA invalide.';
    console.error('Configuration du générateur IA invalide:', errorMessage);
    return res.status(503).json({ error: errorMessage });
  }

  const sourceKey = req.ip || req.socket.remoteAddress || 'unknown';
  if (!consumeGenerationQuota(sourceKey)) {
    return res.status(429).json({ error: 'Trop de générations récentes. Réessayez dans une heure.' });
  }
  if (generationsInProgress.has(roomCode)) {
    return res.status(409).json({ error: 'Une génération est déjà en cours pour ce salon.' });
  }

  generationsInProgress.add(roomCode);
  try {
    const { themeName, count = DEFAULT_GENERATED_PACK_COUNT } = req.body;
    if (!themeName || typeof themeName !== 'string' || themeName.trim().length < 2 || themeName.length > 100) {
      return res.status(400).json({ error: 'Nom de thème requis (2 à 100 caractères).' });
    }

    const cleanTheme = themeName.trim();
    const requestedCount = Math.min(
      Math.max(Number(count) || DEFAULT_GENERATED_PACK_COUNT, 5),
      GENERATION_MAX_COUNT,
    );
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
      .filter((r): r is PromiseFulfilledResult<any[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);

    if (rawQuestions.length === 0) {
      const firstError = batchResults.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw new Error(firstError?.reason instanceof Error ? firstError.reason.message : 'La génération a échoué, réessayez.');
    }

    // Mise en forme, puis contrôle éditorial complet : ce sont les règles de
    // l'ADR 0001, celles que `npm run audit:questions` applique à la banque
    // rédigée. Une carte non conforme est écartée, jamais rafistolée.
    const stamp = Date.now();
    const candidates: Question[] = rawQuestions
      .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options))
      .map((q, idx) => ({
        id: `gen_${stamp}_${idx}`,
        categoryId: normalizeCategoryId(q.categoryId),
        question: q.question.trim(),
        options: q.options.map((o: unknown) => String(o ?? '').trim()),
        correctAnswerIndex: q.correctAnswerIndex,
        explanation: typeof q.explanation === 'string' ? q.explanation.trim() : undefined,
        difficulty: normalizeDifficulty(q.difficulty),
        themePack: cleanTheme
      }));

    const pack = assembleGeneratedPack(candidates, requestedCount, getKnownFacts());

    if (pack.questions.length === 0) {
      throw new Error('Aucune question conforme générée, réessayez avec un thème plus précis.');
    }

    console.log(
      `[Pack IA/${generator.provider}:${generator.model}] "${cleanTheme}" : ${pack.questions.length} question(s) retenue(s)`
        + ` sur ${pack.examined} générée(s) — rejets : ${describeRejections(pack.rejections)}`,
    );
    return res.json({
      success: true,
      questions: pack.questions,
      themeName: cleanTheme,
      requested: requestedCount,
      examined: pack.examined,
    });
  } catch (err: unknown) {
    console.error('Erreur génération IA:', err);
    const errorMessage = err instanceof Error ? err.message : 'Erreur lors de la génération du thème';
    return res.status(500).json({ error: errorMessage });
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
attachGameSocketServer(httpServer, { rooms, persist: () => saveRooms(rooms) });

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
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
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
    app.get('/assets/*', (req, res, next) => {
      const relativeAsset = req.path.slice('/assets/'.length);
      const originalPath = path.resolve(assetsPath, relativeAsset);
      if (!originalPath.startsWith(`${assetsPath}${path.sep}`)) return next();

      const accepted = req.header('accept-encoding') ?? '';
      const encoding = accepted.includes('br') ? 'br' : accepted.includes('gzip') ? 'gzip' : null;
      const compressedPath = encoding === 'br'
        ? `${originalPath}.br`
        : encoding === 'gzip'
          ? `${originalPath}.gz`
          : originalPath;

      if (!existsSync(compressedPath)) return next();
      const contentType = contentTypes[path.extname(originalPath)];
      if (contentType) res.setHeader('Content-Type', contentType);
      if (encoding) {
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Vary', 'Accept-Encoding');
      }
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
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(withAbsolutePreviewImages(indexTemplate, previewOrigin(req)));
    });
  }

  checkStore();
  startRoomPersistence(rooms);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Serveur Le Défi des Familles en ligne sur http://0.0.0.0:${PORT}`);
    console.log(`💾 Parties sauvegardées dans ${ROOM_STORE_PATH}`);
  });
}

startServer();
