import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PENDING_ICE_CANDIDATES,
  PUBLIC_STUN_SERVERS,
  buildIceConfiguration,
  countLiveConnections,
  describeAudience,
  enqueueBounded,
  isAllowedViewer,
  sanitizeIceServers
} from '../src/utils/media';

const players = [
  { id: 'moi', isConnected: true },
  { id: 'lea', isConnected: true },
  { id: 'tom', isConnected: false }
];

test('isAllowedViewer : seul un joueur assis et connecté reçoit notre flux', () => {
  assert.equal(isAllowedViewer('lea', players, 'moi'), true);
  // Déconnecté : sa connexion serait morte, et son identifiant peut être repris.
  assert.equal(isAllowedViewer('tom', players, 'moi'), false);
  // Inconnu de la table : un identifiant relayé ne suffit pas.
  assert.equal(isAllowedViewer('intrus', players, 'moi'), false);
  // Jamais à soi-même.
  assert.equal(isAllowedViewer('moi', players, 'moi'), false);
});

test('isAllowedViewer : entrées malformées refusées sans lever', () => {
  assert.equal(isAllowedViewer(undefined, players, 'moi'), false);
  assert.equal(isAllowedViewer({ id: 'lea' }, players, 'moi'), false);
  assert.equal(isAllowedViewer('', players, ''), false);
  assert.equal(isAllowedViewer('lea', undefined, 'moi'), false);
  assert.equal(isAllowedViewer('lea', null, 'moi'), false);
});

test('enqueueBounded : la file des candidates ICE plafonne puis ignore', () => {
  const queue: number[] = [];
  for (let i = 0; i < MAX_PENDING_ICE_CANDIDATES; i += 1) {
    assert.equal(enqueueBounded(queue, i), true);
  }
  assert.equal(enqueueBounded(queue, 999), false);
  assert.equal(queue.length, MAX_PENDING_ICE_CANDIDATES);
  // On garde les premières, on n'évince rien.
  assert.equal(queue[0], 0);
  assert.equal(queue.includes(999), false);
  assert.equal(MAX_PENDING_ICE_CANDIDATES, 50);
});

test('countLiveConnections : seules les connexions établies comptent', () => {
  assert.equal(
    countLiveConnections([
      { connectionState: 'connected' },
      { connectionState: 'connecting', iceConnectionState: 'checking' },
      { iceConnectionState: 'completed' },
      { connectionState: 'failed', iceConnectionState: 'failed' },
      {}
    ]),
    2
  );
  assert.equal(countLiveConnections(new Map().values()), 0);
});

test('describeAudience : singulier, pluriel et personne', () => {
  assert.equal(describeAudience(0), 'En direct · personne ne vous voit encore');
  assert.equal(describeAudience(1), 'En direct · 1 personne vous voit');
  assert.equal(describeAudience(3), 'En direct · 3 personnes vous voient');
  assert.equal(describeAudience(Number.NaN), 'En direct · personne ne vous voit encore');
});

test('buildIceConfiguration : sans rien, les STUN publics seuls', () => {
  assert.deepEqual(buildIceConfiguration(), { iceServers: [...PUBLIC_STUN_SERVERS] });
});

test('buildIceConfiguration : le TURN statique reste servi à l’identique en repli', () => {
  const config = buildIceConfiguration(undefined, {
    url: 'turn:turn.example.org:3478',
    username: 'u',
    credential: 'c'
  });
  assert.deepEqual(config.iceServers, [
    ...PUBLIC_STUN_SERVERS,
    { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'c' }
  ]);
});

test('buildIceConfiguration : des serveurs fournis à l’exécution remplacent le TURN statique', () => {
  const runtime = [{ urls: ['turn:relay.example.org:3478?transport=udp'], username: '1700000000:p', credential: 'eph' }];
  const config = buildIceConfiguration(runtime, { url: 'turn:static.example.org', username: 'u', credential: 'c' });
  assert.deepEqual(config.iceServers, [...PUBLIC_STUN_SERVERS, ...runtime]);
});

test('sanitizeIceServers : écarte les entrées mal formées au lieu de faire tomber le direct', () => {
  assert.deepEqual(sanitizeIceServers('turn:x'), []);
  assert.deepEqual(
    sanitizeIceServers([
      null,
      'turn:x',
      { urls: 'https://evil.example' },
      { urls: [] },
      { urls: ['turn:ok.example', 42] },
      { urls: 'stun:ok.example', username: 7, credential: 'c' }
    ]),
    [{ urls: 'stun:ok.example', credential: 'c' }]
  );
  // Une liste entièrement invalide retombe sur le repli.
  assert.deepEqual(buildIceConfiguration([{ urls: 'javascript:alert(1)' }]), { iceServers: [...PUBLIC_STUN_SERVERS] });
});
