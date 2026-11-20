import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import { GameSocketServer, Room, SocketLimits, attachGameSocketServer } from '../src/server/gameSocketServer';
import type { Question } from '../src/types';

/**
 * Le serveur de jeu, éprouvé par de vrais clients socket.io.
 *
 * Les tests unitaires couvrent les décisions pures ; ceux-ci vérifient qu'elles
 * sont bien branchées sur les événements — c'est là que les failles de l'audit
 * vivaient, un handler qui oubliait de vérifier l'appartenance au salon ou le
 * type d'un champ.
 */

let server: GameSocketServer;
let url = '';
const rooms = new Map<string, Room>();
const clients: ClientSocket[] = [];

async function startServer(roomMap: Map<string, Room>, limits?: Partial<SocketLimits>) {
  const httpServer = createServer();
  const instance = attachGameSocketServer(httpServer, { rooms: roomMap, persist: () => {}, limits });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  return { instance, url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}` };
}

before(async () => {
  // Tous les clients des tests partagent l'adresse 127.0.0.1 : les plafonds par
  // adresse sont relevés ici, et éprouvés à part sur leur propre serveur.
  const started = await startServer(rooms, { maxRoomsPerAddress: 1000, maxCodeFailuresPerAddress: 1000 });
  server = started.instance;
  url = started.url;
});

after(async () => {
  for (const client of clients) client.disconnect();
  await server.close();
});

async function client(target = url, extraHeaders?: Record<string, string>): Promise<ClientSocket> {
  const socket = connect(target, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

/** Attend un événement, ou échoue au bout du délai. */
function next<T = any>(socket: ClientSocket, event: string, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`« ${event} » jamais reçu`));
    }, timeoutMs);
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

/** Vérifie qu'un événement n'arrive PAS pendant la fenêtre donnée. */
async function silence(socket: ClientSocket, event: string, windowMs = 300): Promise<void> {
  let received: unknown;
  const onEvent = (payload: unknown) => { received = payload ?? true; };
  socket.on(event, onEvent);
  await new Promise(resolve => setTimeout(resolve, windowMs));
  socket.off(event, onEvent);
  assert.equal(received, undefined, `« ${event} » n'aurait pas dû arriver`);
}

async function createRoom(host: ClientSocket, name = 'Charles', settings: Record<string, unknown> = {}) {
  const created = next(host, 'room-created');
  host.emit('create-room', { player: { name }, settings });
  return created;
}

test('un salon se crée et se rejoint', async () => {
  const host = await client();
  const { roomCode } = await createRoom(host);
  const guest = await client();
  const joined = next(guest, 'room-joined');
  guest.emit('join-room', { roomCode, player: { name: 'Laura' } });
  const payload = await joined;
  assert.equal(payload.player.name, 'Laura');
  assert.equal(rooms.get(roomCode)?.gameState.players.length, 2);
});

test('des paquets malformés ne tuent pas le serveur', async () => {
  const attacker = await client();
  const { roomCode } = await createRoom(attacker, 'Mallory');
  // Chacun de ces envois faisait planter le processus avant le correctif
  // (TypeError dans le handler, hors de toute pile protégée).
  attacker.emit('create-room');
  attacker.emit('create-room', null);
  attacker.emit('create-room', 'FAM-ABCD');
  attacker.emit('create-room', [1, 2]);
  attacker.emit('create-room', { player: null, settings: 7 });
  attacker.emit('reconnect-session', null);
  attacker.emit('reconnect-session', { roomCode: { $ne: 1 }, playerId: [], sessionToken: {} });
  attacker.emit('join-room', { roomCode });
  attacker.emit('join-room', { roomCode: 42, player: 'x' });
  attacker.emit('update-player', { roomCode });
  attacker.emit('update-player', { roomCode, player: { name: 12, color: 1, difficulty: {} } });
  attacker.emit('add-custom-pack', { roomCode, questions: [{}] });
  attacker.emit('add-local-player', { roomCode, player: { color: 1 } });
  attacker.emit('remove-local-player', { roomCode, playerId: 5 });
  attacker.emit('submit-answer', null);
  attacker.emit('send-emoji');

  // Le serveur répond toujours, à un autre client comme à l'attaquant.
  const witness = await client();
  const created = await createRoom(witness, 'Témoin');
  assert.match(created.roomCode, /^FAM-/);
  const again = await createRoom(attacker, 'Mallory');
  assert.match(again.roomCode, /^FAM-/);
});

test('un prénom qui n’est pas une chaîne n’entre pas dans le salon', async () => {
  const host = await client();
  const created = next(host, 'room-created');
  host.emit('create-room', { player: { name: { toString: 'x' }, color: 1, avatarId: '<script>' }, settings: {} });
  const { roomCode, player } = await created;
  assert.equal(player.name, 'Hôte Famille');
  assert.equal(player.color, '#EF4444');
  assert.equal(player.avatarId, 'lion');

  const guest = await client();
  const joined = next(guest, 'room-joined');
  guest.emit('join-room', { roomCode, player: { name: ['Laura'], difficulty: 'expert' } });
  const payload = await joined;
  assert.equal(typeof payload.player.name, 'string');
  assert.equal(payload.player.difficulty, 'adulte');
});

test('create-room passe par sanitizeSettings', async () => {
  const host = await client();
  const created = next(host, 'room-created');
  host.emit('create-room', {
    player: { name: 'Charles' },
    settings: { wedgesToWin: 99, timerSeconds: -5, selectedCategories: ['constructor'], boardType: 'piege' },
  });
  const { roomCode } = await created;
  const settings = rooms.get(roomCode)!.settings;
  assert.equal(settings.wedgesToWin, 6);
  assert.equal(settings.timerSeconds, 60);
  assert.equal(settings.boardType, 'wheel');
  assert.deepEqual(settings.selectedCategories, []);
});

test('un pack contenant une question null est refusé', async () => {
  const host = await client();
  const { roomCode } = await createRoom(host);
  const refused = next(host, 'error-msg');
  host.emit('add-custom-pack', { roomCode, themeName: 'Piège', questions: [null] });
  assert.match(await refused, /invalide/);
  assert.equal(rooms.get(roomCode)!.gameState.customPacks?.length ?? 0, 0);

  const accepted = next(host, 'game-state-update');
  host.emit('add-custom-pack', {
    roomCode,
    themeName: 'Harry Potter',
    questions: [{
      id: 'q_choisi_par_le_client',
      categoryId: 'cinema',
      question: 'Quel sorcier porte une cicatrice en forme d’éclair ?',
      options: ['Harry', 'Ron', 'Drago', 'Neville'],
      correctAnswerIndex: 0,
      difficulty: 'ado',
    }],
  });
  await accepted;
  const pack = rooms.get(roomCode)!.gameState.customPacks![0];
  assert.equal(pack.questions.length, 1);
  assert.notEqual(pack.questions[0].id, 'q_choisi_par_le_client');
  assert.equal(pack.questions[0].themePack, 'Harry Potter');
});

async function tableOfTwo() {
  const host = await client();
  const { roomCode } = await createRoom(host, 'Charles');
  const guest = await client();
  const joined = next(guest, 'room-joined');
  guest.emit('join-room', { roomCode, player: { name: 'Laura' } });
  await joined;
  return { host, guest, roomCode, room: rooms.get(roomCode)! };
}

test('une réaction ne se relaie qu’entre membres, depuis la liste, une par seconde', async () => {
  const { host, guest, roomCode } = await tableOfTwo();
  const outsider = await client();

  // Un non-membre qui connaît le code ne parle pas au salon.
  outsider.emit('send-emoji', { roomCode, emoji: '🔥' });
  await silence(host, 'emoji-received');

  // Un membre, mais avec un objet à la place de l'emoji.
  guest.emit('send-emoji', { roomCode, emoji: { toString: null } });
  guest.emit('send-emoji', { roomCode, emoji: '💩' });
  await silence(host, 'emoji-received');

  const received = next(host, 'emoji-received');
  guest.emit('send-emoji', { roomCode, emoji: '👏' });
  assert.equal((await received).emoji, '👏');

  // La seconde, dans la même seconde, est ignorée.
  guest.emit('send-emoji', { roomCode, emoji: '🎉' });
  await silence(host, 'emoji-received');
});

test('en partie, un joueur ne change plus que son avatar', async () => {
  const host = await client();
  const { roomCode } = await createRoom(host, 'Charles', { isLocalMode: true });
  const room = rooms.get(roomCode)!;
  room.gameState.phase = 'rolling';
  const updated = next(host, 'game-state-update');
  host.emit('update-player', { roomCode, player: { name: 'Autre', difficulty: 'enfant', avatarId: 'owl' } });
  await updated;
  const me = room.gameState.players[0];
  assert.equal(me.name, 'Charles');
  assert.equal(me.difficulty, 'adulte');
  assert.equal(me.avatarId, 'owl');
});

test('les nouveaux codes ont six caractères, les anciens restent rejoignables', async () => {
  const host = await client();
  const { roomCode } = await createRoom(host);
  assert.match(roomCode, /^FAM-[A-Z2-9]{6}$/);

  // Un salon à quatre caractères, comme ceux qu'a laissés la version d'avant.
  const legacy = rooms.get(roomCode)!;
  rooms.delete(roomCode);
  legacy.code = 'FAM-ABCD';
  legacy.gameState.roomCode = 'FAM-ABCD';
  rooms.set('FAM-ABCD', legacy);
  const guest = await client();
  const joined = next(guest, 'room-joined');
  guest.emit('join-room', { roomCode: ' fam-abcd ', player: { name: 'Laura' } });
  assert.equal((await joined).roomCode, 'FAM-ABCD');
});

test('la force brute sur les codes de salon est coupée', async () => {
  const host = await client();
  const { roomCode } = await createRoom(host);
  const attacker = await client();
  const disconnected = next(attacker, 'disconnect', 3000);
  for (let i = 0; i < 11; i += 1) {
    attacker.emit('join-room', { roomCode: `FAM-ZZZZ${'23456789'[i % 8]}${'23456789'[Math.floor(i / 8)]}`, player: { name: 'X' } });
  }
  // Même le bon code, essayé ensuite, ne passe plus : la connexion est coupée.
  attacker.emit('join-room', { roomCode, player: { name: 'X' } });
  await disconnected;
  assert.equal(rooms.get(roomCode)!.gameState.players.length, 1);
});

test('un flot d’événements est tari, puis la connexion coupée', async () => {
  const flooder = await client();
  const disconnected = next(flooder, 'disconnect', 3000);
  for (let i = 0; i < 400; i += 1) flooder.emit('toggle-ready', { roomCode: 'FAM-ZZZZZZ' });
  await disconnected;
});

test('une page d’une autre origine ne se connecte pas', async () => {
  await assert.rejects(client(url, { Origin: 'https://pirate.example' }));
  const local = await client(url, { Origin: url });
  assert.ok(local.connected);
});

test('trois salons ouverts par adresse, pas un de plus', async () => {
  const ownRooms = new Map<string, Room>();
  const { instance, url: ownUrl } = await startServer(ownRooms);
  const own: ClientSocket[] = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const host = await client(ownUrl);
      own.push(host);
      await createRoom(host, `Hôte ${i}`);
    }
    const fourth = await client(ownUrl);
    own.push(fourth);
    const refused = next(fourth, 'error-msg');
    fourth.emit('create-room', { player: { name: 'Encore' }, settings: {} });
    assert.match(await refused, /plusieurs salons/);
    assert.equal(ownRooms.size, 3);
  } finally {
    for (const socket of own) socket.disconnect();
    await instance.close();
  }
});

test('un appel refusé d’un inconnu ne rafraîchit pas le salon', async () => {
  const host = await client();
  const { roomCode } = await createRoom(host);
  const room = rooms.get(roomCode)!;
  room.lastActivityAt = 1;
  const outsider = await client();
  outsider.emit('start-game', { roomCode });
  outsider.emit('toggle-pause', { roomCode });
  await silence(outsider, 'game-state-update', 200);
  assert.equal(room.lastActivityAt, 1);
  const updated = next(host, 'game-state-update');
  host.emit('update-settings', { roomCode, settings: { wedgesToWin: 3 } });
  await updated;
  assert.ok(room.lastActivityAt > 1);
});

/** Attend que le serveur ait vu partir un appareil. */
async function until(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition jamais remplie');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Une partie lancée où Christelle vient de perdre le réseau avec quatre camemberts. */
async function tableWithLostSeat() {
  const { host, guest, roomCode, room } = await tableOfTwo();
  const christelle = await client();
  const joined = next(christelle, 'room-joined');
  christelle.emit('join-room', { roomCode, player: { name: 'Christelle' } });
  await joined;
  room.gameState.phase = 'rolling';
  const seat = room.gameState.players.find(player => player.name === 'Christelle')!;
  seat.wedges = ['histoire', 'art', 'sports', 'cinema'];
  christelle.disconnect();
  await until(() => !seat.isConnected);
  return { host, guest, roomCode, room, seat };
}

test('un intrus ne reprend pas le siège de l’organisateur par son prénom', async () => {
  const { host, roomCode, room } = await tableOfTwo();
  room.gameState.phase = 'rolling';
  host.disconnect();
  await until(() => !room.gameState.players[0].isConnected);

  const intruder = await client();
  const refused = next(intruder, 'error-msg');
  intruder.on('room-joined', () => assert.fail('l’intrus a obtenu une place'));
  intruder.emit('join-room', { roomCode, player: { name: 'charles' } });
  assert.match(await refused, /organisateur/);
  assert.equal(room.hostSocketId, room.gameState.players[0].id);
  assert.ok(!room.sockets.has(intruder.id!));
});

test('organisateur présent : reprendre une place se demande, et s’obtient s’il accepte', async () => {
  const { host, roomCode, room, seat } = await tableWithLostSeat();
  const returning = await client();
  const askedHost = next(host, 'seat-requests');
  const pending = next(returning, 'seat-request-pending');
  returning.emit('join-room', { roomCode, player: { name: 'christelle' } });

  assert.equal((await pending).kind, 'reclaim');
  const requests = await askedHost;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, 'Christelle');
  assert.equal(requests[0].wedgeCount, 4);
  // Rien n'est rendu tant que l'organisateur n'a pas répondu.
  assert.equal(seat.isConnected, false);

  const joined = next(returning, 'room-joined');
  host.emit('answer-seat-request', { roomCode, requestId: requests[0].id, accept: true });
  const payload = await joined;
  assert.equal(payload.player.wedges.length, 4);
  assert.equal(payload.generationToken, undefined);
  assert.equal(seat.id, returning.id);
  assert.ok(room.sockets.has(returning.id!));
});

test('organisateur présent : une demande refusée est refusée', async () => {
  const { host, roomCode, seat } = await tableWithLostSeat();
  const intruder = await client();
  const asked = next(host, 'seat-requests');
  intruder.emit('join-room', { roomCode, player: { name: 'Christelle' } });
  const [request] = await asked;

  const refused = next(intruder, 'seat-request-refused');
  host.emit('answer-seat-request', { roomCode, requestId: request.id, accept: false });
  assert.match((await refused).message, /pas accepté/);
  assert.equal(seat.isConnected, false);
});

test('organisateur présent : un nouveau venu en pleine partie attend son accord', async () => {
  const { host, roomCode, room } = await tableOfTwo();
  room.gameState.phase = 'rolling';
  const newcomer = await client();
  const asked = next(host, 'seat-requests');
  const pending = next(newcomer, 'seat-request-pending');
  newcomer.emit('join-room', { roomCode, player: { name: 'Thomas' } });
  assert.equal((await pending).kind, 'join');
  const [request] = await asked;
  assert.equal(room.gameState.players.length, 2);

  const joined = next(newcomer, 'room-joined');
  host.emit('answer-seat-request', { roomCode, requestId: request.id, accept: true });
  assert.equal((await joined).player.name, 'Thomas');
  assert.equal(room.gameState.players.length, 3);
});

test('organisateur absent : une place ordinaire se reprend encore toute seule', async () => {
  const { host, roomCode, room, seat } = await tableWithLostSeat();
  host.disconnect();
  await until(() => !room.sockets.has(room.hostSocketId));
  const returning = await client();
  const joined = next(returning, 'room-joined');
  returning.emit('join-room', { roomCode, player: { name: 'Christelle' } });
  assert.equal((await joined).player.wedges.length, 4);
  assert.equal(seat.isConnected, true);
});

test('un appareil ne rejoint pas deux fois la même table, ni deux tables à la fois', async () => {
  const { guest, roomCode, room } = await tableOfTwo();
  const refused = next(guest, 'error-msg');
  guest.emit('join-room', { roomCode, player: { name: 'Laura bis' } });
  assert.match(await refused, /déjà à cette table/);
  assert.equal(room.gameState.players.length, 2);

  const otherHost = await client();
  const other = await createRoom(otherHost, 'Paul');
  const joined = next(guest, 'room-joined');
  guest.emit('join-room', { roomCode: other.roomCode, player: { name: 'Laura' } });
  await joined;
  assert.ok(!room.sockets.has(guest.id!));
  assert.equal(room.gameState.players.length, 1);
});

/** Laura a la main, Charles — assis juste avant elle — lit la carte. */
async function questionForLaura(question: Partial<Question>, startedAgoMs = 0) {
  const table = await tableOfTwo();
  // Laisse passer les mises à jour de l'arrivée de Laura avant de poser la carte.
  await new Promise(resolve => setTimeout(resolve, 100));
  const { room } = table;
  room.settings.isReaderMode = true;
  room.settings.timerSeconds = 30;
  room.gameState.phase = 'question';
  room.gameState.activePlayerIndex = 1;
  room.gameState.questionStartTime = Date.now() - startedAgoMs;
  room.gameState.currentQuestion = {
    id: 'q_test',
    categoryId: 'histoire',
    question: 'Quel navire a conduit les Pères pèlerins en Amérique ?',
    options: [],
    correctAnswerIndex: 0,
    difficulty: 'ado',
    ...question,
  };
  return table;
}

test('le joueur actif ne s’auto-valide pas une carte ouverte ; le lecteur, si', async () => {
  const { host, guest, roomCode, room } = await questionForLaura({ format: 'open', answer: 'Le Mayflower' });
  guest.emit('submit-answer', { roomCode, optionIndex: 0 });
  await silence(host, 'game-state-update');
  assert.equal(room.gameState.lastAnswerResult, null);

  const judged = next(host, 'game-state-update');
  host.emit('submit-answer', { roomCode, optionIndex: 0 });
  await judged;
  assert.equal(room.gameState.lastAnswerResult?.isCorrect, true);
});

test('le joueur actif peut toujours passer une carte ouverte', async () => {
  const { host, guest, roomCode, room } = await questionForLaura({ format: 'open', answer: 'Le Mayflower' });
  const passed = next(host, 'game-state-update');
  guest.emit('submit-answer', { roomCode, optionIndex: -1 });
  await passed;
  assert.equal(room.gameState.lastAnswerResult?.isCorrect, false);
});

test('une bonne réponse arrivée après le minuteur compte comme un temps écoulé', async () => {
  const { host, guest, roomCode, room } = await questionForLaura({
    format: 'mcq',
    options: ['Le Mayflower', 'La Santa Maria', 'Le Titanic', 'Le Bounty'],
  }, 40_000);
  const answered = next(host, 'game-state-update');
  guest.emit('submit-answer', { roomCode, optionIndex: 0 });
  await answered;
  assert.equal(room.gameState.lastAnswerResult?.isCorrect, false);
  assert.equal(room.gameState.lastAnswerResult?.selectedOption, -1);
});

test('un client aux connexions multiples ne bloque pas la file des demandes', async () => {
  const { host, roomCode, room } = await tableOfTwo();
  room.gameState.phase = 'rolling';
  // Le serveur lit l'adresse dans la dernière entrée de X-Forwarded-For, comme
  // derrière le proxy de Railway : de quoi simuler deux foyers.
  const attackerAddress = { 'X-Forwarded-For': '203.0.113.9' };
  const attackers: ClientSocket[] = [];
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const socket = await client(url, attackerAddress);
    attackers.push(socket);
    const outcome = Promise.race([
      next(socket, 'seat-request-pending').then(() => 'attente'),
      next(socket, 'error-msg').then(() => 'refus'),
    ]);
    socket.emit('join-room', { roomCode, player: { name: `Intrus ${i}` } });
    outcomes.push(await outcome);
  }
  assert.deepEqual(outcomes, ['attente', 'attente', 'refus', 'refus', 'refus', 'refus']);

  const family = await client(url, { 'X-Forwarded-For': '198.51.100.4' });
  const pending = next(family, 'seat-request-pending');
  family.emit('join-room', { roomCode, player: { name: 'Thomas' } });
  assert.equal((await pending).name, 'Thomas');
  assert.equal(room.seatRequests?.length, 3);

  // Une connexion qui s'en va emporte sa demande.
  const leavingId = attackers[0].id;
  attackers[0].disconnect();
  await until(() => room.seatRequests?.length === 2);
  assert.ok(!room.seatRequests!.some(request => request.socketId === leavingId));

  // Éconduite, l'adresse ne revient pas aussitôt, même par une connexion neuve.
  const [intruderRequest] = room.seatRequests!.filter(request => request.name.startsWith('Intrus'));
  host.emit('answer-seat-request', { roomCode, requestId: intruderRequest.id, accept: false });
  await until(() => room.seatRefusals?.has('203.0.113.9') === true);
  const again = await client(url, attackerAddress);
  const refused = next(again, 'error-msg');
  again.emit('join-room', { roomCode, player: { name: 'Intrus encore' } });
  assert.match(await refused, /refusé/);
});

test('une fusion exige que l’appareil du doublon soit connecté', async () => {
  const { host, roomCode, room, seat } = await tableWithLostSeat();
  // Un doublon arrivé au salon, puis reparti à son tour.
  room.gameState.phase = 'lobby';
  const duplicate = await client();
  const joined = next(duplicate, 'room-joined');
  duplicate.emit('join-room', { roomCode, player: { name: 'Chris' } });
  const duplicateId = (await joined).player.id;
  room.gameState.phase = 'rolling';
  duplicate.disconnect();
  await until(() => !room.sockets.has(duplicateId));

  host.emit('merge-player', { roomCode, sourcePlayerId: duplicateId, targetPlayerId: seat.id });
  await silence(host, 'game-state-update', 200);
  assert.equal(seat.isConnected, false);
  assert.ok(!room.sockets.has(duplicateId));
});

test('un pion ne se pose pas sur une case qui n’existe pas', async () => {
  const host = await client();
  const { roomCode } = await createRoom(host, 'Charles', { isLocalMode: true });
  const room = rooms.get(roomCode)!;
  room.gameState.phase = 'moving';
  room.gameState.possibleMoves = [];
  const before = room.gameState.players[0].currentTileId;
  host.emit('move-player', { roomCode, destinationTileId: 9999 });
  host.emit('move-player', { roomCode, destinationTileId: { id: 1 } });
  await silence(host, 'game-state-update', 200);
  assert.equal(room.gameState.players[0].currentTileId, before);
  assert.equal(room.gameState.phase, 'moving');
});

