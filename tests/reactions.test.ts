import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { REACTION_EMOJIS, isReactionEmoji } from '../src/config/reactions';

test('seuls les emojis proposés par l’interface sont des réactions', () => {
  assert.ok(isReactionEmoji('👏'));
  assert.ok(!isReactionEmoji('💩'));
  assert.ok(!isReactionEmoji({ emoji: '👏' }));
  assert.ok(!isReactionEmoji(['👏']));
  assert.ok(!isReactionEmoji('👏'.repeat(1000)));
});

test('la barre de réactions propose exactement la liste que le serveur relaie', () => {
  // Si la barre s'écrit sa propre liste, elle doit rester celle du serveur :
  // un emoji ajouté d'un seul côté serait envoyé puis silencieusement refusé.
  const source = readFileSync(new URL('../src/components/LiveChat.tsx', import.meta.url), 'utf8');
  if (source.includes('REACTION_EMOJIS')) return;
  const literal = source.match(/EMOJI_LIST\s*=\s*\[([^\]]*)\]/);
  assert.ok(literal, 'liste des réactions introuvable dans LiveChat.tsx');
  const emojis = [...literal[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(emojis, [...REACTION_EMOJIS]);
});
