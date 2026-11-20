import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOST_NAME_REFUSAL,
  NAME_TAKEN_REFUSAL,
  QUEUE_FULL,
  REFUSED_RECENTLY,
  SEAT_REFUSAL_COOLDOWN_MS,
  SEAT_REQUEST_TTL_MS,
  SeatRequest,
  TOO_MANY_FROM_ADDRESS,
  admitSeatRequest,
  decideArrival,
  describeSeatRequest,
  isExpired,
} from '../src/server/seatRequests';
import { findAbandonedSeat } from '../src/server/seats';
import { createGameState, createPlayer } from './fixtures';

// La table de l'audit : Charles organise, Christelle a perdu le réseau avec
// quatre camemberts, Laura joue.
function table(phase: 'lobby' | 'rolling' = 'rolling', hostConnected = true) {
  return createGameState({
    phase,
    players: [
      { ...createPlayer('host', true), name: 'Charles', isConnected: hostConnected },
      { ...createPlayer('seat-christelle'), name: 'Christelle', isConnected: false, wedges: ['histoire', 'art', 'sports', 'cinema'] },
      { ...createPlayer('seat-laura'), name: 'Laura' },
    ],
  });
}

const present = { hostSeatId: 'host', hostConnected: true };
const absent = { hostSeatId: 'host', hostConnected: false };

test('le siège de l’organisateur ne se reprend jamais au prénom', () => {
  // Même déconnecté, même en son absence : c'était devenir organisateur.
  const state = table('rolling', false);
  assert.deepEqual(decideArrival(state, 'charles', absent), { kind: 'refuse', message: HOST_NAME_REFUSAL });
  assert.deepEqual(decideArrival(state, ' CHARLES ', present), { kind: 'refuse', message: HOST_NAME_REFUSAL });
  assert.equal(findAbandonedSeat(state, 'Charles'), null);
});

test('organisateur présent : la reprise d’une place devient une demande', () => {
  const decision = decideArrival(table(), 'christelle', present);
  assert.equal(decision.kind, 'ask-reclaim');
  assert.equal(decision.kind === 'ask-reclaim' && decision.seat.id, 'seat-christelle');
});

test('organisateur absent : la reprise reste automatique, pour ne pas bloquer la famille', () => {
  const decision = decideArrival(table('rolling', false), 'Christelle', absent);
  assert.equal(decision.kind, 'reclaim');
});

test('une arrivée en cours de partie se demande, une arrivée au salon est libre', () => {
  assert.deepEqual(decideArrival(table('rolling'), 'Thomas', present), { kind: 'ask-join' });
  assert.deepEqual(decideArrival(table('lobby'), 'Thomas', present), { kind: 'join' });
  assert.deepEqual(decideArrival(table('rolling', false), 'Thomas', absent), { kind: 'join' });
  assert.deepEqual(decideArrival(table('rolling'), null, present), { kind: 'ask-join' });
});

test('un prénom porté par un joueur présent est refusé', () => {
  assert.deepEqual(decideArrival(table(), 'laura', present), { kind: 'refuse', message: NAME_TAKEN_REFUSAL });
  const local = table('lobby');
  local.players.push({ ...createPlayer('local_1'), name: 'Mamie' });
  assert.equal(decideArrival(local, 'Mamie', present).kind, 'refuse');
});

test('une demande expire au bout de deux minutes', () => {
  const request: SeatRequest = {
    id: 'r', socketId: 's', addressKey: '192.0.2.1', kind: 'join', seatId: null, name: 'Thomas',
    avatarId: 'fox', color: '#3B82F6', difficulty: 'ado', createdAt: 1000,
  };
  assert.ok(!isExpired(request, 1000 + SEAT_REQUEST_TTL_MS - 1));
  assert.ok(isExpired(request, 1000 + SEAT_REQUEST_TTL_MS));
});

test('l’organisateur voit ce qu’il rend, jamais l’identifiant d’un socket', () => {
  const view = describeSeatRequest({
    id: 'r', socketId: 'socket-secret', addressKey: '192.0.2.1', kind: 'reclaim', seatId: 'seat-christelle', name: 'christelle',
    avatarId: 'owl', color: '#3B82F6', difficulty: 'ado', createdAt: 0,
  }, table());
  assert.deepEqual(view, { id: 'r', kind: 'reclaim', name: 'Christelle', avatarId: 'lion', color: '#000000', wedgeCount: 4 });
  assert.ok(!JSON.stringify(view).includes('socket-secret'));
  assert.ok(!JSON.stringify(view).includes('192.0.2.1'));
});

function pending(socketId: string, addressKey: string, createdAt = 0): SeatRequest {
  return {
    id: socketId, socketId, addressKey, kind: 'join', seatId: null, name: socketId,
    avatarId: 'fox', color: '#3B82F6', difficulty: 'ado', createdAt,
  };
}

test('une même adresse ne remplit pas la file à elle seule', () => {
  // L'attaquant ouvre autant de connexions qu'il veut, depuis la même box.
  const queue = [pending('a1', '203.0.113.9'), pending('a2', '203.0.113.9')];
  assert.deepEqual(admitSeatRequest(queue, { socketId: 'a3', addressKey: '203.0.113.9' }, undefined, 1), {
    ok: false, message: TOO_MANY_FROM_ADDRESS,
  });
  // La famille, ailleurs, dépose toujours la sienne.
  assert.deepEqual(admitSeatRequest(queue, { socketId: 'f1', addressKey: '198.51.100.4' }, undefined, 1), { ok: true });
  // Une connexion n'a qu'une demande à la fois.
  assert.equal(admitSeatRequest(queue, { socketId: 'a1', addressKey: '198.51.100.4' }, undefined, 1).ok, false);
});

test('la file d’un salon reste bornée, et une demande expirée n’y compte plus', () => {
  const queue = [1, 2, 3, 4, 5].map(i => pending(`s${i}`, `192.0.2.${i}`));
  assert.deepEqual(admitSeatRequest(queue, { socketId: 'x', addressKey: '192.0.2.99' }, undefined, 1), {
    ok: false, message: QUEUE_FULL,
  });
  assert.deepEqual(
    admitSeatRequest(queue, { socketId: 'x', addressKey: '192.0.2.99' }, undefined, SEAT_REQUEST_TTL_MS + 1),
    { ok: true },
  );
});

test('après un refus, l’adresse attend avant de redemander', () => {
  const until = 1000 + SEAT_REFUSAL_COOLDOWN_MS;
  assert.deepEqual(admitSeatRequest([], { socketId: 'x', addressKey: 'a' }, until, 1000), {
    ok: false, message: REFUSED_RECENTLY,
  });
  assert.deepEqual(admitSeatRequest([], { socketId: 'x', addressKey: 'a' }, until, until), { ok: true });
});
