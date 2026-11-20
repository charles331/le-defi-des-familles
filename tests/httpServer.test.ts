/**
 * Le serveur buildé, tel que Railway le lance : `build/server.cjs` sur un port
 * éphémère. On vérifie la surface HTTP réelle — en-têtes, fichiers servis,
 * erreurs — plutôt qu'une copie de sa configuration, parce que c'est l'écart
 * entre les deux qui avait laissé le bundle serveur en accès public.
 *
 * `npm run check` construit avant de tester. Lancé seul sans build, le test
 * est sauté — sauf en CI, où un build manquant est une erreur.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const bundle = path.join(root, 'build', 'server.cjs');
const built = existsSync(bundle) && existsSync(path.join(root, 'dist', 'index.html'));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

function waitForStartup(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`démarrage trop long :\n${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('en ligne sur')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`le serveur s'est arrêté (code ${code}) :\n${output}`));
    });
  });
}

test('le serveur buildé ne sert que le client, avec ses en-têtes de sécurité', {
  skip: !built && !process.env.CI ? 'build/server.cjs absent : lancer `npm run build`' : false,
  timeout: 60_000,
}, async (t) => {
  assert.ok(built, 'build/server.cjs et dist/index.html doivent exister (npm run build)');
  assert.equal(existsSync(path.join(root, 'dist', 'server.cjs')), false, 'le bundle serveur ne vit plus dans dist/');
  const publicFiles = readdirSync(path.join(root, 'dist'), { recursive: true }).map(String);
  assert.deepEqual(publicFiles.filter((file) => /\.(map|cjs|ts|tsx)$/.test(file)), []);

  const port = await freePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'defi-http-'));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  // Sans NODE_ENV : le serveur doit se croire en production par défaut.
  delete env.NODE_ENV;
  delete env.GEMINI_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PUBLIC_ORIGIN;
  const child = spawn(process.execPath, [bundle], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForStartup(child);
  const base = `http://127.0.0.1:${port}`;

  await t.test('la page porte la CSP et les en-têtes de sécurité', async () => {
    const response = await fetch(`${base}/?code=FAM-TEST`);
    assert.equal(response.status, 200);
    const headers = response.headers;
    const csp = headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+;/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(headers.get('permissions-policy') ?? '', /camera=\(self\)/);
    assert.equal(headers.get('x-powered-by'), null);
    assert.equal(headers.get('strict-transport-security'), null, 'pas de HSTS en clair');

    // Tout ce que la page charge vient d'elle-même, et aucun script n'est en
    // ligne : c'est ce qui permet `script-src 'self'` sans exception.
    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    for (const [, attributes, body] of scripts) {
      assert.match(attributes, /src="\/[^/]/, 'script servi par la même origine');
      assert.equal(body.trim(), '', 'aucun script en ligne');
    }
    for (const [, href] of html.matchAll(/<link\b[^>]*href="([^"]+)"/g)) {
      assert.match(href, /^\/[^/]/, `ressource same-origin : ${href}`);
    }
    assert.match(html, /content="http:\/\/127\.0\.0\.1:\d+\/og-image\.png"/);
  });

  await t.test('le bundle serveur et sa source map ne sont pas servis', async () => {
    for (const file of ['/server.cjs', '/server.cjs.map', '/assets/server.cjs', '/build/server.cjs', '/server.ts']) {
      const response = await fetch(`${base}${file}`);
      const body = await response.text();
      assert.equal(response.status, 404, file);
      assert.ok(!body.includes('require(') && !body.includes('correctAnswerIndex'), file);
    }
    const api = await fetch(`${base}/api/inconnue`);
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: 'Ressource introuvable.' });
  });

  await t.test('les fichiers précompressés respectent Accept-Encoding', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert.ok(script);

    const brotli = await fetch(`${base}${script}`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(brotli.headers.get('content-encoding'), 'br');
    assert.equal(brotli.headers.get('vary'), 'Accept-Encoding');
    await brotli.arrayBuffer();

    const refused = await fetch(`${base}${script}`, { headers: { 'accept-encoding': 'br;q=0, gzip' } });
    assert.equal(refused.headers.get('content-encoding'), 'gzip');
    await refused.arrayBuffer();

    const plain = await fetch(`${base}${script}`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(plain.headers.get('vary'), 'Accept-Encoding', 'Vary aussi sur le fichier d’origine');
    await plain.arrayBuffer();
  });

  await t.test('un JSON malformé reçoit un message générique, sans pile', async () => {
    const response = await fetch(`${base}/api/generate-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"themeName": ',
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'Requête invalide.' });
    assert.ok(!/SyntaxError|at |node_modules/.test(text));
  });

  await t.test('un corps de plus de 8 ko est refusé', async () => {
    const response = await fetch(`${base}/api/generate-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeName: 'x'.repeat(9000) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Requête trop volumineuse.' });
  });

  await t.test('la génération exige le jeton de l’organisateur', async () => {
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', 'x-room-code': 'FAM-ABCD', 'x-host-token': 'faux' },
    ]) {
      const response = await fetch(`${base}/api/generate-pack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ themeName: 'Astérix' }),
      });
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.ok(!JSON.stringify(body).includes('API_KEY'));
    }
  });

  await t.test('SIGTERM arrête le serveur proprement', async () => {
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  });
});
