import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_GRACE_MS, judgeAnswer } from '../src/server/answerRules';
import { isDesignatedReader } from '../src/server/gameStateView';
import { createGameState, createPlayer, testSettings } from './fixtures';

const online = { ...testSettings, timerSeconds: 30, isReaderMode: true };
const open = { format: 'open' as const };
const mcq = { format: 'mcq' as const };

test('le joueur actif ne se valide pas sa propre carte ouverte', () => {
  const verdict = judgeAnswer({ question: open, optionIndex: 0, isReader: false, settings: online, questionStartTime: 0, now: 1000 });
  assert.equal(verdict.accepted, false);
  // Il peut toujours passer : c'est le filet quand plus personne ne peut lire.
  assert.deepEqual(
    judgeAnswer({ question: open, optionIndex: -1, isReader: false, settings: online, questionStartTime: 0, now: 1000 }),
    { accepted: true, optionIndex: -1, late: false },
  );
});

test('le lecteur juge la carte ouverte', () => {
  assert.deepEqual(
    judgeAnswer({ question: open, optionIndex: 0, isReader: true, settings: online, questionStartTime: 0, now: 1000 }),
    { accepted: true, optionIndex: 0, late: false },
  );
});

test('une réponse après le minuteur et sa marge compte comme un temps écoulé', () => {
  const deadline = 30_000 + ANSWER_GRACE_MS;
  const base = { question: mcq, optionIndex: 2, isReader: false, settings: online, questionStartTime: 0 };
  assert.equal(judgeAnswer({ ...base, now: deadline }).accepted, true);
  assert.deepEqual(judgeAnswer({ ...base, now: deadline }), { accepted: true, optionIndex: 2, late: false });
  assert.deepEqual(judgeAnswer({ ...base, now: deadline + 1 }), { accepted: true, optionIndex: -1, late: true });
});

test('sans minuteur, roue en cours ou décompte local, pas d’échéance serveur', () => {
  const base = { question: mcq, optionIndex: 2, isReader: false, questionStartTime: 0 as number | null, now: 10 * 60_000 };
  assert.deepEqual(judgeAnswer({ ...base, settings: { ...online, timerSeconds: 0 } }), { accepted: true, optionIndex: 2, late: false });
  assert.deepEqual(judgeAnswer({ ...base, settings: online, questionStartTime: null }), { accepted: true, optionIndex: 2, late: false });
  // Pass & play en mode lecteur : le décompte part quand le lecteur est prêt,
  // sur l'appareil, à un instant que le serveur ignore.
  assert.deepEqual(
    judgeAnswer({ ...base, settings: { ...online, isLocalMode: true } }),
    { accepted: true, optionIndex: 2, late: false },
  );
});

test('le lecteur désigné : le joueur d’avant en ligne, l’organisateur en pass & play', () => {
  const state = createGameState({
    settings: online,
    players: [createPlayer('host', true), createPlayer('laura'), createPlayer('paul')],
    activePlayerIndex: 1,
  });
  assert.ok(isDesignatedReader(state, 'host', 'host'));
  assert.ok(!isDesignatedReader(state, 'laura', 'host'));
  state.settings = { ...online, isLocalMode: true };
  state.activePlayerIndex = 0;
  assert.ok(isDesignatedReader(state, 'host', 'host'));
  state.settings = { ...online, isReaderMode: false };
  assert.ok(!isDesignatedReader(state, 'host', 'host'));
});
