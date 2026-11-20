import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOST_NAME_REFUSAL,
  NAME_TAKEN_REFUSAL,
  SEAT_REQUEST_TTL_MS,
  SeatRequest,
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
    id: 'r', socketId: 's', kind: 'join', seatId: null, name: 'Thomas',
    avatarId: 'fox', color: '#3B82F6', difficulty: 'ado', createdAt: 1000,
  };
  assert.ok(!isExpired(request, 1000 + SEAT_REQUEST_TTL_MS - 1));
  assert.ok(isExpired(request, 1000 + SEAT_REQUEST_TTL_MS));
});

test('l’organisateur voit ce qu’il rend, jamais l’identifiant d’un socket', () => {
  const view = describeSeatRequest({
    id: 'r', socketId: 'socket-secret', kind: 'reclaim', seatId: 'seat-christelle', name: 'christelle',
    avatarId: 'owl', color: '#3B82F6', difficulty: 'ado', createdAt: 0,
  }, table());
  assert.deepEqual(view, { id: 'r', kind: 'reclaim', name: 'Christelle', avatarId: 'lion', color: '#000000', wedgeCount: 4 });
  assert.ok(!JSON.stringify(view).includes('socket-secret'));
});
