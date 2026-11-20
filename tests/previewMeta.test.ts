import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  escapeHtmlAttribute,
  previewOrigin,
  requestOrigin,
  withAbsolutePreviewImages,
} from '../src/server/previewMeta';

const indexHtml = readFileSync(path.join(process.cwd(), 'index.html'), 'utf-8');

test('les images d’aperçu passent en adresse absolue', () => {
  const rendered = withAbsolutePreviewImages(indexHtml, 'https://jeu.example.com');

  assert.match(
    rendered,
    /<meta property="og:image" content="https:\/\/jeu\.example\.com\/og-image\.png" \/>/,
  );
  assert.match(
    rendered,
    /<meta name="twitter:image" content="https:\/\/jeu\.example\.com\/og-image\.png" \/>/,
  );
  assert.equal(rendered.includes('content="/og-image.png"'), false);
});

test('les autres balises et les icônes ne sont pas touchées', () => {
  const rendered = withAbsolutePreviewImages(indexHtml, 'https://jeu.example.com');

  assert.match(rendered, /<title>Le Défi des Familles<\/title>/);
  assert.match(rendered, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
  assert.match(rendered, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png" \/>/);
  assert.match(rendered, /<meta property="og:image:width" content="1200" \/>/);
});

test('sans origine connue, la page est livrée telle quelle', () => {
  assert.equal(withAbsolutePreviewImages(indexHtml, ''), indexHtml);
});

test('l’origine annoncée suit la requête, ou la configuration si elle existe', () => {
  const request = {
    protocol: 'https',
    get: (header: string) => (header === 'host' ? 'trivial.up.railway.app' : undefined),
  };

  assert.equal(previewOrigin(request, undefined), 'https://trivial.up.railway.app');
  assert.equal(previewOrigin(request, ''), 'https://trivial.up.railway.app');
  assert.equal(previewOrigin(request, 'https://jeu.famille.be/'), 'https://jeu.famille.be');
  assert.equal(
    previewOrigin({ protocol: 'http', get: () => undefined }, undefined),
    '',
    'sans hôte, aucune réécriture plutôt qu’une adresse inventée',
  );
});

test('la page annonce bien un visuel d’aperçu et ses icônes', () => {
  for (const expected of [
    'property="og:image"',
    'property="og:image:width"',
    'property="og:image:height"',
    'name="twitter:card" content="summary_large_image"',
    'rel="apple-touch-icon"',
    'rel="icon" type="image/svg+xml"',
  ]) {
    assert.ok(indexHtml.includes(expected), `balise manquante : ${expected}`);
  }
});

test('un en-tête Host piégé ne sort pas de la balise meta', () => {
  const hostile = (host: string, protocol = 'https') => ({
    protocol,
    get: (header: string) => (header === 'host' ? host : undefined),
  });

  for (const host of ['x"><script>alert(1)</script>', "jeu.be'onload=x", 'jeu.be/chemin', 'jeu .be', 'a@b']) {
    assert.equal(previewOrigin(hostile(host), undefined), '', `hôte refusé : ${host}`);
  }
  assert.equal(previewOrigin(hostile('jeu.be', 'javascript'), undefined), '', 'protocole refusé');
  assert.equal(previewOrigin(hostile('Jeu.Example.com:8443'), undefined), 'https://jeu.example.com:8443');
  assert.equal(requestOrigin(hostile('localhost:3000', 'http')), 'http://localhost:3000');
});

test('PUBLIC_ORIGIN prime sur l’hôte de la requête, et doit être une adresse http(s)', () => {
  const request = { protocol: 'https', get: () => 'attaquant.example' };
  assert.equal(previewOrigin(request, 'https://jeu.famille.be/chemin?x=1'), 'https://jeu.famille.be');
  assert.equal(previewOrigin(request, 'javascript:alert(1)'), 'https://attaquant.example');
  assert.equal(previewOrigin(request, 'pas une adresse'), 'https://attaquant.example');
});

test('l’origine est échappée dans l’attribut, quoi qu’on lui passe', () => {
  assert.equal(escapeHtmlAttribute(`a"b'c<d>e&f`), 'a&quot;b&#39;c&lt;d&gt;e&amp;f');
  const rendered = withAbsolutePreviewImages(indexHtml, 'https://x"><script>');
  assert.ok(!rendered.includes('"><script>'));
  assert.match(rendered, /content="https:\/\/x&quot;&gt;&lt;script&gt;\/og-image\.png"/);
});
