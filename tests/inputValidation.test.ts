import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBoardCategories } from '../src/data/boards';
import { MAX_SOCKET_PAYLOAD_BYTES } from '../src/server/gameSocketServer';
import {
  MAX_CUSTOM_EXPLANATION_LENGTH,
  MAX_CUSTOM_OPTION_LENGTH,
  MAX_CUSTOM_QUESTION_LENGTH,
  cleanText,
  reviveStoredPlayer,
  reviveStoredSettings,
  sanitizeAvatarId,
  sanitizeColor,
  sanitizeCustomQuestion,
  sanitizeDifficulty,
  sanitizePlayerName,
  sanitizePlayerProfile,
  sanitizeSettings,
  sanitizeThemeName,
} from '../src/server/inputValidation';
import { reviveStoredRoom } from '../roomStore';
import { normalizeRoomCode } from '../src/server/roomCodes';
import { createGameState, createPlayer, testSettings } from './fixtures';

// Les caractères invisibles sont construits ici plutôt que tapés : un éditeur
// les cacherait, et c'est justement ce qu'on leur reproche.
const RLO = String.fromCharCode(0x202e);
const LRI = String.fromCharCode(0x2066);
const LRM = String.fromCharCode(0x200e);

test('un prénom est une chaîne nettoyée de 1 à 18 caractères', () => {
  assert.equal(sanitizePlayerName('  Christelle  '), 'Christelle');
  assert.equal(sanitizePlayerName('Jean \n\t Luc'), 'Jean Luc');
  assert.equal(sanitizePlayerName(''), null);
  assert.equal(sanitizePlayerName('   '), null);
  assert.equal(sanitizePlayerName('a'.repeat(40))?.length, 18);
  // Les types qui faisaient planter `normalizeSeatName` et `start-game`.
  assert.equal(sanitizePlayerName({ toString: 'x' }), null);
  assert.equal(sanitizePlayerName(42), null);
  assert.equal(sanitizePlayerName(['Christelle']), null);
  assert.equal(sanitizePlayerName(null), null);
});

test('un prénom perd ses marques de direction et ses caractères de contrôle', () => {
  // « Telle » affiché, « elleT » écrit : de quoi se faire passer pour un autre.
  assert.equal(sanitizePlayerName(`${RLO}elleT`), 'elleT');
  assert.equal(sanitizePlayerName(`Chris${LRI}telle${LRM}`), 'Christelle');
  assert.equal(sanitizePlayerName(`Papa\u0000\u0007`), 'Papa');
  assert.equal(sanitizePlayerName(RLO), null);
});

test('un emoji n’est jamais coupé en deux par la troncature', () => {
  const name = `${'a'.repeat(17)}🦊🦊`;
  assert.equal(cleanText(name, 18), `${'a'.repeat(17)}🦊`);
});

test('avatar, couleur et niveau inconnus retombent sur la valeur par défaut', () => {
  assert.equal(sanitizeAvatarId('owl', 'lion'), 'owl');
  assert.equal(sanitizeAvatarId('<img>', 'lion'), 'lion');
  assert.equal(sanitizeAvatarId(7, 'lion'), 'lion');
  assert.equal(sanitizeColor('#ef4444', '#000000'), '#ef4444');
  assert.equal(sanitizeColor('#14B8A6', '#000000'), '#14B8A6');
  // `color: 1` faisait planter `add-local-player` sur `.toLowerCase()`.
  assert.equal(sanitizeColor(1, '#000000'), '#000000');
  assert.equal(sanitizeColor('red; background:url(x)', '#000000'), '#000000');
  assert.equal(sanitizeDifficulty('ado', 'adulte'), 'ado');
  assert.equal(sanitizeDifficulty('expert', 'adulte'), 'adulte');
});

test('un profil absent ou malformé donne un profil complet et sûr', () => {
  const defaults = { avatarId: 'fox', color: '#3B82F6', difficulty: 'adulte' as const };
  assert.deepEqual(sanitizePlayerProfile(undefined, defaults), { name: null, ...defaults });
  assert.deepEqual(sanitizePlayerProfile('Laura', defaults), { name: null, ...defaults });
  assert.deepEqual(
    sanitizePlayerProfile({ name: { a: 1 }, avatarId: 'owl', color: 1, difficulty: 'enfant' }, defaults),
    { name: null, avatarId: 'owl', color: '#3B82F6', difficulty: 'enfant' },
  );
});

test('« constructor » n’est pas une catégorie', () => {
  const clean = sanitizeSettings({
    selectedCategories: ['constructor', 'toString', '__proto__', 'histoire', 'histoire', 'sports'],
  });
  assert.deepEqual(clean.selectedCategories, ['histoire', 'sports']);
  const board = resolveBoardCategories(['constructor' as never, 'hasOwnProperty' as never, 'cinema']);
  assert.equal(board.length, 6);
  assert.equal(board[0], 'cinema');
  assert.ok(!board.includes('constructor' as never));
});

test('des réglages qui ne sont pas un objet ne donnent rien', () => {
  assert.deepEqual(sanitizeSettings(null), {});
  assert.deepEqual(sanitizeSettings('wheel'), {});
  assert.deepEqual(sanitizeSettings([1, 2]), {});
});

test('les thèmes actifs sont des noms bornés et dédoublonnés', () => {
  const clean = sanitizeSettings({
    customThemePackNames: ['Harry Potter', 'harry potter', 42, '', 'x'.repeat(500), ...Array(30).fill('t').map((t, i) => `${t}${i}`)],
  });
  assert.equal(clean.customThemePackNames?.[0], 'Harry Potter');
  assert.equal(clean.customThemePackNames?.[1].length, 100);
  assert.equal(clean.customThemePackNames?.length, 12);
  assert.equal(sanitizeThemeName({}), null);
});

const validQuestion = {
  categoryId: 'cinema',
  question: 'Quel sorcier porte une cicatrice en forme d’éclair ?',
  options: ['Harry Potter', 'Ron Weasley', 'Drago Malefoy', 'Neville Londubat'],
  correctAnswerIndex: 0,
  explanation: 'Elle lui vient du sort lancé par Voldemort quand il était bébé.',
  difficulty: 'ado',
};

test('une carte de pack valide est refaite par le serveur', () => {
  const clean = sanitizeCustomQuestion(
    { ...validQuestion, id: 'q_du_client', themePack: 'autre chose' },
    { id: 'custom_1', themePack: 'Harry Potter' },
  );
  assert.ok(clean);
  assert.equal(clean.id, 'custom_1');
  assert.equal(clean.themePack, 'Harry Potter');
  assert.equal(clean.format, undefined);
  assert.equal(clean.options.length, 4);
});

test('une carte malformée est refusée, jamais réparée', () => {
  const ctx = { id: 'x', themePack: 'T' };
  const refuse = (raw: unknown) => assert.equal(sanitizeCustomQuestion(raw, ctx), null, JSON.stringify(raw));
  refuse(null);
  refuse('question');
  refuse({ ...validQuestion, options: undefined });
  refuse({ ...validQuestion, options: ['seule'] });
  refuse({ ...validQuestion, options: ['a', 'b', 'c', 'd', 'e'] });
  refuse({ ...validQuestion, options: ['a', null, 'c', 'd'] });
  refuse({ ...validQuestion, correctAnswerIndex: 4 });
  refuse({ ...validQuestion, correctAnswerIndex: -1 });
  refuse({ ...validQuestion, correctAnswerIndex: 1.5 });
  refuse({ ...validQuestion, correctAnswerIndex: '0' });
  refuse({ ...validQuestion, categoryId: 'constructor' });
  refuse({ ...validQuestion, format: 'piege' });
  refuse({ ...validQuestion, question: 'x'.repeat(MAX_CUSTOM_QUESTION_LENGTH + 1) });
  refuse({ ...validQuestion, options: ['x'.repeat(MAX_CUSTOM_OPTION_LENGTH + 1), 'b'] });
  refuse({ ...validQuestion, explanation: 'x'.repeat(MAX_CUSTOM_EXPLANATION_LENGTH + 1) });
  refuse({ ...validQuestion, explanation: { html: '<b>' } });
  refuse({ ...validQuestion, format: 'boolean', options: ['Vrai', 'Faux', 'Peut-être'] });
  refuse({ ...validQuestion, format: 'open', options: [], answer: '' });
});

test('Vrai/Faux et carte ouverte gardent leur forme', () => {
  const ctx = { id: 'x', themePack: 'T' };
  const bool = sanitizeCustomQuestion({ ...validQuestion, format: 'boolean', options: ['Vrai', 'Faux'], correctAnswerIndex: 1 }, ctx);
  assert.equal(bool?.format, 'boolean');
  assert.equal(bool?.correctAnswerIndex, 1);
  const open = sanitizeCustomQuestion({ ...validQuestion, format: 'open', options: ['ignorée'], correctAnswerIndex: 3, answer: 'Harry Potter' }, ctx);
  assert.equal(open?.format, 'open');
  assert.deepEqual(open?.options, []);
  assert.equal(open?.correctAnswerIndex, 0);
  assert.equal(open?.answer, 'Harry Potter');
});

test('une description WebRTC tient largement dans un message', () => {
  // Les packs ne transitent plus par le client : les plus gros messages
  // légitimes sont désormais les offres du direct. Une offre très chargée
  // (audio, vidéo, nombreux codecs et candidats) dépasse rarement 20 ko.
  const sdp = 'a=rtpmap:96 VP8/90000\r\n'.repeat(1000).slice(0, 20_000);
  const payload = { roomCode: 'FAM-ABCDEF', targetPlayerId: 'x'.repeat(20), offer: { type: 'offer', sdp } };
  const bytes = Buffer.byteLength(`42${JSON.stringify(['webrtc-offer', payload])}`);
  assert.ok(bytes * 2 < MAX_SOCKET_PAYLOAD_BYTES, `${bytes} octets pour une limite de ${MAX_SOCKET_PAYLOAD_BYTES}`);
});

test('un code de salon garde sa forme, quatre ou six caractères', () => {
  assert.equal(normalizeRoomCode(' fam-abcd '), 'FAM-ABCD');
  assert.equal(normalizeRoomCode('FAM-ABCDEF'), 'FAM-ABCDEF');
  assert.equal(normalizeRoomCode('FAM-ABC'), null);
  assert.equal(normalizeRoomCode('FAM-ABCDEFG'), null);
  // I, O, 0 et 1 ne sont jamais tirés : un code qui en contient est faux.
  assert.equal(normalizeRoomCode('FAM-ABC0'), null);
  assert.equal(normalizeRoomCode({ code: 'FAM-ABCD' }), null);
  assert.equal(normalizeRoomCode('FAM-' + 'A'.repeat(10_000)), null);
});

test('un joueur relu du disque est revalidé', () => {
  const player = reviveStoredPlayer({ ...createPlayer('Christelle'), color: 1, avatarId: 'inconnu', wedges: ['histoire', 'constructor'] });
  assert.ok(player);
  assert.equal(player.color, '#EF4444');
  assert.equal(player.avatarId, 'lion');
  assert.deepEqual(player.wedges, ['histoire']);
  assert.equal(player.isConnected, false);
  assert.equal(reviveStoredPlayer({ ...createPlayer('x'), name: { evil: true } }), null);
  assert.equal(reviveStoredPlayer(null), null);
});

test('des réglages relus du disque repassent par le même filtre', () => {
  const settings = reviveStoredSettings({ ...testSettings, wedgesToWin: 99, selectedCategories: ['constructor', 'art'] }, 'FAM-TEST');
  assert.equal(settings.wedgesToWin, 6);
  assert.deepEqual(settings.selectedCategories, ['art']);
  assert.equal(settings.roomCode, 'FAM-TEST');
});

function storedRoom(gameState: Record<string, unknown>) {
  const now = Date.now();
  return {
    code: 'FAM-TEST',
    hostSocketId: 'host',
    generationToken: 'jeton',
    reconnectTokens: { host: 'a' },
    settings: testSettings,
    createdAt: now,
    lastActivityAt: now,
    emptySince: null,
    hostDisconnectedAt: null,
    gameState,
  };
}

test('un salon sauvegardé avec un prénom piégé est écarté, pas rejoué', () => {
  const { questionsPool: _pool, ...state } = createGameState({
    players: [createPlayer('host', true), { ...createPlayer('x'), name: { a: 1 } as never }],
  });
  assert.equal(reviveStoredRoom(storedRoom(state), [], v => v, Date.now()), null);
});

test('un pack sauvegardé avec une carte null perd la carte, le salon survit', () => {
  const { questionsPool: _pool, ...state } = createGameState({
    players: [createPlayer('host', true)],
    customPacks: [{ name: 'Harry Potter', questions: [null as never, { ...validQuestion, id: 'custom_a' } as never] }],
  });
  const room = reviveStoredRoom(storedRoom(state), [], v => v, Date.now());
  assert.ok(room && room !== 'expired');
  assert.equal(room.gameState.customPacks?.[0].questions.length, 1);
  assert.equal(room.gameState.customPacks?.[0].questions[0].id, 'custom_a');
  assert.equal(room.gameState.questionsPool.length, 1);
});

test('une carte en cours devenue illisible ramène le tour au lancer', () => {
  const { questionsPool: _pool, ...state } = createGameState({
    phase: 'question',
    players: [createPlayer('host', true)],
    currentQuestion: { question: 'sans options' } as never,
  });
  const room = reviveStoredRoom(storedRoom(state), [], v => v, Date.now());
  assert.ok(room && room !== 'expired');
  assert.equal(room.gameState.phase, 'rolling');
  assert.equal(room.gameState.currentQuestion, null);
});

test('un prénom effacé au salon ne fait pas perdre le salon au redémarrage', () => {
  // `update-player` garde un champ vidé tel quel jusqu'au lancement ; la
  // sauvegarde l'écrit, la relecture doit l'accepter.
  const player = reviveStoredPlayer({ ...createPlayer('Christelle'), name: '' });
  assert.ok(player);
  assert.equal(player.name, '');
});
