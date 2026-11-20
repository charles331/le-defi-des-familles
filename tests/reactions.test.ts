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

test('la barre de réactions propose la liste que le serveur relaie', () => {
  // Un emoji ajouté d'un seul côté serait envoyé puis silencieusement refusé :
  // la barre ne s'écrit plus sa propre liste, elle lit celle du serveur.
  const source = readFileSync(new URL('../src/components/LiveChat.tsx', import.meta.url), 'utf8');
  assert.match(source, /REACTION_EMOJIS\.map\(/);
  assert.doesNotMatch(source, /EMOJI_LIST/);
});
