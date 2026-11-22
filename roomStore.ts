import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'fs';
import { mkdir, open, rename, rm } from 'fs/promises';
import { randomBytes } from 'crypto';
import path from 'path';
import { GameSettings, GameState, Player, Question } from './src/types.js';
import {
  isKnownCategory,
  isPlainObject,
  reviveStoredPack,
  reviveStoredPlayer,
  reviveStoredSettings,
} from './src/server/inputValidation.js';
import { normalizeRoomCode } from './src/server/roomCodes.js';

/**
 * Persistance des parties sans base de données.
 *
 * Les parties vivaient uniquement dans une `Map` en mémoire : tout redémarrage
 * du serveur les effaçait, qu'il vienne d'un redéploiement, d'un plantage ou du
 * rechargement automatique de `tsx` en développement.
 *
 * Deux précautions dictent la forme de ce module.
 *
 * 1. `gameState.questionsPool` est une copie complète de la banque de questions
 *    pour chaque salle, soit près de 2 Mo une fois sérialisée. On ne l'écrit
 *    jamais : elle est reconstruite au chargement à partir de la banque et des
 *    paquets personnalisés de la salle. Seul `usedQuestionIds` compte vraiment,
 *    puisque le tirage est aléatoire parmi les questions non utilisées.
 * 2. Sur un hébergement comme Railway, le système de fichiers est éphémère. Le
 *    chemin d'écriture est donc configurable par `DATA_DIR` : monté sur un
 *    volume, l'état survit aux redéploiements ; sans volume, il survit au moins
 *    aux redémarrages du processus. Si le dossier n'est pas accessible en
 *    écriture, le serveur continue de fonctionner en mémoire seule.
 */

/** Structurellement identique au `Room` de server.ts, sans l'importer. */
export interface PersistableRoom {
  code: string;
  hostSocketId: string;
  generationToken: string;
  reconnectTokens: Map<string, string>;
  settings: GameSettings;
  gameState: GameState;
  sockets: Map<string, Player>;
  createdAt: number;
  lastActivityAt: number;
  emptySince: number | null;
  hostDisconnectedAt: number | null;
}

/** Ce qui part réellement sur le disque : tout sauf les sockets et le pool. */
interface StoredRoom {
  code: string;
  hostSocketId: string;
  generationToken?: string;
  reconnectTokens?: Record<string, string>;
  settings: GameSettings;
  createdAt: number;
  lastActivityAt: number;
  emptySince: number | null;
  hostDisconnectedAt: number | null;
  gameState: Omit<GameState, 'questionsPool'>;
}

interface StoredFile {
  version: 1;
  savedAt: number;
  rooms: StoredRoom[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const STORE_PATH = path.join(DATA_DIR, 'rooms.json');
/**
 * Un fichier temporaire par écriture. Un nom fixe se partageait entre
 * l'écriture périodique et celle de l'arrêt (ou celle d'un second processus
 * pendant un redéploiement) : l'une pouvait renommer le fichier que l'autre
 * était en train d'écrire.
 */
const tempPath = (): string => `${STORE_PATH}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

/** Une salle plus vieille que cela n'est pas rechargée : elle serait balayée. */
const MAX_RESTORE_AGE_MS = 12 * 60 * 60 * 1000;
/** Même plafond que `MAX_CUSTOM_PACKS_PER_ROOM` côté jeu. */
const MAX_STORED_PACKS = 3;

let lastWritten = '';
let disabled = false;
let writing = false;
let pending: Map<string, PersistableRoom> | null = null;

function warnOnce(message: string, error: unknown): void {
  if (disabled) return;
  disabled = true;
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`⚠️  ${message} (${detail})`);
  console.warn('   Les parties resteront en mémoire et seront perdues au redémarrage.');
}

function serialize(rooms: Map<string, PersistableRoom>): string {
  const payload: StoredFile = {
    version: 1,
    savedAt: Date.now(),
    rooms: [...rooms.values()].map((room) => {
      const { questionsPool, ...gameState } = room.gameState;
      return {
        code: room.code,
        hostSocketId: room.hostSocketId,
        generationToken: room.generationToken,
        reconnectTokens: Object.fromEntries(room.reconnectTokens),
        settings: room.settings,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt,
        emptySince: room.emptySince,
        hostDisconnectedAt: room.hostDisconnectedAt,
        gameState,
      };
    }),
  };
  return JSON.stringify(payload);
}

/**
 * Écrit l'état si quelque chose a changé, sans bloquer le serveur.
 *
 * Les écritures sont asynchrones à dessein : un disque lent — un volume réseau,
 * par exemple — ne doit jamais figer la partie en cours. Deux écritures ne se
 * chevauchent pas ; si l'état change pendant une écriture, une seule reprise est
 * programmée à la fin. Le fichier temporaire suivi d'un `rename` garantit qu'une
 * coupure au mauvais moment ne laisse jamais un JSON tronqué.
 */
export function saveRooms(rooms: Map<string, PersistableRoom>): void {
  if (disabled) return;
  if (writing) {
    pending = rooms;
    return;
  }
  const payload = serialize(rooms);
  if (payload === lastWritten) return;

  writing = true;
  void (async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      // `fsync` avant le `rename` : sans lui, une coupure de courant peut
      // laisser un fichier renommé mais vide, le rename atteignant le disque
      // avant les données.
      const temp = tempPath();
      try {
        const handle = await open(temp, 'w');
        try {
          await handle.writeFile(payload, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, STORE_PATH);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      lastWritten = payload;
    } catch (error) {
      warnOnce(`Impossible d'écrire les parties dans ${STORE_PATH}`, error);
    } finally {
      writing = false;
      const next = pending;
      pending = null;
      if (next) saveRooms(next);
    }
  })();
}

/**
 * Écriture bloquante, réservée à l'arrêt du processus.
 *
 * À ce moment précis, il faut que l'écriture soit terminée avant de rendre la
 * main : c'est elle qui sauve la partie en cours lors d'un redéploiement.
 */
export function saveRoomsSync(rooms: Map<string, PersistableRoom>): void {
  if (disabled) return;
  try {
    const payload = serialize(rooms);
    if (payload === lastWritten) return;
    mkdirSync(DATA_DIR, { recursive: true });
    const temp = tempPath();
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, payload, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, STORE_PATH);
    lastWritten = payload;
  } catch (error) {
    warnOnce(`Impossible d'écrire les parties dans ${STORE_PATH}`, error);
  }
}

/**
 * Recharge les parties sauvegardées.
 *
 * Les joueurs reviennent marqués déconnectés : leurs sockets n'existent plus.
 * Les délais de grâce de l'hôte et des salles vides repartent de maintenant,
 * pour laisser à la famille le temps de se reconnecter après un redéploiement.
 */
export function loadRooms(
  questionsDatabase: Question[],
  shuffle: <T>(values: T[]) => T[],
): Map<string, PersistableRoom> {
  const rooms = new Map<string, PersistableRoom>();
  let raw: string;
  try {
    raw = readFileSync(STORE_PATH, 'utf8');
  } catch {
    return rooms; // premier démarrage, ou volume vide : cas normal
  }

  let parsed: StoredFile;
  try {
    parsed = JSON.parse(raw) as StoredFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.rooms)) {
      throw new Error('format inattendu');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Sauvegarde des parties illisible, elle est ignorée (${detail}).`);
    return rooms;
  }

  const now = Date.now();
  let skipped = 0;
  let rejected = 0;
  for (const stored of parsed.rooms) {
    // Un salon illisible est écarté seul : avant, une seule donnée malformée —
    // un prénom qui n'était pas une chaîne — faisait planter chaque démarrage,
    // et toutes les parties en cours avec lui.
    try {
      const room = reviveStoredRoom(stored, questionsDatabase, shuffle, now);
      if (room === 'expired') skipped += 1;
      else if (room === null) rejected += 1;
      else rooms.set(room.code, room);
    } catch (error) {
      rejected += 1;
      console.warn(`⚠️  Salon sauvegardé illisible, il est écarté (${error instanceof Error ? error.message : error}).`);
    }
  }

  if (rooms.size > 0 || skipped > 0 || rejected > 0) {
    console.log(
      `💾 ${rooms.size} partie(s) rechargée(s) depuis ${STORE_PATH}`
        + (skipped > 0 ? `, ${skipped} trop ancienne(s) ignorée(s)` : '')
        + (rejected > 0 ? `, ${rejected} invalide(s) écartée(s)` : ''),
    );
  }
  return rooms;
}

const STORED_PHASES: readonly GameState['phase'][] = [
  'lobby', 'first_player_roll', 'rolling', 'moving', 'question', 'evaluating', 'game_over',
];

/**
 * Un salon relu du disque, revalidé avec les règles qui s'appliquent aux envois
 * des clients (`src/server/inputValidation.ts`).
 *
 * Un joueur inutilisable fait écarter le salon entier : sans lui, les sièges, le
 * tour et le tirage d'ouverture ne se correspondraient plus. Un pack illisible,
 * lui, s'écarte seul — la partie peut se poursuivre sans ses cartes.
 *
 * Les joueurs reviennent marqués déconnectés : leurs sockets n'existent plus.
 */
export function reviveStoredRoom(
  stored: unknown,
  questionsDatabase: Question[],
  shuffle: <T>(values: T[]) => T[],
  now: number,
): PersistableRoom | 'expired' | null {
  if (!isPlainObject(stored) || !isPlainObject(stored.gameState)) return null;
  const code = normalizeRoomCode(stored.code);
  if (!code || typeof stored.hostSocketId !== 'string') return null;
  const createdAt = typeof stored.createdAt === 'number' && Number.isFinite(stored.createdAt) ? stored.createdAt : now;
  const lastActivityAt = typeof stored.lastActivityAt === 'number' && Number.isFinite(stored.lastActivityAt)
    ? stored.lastActivityAt
    : now;
  if (now - lastActivityAt > MAX_RESTORE_AGE_MS) return 'expired';

  const storedState = stored.gameState as Record<string, unknown> & Omit<GameState, 'questionsPool'>;
  if (!Array.isArray(storedState.players)) return null;
  const players: Player[] = [];
  for (const raw of storedState.players) {
    const player = reviveStoredPlayer(raw);
    if (!player) return null;
    // Personne n'est encore revenu : chacun dispose du même délai, à compter du
    // redémarrage, avant que son rôle de lecteur ou son tour ne passe.
    player.disconnectedAt = now;
    players.push(player);
  }

  const customPacks = Array.isArray(storedState.customPacks)
    ? storedState.customPacks
      .map(reviveStoredPack)
      .filter((pack): pack is NonNullable<typeof pack> => pack !== null)
      .slice(0, MAX_STORED_PACKS)
    : [];
  const customQuestions = customPacks.flatMap((pack) => pack.questions);
  const settings = reviveStoredSettings(stored.settings, code);

  const reconnectTokens = new Map<string, string>();
  if (isPlainObject(stored.reconnectTokens)) {
    for (const [playerId, token] of Object.entries(stored.reconnectTokens)) {
      if (typeof token === 'string' && token.length <= 200) reconnectTokens.set(playerId, token);
    }
  }

  // Une carte en cours dont la forme ne tient plus est abandonnée : le tour
  // repart du lancer plutôt que de planter à la réponse.
  let phase = STORED_PHASES.includes(storedState.phase) ? storedState.phase : 'lobby';
  let currentQuestion = storedState.currentQuestion ?? null;
  if (currentQuestion !== null && (
    !isPlainObject(currentQuestion)
    || typeof currentQuestion.question !== 'string'
    || !Array.isArray(currentQuestion.options)
  )) {
    currentQuestion = null;
  }
  if ((phase === 'question' || phase === 'evaluating') && !currentQuestion) phase = 'rolling';

  const activePlayerIndex = Number.isInteger(storedState.activePlayerIndex)
    && storedState.activePlayerIndex >= 0
    && storedState.activePlayerIndex < Math.max(players.length, 1)
    ? storedState.activePlayerIndex
    : 0;

  return {
    code,
    hostSocketId: stored.hostSocketId,
    generationToken: typeof stored.generationToken === 'string' && stored.generationToken
      ? stored.generationToken
      : randomBytes(32).toString('base64url'),
    reconnectTokens,
    settings,
    createdAt,
    lastActivityAt,
    // Les compteurs de grâce repartent à zéro : sans cela une salle rechargée
    // serait balayée aussitôt, personne n'ayant encore eu le temps de revenir.
    emptySince: now,
    hostDisconnectedAt: now,
    sockets: new Map(),
    gameState: {
      ...storedState,
      roomCode: code,
      phase,
      currentQuestion,
      activePlayerIndex,
      // Le lecteur fixé de la carte en cours, s'il désigne toujours un joueur du
      // salon ; sinon le rôle se déduit de l'ordre de la table.
      readerId: storedState.readerId === null
        ? null
        : players.some(player => player.id === storedState.readerId)
          ? storedState.readerId
          : undefined,
      settings,
      players,
      customPacks,
      usedQuestionIds: Array.isArray(storedState.usedQuestionIds)
        ? storedState.usedQuestionIds.filter((id): id is string => typeof id === 'string')
        : [],
      boardCategories: Array.isArray(storedState.boardCategories)
        ? storedState.boardCategories.filter(isKnownCategory)
        : undefined,
      questionsPool: shuffle([...customQuestions, ...questionsDatabase]),
    },
  };
}

/**
 * Vérifie au démarrage que le dossier de sauvegarde est réellement utilisable.
 *
 * Sans cela, une erreur de configuration — volume monté sur un autre chemin que
 * `DATA_DIR`, dossier en lecture seule — ne se découvrirait qu'en perdant une
 * partie. Le test écrit puis supprime un fichier témoin, et distingue un dossier
 * neuf d'un dossier qui contient déjà une sauvegarde.
 */
export function checkStore(): void {
  const probe = path.join(DATA_DIR, '.write-test');
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${DATA_DIR} n'est pas accessible en écriture (${detail}).`);
    console.error('   Les parties ne seront PAS sauvegardées.');
    console.error('   Sur Railway : vérifiez que le volume est monté exactement sur');
    console.error(`   le chemin de DATA_DIR, ici « ${DATA_DIR} ».`);
    return;
  }

  const configured = process.env.DATA_DIR
    ? `DATA_DIR=${process.env.DATA_DIR}`
    : 'DATA_DIR non défini, dossier local par défaut';
  let existing = 'aucune sauvegarde pour le moment';
  try {
    const stats = statSync(STORE_PATH);
    const age = Math.round((Date.now() - stats.mtimeMs) / 1000);
    existing = `sauvegarde existante de ${stats.size} octets, écrite il y a ${age} s`;
  } catch {
    // premier démarrage sur ce volume : cas normal
  }
  console.log(`✅ Sauvegarde des parties opérationnelle (${configured}) — ${existing}.`);
}

/**
 * Sauvegarde périodique, plus une sauvegarde immédiate à l'arrêt.
 *
 * C'est le `SIGTERM` qui compte le plus : Railway l'envoie avant de remplacer
 * le conteneur, ce qui laisse le temps d'écrire la partie en cours.
 */
export function startRoomPersistence(
  rooms: Map<string, PersistableRoom>,
  intervalMs = 3000,
  // Fermeture des connexions, appelée une fois la sauvegarde écrite : c'est la
  // sauvegarde qui compte, elle passe donc en premier.
  closeConnections?: () => Promise<void>,
): void {
  const timer = setInterval(() => saveRooms(rooms), intervalMs);
  timer.unref?.();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    saveRoomsSync(rooms);
    console.log(`💾 Parties sauvegardées avant l'arrêt (${signal}).`);
    if (!closeConnections) process.exit(0);
    // Une connexion qui traîne ne doit pas retenir l'arrêt au-delà du délai
    // que laisse l'hébergeur avant de tuer le conteneur.
    const forced = setTimeout(() => process.exit(0), 5000);
    forced.unref?.();
    closeConnections()
      .catch((error) => console.warn('Fermeture des connexions incomplète :', error))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

export const ROOM_STORE_PATH = STORE_PATH;
