/**
 * En-têtes de sécurité et gestionnaire d'erreurs final du serveur HTTP.
 *
 * Écrits à la main plutôt que tirés de `helmet` : le jeu n'a qu'une page, et
 * chaque directive ci-dessous découle de ce que le client charge réellement —
 * une liste qu'on peut relire d'un coup d'œil vaut mieux qu'une dépendance dont
 * les valeurs par défaut changent d'une version à l'autre.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { requestOrigin } from './previewMeta';

/**
 * Politique de contenu de la page buildée. Chaque source ouverte a sa raison :
 *
 * - `script-src 'self'` : Vite produit des modules externes, aucun script en
 *   ligne (le préchargement de modules est inclus dans le bundle d'entrée).
 * - `style-src 'unsafe-inline'` : React et Motion animent par l'attribut
 *   `style` (dé, roue, pions) ; sans cela, plus rien ne bouge.
 * - `worker-src blob:` : canvas-confetti dessine la pluie de victoire dans un
 *   Worker créé depuis un Blob. Bloqué, il retombe sur le fil principal, mais en
 *   laissant une violation dans la console.
 * - `img-src data: blob:` : icônes et motifs que Tailwind ou un SVG peuvent
 *   embarquer en ligne.
 * - `media-src blob: mediastream:` : flux de la caméra en direct.
 * - `connect-src` : socket.io d'abord en long polling (`'self'`), puis en
 *   WebSocket vers la même origine — que certains Safari ne rangent pas sous
 *   `'self'`, d'où l'origine ws(s) explicite quand l'hôte est connu.
 *
 * Les échanges WebRTC (STUN/TURN) ne relèvent pas de la CSP.
 */
export function contentSecurityPolicy(origin = ''): string {
  const connectSources = ["'self'"];
  if (origin) {
    const socketOrigin = origin.replace(/^http/, 'ws');
    connectSources.push(socketOrigin);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self' blob:",
    `connect-src ${connectSources.join(' ')}`,
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Fonctions du navigateur ouvertes à la page, et à elle seule : la caméra et le
 * micro du direct, le presse-papiers du lien d'invitation. Tout le reste est
 * fermé, y compris aux cadres qu'on embarquerait un jour.
 *
 * Le partage natif (`navigator.share`) n'y figure pas : Chrome ne reconnaît pas
 * `web-share` et le signale à chaque chargement, alors que sa valeur par défaut
 * (`self`) est déjà celle qu'on veut. Même raison pour `bluetooth`.
 */
export const PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=(self)',
  'clipboard-write=(self)',
  'autoplay=(self)',
  'fullscreen=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'midi=()',
  'display-capture=()',
  'screen-wake-lock=()',
  'accelerometer=()',
  'gyroscope=()',
  'magnetometer=()',
  'publickey-credentials-get=()',
  'browsing-topics=()',
].join(', ');

export interface SecurityHeaderOptions {
  /**
   * Production : CSP complète et HSTS. En développement, le middleware Vite
   * injecte un préambule en ligne et ouvre son propre canal HMR — une CSP stricte
   * casserait le rechargement à chaud, on ne la pose donc pas.
   */
  production: boolean;
}

export function securityHeaders({ production }: SecurityHeaderOptions): RequestHandler {
  return (req, res, next) => {
    if (production) {
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(requestOrigin(req)));
      // Derrière Railway, `req.secure` suit X-Forwarded-Proto (trust proxy).
      // Un HSTS envoyé en clair serait de toute façon ignoré par le navigateur.
      if (req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000');
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // L'adresse porte le code du salon (?code=FAM-XXXX) : il ne doit fuiter vers
    // aucun site tiers par l'en-tête Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  };
}

/**
 * Dernier filet d'Express. Sans lui, le gestionnaire par défaut renvoie la pile
 * d'appel dès que NODE_ENV n'est pas « production » — ce qui était le cas sur
 * Railway tant que la variable n'était pas posée. Le détail part dans les
 * journaux du serveur, le client ne reçoit qu'un message générique.
 */
export const finalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const rawStatus = Number(err?.status ?? err?.statusCode);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (status >= 500) {
    console.error(`[HTTP] Erreur sur ${req.method} ${req.path}:`, err);
  }
  const message = status === 400
    ? 'Requête invalide.'
    : status === 413
      ? 'Requête trop volumineuse.'
      : status < 500
        ? 'Requête refusée.'
        : 'Erreur interne du serveur.';

  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: message });
    return;
  }
  res.status(status).type('text/plain; charset=utf-8').send(message);
};
