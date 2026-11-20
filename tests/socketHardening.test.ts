import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import { GameSocketServer, Room, attachGameSocketServer } from '../src/server/gameSocketServer';

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

before(async () => {
  const httpServer = createServer();
  server = attachGameSocketServer(httpServer, { rooms, persist: () => {} });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const client of clients) client.disconnect();
  await server.close();
});

async function client(): Promise<ClientSocket> {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
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

