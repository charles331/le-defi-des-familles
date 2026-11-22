import assert from 'node:assert/strict';
import test from 'node:test';
import { ABSENT_TURN_GRACE_MS, handOverAbsentReader, skipAbsentActivePlayer } from '../src/server/absentPlayers';
import { advanceTurn } from '../src/server/gameEngine';
import { createGameStateView } from '../src/server/gameStateView';
import { cardReaderId, READER_RECONNECT_GRACE_MS, resolveLiveRole, resolveOnAirIds } from '../src/server/turnRoles';
import { createGameState, createPlayer, testSettings } from './fixtures';

const NOW = 1_000_000;

/** Table de trois : Alice répond, Bob (avant elle) lit, Chloé regarde. */
function readAloudCard(overrides: Parameters<typeof createGameState>[0] = {}) {
  return createGameState({
    settings: { ...testSettings, isReaderMode: true },
    players: [createPlayer('chloe', true), createPlayer('bob'), createPlayer('alice')],
    activePlayerIndex: 2,
    readerId: 'bob',
    ...overrides,
  });
}

function dropConnection(state: ReturnType<typeof createGameState>, id: string, at: number) {
  const player = state.players.find(p => p.id === id)!;
  player.isConnected = false;
  player.disconnectedAt = at;
}

test('le lecteur coupé garde sa carte : la solution ne part chez personne d’autre', () => {
  const state = readAloudCard();
  dropConnection(state, 'bob', NOW);

  assert.equal(cardReaderId(state), 'bob');
  // Chloé, simple spectatrice, recevait la solution dès la coupure de Bob.
  assert.equal(createGameStateView(state, 'chloe', 'chloe').currentQuestion?.correctAnswerIndex, undefined);
  assert.equal(handOverAbsentReader(state, NOW + READER_RECONNECT_GRACE_MS - 1), false);
  assert.equal(state.readerId, 'bob');
});

test('passé le délai, le rôle de lecteur passe au joueur connecté précédent', () => {
  const state = readAloudCard();
  dropConnection(state, 'bob', NOW);

  assert.equal(handOverAbsentReader(state, NOW + READER_RECONNECT_GRACE_MS), true);
  assert.equal(state.readerId, 'chloe');
  assert.equal(createGameStateView(state, 'chloe', 'chloe').currentQuestion?.correctAnswerIndex, state.currentQuestion?.correctAnswerIndex);
  // Bob revient trop tard : il ne reprend pas le rôle, la solution ne circule pas deux fois.
  state.players[1].isConnected = true;
  state.players[1].disconnectedAt = null;
  assert.equal(handOverAbsentReader(state, NOW + READER_RECONNECT_GRACE_MS + 1), false);
  assert.equal(cardReaderId(state), 'chloe');
});

test('un joueur qui revient pendant la carte ne prend pas la place du lecteur', () => {
  // Bob était coupé au tirage : Chloé lit. Bob revient, il reste spectateur.
  const state = readAloudCard({ readerId: 'chloe' });
  assert.equal(cardReaderId(state), 'chloe');
  assert.equal(resolveLiveRole(state.players, state.activePlayerIndex, 'bob', cardReaderId(state)), 'spectator');
  assert.deepEqual(resolveOnAirIds(state.players, state.activePlayerIndex, cardReaderId(state)), ['alice', 'chloe']);
});

test('sans lecteur possible, personne ne reçoit la solution, et un lecteur retiré rend la main à l’ordre de la table', () => {
  assert.equal(cardReaderId(readAloudCard({ readerId: null })), null);
  const state = readAloudCard({ readerId: 'parti' });
  assert.equal(cardReaderId(state), 'bob');
});

test('hors d’une carte, ou pour un état sans lecteur fixé, l’ordre de la table décide', () => {
  assert.equal(cardReaderId(readAloudCard({ phase: 'rolling', readerId: 'chloe' })), 'bob');
  assert.equal(cardReaderId(readAloudCard({ readerId: undefined })), 'bob');
  const state = readAloudCard();
  advanceTurn(state);
  assert.equal(state.readerId, undefined);
});

test('le joueur actif absent garde son tour une minute, puis le tour passe au présent suivant', () => {
  const state = readAloudCard({ phase: 'rolling', readerId: undefined });
  // Alice répond (index 2) ; après elle viennent Chloé (0) puis Bob (1).
  dropConnection(state, 'alice', NOW);
  dropConnection(state, 'chloe', NOW);

  assert.equal(skipAbsentActivePlayer(state, NOW + ABSENT_TURN_GRACE_MS - 1), false);
  assert.equal(state.activePlayerIndex, 2);

  assert.equal(skipAbsentActivePlayer(state, NOW + ABSENT_TURN_GRACE_MS), true);
  // Chloé est absente elle aussi : on va directement à Bob.
  assert.equal(state.activePlayerIndex, 1);
  assert.equal(state.phase, 'rolling');
  assert.match(state.lastTurnEventMessage ?? '', /alice a perdu la connexion/);
});

test('un absent pendant sa carte la perd, même après une bonne réponse', () => {
  const state = readAloudCard({
    phase: 'evaluating',
    lastAnswerResult: { playerId: 'alice', isCorrect: true, selectedOption: 0, earnedWedge: null },
  });
  dropConnection(state, 'alice', NOW);

  assert.equal(skipAbsentActivePlayer(state, NOW + ABSENT_TURN_GRACE_MS), true);
  // `advanceTurn` seul l'aurait fait rejouer.
  assert.equal(state.activePlayerIndex, 0);
  assert.equal(state.currentQuestion, null);
  assert.equal(state.readerId, undefined);
});

test('le tour ne passe ni en pass & play, ni en pause, ni sans personne pour reprendre', () => {
  const later = NOW + ABSENT_TURN_GRACE_MS * 2;

  const local = readAloudCard({ phase: 'rolling', settings: { ...testSettings, isLocalMode: true } });
  dropConnection(local, 'alice', NOW);
  assert.equal(skipAbsentActivePlayer(local, later), false);

  const paused = readAloudCard({ phase: 'rolling', isPaused: true });
  dropConnection(paused, 'alice', NOW);
  assert.equal(skipAbsentActivePlayer(paused, later), false);

  const alone = readAloudCard({ phase: 'rolling' });
  for (const id of ['alice', 'bob', 'chloe']) dropConnection(alone, id, NOW);
  assert.equal(skipAbsentActivePlayer(alone, later), false);

  const lobby = readAloudCard({ phase: 'lobby' });
  dropConnection(lobby, 'alice', NOW);
  assert.equal(skipAbsentActivePlayer(lobby, later), false);
});

test('une coupure sans date n’est jamais tranchée sur-le-champ', () => {
  const state = readAloudCard({ phase: 'rolling' });
  state.players[2].isConnected = false;
  assert.equal(skipAbsentActivePlayer(state, NOW), false);
  state.players[1].isConnected = false;
  assert.equal(handOverAbsentReader(readAloudCard({ players: state.players }), NOW), false);
});
