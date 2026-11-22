import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_GENERATIONS_PER_DAY,
  DEFAULT_MAX_AI_TOKENS_PER_DAY,
  DailyBudget,
  SlidingWindowQuota,
  dailyBudgetStorePath,
  ipQuotaKey,
  parseDailyLimit,
} from '../src/server/generationQuota';

test('une IPv4 compte seule, y compris sous sa forme IPv6 mappée', () => {
  assert.equal(ipQuotaKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipQuotaKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipQuotaKey(undefined), 'inconnue');
});

test('les adresses IPv6 d’un même /64 partagent leur quota', () => {
  const first = ipQuotaKey('2001:db8:abcd:12::1');
  const second = ipQuotaKey('2001:0db8:abcd:0012:ffff:ffff:ffff:fffe');
  const third = ipQuotaKey('2001:db8:abcd:12:dead:beef::42');
  assert.equal(first, '2001:0db8:abcd:0012::/64');
  assert.equal(second, first);
  assert.equal(third, first);
  assert.notEqual(ipQuotaKey('2001:db8:abcd:13::1'), first, 'le /64 voisin est un autre abonné');
  assert.equal(ipQuotaKey('::1'), '0000:0000:0000:0000::/64');
  assert.equal(ipQuotaKey('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
});

test('changer d’adresse dans son /64 ne contourne plus le quota', () => {
  const quota = new SlidingWindowQuota(2, 60_000);
  assert.ok(quota.consume(ipQuotaKey('2001:db8::1'), 0));
  assert.ok(quota.consume(ipQuotaKey('2001:db8::2'), 1));
  assert.equal(quota.consume(ipQuotaKey('2001:db8::3'), 2), false);
  assert.ok(quota.consume(ipQuotaKey('2001:db8::4'), 60_001), 'la fenêtre glisse');
});

test('les entrées expirées sont purgées de la mémoire', () => {
  const quota = new SlidingWindowQuota(1, 1000);
  for (let index = 0; index < 50; index += 1) quota.consume(`10.0.0.${index}`, 0);
  assert.equal(quota.size, 50);
  quota.consume('10.0.1.1', 5000);
  assert.equal(quota.size, 1, 'seule la clé encore active reste');
});

test('le budget global refuse au-delà du plafond, puis repart le lendemain', () => {
  const day = Date.UTC(2026, 10, 20, 12);
  const budget = new DailyBudget(2, null, day);
  assert.ok(budget.tryConsume(day));
  assert.ok(budget.tryConsume(day + 1));
  assert.equal(budget.tryConsume(day + 2), false);
  assert.ok(budget.tryConsume(day + 24 * 60 * 60 * 1000));
  assert.equal(budget.used, 1);
});

test('un plafond à zéro coupe la génération', () => {
  const budget = new DailyBudget(0, null);
  assert.equal(budget.tryConsume(), false);
});

test('le budget survit à un redémarrage quand DATA_DIR est configuré', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  try {
    const storePath = dailyBudgetStorePath(directory)!;
    const day = Date.UTC(2026, 10, 20, 8);
    const before = new DailyBudget(3, storePath, day);
    before.tryConsume(day);
    before.tryConsume(day);
    assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')), { day: '2026-11-20', count: 2 });

    const after = new DailyBudget(3, storePath, day + 1000);
    assert.equal(after.used, 2);
    assert.ok(after.tryConsume(day + 1000));
    assert.equal(after.tryConsume(day + 1001), false);

    const tomorrow = new DailyBudget(3, storePath, day + 24 * 60 * 60 * 1000);
    assert.equal(tomorrow.used, 0, 'le compteur d’hier ne compte plus');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('le budget de tokens compte ce que le fournisseur facture, et s’arrête au plafond', () => {
  const day = Date.UTC(2026, 10, 22, 9);
  const tokens = new DailyBudget(10_000, null, day);
  tokens.add(4600, day);
  tokens.add(4600, day);
  assert.equal(tokens.isExhausted(day), false);
  // Un lot parti avant que le plafond tombe est facturé quand même : il compte.
  tokens.add(4600, day);
  assert.equal(tokens.used, 13_800);
  assert.equal(tokens.isExhausted(day), true);
  tokens.add(Number.NaN, day);
  tokens.add(-50, day);
  assert.equal(tokens.used, 13_800, 'un relevé absent ou absurde ne compte pas');
  assert.equal(tokens.isExhausted(day + 24 * 60 * 60 * 1000), false);
});

test('les plafonds se lisent dans l’environnement, avec leur propre défaut', () => {
  assert.equal(parseDailyLimit(undefined, DEFAULT_MAX_AI_TOKENS_PER_DAY), 2_000_000);
  assert.equal(parseDailyLimit('200000', DEFAULT_MAX_AI_TOKENS_PER_DAY), 200_000);
  assert.equal(parseDailyLimit('2_000_000', DEFAULT_MAX_AI_TOKENS_PER_DAY), 2_000_000);
  assert.equal(parseDailyLimit('beaucoup', DEFAULT_MAX_AI_TOKENS_PER_DAY), 2_000_000);
  assert.equal(parseDailyLimit(undefined), DEFAULT_MAX_GENERATIONS_PER_DAY);
});

test('sans DATA_DIR, le budget reste en mémoire', () => {
  assert.equal(dailyBudgetStorePath(undefined), null);
  assert.equal(dailyBudgetStorePath('  '), null);
});

test('MAX_GENERATIONS_PER_DAY : entier positif ou nul, sinon le défaut', () => {
  assert.equal(parseDailyLimit(undefined), DEFAULT_MAX_GENERATIONS_PER_DAY);
  assert.equal(parseDailyLimit(''), DEFAULT_MAX_GENERATIONS_PER_DAY);
  assert.equal(parseDailyLimit('50'), 50);
  assert.equal(parseDailyLimit('0'), 0);
  assert.equal(parseDailyLimit('-3'), DEFAULT_MAX_GENERATIONS_PER_DAY);
  assert.equal(parseDailyLimit('beaucoup'), DEFAULT_MAX_GENERATIONS_PER_DAY);
  assert.equal(DEFAULT_MAX_GENERATIONS_PER_DAY, 200);
});
