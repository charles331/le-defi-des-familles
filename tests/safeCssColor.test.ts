import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_PLAYER_COLOR, luminance, safeCssColor, shade, tint, withAlpha } from '../src/utils/motion';

test('safeCssColor refuse la charge d’injection qui refermait le dégradé', () => {
  const payload = 'red 0%,red 100%),url(https://evil.example/t.png),linear-gradient(red';
  assert.equal(safeCssColor(payload), FALLBACK_PLAYER_COLOR);
  assert.equal(safeCssColor('#fff;background:url(x)'), FALLBACK_PLAYER_COLOR);
  assert.equal(safeCssColor('#fff\n'), '#fff');
  assert.equal(safeCssColor('red'), FALLBACK_PLAYER_COLOR);
  assert.equal(safeCssColor('rgb(1,2,3)'), FALLBACK_PLAYER_COLOR);
  assert.equal(safeCssColor('#12345'), FALLBACK_PLAYER_COLOR);
  assert.equal(safeCssColor('#1234567'), FALLBACK_PLAYER_COLOR);
  assert.equal(safeCssColor('#ggg'), FALLBACK_PLAYER_COLOR);
  assert.equal(safeCssColor('3B82F6'), FALLBACK_PLAYER_COLOR);
});

test('safeCssColor renvoie le repli pour une valeur qui n’est pas une chaîne', () => {
  for (const value of [undefined, null, 42, {}, ['#fff'], { toString: () => '#fff' }]) {
    assert.equal(safeCssColor(value), FALLBACK_PLAYER_COLOR);
  }
  assert.equal(safeCssColor(null, '#000'), '#000');
});

test('safeCssColor accepte #rgb et #rrggbb, majuscules comprises', () => {
  assert.equal(safeCssColor('#3B82F6'), '#3b82f6');
  assert.equal(safeCssColor('#abc'), '#abc');
  assert.equal(safeCssColor('#ABC'), '#abc');
  assert.equal(safeCssColor('  #ef4444 '), '#ef4444');
});

test('les helpers de couleur ne plantent plus sur une couleur absurde', () => {
  const bad = { not: 'a string' } as unknown as string;
  assert.doesNotThrow(() => shade(bad, 0.5));
  assert.doesNotThrow(() => tint(bad, 0.5));
  assert.doesNotThrow(() => luminance(bad));
  assert.match(withAlpha('url(x)', 0.5), /^rgba\(\d+, \d+, \d+, 0\.5\)$/);
  // La forme courte reste développée comme avant.
  assert.equal(withAlpha('#f00', 1), 'rgba(255, 0, 0, 1)');
});
