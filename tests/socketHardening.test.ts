import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import { GameSocketServer, Room, SocketLimits, attachGameSocketServer } from '../src/server/gameSocketServer';

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

