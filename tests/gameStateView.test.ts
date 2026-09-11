import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameStateView } from '../src/server/gameStateView';
import { createGameState, createPlayer } from './fixtures';

test('the public state never contains the question pool or used IDs', () => {
  const view = createGameStateView(createGameState(), 'host', 'host');
  assert.equal('questionsPool' in view, false);
  assert.equal('usedQuestionIds' in view, false);
  assert.deepEqual(view.customPacks, [{ name: 'Famille', questionCount: 1 }]);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 5000);
});

test('the solution is hidden from active player and spectators before validation', () => {
  const state = createGameState();
  const activeView = createGameStateView(state, 'host', 'host');
  const spectatorView = createGameStateView(state, 'spectator', 'host');

  for (const view of [activeView, spectatorView]) {
    assert.equal(view.currentQuestion?.correctAnswerIndex, undefined);
    assert.equal(view.currentQuestion?.explanation, undefined);
  }
});

test('only the designated reader sees the solution while the question is live', () => {
  const state = createGameState({
    settings: {
      ...createGameState().settings,
      isReaderMode: true,
    },
  });

  const readerView = createGameStateView(state, 'reader', 'host');
  const activeView = createGameStateView(state, 'host', 'host');
  assert.equal(readerView.currentQuestion?.correctAnswerIndex, 1);
  assert.match(readerView.currentQuestion?.explanation ?? '', /réponse attendue/);
  assert.equal(activeView.currentQuestion?.correctAnswerIndex, undefined);
});

test('the solution is revealed to everyone after validation', () => {
  const state = createGameState({ phase: 'evaluating' });
  const view = createGameStateView(state, 'spectator', 'host');
  assert.equal(view.currentQuestion?.correctAnswerIndex, 1);
  assert.ok(view.currentQuestion?.explanation);
});

test('at a full table the solution goes to the preceding player only', () => {
  const state = createGameState({
    players: [createPlayer('a', true), createPlayer('b'), createPlayer('c'), createPlayer('d')],
    activePlayerIndex: 2,
  });
  state.settings = { ...state.settings, isReaderMode: true };

  assert.equal(createGameStateView(state, 'b', 'a').currentQuestion?.correctAnswerIndex, 1);
  for (const spectatorId of ['a', 'c', 'd']) {
    assert.equal(
      createGameStateView(state, spectatorId, 'a').currentQuestion?.correctAnswerIndex,
      undefined,
    );
  }
});

test('la passe de lecture déplace la solution vers le lecteur suivant, écran par écran', () => {
  // Le lecteur naturel de c (actif) est b. Quand b rend la lecture
  // (`declinesReading`), c'est a qui lit : la solution doit le suivre — et ne
  // rester ni chez b (qui a passé), ni chez le joueur actif, ni chez le
  // spectateur d.
  const state = createGameState({
    players: [createPlayer('a', true), createPlayer('b'), createPlayer('c'), createPlayer('d')],
    activePlayerIndex: 2,
  });
  state.settings = { ...state.settings, isReaderMode: true };
  state.players[1].declinesReading = true;

  assert.equal(createGameStateView(state, 'a', 'a').currentQuestion?.correctAnswerIndex, 1);
  for (const otherId of ['b', 'c', 'd']) {
    assert.equal(
      createGameStateView(state, otherId, 'a').currentQuestion?.correctAnswerIndex,
      undefined,
      `la solution ne doit pas partir vers ${otherId}`,
    );
  }

  // b reprend la lecture : la solution lui revient, et quitte a.
  state.players[1].declinesReading = false;
  assert.equal(createGameStateView(state, 'b', 'a').currentQuestion?.correctAnswerIndex, 1);
  assert.equal(createGameStateView(state, 'a', 'a').currentQuestion?.correctAnswerIndex, undefined);
});

test('si tous les autres rendent la lecture, personne ne reçoit la solution', () => {
  // Jamais de repli vers le joueur actif : sans lecteur possible, la carte
  // s'affiche (côté client) mais la solution reste sur le serveur.
  const state = createGameState();
  state.settings = { ...state.settings, isReaderMode: true };
  state.players[1].declinesReading = true;

  assert.equal(createGameStateView(state, 'host', 'host').currentQuestion?.correctAnswerIndex, undefined);
  assert.equal(createGameStateView(state, 'reader', 'host').currentQuestion?.correctAnswerIndex, undefined);
});

test('the live duo hands the solution to the reader without reader mode set', () => {
  const state = createGameState({
    players: [createPlayer('a', true), createPlayer('b'), createPlayer('c')],
    activePlayerIndex: 0,
  });
  state.settings = { ...state.settings, isReaderMode: false, enableLiveCamera: true };

  assert.equal(createGameStateView(state, 'c', 'a').currentQuestion?.correctAnswerIndex, 1);
  assert.equal(createGameStateView(state, 'b', 'a').currentQuestion?.correctAnswerIndex, undefined);
});

test('reader mode does not reveal the solution to a lone online player', () => {
  const state = createGameState();
  state.players = [state.players[0]];
  state.settings = { ...state.settings, isReaderMode: true, isLocalMode: false };
  const view = createGameStateView(state, 'host', 'host');
  assert.equal(view.currentQuestion?.correctAnswerIndex, undefined);
});
