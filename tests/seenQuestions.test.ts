import assert from 'node:assert/strict';
import test from 'node:test';
import { reviveStoredRoom } from '../roomStore';
import { createGameStateView } from '../src/server/gameStateView';
import { pickQuestionForPlayer } from '../src/server/questionSelection';
import {
  MAX_SHARED_SEEN_IDS,
  preferUnseen,
  rememberSeenQuestions,
  sanitizeSeenQuestionIds,
} from '../src/server/seenQuestions';
import { Question } from '../src/types';
import { MAX_SEEN_QUESTIONS, withSeenQuestion } from '../src/utils/seenQuestions';
import { createGameState, createPlayer, testQuestion, testSettings } from './fixtures';

/**
 * La mémoire des cartes vues d'une partie à l'autre. Une famille qui joue chaque
 * semaine retombait sur les mêmes questions : « Rejouer » oubliait les cartes
 * posées, et chaque salon repartait de toute la banque.
 */

const card = (id: string, overrides: Partial<Question> = {}): Question => ({
  ...testQuestion,
  id,
  question: `Question ${id} ?`,
  categoryId: 'histoire',
  difficulty: 'enfant',
  ...overrides,
});

/** Trois cartes enfant d'histoire, toutes jamais posées dans ce salon. */
function smallBank() {
  return createGameState({
    phase: 'rolling',
    settings: { ...testSettings, isReaderMode: false },
    questionsPool: [card('a'), card('b'), card('c')],
    usedQuestionIds: [],
    customPacks: [],
  });
}

test('le salon sert d’abord les cartes que personne à la table n’a vues', () => {
  for (let draw = 0; draw < 20; draw += 1) {
    const state = smallBank();
    rememberSeenQuestions(state, ['a', 'b']);
    assert.equal(pickQuestionForPlayer(state, 'histoire', 'enfant').id, 'c');
  }
});

test('déjà tout vu : on ressert une carte vue plutôt que rien, ou une carte d’un autre niveau', () => {
  const state = smallBank();
  state.questionsPool.push(card('adulte', { difficulty: 'adulte' }));
  rememberSeenQuestions(state, ['a', 'b', 'c']);
  const served = pickQuestionForPlayer(state, 'histoire', 'enfant');
  assert.ok(['a', 'b', 'c'].includes(served.id));
});

test('dans la partie, une carte déjà posée passe encore après une carte vue ailleurs', () => {
  const state = smallBank();
  state.usedQuestionIds = ['a', 'b'];
  rememberSeenQuestions(state, ['c']);
  // Seule c n'a pas été posée ici : vue la semaine dernière, elle sort quand même.
  assert.equal(pickQuestionForPlayer(state, 'histoire', 'enfant').id, 'c');
});

test('seules les cartes que le salon peut servir sont retenues, les dernières en priorité', () => {
  const servable = new Set(['a', 'b', 'c']);
  assert.deepEqual(sanitizeSeenQuestionIds(['a', 'inconnue', 'b', 'a', 42, { id: 'c' }, 'c d', 'x'.repeat(200)], servable), ['a', 'b']);
  assert.deepEqual(sanitizeSeenQuestionIds('a,b', servable), []);
  assert.deepEqual(sanitizeSeenQuestionIds(null, servable), []);

  const many = Array.from({ length: MAX_SHARED_SEEN_IDS + 10 }, (_, i) => `q${i}`);
  const kept = sanitizeSeenQuestionIds(many, new Set(many));
  assert.equal(kept.length, MAX_SHARED_SEEN_IDS);
  assert.equal(kept.at(-1), `q${MAX_SHARED_SEEN_IDS + 9}`);
});

test('les appareils de la table additionnent leurs cartes vues, sans doublon', () => {
  const state = smallBank();
  assert.equal(rememberSeenQuestions(state, ['a']), 1);
  assert.equal(rememberSeenQuestions(state, ['a', 'b', 'pas-ici']), 1);
  assert.deepEqual(state.seenQuestionIds, ['a', 'b']);
});

test('préférer n’est jamais exclure', () => {
  const list = [card('a'), card('b')];
  assert.deepEqual(preferUnseen(list, new Set()), list);
  assert.deepEqual(preferUnseen(list, new Set(['a'])).map(q => q.id), ['b']);
  assert.deepEqual(preferUnseen(list, new Set(['a', 'b'])), list);
});

test('l’appareil garde ses cartes les plus récentes, sans doublon', () => {
  assert.deepEqual(withSeenQuestion(['a', 'b'], 'a'), ['b', 'a']);
  const full = Array.from({ length: MAX_SEEN_QUESTIONS }, (_, i) => `q${i}`);
  const next = withSeenQuestion(full, 'neuve');
  assert.equal(next.length, MAX_SEEN_QUESTIONS);
  assert.equal(next[0], 'q1');
  assert.equal(next.at(-1), 'neuve');
});

test('la liste des cartes vues reste sur le serveur', () => {
  const state = createGameState({ seenQuestionIds: ['q1'] });
  assert.equal('seenQuestionIds' in createGameStateView(state, 'host', 'host'), false);
});

test('la mémoire du salon survit à un redémarrage, purgée de ce qui n’est pas un identifiant', () => {
  const { questionsPool: _pool, ...state } = createGameState({
    players: [createPlayer('host', true)],
    seenQuestionIds: ['q1', 42 as never, 'q2'],
  });
  const now = Date.now();
  const room = reviveStoredRoom({
    code: 'FAM-TEST', hostSocketId: 'host', generationToken: 'jeton', reconnectTokens: {},
    settings: testSettings, createdAt: now, lastActivityAt: now, emptySince: null, hostDisconnectedAt: null,
    gameState: state,
  }, [card('q1'), card('q2')], v => v, now);
  assert.ok(room && room !== 'expired');
  assert.deepEqual(room.gameState.seenQuestionIds, ['q1', 'q2']);
});
