import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_CODE_ALPHABET, generateRoomCode, normalizeRoomCode } from '../src/server/roomCodes';
import {
  FailureWindow,
  TokenBucket,
  addressKey,
  clientAddress,
  isAllowedOrigin,
  parsePublicOrigins,
} from '../src/server/socketGuards';

test('un code neuf a six caractères de l’alphabet sans ambiguïté', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateRoomCode(() => false);
    assert.match(code, /^FAM-[A-Z2-9]{6}$/);
    for (const char of code.slice(4)) assert.ok(ROOM_CODE_ALPHABET.includes(char));
    // Et le serveur le reconnaît, comme il reconnaît encore les codes à quatre.
    assert.equal(normalizeRoomCode(code.toLowerCase()), code);
  }
  assert.equal(normalizeRoomCode('FAM-ABCD'), 'FAM-ABCD');
});

test('un code déjà pris est retiré, et l’échec est franc', () => {
  const taken = new Set(['FAM-AAAAAA']);
  let calls = 0;
  const sequence = () => (calls++ < 6 ? 0 : 1);
  assert.equal(generateRoomCode(code => taken.has(code), sequence), 'FAM-BBBBBB');
  assert.throws(() => generateRoomCode(() => true));
});

test('le seau à jetons laisse passer une rafale, puis le débit soutenu', () => {
  const bucket = new TokenBucket(3, 2, 0);
  assert.ok(bucket.take(0) && bucket.take(0) && bucket.take(0));
  assert.ok(!bucket.take(0));
  assert.ok(!bucket.take(400));
  assert.ok(bucket.take(500));
  // Il ne se remplit jamais au-delà de sa capacité.
  assert.ok(bucket.take(60_000) && bucket.take(60_000) && bucket.take(60_000));
  assert.ok(!bucket.take(60_000));
});

test('au-delà de dix codes inconnus par minute, la clé est bloquée', () => {
  const window = new FailureWindow(10, 60_000);
  for (let i = 0; i < 10; i += 1) assert.equal(window.record('a', i * 1000), false);
  assert.equal(window.record('a', 10_000), true);
  assert.ok(window.isBlocked('a', 10_000));
  assert.ok(!window.isBlocked('b', 10_000));
  // Les échecs sortent de la fenêtre au bout d'une minute.
  assert.ok(!window.isBlocked('a', 71_000));
});

test('le compteur d’échecs ne grossit pas sans fin', () => {
  const window = new FailureWindow(1, 60_000, 3);
  for (const key of ['a', 'b', 'c', 'd']) window.record(key, 0);
  window.record('d', 0);
  assert.ok(window.isBlocked('d', 0));
  window.record('a', 0);
  assert.ok(!window.isBlocked('a', 0), 'la clé la plus ancienne a été oubliée');
});

test('une adresse IPv6 compte pour son /64, une IPv4 transportée pour elle-même', () => {
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(addressKey('192.0.2.7'), '192.0.2.7');
  assert.equal(addressKey('[fe80::1%eth0]'), 'fe80:0:0:0::/64');
});

test('derrière le proxy, seule la dernière entrée de X-Forwarded-For fait foi', () => {
  // La première est écrite par le client, et se falsifie à volonté.
  assert.equal(clientAddress('10.0.0.1', '6.6.6.6, 198.51.100.4'), '198.51.100.4');
  assert.equal(clientAddress('10.0.0.1', ['6.6.6.6', '198.51.100.4']), '198.51.100.4');
  assert.equal(clientAddress('::ffff:127.0.0.1', undefined), '127.0.0.1');
});

test('une connexion vient de la page du jeu, ou d’une origine déclarée', () => {
  assert.ok(isAllowedOrigin('http://localhost:3000', ['localhost:3000', undefined], []));
  assert.ok(isAllowedOrigin('https://jeu.example', ['interne:8080', 'jeu.example'], []));
  assert.ok(!isAllowedOrigin('https://pirate.example', ['jeu.example', undefined], []));
  assert.ok(isAllowedOrigin('https://autre.example', ['jeu.example', undefined], ['https://autre.example']));
  assert.ok(!isAllowedOrigin('pas une url', ['jeu.example', undefined], []));
  // Sans en-tête Origin : pas un navigateur, l'origine ne le concerne pas.
  assert.ok(isAllowedOrigin(undefined, ['jeu.example', undefined], []));
  assert.deepEqual(parsePublicOrigins(' https://a.example/ , nimporte quoi,http://b.example:8080'), [
    'https://a.example',
    'http://b.example:8080',
  ]);
});
