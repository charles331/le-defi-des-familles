import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSIONS_POLICY,
  contentSecurityPolicy,
  finalErrorHandler,
  securityHeaders,
} from '../src/server/httpSecurity';
import { negotiateEncoding } from '../src/server/assetEncoding';

interface FakeResponse {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  contentType?: string;
  headersSent: boolean;
  setHeader(name: string, value: string): void;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  type(value: string): FakeResponse;
  send(body: unknown): FakeResponse;
}

function fakeResponse(): FakeResponse {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    type(value) { this.contentType = value; return this; },
    send(body) { this.body = body; return this; },
  };
}

function fakeRequest(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { host: 'jeu.example.com' };
  return {
    protocol: 'https',
    secure: true,
    method: 'GET',
    path: '/',
    get: (name: string) => headers[name.toLowerCase()],
    ...overrides,
  };
}

function runHeaders(production: boolean, request = fakeRequest()) {
  const response = fakeResponse();
  let nextCalled = false;
  securityHeaders({ production })(request as any, response as any, () => { nextCalled = true; });
  assert.ok(nextCalled, 'le middleware doit passer la main');
  return response.headers;
}

test('en production, la page reçoit la CSP, HSTS et les en-têtes de base', () => {
  const headers = runHeaders(true);

  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['permissions-policy'], PERMISSIONS_POLICY);
  assert.match(headers['strict-transport-security'], /^max-age=\d+/);
  assert.equal(headers['content-security-policy'], contentSecurityPolicy('https://jeu.example.com'));
});

test('HSTS n’est envoyé que sur une connexion chiffrée', () => {
  const headers = runHeaders(true, fakeRequest({ protocol: 'http', secure: false }));
  assert.equal(headers['strict-transport-security'], undefined);
  assert.ok(headers['content-security-policy']);
});

test('en développement, ni CSP ni HSTS : le préambule en ligne de Vite doit passer', () => {
  const headers = runHeaders(false);
  assert.equal(headers['content-security-policy'], undefined);
  assert.equal(headers['strict-transport-security'], undefined);
  assert.equal(headers['x-frame-options'], 'DENY');
});

test('la CSP n’ouvre que ce que le client charge réellement', () => {
  const csp = contentSecurityPolicy('https://jeu.example.com');
  const directives = new Map(csp.split('; ').map((part) => {
    const [name, ...values] = part.split(' ');
    return [name, values] as const;
  }));

  assert.deepEqual(directives.get('script-src'), ["'self'"], 'aucun script en ligne ni externe');
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(directives.get('base-uri'), ["'none'"]);
  assert.ok(directives.get('worker-src')?.includes('blob:'), 'canvas-confetti crée un Worker blob:');
  assert.ok(directives.get('media-src')?.includes('mediastream:'), 'caméra en direct');
  assert.deepEqual(directives.get('connect-src'), ["'self'", 'wss://jeu.example.com']);
  assert.ok(!csp.includes('unsafe-eval'));
});

test('sans hôte fiable, la CSP s’en tient à self', () => {
  assert.match(contentSecurityPolicy(''), /connect-src 'self';/);
  const headers = runHeaders(true, fakeRequest({ get: () => 'evil"host' }));
  assert.match(headers['content-security-policy'], /connect-src 'self';/);
});

test('la Permissions-Policy ouvre caméra et micro à la page, ferme le reste', () => {
  assert.match(PERMISSIONS_POLICY, /camera=\(self\)/);
  assert.match(PERMISSIONS_POLICY, /microphone=\(self\)/);
  assert.match(PERMISSIONS_POLICY, /geolocation=\(\)/);
  assert.match(PERMISSIONS_POLICY, /payment=\(\)/);
});

test('le gestionnaire d’erreurs ne renvoie jamais la pile d’appel', () => {
  const syntaxError = Object.assign(new SyntaxError('Unexpected token } in JSON at position 1'), {
    status: 400,
    type: 'entity.parse.failed',
  });
  const response = fakeResponse();
  finalErrorHandler(syntaxError, fakeRequest({ path: '/api/generate-pack', method: 'POST' }) as any, response as any, () => {});
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'Requête invalide.' });

  const originalError = console.error;
  console.error = () => {};
  try {
    const crash = fakeResponse();
    finalErrorHandler(new Error('secret interne'), fakeRequest() as any, crash as any, () => {});
    assert.equal(crash.statusCode, 500);
    assert.equal(crash.body, 'Erreur interne du serveur.');
    assert.ok(!String(crash.body).includes('secret'));
  } finally {
    console.error = originalError;
  }
});

test('la négociation du codage respecte les poids, refus compris', () => {
  assert.equal(negotiateEncoding('gzip, deflate, br'), 'br');
  assert.equal(negotiateEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(negotiateEncoding('br;q=0'), null);
  assert.equal(negotiateEncoding('gzip;q=0.5, br;q=0.2'), 'gzip');
  assert.equal(negotiateEncoding('*'), 'br');
  assert.equal(negotiateEncoding('*;q=0, gzip'), 'gzip');
  assert.equal(negotiateEncoding('identity'), null);
  assert.equal(negotiateEncoding(undefined), null);
  assert.equal(negotiateEncoding('brotli'), null, 'un nom qui contient « br » n’est pas br');
});
