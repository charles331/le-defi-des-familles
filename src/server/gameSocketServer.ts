import type { Server as HttpServer } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Server, Socket } from 'socket.io';
import { QUESTIONS_DATABASE } from '../data/questions';
import { BOARD_CATEGORY_COUNT, buildBoard, resolveBoardCategories } from '../data/boards';
import { advanceTurn, calculateMoves, removePlayerFromGame, resetGameForNewRound, resolveAnswer, togglePauseState } from './gameEngine';
import {
  beginFirstPlayerDraw,
  pendingRollers,
  purgeFirstPlayerRoll,
  recordFirstPlayerRoll,
  settleFirstPlayerDraw,
  skipFirstPlayerDraw,
  transferFirstPlayerRoll,
} from './firstPlayerDraw';
import { rollDie } from './diceThrow';
import { createGameStateView } from './gameStateView';
import { describeRecoveredSeat, findAbandonedSeat, mergeSeatInto, normalizeSeatName } from './seats';
import {
  MAX_ACTIVE_THEME_NAMES,
  defaultSettings,
  isPlainObject,
  sanitizeAvatarId,
  sanitizeColor,
  sanitizeCustomPack,
  sanitizeDifficulty,
  sanitizePlayerName,
  sanitizePlayerProfile,
  sanitizeSettings,
  sanitizeThemeNames,
} from './inputValidation';
import { generateRoomCode, normalizeRoomCode } from './roomCodes';
import { FailureWindow, TokenBucket, clientAddress, isAllowedOrigin } from './socketGuards';
import { REACTION_MIN_INTERVAL_MS, isReactionEmoji } from '../config/reactions';
import { isCardReadAloud, resolveOnAirIds, resolveReaderId } from './turnRoles';
import { activeThemeKeys, pickQuestionForPlayer } from './questionSelection';
import {
  BIG_LEAP_BONUS,
  BONUS_ROSTER,
  awardSurpriseBonus,
  useBonus,
  useLeapBonus,
  wheelSlotFor,
} from './bonuses';
import {
  BonusType,
  GameState,
  Player,
  GameSettings,
  Question,
  CategoryId,
} from '../types';

/**
 * Le serveur de jeu en temps réel : salons, sièges et tours, sur socket.io.
 *
 * Il vivait au milieu de `server.ts`, qui démarrait tout à l'import — Express,
 * Vite, la lecture des parties sauvegardées. Impossible alors de l'éprouver sans
 * lancer l'application entière : les paquets malformés qui tuaient le processus
 * ne se testaient qu'à la main. Le voici instanciable sur n'importe quel serveur
 * HTTP, avec ses salons et sa persistance passés en paramètre.
 */

/**
 * Sans geste — appui simple, ou bouton de repli —, le dé part quand même vers le
 * plateau : en haut à gauche depuis son coin, la direction qu'aurait prise une
 * main qui le pousse en jeu.
 */
const DEFAULT_THROW_ANGLE = 225;
const PLAYER_COLORS = ['#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];

// --- MULTIPLAYER ROOMS STORE ---
export interface Room {
  code: string;
  hostSocketId: string;
  generationToken: string;
  reconnectTokens: Map<string, string>;
  settings: GameSettings;
  gameState: GameState;
  sockets: Map<string, Player>; // socketId -> Player
  createdAt: number;
  lastActivityAt: number;
  emptySince: number | null;
  hostDisconnectedAt: number | null;
  /**
   * Clé d'adresse de celui qui a créé le salon (voir `clientAddress`), pour le
   * quota de salons par foyer. Absente d'un salon rechargé du disque.
   */
  creatorKey?: string;
}

/** Mélange de Fisher-Yates, partagé par le démarrage de partie et la reprise. */
export function shuffled<T>(values: T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const positiveDuration = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const MAX_ROOMS = 250;
const MAX_PLAYERS_PER_ROOM = 12;
const MAX_CUSTOM_PACKS_PER_ROOM = 3;
const MAX_CUSTOM_QUESTIONS_PER_ROOM = 180;
// Dix minutes : après un redéploiement ou une coupure de réseau, il faut laisser
// à toute la famille le temps de revenir avant de fermer le salon.
const HOST_RECONNECT_GRACE_MS = positiveDuration(process.env.ROOM_HOST_GRACE_MS, 10 * 60 * 1000);
const EMPTY_ROOM_GRACE_MS = positiveDuration(process.env.ROOM_EMPTY_GRACE_MS, 10 * 60 * 1000);
// Partie en pause : le salon est conservé quatre heures, le temps d'un repas ou
// d'une soirée, tant que quelqu'un garde la page ouverte.
const PAUSED_ROOM_TTL_MS = positiveDuration(process.env.ROOM_PAUSED_TTL_MS, 4 * 60 * 60 * 1000);
// Mais une pause sans plus personne de connecté ne tient qu'une demi-heure. Les
// quatre heures valaient aussi pour un salon que plus aucun appareil ne
// regardait : créer des salons, les mettre en pause et fermer l'onglet suffisait
// à occuper durablement les deux cent cinquante places du serveur.
const PAUSED_EMPTY_ROOM_GRACE_MS = positiveDuration(process.env.ROOM_PAUSED_EMPTY_GRACE_MS, 30 * 60 * 1000);
const ROOM_IDLE_TTL_MS = positiveDuration(process.env.ROOM_IDLE_TTL_MS, 4 * 60 * 60 * 1000);
const ROOM_MAX_AGE_MS = positiveDuration(process.env.ROOM_MAX_AGE_MS, 12 * 60 * 60 * 1000);
const ROOM_SWEEP_INTERVAL_MS = positiveDuration(process.env.ROOM_SWEEP_INTERVAL_MS, 30 * 1000);

/**
 * Taille maximale d'un message reçu, en octets.
 *
 * Le défaut de socket.io est d'un mégaoctet : assez pour qu'un seul client
 * envoie des chaînes géantes, que le serveur recopiait dans l'état puis
 * renvoyait à chaque joueur du salon et resérialisait toutes les trois secondes.
 * Le plus gros message légitime est un pack de soixante cartes ; un pack au
 * plafond de chaque champ tient dans cette limite (vérifié par
 * `tests/inputValidation.test.ts`).
 */
export const MAX_SOCKET_PAYLOAD_BYTES = 128 * 1024;

/**
 * Les plafonds contre un client qui abuse. Réglables pour les tests, où tous
 * les clients partagent la même adresse.
 */
export interface SocketLimits {
  /** Salons actifs créés depuis une même adresse (un /64 en IPv6). */
  maxRoomsPerAddress: number;
  /** Codes de salon inexistants essayés par une connexion, par minute. */
  maxCodeFailuresPerSocket: number;
  /** Idem pour une adresse entière, qui peut ouvrir connexion sur connexion. */
  maxCodeFailuresPerAddress: number;
  /**
   * Débit d'événements par connexion : rafale tolérée, puis débit soutenu.
   * Un joueur humain envoie quelques événements par seconde au plus — la
   * saisie du prénom au clavier, lettre par lettre, est la plus rapide.
   */
  eventBurst: number;
  eventsPerSecond: number;
  /**
   * Les candidats ICE arrivent en salve à l'ouverture de chaque connexion
   * vidéo — une ou deux dizaines par pair, et un joueur à l'antenne en ouvre une
   * par spectateur, onze au plus : ils ont leur propre seau, plus large.
   */
  candidateBurst: number;
  candidatesPerSecond: number;
}

export const DEFAULT_SOCKET_LIMITS: SocketLimits = {
  maxRoomsPerAddress: 3,
  maxCodeFailuresPerSocket: 10,
  maxCodeFailuresPerAddress: 30,
  eventBurst: 40,
  eventsPerSecond: 20,
  candidateBurst: 300,
  candidatesPerSecond: 100,
};

const CODE_FAILURE_WINDOW_MS = 60 * 1000;

export interface GameSocketServerOptions {
  /** Les salons, éventuellement rechargés du disque par l'appelant. */
  rooms: Map<string, Room>;
  /** Écrit l'état des salons ; sans effet dans les tests. */
  persist: () => void;
  limits?: Partial<SocketLimits>;
  /** Origines admises en plus de la page servie par ce serveur (`PUBLIC_ORIGIN`). */
  publicOrigins?: string[];
}

export interface GameSocketServer {
  io: Server;
  /** Arrête le balayage des salons et ferme socket.io. */
  close(): Promise<void>;
}

function safeTokenEquals(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function attachGameSocketServer(
  httpServer: HttpServer,
  { rooms, persist, limits: limitOverrides, publicOrigins = [] }: GameSocketServerOptions,
): GameSocketServer {
  const limits: SocketLimits = { ...DEFAULT_SOCKET_LIMITS, ...limitOverrides };
  const io = new Server(httpServer, {
    // Plus d'`origin: '*'` : seule la page du jeu, servie par ce serveur, et
    // les origines de `PUBLIC_ORIGIN` ouvrent une connexion depuis un
    // navigateur. `allowRequest` couvre aussi le WebSocket, que les en-têtes
    // CORS ne protègent pas.
    cors: publicOrigins.length > 0 ? { origin: publicOrigins, methods: ['GET', 'POST'] } : undefined,
    allowRequest: (req, callback) => {
      const allowed = isAllowedOrigin(
        req.headers.origin,
        [req.headers.host, req.headers['x-forwarded-host']],
        publicOrigins,
      );
      if (!allowed) console.warn(`[Socket] Origine refusée : ${String(req.headers.origin).slice(0, 200)}`);
      callback(null, allowed);
    },
    maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
  });

  const codeFailuresBySocket = new FailureWindow(limits.maxCodeFailuresPerSocket, CODE_FAILURE_WINDOW_MS);
  const codeFailuresByAddress = new FailureWindow(limits.maxCodeFailuresPerAddress, CODE_FAILURE_WINDOW_MS);

  /**
   * Le salon désigné par un code venu du réseau, quelle qu'en soit la forme.
   *
   * Seule l'action d'un membre compte comme activité : un appel refusé d'un
   * inconnu rafraîchissait l'horloge d'inactivité, et suffisait à garder en vie
   * indéfiniment un salon abandonné.
   */
  function getRoom(rawCode: unknown, actorId?: string): Room | undefined {
    const code = normalizeRoomCode(rawCode);
    if (!code) return undefined;
    const room = rooms.get(code);
    if (room && actorId && room.sockets.has(actorId)) room.lastActivityAt = Date.now();
    return room;
  }

  function emitGameState(room: Room): void {
    for (const socketId of room.sockets.keys()) {
      io.to(socketId).emit(
        'game-state-update',
        createGameStateView(room.gameState, socketId, room.hostSocketId),
      );
    }
  }

  function gameStateFor(room: Room, socketId: string) {
    return createGameStateView(room.gameState, socketId, room.hostSocketId);
  }

  function closeRoom(code: string, reason: string): boolean {
    const room = rooms.get(code);
    if (!room) return false;

    io.to(code).emit('room-closed', { reason });
    io.in(code).socketsLeave(code);
    room.sockets.clear();
    room.reconnectTokens.clear();
    room.gameState.players.length = 0;
    room.gameState.questionsPool.length = 0;
    room.gameState.usedQuestionIds.length = 0;
    room.gameState.customPacks = [];
    rooms.delete(code);
    // Écriture immédiate : une salle fermée ne doit pas réapparaître si le
    // serveur redémarre dans les secondes qui suivent.
    persist();
    console.log(`[Room] Salon supprimé: ${code} (${reason}). Salons actifs: ${rooms.size}`);
    return true;
  }

  /**
   * Rattache un siège existant à un nouvel appareil.
   *
   * Trois chemins mènent ici — la reconnexion par jeton, la reprise d'un siège
   * abandonné au prénom, la fusion d'un doublon par l'organisateur — et ils doivent
   * faire exactement la même chose : l'identifiant du joueur *est* son identifiant
   * de socket, donc tous les registres indexés dessus (sockets, jetons, siège de
   * l'organisateur, lancer d'ouverture) se déplacent en même temps. Un seul oubli
   * laisse un joueur présent à l'écran mais que le serveur n'autorise plus à agir.
   */
  function bindSeatToSocket(room: Room, seat: Player, previousSeatId: string, socket: Socket, sessionToken: string): void {
    seat.id = socket.id;
    seat.isConnected = true;
    transferFirstPlayerRoll(room.gameState, previousSeatId, socket.id);

    room.sockets.delete(previousSeatId);
    room.sockets.set(socket.id, seat);
    room.reconnectTokens.delete(previousSeatId);
    room.reconnectTokens.set(socket.id, sessionToken);
    room.emptySince = null;
    room.lastActivityAt = Date.now();

    if (room.hostSocketId === previousSeatId) {
      room.hostSocketId = socket.id;
      room.hostDisconnectedAt = null;
      seat.isHost = true;
    }

    socket.join(room.code);
  }

  function removeSocketFromRoom(room: Room, socketId: string): void {
    room.sockets.delete(socketId);
    room.reconnectTokens.delete(socketId);
    const playerIndex = room.gameState.players.findIndex(player => player.id === socketId);
    if (playerIndex >= 0) {
      room.gameState.players.splice(playerIndex, 1);
      if (room.gameState.activePlayerIndex >= room.gameState.players.length) {
        room.gameState.activePlayerIndex = 0;
      } else if (playerIndex < room.gameState.activePlayerIndex) {
        room.gameState.activePlayerIndex -= 1;
      }
      // Un départ pendant le tirage retire le lancer du partant, et peut suffire à
      // départager ceux qui restent.
      purgeFirstPlayerRoll(room.gameState, socketId);
      settleFirstPlayerDraw(room.gameState);
    }
  }

  function leaveAllRoomsForSocket(socketId: string, reason: string): void {
    for (const [code, room] of rooms.entries()) {
      if (!room.sockets.has(socketId)) continue;
      if (room.hostSocketId === socketId) {
        closeRoom(code, reason);
      } else {
        removeSocketFromRoom(room, socketId);
        room.emptySince = room.sockets.size === 0 ? Date.now() : null;
        emitGameState(room);
      }
    }
  }

  const roomSweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
      // Une partie en pause échappe aux délais courts : ni l'absence de
      // l'organisateur ni un salon vide ne la ferment. Seule la fenêtre de pause
      // la limite, afin qu'un salon oublié ne reste pas indéfiniment ouvert —
      // et, quand plus aucun appareil n'est connecté, une demi-heure d'absence.
      if (room.gameState.isPaused) {
        const pausedSince = room.gameState.pausedAt ?? now;
        if (now - pausedSince >= PAUSED_ROOM_TTL_MS) {
          closeRoom(code, 'La partie est restée en pause trop longtemps.');
        } else if (room.sockets.size === 0 && room.emptySince && now - room.emptySince >= PAUSED_EMPTY_ROOM_GRACE_MS) {
          closeRoom(code, 'La partie en pause n’avait plus aucun joueur connecté.');
        }
        continue;
      }

      if (now - room.createdAt >= ROOM_MAX_AGE_MS) {
        closeRoom(code, 'Durée maximale du salon atteinte.');
      } else if (now - room.lastActivityAt >= ROOM_IDLE_TTL_MS) {
        closeRoom(code, 'Le salon a expiré après une longue période d’inactivité.');
      } else if (room.hostDisconnectedAt && now - room.hostDisconnectedAt >= HOST_RECONNECT_GRACE_MS) {
        closeRoom(code, 'L’organisateur a quitté le salon.');
      } else if (room.emptySince && now - room.emptySince >= EMPTY_ROOM_GRACE_MS) {
        closeRoom(code, 'Le salon est vide.');
      }
    }
  }, ROOM_SWEEP_INTERVAL_MS);
  roomSweep.unref();

  // Socket.IO Connection Handler
  io.on('connection', (socket: Socket) => {
    console.log(`[Socket] Connexion: ${socket.id}`);
    const addressOfClient = clientAddress(socket.handshake.address, socket.handshake.headers['x-forwarded-for']);

    // Débit par connexion. Un événement au-delà du seau est ignoré, sans
    // réponse : un client légitime n'y arrive jamais, et lui répondre
    // nourrirait le flot qu'on veut tarir. Un client qui insiste est déconnecté.
    const startedAt = Date.now();
    const events = new TokenBucket(limits.eventBurst, limits.eventsPerSecond, startedAt);
    const candidates = new TokenBucket(limits.candidateBurst, limits.candidatesPerSecond, startedAt);
    const floods = new FailureWindow(limits.eventBurst * 5, CODE_FAILURE_WINDOW_MS);
    socket.use(([event], nextEvent) => {
      const now = Date.now();
      const bucket = event === 'webrtc-candidate' ? candidates : events;
      if (bucket.take(now)) return nextEvent();
      if (floods.record(socket.id, now)) {
        console.warn(`[Socket] ${socket.id} déconnecté : trop d'événements.`);
        socket.disconnect(true);
      }
    });

    /**
     * Un code de salon qui n'existe pas. Au-delà de dix par minute pour une
     * connexion — ou trente pour une adresse, qui peut se reconnecter en boucle —,
     * ce n'est plus une faute de frappe : c'est quelqu'un qui essaie les codes un
     * par un. Il est prévenu, puis déconnecté.
     *
     * Renvoie vrai si la connexion a été coupée.
     */
    function recordUnknownRoomCode(): boolean {
      const now = Date.now();
      const socketBlocked = codeFailuresBySocket.record(socket.id, now);
      const addressBlocked = codeFailuresByAddress.record(addressOfClient, now);
      if (!socketBlocked && !addressBlocked) return false;
      console.warn(`[Socket] ${socket.id} (${addressOfClient}) déconnecté : trop de codes de salon inexistants.`);
      socket.emit('error-msg', 'Trop de codes de salon inconnus. Vérifiez le code et réessayez dans une minute.');
      socket.disconnect(true);
      return true;
    }

    /** Une adresse déjà bloquée ne peut plus rien essayer, même depuis une connexion neuve. */
    function isAddressBlocked(): boolean {
      return codeFailuresByAddress.isBlocked(addressOfClient, Date.now());
    }

    /**
     * Enregistre un handler d'événement client, derrière deux garde-fous.
     *
     * Un message sans objet — `emit('create-room')` tout court, ou `null` — ne
     * parvient jamais au handler. Et une exception levée dedans est journalisée
     * au lieu de remonter : socket.io appelle les handlers hors de toute pile
     * protégée, si bien qu'un seul `TypeError` sur un champ manquant tuait le
     * processus, et toutes les parties en cours avec lui. L'audit l'a obtenu
     * d'une ligne, sans même rejoindre de salon.
     *
     * Les types annoncés par les handlers ne sont qu'une promesse du client :
     * chaque champ dont la forme compte est revérifié dans le handler.
     */
    function on<T extends object>(event: string, handler: (data: T) => void): void {
      socket.on(event, (data: unknown) => {
        if (!isPlainObject(data)) return;
        try {
          handler(data as T);
        } catch (error) {
          console.error(`[Socket] « ${event} » a échoué pour ${socket.id} :`, error);
        }
      });
    }

    // Create Private Room
    on('create-room', (data: { player?: unknown; settings?: unknown }) => {
      leaveAllRoomsForSocket(socket.id, 'L’organisateur a créé un nouveau salon.');
      if (rooms.size >= MAX_ROOMS) {
        return socket.emit('error-msg', 'Trop de salons sont actifs. Réessayez dans quelques minutes.');
      }
      // Trois salons ouverts par foyer : de quoi recommencer une partie ratée,
      // pas de quoi occuper à soi seul les places du serveur.
      const roomsFromAddress = [...rooms.values()].filter(room => room.creatorKey === addressOfClient).length;
      if (roomsFromAddress >= limits.maxRoomsPerAddress) {
        return socket.emit('error-msg', 'Vous avez déjà plusieurs salons ouverts. Fermez-en un avant d’en créer un autre.');
      }

      const roomCode = generateRoomCode(code => rooms.has(code));
      const requestedSettings = sanitizeSettings(data.settings);
      const isLocal = requestedSettings.isLocalMode === true;
      const profile = sanitizePlayerProfile(data.player, { avatarId: 'lion', color: '#EF4444', difficulty: 'adulte' });

      const hostPlayer: Player = {
        id: socket.id,
        name: profile.name ?? 'Hôte Famille',
        avatarId: profile.avatarId,
        color: profile.color,
        difficulty: profile.difficulty,
        wedges: [],
        currentTileId: 0,
        isHost: true,
        isReady: isLocal,
        score: 0,
        correctAnswersCount: 0,
        totalAnswersCount: 0,
        isConnected: true,
        bonuses: {},
      };

      // Mêmes règles qu'`update-settings` : ce chemin les contournait, et une
      // sélection de catégories inventée entrait dans le salon dès sa création.
      const initialSettings: GameSettings = {
        ...defaultSettings(roomCode, isLocal),
        ...requestedSettings,
        roomCode,
        // Un salon neuf n'a encore aucun pack : aucun thème ne peut y être actif.
        customThemePackNames: undefined,
      };

      const initialGameState: GameState = {
        roomCode,
        phase: 'lobby',
        settings: initialSettings,
        players: [hostPlayer],
        activePlayerIndex: 0,
        diceValue: null,
        diceThrow: null,
        possibleMoves: [],
        selectedTileId: null,
        currentQuestion: null,
        questionStartTime: null,
        lastAnswerResult: null,
        winnerId: null,
        questionsPool: [...QUESTIONS_DATABASE],
        usedQuestionIds: [],
        bonusAwardedThisTurn: null,
        activeQuestionBonus: null,
      };

      const now = Date.now();
      const room: Room = {
        code: roomCode,
        hostSocketId: socket.id,
        generationToken: randomBytes(32).toString('base64url'),
        reconnectTokens: new Map([[socket.id, randomBytes(32).toString('base64url')]]),
        settings: initialSettings,
        gameState: initialGameState,
        sockets: new Map([[socket.id, hostPlayer]]),
        createdAt: now,
        lastActivityAt: now,
        emptySince: null,
        hostDisconnectedAt: null,
        creatorKey: addressOfClient,
      };

      rooms.set(roomCode, room);
      socket.join(roomCode);

      socket.emit('room-created', {
        roomCode,
        player: hostPlayer,
        gameState: gameStateFor(room, socket.id),
        generationToken: room.generationToken,
        sessionToken: room.reconnectTokens.get(socket.id),
      });
      console.log(`[Room] Salon créé: ${roomCode} par ${hostPlayer.name}`);
    });

    // Reconnect Existing Session (on page refresh or disconnect recovery)
    on('reconnect-session', (data: { roomCode: string; playerId: string; sessionToken?: string }) => {
      if (isAddressBlocked()) return void recordUnknownRoomCode();
      const code = normalizeRoomCode(data.roomCode) ?? '';
      const room = getRoom(code, socket.id);

      if (!room) {
        if (recordUnknownRoomCode()) return;
        return socket.emit('reconnect-failed', { message: 'Salon expiré ou introuvable.' });
      }

      const player = room.gameState.players.find(p => p.id === data.playerId);
      const expectedSessionToken = room.reconnectTokens.get(data.playerId);
      if (!player || !expectedSessionToken || !safeTokenEquals(data.sessionToken, expectedSessionToken)) {
        return socket.emit('reconnect-failed', { message: 'Joueur non trouvé dans ce salon.' });
      }

      // Le lancer du tirage suit le joueur : il n'a pas à relancer après un
      // simple rafraîchissement de page.
      bindSeatToSocket(room, player, player.id, socket, expectedSessionToken);

      socket.emit('room-joined', {
        roomCode: code,
        player,
        gameState: gameStateFor(room, socket.id),
        generationToken: player.isHost ? room.generationToken : undefined,
        sessionToken: expectedSessionToken,
      });
      emitGameState(room);
      console.log(`[Room] ${player.name} s'est reconnecté avec succès à ${code}`);
    });

    // Join Room
    on('join-room', (data: { roomCode: unknown; player?: unknown }) => {
      if (isAddressBlocked()) return void recordUnknownRoomCode();
      const code = normalizeRoomCode(data.roomCode) ?? '';
      const room = getRoom(code, socket.id);

      if (!room) {
        if (recordUnknownRoomCode()) return;
        return socket.emit('error-msg', 'Salon introuvable. Vérifiez le code de la salle privée.');
      }
      const profile = sanitizePlayerProfile(data.player, { avatarId: 'fox', color: '#3B82F6', difficulty: 'adulte' });

      // Quelqu'un qui revient avec son prénom reprend son siège au lieu d'en créer
      // un second. C'est le filet du jeton de session, qui ne survit pas au
      // changement de navigateur : sans lui, une coupure de réseau se soldait par un
      // doublon — un « Christelle » déconnecté avec quatre camemberts, un autre à
      // zéro — que rien ne permettait de réunir.
      const abandonedSeat = findAbandonedSeat(room.gameState, profile.name ?? '');
      if (abandonedSeat) {
        const recoveredToken = randomBytes(32).toString('base64url');
        const previousSeatId = abandonedSeat.id;
        bindSeatToSocket(room, abandonedSeat, previousSeatId, socket, recoveredToken);
        // Elle peut avoir changé d'avis sur son avatar en revenant ; ses camemberts,
        // son pion et son niveau, eux, appartiennent à la partie en cours.
        abandonedSeat.avatarId = sanitizeAvatarId((data.player as { avatarId?: unknown } | undefined)?.avatarId, abandonedSeat.avatarId);
        settleFirstPlayerDraw(room.gameState);

        socket.emit('room-joined', {
          roomCode: code,
          player: abandonedSeat,
          gameState: gameStateFor(room, socket.id),
          generationToken: abandonedSeat.isHost ? room.generationToken : undefined,
          sessionToken: recoveredToken,
        });
        room.gameState.lastTurnEventMessage = describeRecoveredSeat(abandonedSeat.name, abandonedSeat.wedges.length);
        emitGameState(room);
        persist();
        console.log(`[Room] ${abandonedSeat.name} a retrouvé son siège dans ${code}`);
        return;
      }

      if (room.gameState.players.length >= MAX_PLAYERS_PER_ROOM) {
        return socket.emit('error-msg', 'Ce salon a atteint sa limite de joueurs.');
      }

      // Create new player in room
      const newPlayer: Player = {
        id: socket.id,
        name: profile.name ?? `Joueur ${room.gameState.players.length + 1}`,
        avatarId: profile.avatarId,
        color: profile.color,
        difficulty: profile.difficulty,
        wedges: [],
        currentTileId: 0,
        isHost: false,
        isReady: false,
        score: 0,
        correctAnswersCount: 0,
        totalAnswersCount: 0,
        isConnected: true,
        bonuses: {},
      };

      room.sockets.set(socket.id, newPlayer);
      const sessionToken = randomBytes(32).toString('base64url');
      room.reconnectTokens.set(socket.id, sessionToken);
      room.gameState.players.push(newPlayer);
      room.emptySince = null;
      room.lastActivityAt = Date.now();
      socket.join(code);

      socket.emit('room-joined', {
        roomCode: code,
        player: newPlayer,
        gameState: gameStateFor(room, socket.id),
        sessionToken,
      });
      emitGameState(room);
      console.log(`[Room] ${newPlayer.name} a rejoint le salon ${code}`);
    });

    // Local Pass & Play Add Player
    on('add-local-player', (data: { roomCode: string; player?: unknown }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id || !room.settings.isLocalMode) return;
      if (room.gameState.players.length >= MAX_PLAYERS_PER_ROOM) {
        return socket.emit('error-msg', 'Ce salon a atteint sa limite de joueurs.');
      }

      const usedColors = new Set(room.gameState.players.map(player => player.color.toLowerCase()));
      // Couleur « vide » en repli : seule une couleur réellement demandée, et
      // valide, peut l'emporter sur la première couleur libre de la palette.
      const profile = sanitizePlayerProfile(data.player, { avatarId: 'robot', color: '', difficulty: 'enfant' });
      const requestedColor = profile.color.toLowerCase();
      const availableColor = PLAYER_COLORS.find(color => !usedColors.has(color.toLowerCase())) || profile.color || '#10B981';

      const newPlayer: Player = {
        id: `local_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        name: profile.name ?? `Joueur ${room.gameState.players.length + 1}`,
        avatarId: profile.avatarId,
        color: requestedColor && !usedColors.has(requestedColor) ? profile.color : availableColor,
        difficulty: profile.difficulty,
        wedges: [],
        currentTileId: 0,
        isHost: false,
        isReady: true,
        score: 0,
        correctAnswersCount: 0,
        totalAnswersCount: 0,
        isConnected: true,
        bonuses: {},
      };

      room.gameState.players.push(newPlayer);
      emitGameState(room);
    });

    /**
     * L'organisateur retire un joueur, y compris en pleine partie.
     *
     * Il n'existait aucun moyen de le faire : seul le départ volontaire
     * (`leave-room`) sortait quelqu'un d'une partie lancée, et `remove-local-player`
     * est bloqué hors du lobby. Une famille où un enfant va se coucher restait donc
     * avec un pion inerte qui prenait son tour à chaque passage.
     *
     * L'organisateur ne peut pas se retirer lui-même par ce chemin : partir ferme le
     * salon pour tout le monde, ce qui est une autre décision et passe par
     * « Quitter ».
     */
    on('remove-player', (data: { roomCode: string; playerId: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!data.playerId || data.playerId === room.hostSocketId) return;

      const player = room.gameState.players.find(candidate => candidate.id === data.playerId);
      if (!player) return;
      const removedName = player.name;

      if (!removePlayerFromGame(room.gameState, data.playerId)) return;

      // Le siège d'un joueur en ligne libère aussi son socket et son jeton : sans
      // cela il se reconnecterait dans un salon qui ne l'attend plus.
      if (!data.playerId.startsWith('local_')) {
        room.sockets.delete(data.playerId);
        room.reconnectTokens.delete(data.playerId);
        io.to(data.playerId).emit('room-left');
        io.sockets.sockets.get(data.playerId)?.leave(room.code);
      }

      room.gameState.lastTurnEventMessage = `${removedName} a quitté la partie.`;
      emitGameState(room);
      persist();
      console.log(`[Room] ${removedName} retiré du salon ${room.code} par l'organisateur`);
    });

    /**
     * L'organisateur réunit un doublon avec le siège qu'il aurait dû retrouver.
     *
     * La reprise automatique par prénom couvre le cas courant, mais pas celui où la
     * personne est revenue sous un autre nom, ni les parties déjà abîmées. Il fallait
     * une réparation manuelle : jusqu'ici, un doublon était définitif et les
     * camemberts du siège d'origine étaient perdus pour la partie.
     *
     * C'est le siège d'origine qui l'emporte — il porte la partie déjà jouée — et
     * l'appareil du doublon qui en reprend les commandes.
     */
    on('merge-player', (data: { roomCode: string; sourcePlayerId: string; targetPlayerId: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;

      const seat = room.gameState.players.find(player => player.id === data.targetPlayerId);
      const duplicate = room.gameState.players.find(player => player.id === data.sourcePlayerId);
      if (!seat || !duplicate) return;
      if (duplicate.id.startsWith('local_') || seat.id.startsWith('local_')) return;

      const duplicateName = duplicate.name;
      const merged = mergeSeatInto(room.gameState, data.sourcePlayerId, data.targetPlayerId);
      if (!merged) return;

      // Le doublon a disparu de la table, mais son appareil reste en ligne : c'est
      // désormais lui qui tient le siège d'origine, donc ses registres suivent.
      const token = room.reconnectTokens.get(data.sourcePlayerId) ?? randomBytes(32).toString('base64url');
      room.sockets.delete(merged.previousSeatId);
      room.sockets.set(data.sourcePlayerId, merged.seat);
      room.reconnectTokens.delete(merged.previousSeatId);
      room.reconnectTokens.set(data.sourcePlayerId, token);
      if (room.hostSocketId === merged.previousSeatId) {
        room.hostSocketId = data.sourcePlayerId;
        room.hostDisconnectedAt = null;
        merged.seat.isHost = true;
      }
      settleFirstPlayerDraw(room.gameState);

      // L'appareil fusionné doit apprendre son nouvel identifiant de joueur, sinon
      // il continue de se croire le doublon et le serveur refuse ses actions.
      io.to(data.sourcePlayerId).emit('room-joined', {
        roomCode: room.code,
        player: merged.seat,
        gameState: createGameStateView(room.gameState, data.sourcePlayerId, room.hostSocketId),
        generationToken: merged.seat.isHost ? room.generationToken : undefined,
        sessionToken: token,
      });

      room.gameState.lastTurnEventMessage = describeRecoveredSeat(merged.seat.name, merged.seat.wedges.length);
      emitGameState(room);
      persist();
      console.log(`[Room] Fusion dans ${room.code} : ${duplicateName} rendu à son siège d'origine`);
    });

    on('remove-local-player', (data: { roomCode: string; playerId: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id || !room.settings.isLocalMode || room.gameState.phase !== 'lobby') return;
      if (typeof data.playerId !== 'string' || !data.playerId.startsWith('local_')) return;

      room.gameState.players = room.gameState.players.filter(player => player.id !== data.playerId);
      emitGameState(room);
    });

    on('toggle-ready', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.gameState.phase !== 'lobby' || room.settings.isLocalMode) return;

      const player = room.gameState.players.find(p => p.id === socket.id);
      if (!player) return;

      player.isReady = !player.isReady;
      emitGameState(room);
    });

    // Update Settings (Host only)
    on('update-settings', (data: { roomCode: string; settings: Partial<GameSettings> }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;

      // Les réglages ne se modifient que dans le salon. Sans ce garde, un client
      // resté sur un vieil écran pouvait changer le nombre de camemberts ou la durée
      // du chrono au milieu d'une partie déjà commencée.
      if (room.gameState.phase !== 'lobby') return;

      // Et ils se valident, au lieu d'être fusionnés tels quels. C'était l'entrée la
      // plus permissive du serveur : un `wedgesToWin` de 99 rendait la partie
      // ingagnable, un `timerSeconds` négatif cassait le décompte, et une catégorie
      // inconnue faisait planter le rendu du plateau. Rien de tout cela n'est
      // atteignable depuis l'interface — c'est précisément pourquoi personne ne s'en
      // apercevrait.
      room.settings = { ...room.settings, ...sanitizeSettings(data.settings) };
      room.gameState.settings = room.settings;

      emitGameState(room);
    });

    // Update Player Profile (Avatar, Color, Name, Difficulty)
    on('update-player', (data: { roomCode: string; player?: unknown }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || !isPlainObject(data.player)) return;
      const update = data.player;

      const requestedPlayer = room.gameState.players.find(pl => pl.id === update.id);
      const canEditRequestedLocalPlayer = room.hostSocketId === socket.id && requestedPlayer?.id.startsWith('local_');
      const p = room.gameState.players.find(pl => pl.id === socket.id) || (canEditRequestedLocalPlayer ? requestedPlayer : undefined);
      if (!p) return;

      // En partie, seul l'avatar se change encore. Le niveau choisit les cartes
      // et le prénom identifie le siège — c'est par lui qu'on le reprend après
      // une coupure : les changer en cours de route, c'était se donner des
      // cartes enfant à quatre camemberts de la victoire, ou prendre le prénom
      // d'un absent pour qu'on lui rende sa place.
      const inLobby = room.gameState.phase === 'lobby';
      p.avatarId = sanitizeAvatarId(update.avatarId, p.avatarId);
      if (inLobby) {
        p.color = sanitizeColor(update.color, p.color);
        p.difficulty = sanitizeDifficulty(update.difficulty, p.difficulty);
        if (typeof update.name === 'string') {
          // Un champ vidé pendant la saisie reste vide : « Joueur N » le
          // remplacera au lancement.
          const name = sanitizePlayerName(update.name) ?? '';
          const taken = name !== '' && room.gameState.players.some(other => (
            other !== p && normalizeSeatName(other.name) === normalizeSeatName(name)
          ));
          if (taken) {
            socket.emit('error-msg', 'Ce prénom est déjà pris à cette table.');
          } else {
            p.name = name;
          }
        }
      }

      emitGameState(room);
    });

    // Add Custom AI Theme Pack
    on('add-custom-pack', (data: { roomCode: string; themeName?: unknown; questions?: unknown }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;

      // Chaque carte est refaite par le serveur : identifiant neuf, thème du
      // pack, forme contrôlée. Une carte `null` ou sans propositions faisait
      // planter le tirage — et la sauvegarde la rejouait à chaque démarrage.
      const stamp = `${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
      const pack = sanitizeCustomPack(data.themeName, data.questions, index => `custom_${stamp}_${index}`);
      if ('error' in pack) return socket.emit('error-msg', pack.error);
      const { themeName, questions } = pack;
      const themeKey = themeName.toLowerCase();

      if (!room.gameState.customPacks) {
        room.gameState.customPacks = [];
      }

      const existingIndex = room.gameState.customPacks.findIndex(
        p => p.name.toLowerCase().trim() === themeKey
      );

      const currentCustomQuestionCount = room.gameState.customPacks.reduce(
        (total, pack) => total + pack.questions.length,
        0
      );
      if (currentCustomQuestionCount + questions.length > MAX_CUSTOM_QUESTIONS_PER_ROOM) {
        return socket.emit('error-msg', 'Ce salon a atteint sa limite de questions personnalisées.');
      }
      if (existingIndex < 0 && room.gameState.customPacks.length >= MAX_CUSTOM_PACKS_PER_ROOM) {
        return socket.emit('error-msg', 'Ce salon a atteint sa limite de thèmes personnalisés.');
      }

      if (existingIndex >= 0) {
        // Les cartes ajoutées portent le nom du pack existant, pas sa variante
        // de casse : le tirage les rapproche par ce nom.
        const existing = room.gameState.customPacks[existingIndex];
        existing.questions.push(...questions.map(question => ({ ...question, themePack: existing.name })));
      } else {
        room.gameState.customPacks.push({
          name: themeName,
          questions,
        });
      }

      // Le thème fraîchement généré rejoint les thèmes actifs, sans désactiver
      // les autres : la table peut jouer avec ses trois thèmes à la fois.
      if (!activeThemeKeys(room.settings).has(themeKey)) {
        const activeNames = sanitizeThemeNames([
          ...(room.settings.customThemePackNames ?? []),
          ...(room.settings.customThemePackName ? [room.settings.customThemePackName] : []),
          themeName,
        ], MAX_ACTIVE_THEME_NAMES);
        room.settings.customThemePackNames = activeNames;
        room.settings.customThemePackName = undefined;
        room.gameState.settings.customThemePackNames = activeNames;
        room.gameState.settings.customThemePackName = undefined;
      }

      // Merge into room's active questions pool
      room.gameState.questionsPool = [...questions, ...room.gameState.questionsPool];

      emitGameState(room);
      console.log(`[Pack IA] ${questions.length} questions ajoutées pour "${themeName}" dans le salon ${room.code}`);
    });

    /**
     * Retour au salon depuis l'écran de victoire.
     *
     * Le bouton était câblé sur `leave-room`, si bien que l'organisateur qui venait
     * de gagner fermait le salon pour toute la table : « l'organisateur a fermé le
     * salon ». Ce n'est pas la même intention — on veut revenir régler la partie et
     * en relancer une, pas s'en aller.
     */
    on('return-to-lobby', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.gameState.phase === 'lobby') return;

      resetGameForNewRound(room.gameState);
      room.gameState.phase = 'lobby';
      emitGameState(room);
      persist();
      console.log(`[Room] ${room.code} revient au salon`);
    });

    // Start Game
    on('start-game', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;

      if (room.gameState.players.length < 1) {
        return socket.emit('error-msg', 'Il faut au moins 1 joueur pour commencer.');
      }

      if (!room.settings.isLocalMode) {
        const connectedPlayers = room.gameState.players.filter(player => player.isConnected);
        if (connectedPlayers.some(player => !player.isReady)) {
          return socket.emit('error-msg', 'Tous les joueurs connectés doivent être prêts avant de commencer.');
        }
      }

      // Exactement six catégories, ni plus ni moins : la roue a six branches et le
      // camembert six parts (ADR 0007). Le refus se fait ici et pas seulement dans
      // l'interface, parce que c'est le serveur qui construit le plateau — et parce
      // qu'un salon repris du disque peut porter une sélection d'une version d'avant.
      if (room.settings.selectedCategories?.length !== BOARD_CATEGORY_COUNT) {
        return socket.emit(
          'error-msg',
          `Choisissez exactement ${BOARD_CATEGORY_COUNT} catégories pour le plateau.`,
        );
      }

      // Ensure all players have a non-empty name when game starts
      room.gameState.players.forEach((player, idx) => {
        if (!player.name || !player.name.trim()) {
          player.name = `Joueur ${idx + 1}`;
        }
      });

      // Une nouvelle manche repart de zéro : camemberts, pions, scores et bonus.
      // Sans cela, « Rejouer » après une victoire redonnait la main au vainqueur
      // avec tous ses camemberts déjà en poche.
      resetGameForNewRound(room.gameState);

      // Les catégories du plateau se figent ici, au lancement, et plus jamais après :
      // l'hôte peut encore toucher aux réglages du salon, mais une partie en cours ne
      // doit pas voir ses cases changer de catégorie sous elle. Après la remise à zéro,
      // pour qu'un futur nettoyage de manche ne les efface pas.
      room.gameState.boardCategories = resolveBoardCategories(room.settings.selectedCategories);

      // Collect all custom questions from custom packs added to the room
      const customQuestions: Question[] = [];
      if (room.gameState.customPacks) {
        room.gameState.customPacks.forEach((pack) => {
          customQuestions.push(...pack.questions);
        });
      }

      // Shuffle questions pool on game start (custom pack questions included first)
      room.gameState.questionsPool = shuffled([...customQuestions, ...QUESTIONS_DATABASE]);

      // Le premier joueur n'est plus l'organisateur d'office : tout le monde
      // lance le dé une fois et le meilleur lancer ouvre la partie. Une partie
      // solo n'a évidemment rien à départager.
      if (room.gameState.players.length === 1) {
        skipFirstPlayerDraw(room.gameState);
      } else {
        beginFirstPlayerDraw(room.gameState, Date.now());
      }

      emitGameState(room);
      persist();
    });

    /**
     * Qui lance, et pour qui.
     *
     * En ligne, chacun lance pour lui-même. En pass & play, l'appareil est unique :
     * l'organisateur lance pour chaque joueur à son tour, dans l'ordre de la table.
     */
    function resolveFirstPlayerRoller(room: Room, socketId: string, requestedId?: string): Player | null {
      const pending = pendingRollers(room.gameState);
      if (pending.length === 0) return null;

      const roller = room.settings.isLocalMode
        ? room.hostSocketId === socketId ? pending[0] : null
        : pending.find(player => player.id === socketId) ?? null;

      // Le client annonce pour qui il croit lancer. S'il se trompe — parce que la
      // partie a avancé entre-temps, ou parce qu'il vise quelqu'un d'autre — mieux
      // vaut refuser que d'attribuer le lancer au voisin.
      if (!roller || (requestedId && requestedId !== roller.id)) return null;
      return roller;
    }

    // Tirage du premier joueur : un seul lancer par joueur.
    on('roll-first-player', (data: { roomCode: string; playerId?: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.gameState.phase !== 'first_player_roll') return;
      if (isPaused(room)) return;

      const roller = resolveFirstPlayerRoller(room, socket.id, data.playerId);
      if (!roller) return;

      const dice = Math.floor(Math.random() * 6) + 1;
      if (!recordFirstPlayerRoll(room.gameState, roller.id, dice, Date.now())) return;

      settleFirstPlayerDraw(room.gameState);
      emitGameState(room);
      persist();
    });

    /**
     * Départage sans attendre les joueurs manquants. Réservée à l'organisateur,
     * cette sortie de secours évite qu'un joueur parti chercher un verre bloque
     * indéfiniment le lancement de la partie.
     */
    on('end-first-player-roll', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.gameState.phase !== 'first_player_roll') return;

      if (!settleFirstPlayerDraw(room.gameState, { force: true })) {
        return socket.emit('error-msg', 'Il faut au moins un lancer pour désigner le premier joueur.');
      }

      emitGameState(room);
      persist();
    });

    // Helper to check if a socket is authorized to take action for the active player
    function isPlayerAllowedToAct(room: any, socketId: string): boolean {
      const activePlayer = room.gameState.players[room.gameState.activePlayerIndex];
      if (!activePlayer) return false;

      // Direct online player turn
      if (activePlayer.id === socketId) return true;

      // Local pass-and-play player, room host, or single-player room host
      if (room.hostSocketId === socketId) {
        if (room.settings.isLocalMode || activePlayer.id.startsWith('local_') || room.gameState.players.length === 1) {
          return true;
        }
      }

      return false;
    }

    function isPlayerAllowedToAnswer(room: Room, socketId: string): boolean {
      if (isPlayerAllowedToAct(room, socketId)) return true;
      if (!isCardReadAloud(room.settings)) return false;

      return resolveReaderId(room.gameState.players, room.gameState.activePlayerIndex) === socketId;
    }

    /**
     * Bascule la pause. Réservée à l'organisateur.
     *
     * À la reprise, `questionStartTime` est décalé de la durée de la pause : le
     * minuteur repart là où il s'était arrêté au lieu d'avoir expiré entre-temps.
     */
    on('toggle-pause', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.gameState.phase === 'lobby' || room.gameState.phase === 'game_over') return;

      const wasPaused = room.gameState.isPaused === true;
      togglePauseState(room.gameState, Date.now());
      console.log(`[Room] Partie ${wasPaused ? 'reprise' : 'mise en pause'}: ${room.code}`);

      emitGameState(room);
      persist();
    });

    /** Pendant la pause, aucune action de jeu n'est acceptée. */
    function isPaused(room: Room): boolean {
      return room.gameState.isPaused === true;
    }

    // Roll Dice
    on('roll-dice', (data: {
      roomCode: string;
      power?: number | null;
      /** Angle du geste, en degrés : il donne la direction du dé sur le plateau. */
      angle?: number | null;
    }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.gameState.phase !== 'rolling') return;
      if (isPaused(room)) return;

      if (!isPlayerAllowedToAct(room, socket.id)) {
        console.warn(`[Roll Rejected] Socket ${socket.id} is not active player ${room.gameState.players[room.gameState.activePlayerIndex]?.id}`);
        return;
      }

      // Le serveur tire la face, et lui seul : le client n'envoie qu'un geste,
      // jamais une face. Le geste ne pèse pas sur le résultat — il dessine le vol,
      // juste en dessous.
      const dice = rollDie();
      room.gameState.diceValue = dice;

      // Le parcours du dé sur le plateau se déduit de la poussée et d'une graine
      // tirée ici : tous les écrans rejouent alors le même vol. Les deux nombres
      // qui viennent du réseau sont bornés — l'angle tourne, la puissance non.
      const power = typeof data?.power === 'number' && Number.isFinite(data.power)
        ? Math.max(0, Math.min(100, data.power))
        : 0;
      const angle = typeof data?.angle === 'number' && Number.isFinite(data.angle)
        ? ((data.angle % 360) + 360) % 360
        : DEFAULT_THROW_ANGLE;
      room.gameState.diceThrow = {
        power,
        angle,
        seed: Math.floor(Math.random() * 0x7fffffff) + 1,
      };
      room.gameState.phase = 'moving';
      room.gameState.lastTurnEventMessage = null;
      room.gameState.bonusAwardedThisTurn = null;
      room.gameState.surpriseSpinThisTurn = false;
      room.gameState.surpriseWheel = null;
      room.gameState.activeQuestionBonus = null;
      room.gameState.bigLeapThisTurn = null;

      const activePlayer = room.gameState.players[room.gameState.activePlayerIndex];
      const board = buildBoard(room.settings.boardType, room.gameState.boardCategories);

      // Calculate possible movement destination tile IDs
      const currentTile = board.tiles.find(t => t.id === activePlayer.currentTileId) || board.tiles[0];
      const possibleMoves = calculateMoves(currentTile.id, dice, board);

      // Compute possible destination tiles; movement will be executed via 'move-player'
      room.gameState.possibleMoves = possibleMoves;

      emitGameState(room);
    });

    // Move Token to Tile
    on('move-player', (data: { roomCode: string; destinationTileId: number }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.gameState.phase !== 'moving') return;
      if (isPaused(room)) return;

      if (!isPlayerAllowedToAct(room, socket.id)) {
        console.warn(`[Move Rejected] Socket ${socket.id} not allowed to move for player`);
        return;
      }

      // Guardrail: Destination tile must be one of the calculated possible moves
      if (room.gameState.possibleMoves.length > 0 && !room.gameState.possibleMoves.includes(data.destinationTileId)) {
        console.warn(`[Move Safety] Tile ${data.destinationTileId} not in possibleMoves, redirecting to:`, room.gameState.possibleMoves[0]);
        data.destinationTileId = room.gameState.possibleMoves[0];
      }

      const activePlayer = room.gameState.players[room.gameState.activePlayerIndex];
      activePlayer.currentTileId = data.destinationTileId;
      room.gameState.selectedTileId = data.destinationTileId;

      const board = buildBoard(room.settings.boardType, room.gameState.boardCategories);
      const tile = board.tiles.find(t => t.id === data.destinationTileId);

      if (!tile) return;

      if (tile.type === 'reroll') {
        // Re-roll tile: player gets another roll!
        room.gameState.phase = 'rolling';
        room.gameState.diceValue = null;
        // La poussée précédente ne décrit plus rien : sans cet oubli, le dé restait
        // affiché à son point de chute au milieu du plateau, puis le nouveau lancer
        // le faisait repartir de son coin — il sautait d'un endroit à l'autre.
        room.gameState.diceThrow = null;
        room.gameState.possibleMoves = [];
        // Le Grand saut décrivait le déplacement qu'on vient d'annuler : la case
        // Relancer renvoie au lancer, donc le compte de pas ne veut plus rien dire.
        room.gameState.bigLeapThisTurn = null;
        room.gameState.lastTurnEventMessage = `🎲 ${activePlayer.name} a atterri sur une case Relancer le dé ! Rejouez tout de suite.`;
        emitGameState(room);
        return;
      }

      if (tile.type === 'surprise') {
        awardSurpriseBonus(room.gameState);
        // Le résultat (bonus ou case vide) est révélé par la roue côté client ; le
        // journal reste volontairement muet pour ne pas divulgâcher le tirage.
        if (room.gameState.surpriseSpinThisTurn) {
          room.gameState.lastTurnEventMessage = `🎡 Boîte surprise : ${activePlayer.name} fait tourner la roue !`;
        }
      }

      // Pick question according to tile category or player's difficulty
      const validCategories = room.settings.selectedCategories && room.settings.selectedCategories.length > 0 
        ? room.settings.selectedCategories 
        : ['histoire', 'geographie', 'cinema', 'sciences', 'art', 'sports', 'popculture', 'gastronomie'];

      const categoryId = tile.categoryId || validCategories[Math.floor(Math.random() * validCategories.length)];
      const question = pickQuestionForPlayer(room.gameState, categoryId as CategoryId, activePlayer.difficulty);

      room.gameState.currentQuestion = question;
      // Le rappel de la carte précédente s'effface ici, et pas au changement de
      // tour : c'est précisément l'intervalle pendant lequel la table doit pouvoir
      // finir de lire le « Le saviez-vous ? ».
      room.gameState.lastQuestionRecap = null;
      room.gameState.phase = 'question';
      // Sur une case Surprise, le minuteur ne démarre pas tout de suite : la roue
      // doit d'abord tourner. On laisse `questionStartTime` en attente (null) et
      // c'est le joueur actif qui lance le décompte en fermant la roue, via
      // « start-question-timer ». Sinon le temps défilait pour toute la table
      // pendant l'animation de la roue.
      room.gameState.questionStartTime = room.gameState.surpriseSpinThisTurn ? null : Date.now();

      emitGameState(room);
      persist();
    });

    // Lancement de la roue surprise. Le client n'envoie qu'un **geste** — un appui,
    // sans résultat —, comme pour le dé : c'est le serveur qui retient l'instant du
    // lancer, et le quartier d'arrivée était déjà décidé en arrivant sur la case.
    // Toute la table voit alors la même roue tourner et s'arrêter au même endroit.
    on('spin-surprise-wheel', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || isPaused(room)) return;
      if (room.gameState.phase !== 'question') return;
      if (!isPlayerAllowedToAct(room, socket.id)) return;
      if (!room.gameState.surpriseSpinThisTurn) return;
      const wheel = room.gameState.surpriseWheel;
      if (wheel?.startedAt != null) return; // déjà lancée

      // Un salon repris du disque peut avoir été enregistré avant que la roue ne
      // soit décrite dans l'état : sans ce repli, son quartier manquerait et
      // personne ne pourrait plus la lancer — la table resterait bloquée devant.
      const slot = wheel?.slot ?? wheelSlotFor(room.gameState.bonusAwardedThisTurn ?? null);
      room.gameState.surpriseWheel = { slot, startedAt: Date.now() };
      emitGameState(room);
      persist();
    });

    // Fin de la roue surprise : le joueur actif démarre le minuteur pour toute la
    // table, une fois la roue arrêtée et le bonus révélé. Idempotent et réservé au
    // joueur actif — c'est lui qui donne le rythme, les autres écrans referment leur
    // roue en voyant le minuteur démarrer.
    on('start-question-timer', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || isPaused(room)) return;
      if (room.gameState.phase !== 'question') return;
      if (!isPlayerAllowedToAct(room, socket.id)) return;
      if (!room.gameState.surpriseSpinThisTurn) return;
      if (room.gameState.questionStartTime != null) return; // déjà lancé

      room.gameState.questionStartTime = Date.now();
      emitGameState(room);
      persist();
    });

    // Use a stored question bonus. The server chooses the eliminated answers so
    // the correct answer never needs to be sent to the answering player's client.
    on('use-bonus', (data: { roomCode: string; bonusType: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || isPaused(room)) return;
      if (!BONUS_ROSTER.includes(data.bonusType as BonusType)) return;
      // `isPlayerAllowedToAct` et non `isPlayerAllowedToAnswer` : le lecteur a le
      // droit de trancher une réponse à voix haute, mais pas de dépenser un bonus
      // qui n'est pas le sien. `useBonus` prélève sur le joueur actif, si bien que
      // le lecteur consommait le 50/50 de la personne qu'il interrogeait — signalé
      // en partie : « quand c'était à ma femme de jouer, j'avais la possibilité
      // d'activer son bonus à sa place ». Un bonus est un choix tactique, il
      // n'appartient qu'à celui dont c'est le tour.
      if (!isPlayerAllowedToAct(room, socket.id)) return;

      // Le Grand saut est le seul bonus qui agit sur le plateau et non sur la
      // carte : il lui faut le plateau de la partie, et sa propre phase.
      if (data.bonusType === BIG_LEAP_BONUS) {
        const board = buildBoard(room.settings.boardType, room.gameState.boardCategories);
        // Le saut s'annonce dans le sélecteur de destination, qui est déjà à
        // l'écran de tout le monde en phase `moving` : pas de message de tour, qui
        // ne s'affiche qu'en phase de lancer et arriverait donc trop tard.
        if (!useLeapBonus(room.gameState, board)) return;
      } else if (!useBonus(room.gameState, data.bonusType as BonusType)) {
        return;
      }

      emitGameState(room);
      persist();
    });

    // Submit Question Answer
    on('submit-answer', (data: { roomCode: string; optionIndex: number }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.gameState.phase !== 'question' || !room.gameState.currentQuestion) return;
      if (isPaused(room)) return;
      if (!isPlayerAllowedToAnswer(room, socket.id)) return;
      if (!Number.isInteger(data.optionIndex) || data.optionIndex < -1 || data.optionIndex > 3) return;
      if (room.gameState.activeQuestionBonus?.hiddenOptionIndexes.includes(data.optionIndex)) return;

      const board = buildBoard(room.settings.boardType, room.gameState.boardCategories);
      resolveAnswer(room.gameState, room.settings, board, data.optionIndex);
      emitGameState(room);
    });

    // Next Turn or Extra Turn
    on('next-turn', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || room.gameState.phase === 'game_over') return;
      if (isPaused(room)) return;

      // Guardrail: next-turn CAN ONLY BE EXECUTED when phase is evaluating or question
      if (room.gameState.phase !== 'evaluating' && room.gameState.phase !== 'question') {
        console.warn(`[NextTurn Rejected] Cannot trigger next-turn from phase "${room.gameState.phase}"`);
        return;
      }
      if (!isPlayerAllowedToAnswer(room, socket.id)) return;

      advanceTurn(room.gameState);
      emitGameState(room);
    });

    // Send Emoji Reaction
    //
    // Relayée à tout le salon, la réaction ne vient que d'un membre, n'est qu'un
    // des emojis que l'interface propose, et pas plus d'une par seconde. Sans
    // ces trois gardes, n'importe qui connaissant le code pouvait envoyer un
    // objet à la place de l'emoji et faire planter le rendu de toute la table.
    let lastReactionAt = 0;
    on('send-emoji', (data: { roomCode: string; emoji: unknown }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || !room.sockets.has(socket.id)) return;
      if (!isReactionEmoji(data.emoji)) return;
      const now = Date.now();
      if (now - lastReactionAt < REACTION_MIN_INTERVAL_MS) return;
      lastReactionAt = now;

      const player = room.gameState.players.find(p => p.id === socket.id);
      io.to(room.code).emit('emoji-received', {
        id: `${Date.now()}_${Math.random()}`,
        playerId: socket.id,
        playerName: player?.name || 'Joueur',
        emoji: data.emoji,
        timestamp: Date.now()
      });
    });

    // WebRTC Signaling for the live reader/answerer duo.
    //
    // Two players are on air during a question: the answerer and their reader.
    // Each of them publishes to every other room member, so the duo see and hear
    // each other and the remaining players follow along. Only a publisher may
    // offer, which keeps the handshake free of glare: a connection is therefore
    // fully identified by its publisher, carried in `publisherId`.
    const isOnAir = (room: Room, socketId: string) =>
      room.settings.enableLiveCamera === true
      && room.gameState.phase === 'question'
      && resolveOnAirIds(room.gameState.players, room.gameState.activePlayerIndex).includes(socketId);

    on('webrtc-broadcaster-ready', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || !isOnAir(room, socket.id)) return;

      socket.to(room.code).emit('webrtc-broadcaster-ready', {
        senderPlayerId: socket.id
      });
    });

    on('webrtc-viewer-ready', (data: { roomCode: string; targetPlayerId: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || !room.sockets.has(socket.id)) return;
      if (!isOnAir(room, data.targetPlayerId)) return;
      // A publisher never subscribes to itself, and asking for one's own stream
      // would make it open a peer connection to its own socket.
      if (data.targetPlayerId === socket.id) return;

      io.to(data.targetPlayerId).emit('webrtc-viewer-ready', {
        senderPlayerId: socket.id
      });
    });

    on('webrtc-offer', (data: { roomCode: string; targetPlayerId: string; offer: any }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || !isOnAir(room, socket.id)) return;
      if (!room.sockets.has(data.targetPlayerId)) return;

      io.to(data.targetPlayerId).emit('webrtc-offer', {
        senderPlayerId: socket.id,
        offer: data.offer
      });
    });

    on('webrtc-answer', (data: { roomCode: string; targetPlayerId: string; answer: any }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || !room.sockets.has(socket.id)) return;
      if (!isOnAir(room, data.targetPlayerId)) return;

      io.to(data.targetPlayerId).emit('webrtc-answer', {
        senderPlayerId: socket.id,
        answer: data.answer
      });
    });

    on('webrtc-candidate', (data: {
      roomCode: string;
      targetPlayerId: string;
      publisherId: string;
      candidate: any;
    }) => {
      const room = getRoom(data.roomCode, socket.id);
      if (!room || !room.sockets.has(socket.id)) return;
      if (!room.sockets.has(data.targetPlayerId)) return;
      // The candidate must belong to a live connection, and both ends must be part
      // of it: without this, any room member could inject candidates into a
      // stranger's session.
      if (!isOnAir(room, data.publisherId)) return;
      if (data.publisherId !== socket.id && data.publisherId !== data.targetPlayerId) return;

      io.to(data.targetPlayerId).emit('webrtc-candidate', {
        senderPlayerId: socket.id,
        publisherId: data.publisherId,
        candidate: data.candidate
      });
    });

    on('webrtc-stop', (data: { roomCode: string }) => {
      const room = getRoom(data.roomCode, socket.id);
      // Any room member may announce that their own stream stopped: a sender can
      // only ever speak about itself here. Requiring the broadcaster role would
      // reject the notice sent at the end of a turn, since the phase has already
      // left `question` by then — which left every viewer holding a dead peer
      // connection until ICE eventually timed out.
      if (!room || !room.sockets.has(socket.id)) return;

      socket.to(room.code).emit('webrtc-stopped', {
        senderPlayerId: socket.id
      });
    });

    on('leave-room', (data: { roomCode: string }) => {
      const code = normalizeRoomCode(data.roomCode) ?? '';
      const room = getRoom(code, socket.id);
      if (!room || !room.sockets.has(socket.id)) return;

      if (room.hostSocketId === socket.id) {
        closeRoom(code, 'L’organisateur a fermé le salon.');
        return;
      }

      removeSocketFromRoom(room, socket.id);
      socket.leave(code);
      socket.emit('room-left');
      room.emptySince = room.sockets.size === 0 ? Date.now() : null;
      emitGameState(room);
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Socket] Déconnexion: ${socket.id}`);
      for (const [code, room] of rooms.entries()) {
        if (room.sockets.has(socket.id)) {
          room.sockets.delete(socket.id);
          const p = room.gameState.players.find(pl => pl.id === socket.id);
          if (p) {
            p.isConnected = false;
            // On n'attend plus le lancer d'un absent : si les présents ont tous
            // lancé, le tirage se tranche tout de suite.
            settleFirstPlayerDraw(room.gameState);
          }

          if (room.hostSocketId === socket.id) {
            room.hostDisconnectedAt = Date.now();
          }
          room.emptySince = room.sockets.size === 0 ? Date.now() : null;

          emitGameState(room);
        }
      }
    });
  });
  return {
    io,
    close: () => new Promise<void>((resolve) => {
      clearInterval(roomSweep);
      io.close(() => resolve());
    }),
  };
}
