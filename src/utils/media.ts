/**
 * Camera & microphone helpers shared by the live spotlight.
 *
 * Everything here exists because mobile Safari is far stricter than desktop
 * Chrome: it hides `navigator.mediaDevices` outside a secure context, it is
 * restrictive inside third-party iframes, and it burns battery fast when a
 * WebRTC sender is left uncapped.
 */

export type MediaBlockReason = 'unsupported' | 'insecure-context' | 'embedded' | null;

export interface MediaAvailability {
  /** False when getUserMedia cannot possibly succeed on this page. */
  isAvailable: boolean;
  reason: MediaBlockReason;
  /** Player-facing explanation, already in French. */
  message: string | null;
  /** The page runs inside an iframe, which mobile Safari restricts. */
  isEmbedded: boolean;
}

/** True when the document is nested in another document. */
export function isEmbeddedPage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access, which itself proves nesting.
    return true;
  }
}

/**
 * Explains up-front why capture cannot work, instead of letting
 * `navigator.mediaDevices.getUserMedia` throw a bare TypeError that the UI then
 * reports as "your device has no camera".
 */
export function detectMediaAvailability(): MediaAvailability {
  const isEmbedded = isEmbeddedPage();

  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { isAvailable: false, reason: 'unsupported', message: 'Caméra indisponible dans cet environnement.', isEmbedded };
  }

  const hasApi = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  if (!hasApi) {
    // Safari removes the whole API outside HTTPS, so this is the usual cause on
    // a phone reaching the game through a local IP address.
    if (window.isSecureContext === false) {
      return {
        isAvailable: false,
        reason: 'insecure-context',
        message:
          'La caméra exige une connexion sécurisée. Ouvrez le jeu via une adresse https:// (une adresse http:// en réseau local est refusée par iPhone).',
        isEmbedded
      };
    }
    return {
      isAvailable: false,
      reason: 'unsupported',
      message: 'Ce navigateur ne propose pas d’accès à la caméra et au micro.',
      isEmbedded
    };
  }

  return { isAvailable: true, reason: null, message: null, isEmbedded };
}

/**
 * Turns a getUserMedia rejection into an actionable French message.
 * `isEmbedded` matters because mobile Safari denies capture in third-party
 * iframes with the very same error name as a user refusal.
 */
export function describeMediaError(error: unknown, isEmbedded: boolean): string {
  const name = (error as { name?: string } | null)?.name ?? '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    if (isEmbedded) {
      return 'Caméra bloquée dans cette page intégrée. Ouvrez le jeu dans un onglet Safari à part, puis autorisez la caméra.';
    }
    return 'Caméra/micro bloqués par le navigateur. Autorisez-les pour ce site (Réglages ▸ Safari ▸ Caméra), puis touchez « Activer ma caméra ».';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'Aucune caméra ou aucun micro utilisable n’a été trouvé sur cet appareil.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'La caméra est déjà utilisée par une autre application. Fermez-la puis réessayez.';
  }
  return 'Impossible de démarrer la caméra. Touchez « Activer ma caméra » pour réessayer.';
}

/**
 * Deliberately small capture profile: the spotlight is a thumbnail, so a phone
 * has no reason to grab (and then encode) a 720p stream. `max` matters as much
 * as `ideal` — `ideal` alone is only a hint and iOS happily ignores it.
 */
export const BROADCAST_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: 'user',
    width: { ideal: 320, max: 320 },
    height: { ideal: 240, max: 240 },
    frameRate: { ideal: 10, max: 10 }
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};

/** Cheapest possible capture, only used to trigger the permission prompt. */
export const PERMISSION_PROBE_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'user', width: { ideal: 320, max: 320 }, height: { ideal: 240, max: 240 }, frameRate: { max: 10 } },
  audio: true
};

export const MAX_VIDEO_BITRATE = 150_000;
export const MAX_VIDEO_FRAMERATE = 10;

/**
 * Caps an outgoing video sender. Without this, WebRTC ramps the bitrate up to
 * whatever the link allows — on home Wi-Fi that means encoding a thumbnail at
 * megabits per second, on battery, once per viewer.
 *
 * Call it after `setLocalDescription`, which is when Safari keeps the values.
 */
export async function limitOutgoingVideo(pc: RTCPeerConnection): Promise<void> {
  const videoSenders = pc.getSenders().filter(sender => sender.track?.kind === 'video');

  for (const sender of videoSenders) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      parameters.encodings[0].maxFramerate = MAX_VIDEO_FRAMERATE;
      // Keep motion smooth and let resolution drop first: a talking head stays
      // readable at low resolution, and it costs the encoder much less.
      (parameters as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
        'maintain-framerate';
      await sender.setParameters(parameters);
    } catch (err) {
      // Older WebKit rejects some parameter shapes; an uncapped sender is still
      // better than a broken call.
      console.warn('Unable to cap outgoing video sender:', err);
    }
  }
}

/** Detaches a media element so WebKit actually releases the capture pipeline. */
export function releaseVideoElement(element: HTMLVideoElement | null): void {
  if (!element) return;
  try {
    element.pause();
  } catch {
    // Pausing a never-started element throws on some browsers; harmless.
  }
  try {
    element.srcObject = null;
  } catch {
    element.removeAttribute('src');
  }
}

const CLIENT_ID_KEY = 'tp_fam_client_id';

/**
 * Stable per-browser identifier.
 *
 * Consent must not be keyed on the socket id: the server rotates a player's id
 * on every reconnection, and mobile Safari reconnects every time the game goes
 * to the background. Keying on the socket id made the permission dialog pop up
 * again mid-game and silently stopped the automatic broadcast.
 */
export function getStableClientId(): string {
  if (typeof window === 'undefined') return 'anonymous';

  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;

    const created =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    // Private browsing blocks storage: fall back to a per-session identity.
    return 'no-storage';
  }
}

// ------------------------------------------------------------ défense du direct
// Les fonctions ci-dessous sont pures, et testées comme telles : elles décident
// à qui l'on montre sa caméra, et combien de messages d'un pair on accepte de
// garder en mémoire. Le serveur filtre aussi (`isOnAir`), mais un client ne doit
// jamais ouvrir sa caméra sur la seule foi d'un message relayé.

/** Le strict nécessaire d'un joueur pour décider s'il peut nous regarder. */
export interface ViewerCandidate {
  id: string;
  isConnected: boolean;
}

/**
 * Un `webrtc-viewer-ready` ne suffit pas à recevoir notre flux : son expéditeur
 * doit être assis à la table **et** connecté. Sans ce contrôle, n'importe quel
 * identifiant relayé jusqu'à nous — un joueur parti, une socket qui n'a jamais
 * rejoint la partie — recevait une offre, donc la caméra et le micro de la
 * personne filmée.
 */
export function isAllowedViewer(
  viewerId: unknown,
  players: readonly ViewerCandidate[] | null | undefined,
  selfId: string
): boolean {
  if (typeof viewerId !== 'string' || viewerId === '' || viewerId === selfId) return false;
  return (players ?? []).some(player => player.id === viewerId && player.isConnected === true);
}

/**
 * Plafond de candidates ICE gardées en attente pour un même pair. Une connexion
 * réelle en produit une dizaine ; au-delà, c'est un pair qui inonde, et la file
 * grossirait sans limite tant que la description distante n'arrive pas.
 */
export const MAX_PENDING_ICE_CANDIDATES = 50;

/**
 * Met `item` en file s'il reste de la place. Renvoie `false` quand la file est
 * pleine : l'élément est alors ignoré, jamais une ancienne entrée évincée (les
 * premières candidates sont les plus utiles, les hôtes locaux d'abord).
 */
export function enqueueBounded<T>(queue: T[], item: T, max: number = MAX_PENDING_ICE_CANDIDATES): boolean {
  if (queue.length >= max) return false;
  queue.push(item);
  return true;
}

/** État minimal d'une connexion WebRTC, pour compter qui nous voit vraiment. */
export interface ConnectionStateLike {
  connectionState?: string;
  iceConnectionState?: string;
}

/**
 * Nombre de connexions sortantes réellement établies. Une offre envoyée n'est
 * pas un spectateur : seul un lien établi transporte l'image. On lit aussi
 * `iceConnectionState`, que d'anciens Safari renseignent seul.
 */
export function countLiveConnections(connections: Iterable<ConnectionStateLike>): number {
  let count = 0;
  for (const pc of connections) {
    if (
      pc.connectionState === 'connected'
      || pc.iceConnectionState === 'connected'
      || pc.iceConnectionState === 'completed'
    ) {
      count += 1;
    }
  }
  return count;
}

/** Le bandeau permanent de la personne filmée : qui la voit, en ce moment. */
export function describeAudience(viewerCount: number): string {
  if (!(viewerCount > 0)) return 'En direct · personne ne vous voit encore';
  if (viewerCount === 1) return 'En direct · 1 personne vous voit';
  return `En direct · ${viewerCount} personnes vous voient`;
}

/** Les STUN publics : ils suffisent dans la grande majorité des cas (ADR 0002). */
export const PUBLIC_STUN_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

/** Ce qu'on lit encore des variables `VITE_TURN_*` au build. */
export interface StaticTurnSettings {
  url?: string;
  username?: string;
  credential?: string;
}

const ICE_URL = /^(stun|stuns|turn|turns):\S+$/i;

function isIceUrlList(urls: unknown): urls is string | string[] {
  if (typeof urls === 'string') return ICE_URL.test(urls);
  return Array.isArray(urls) && urls.length > 0 && urls.every(url => typeof url === 'string' && ICE_URL.test(url));
}

/**
 * Ne garde d'une liste reçue à l'exécution que des serveurs ICE bien formés :
 * une entrée mal formée ferait lever `new RTCPeerConnection`, et le direct
 * tomberait pour tout le monde au lieu d'ignorer un seul serveur.
 */
export function sanitizeIceServers(servers: unknown): RTCIceServer[] {
  if (!Array.isArray(servers)) return [];
  const clean: RTCIceServer[] = [];
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;
    const { urls, username, credential } = server as Record<string, unknown>;
    if (!isIceUrlList(urls)) continue;
    const entry: RTCIceServer = { urls };
    if (typeof username === 'string') entry.username = username;
    if (typeof credential === 'string') entry.credential = credential;
    clean.push(entry);
  }
  return clean;
}

/**
 * Configuration ICE des connexions du direct.
 *
 * Les identifiants TURN ne doivent plus venir de `VITE_TURN_USERNAME` ni de
 * `VITE_TURN_CREDENTIAL` : tout ce qui porte le préfixe `VITE_` est recopié en
 * clair dans le bundle public, donc lisible par n'importe quel visiteur, qui
 * peut alors faire relayer son propre trafic par notre serveur TURN, à nos
 * frais. La bonne forme est un identifiant éphémère, délivré par le serveur à
 * un joueur assis dans une partie et qui expire vite : c'est ce qu'attend
 * `runtimeIceServers`.
 *
 * Tant que le serveur n'en fournit pas, le comportement reste celui
 * d'aujourd'hui — STUN publics, plus le TURN statique s'il est configuré —
 * pour ne casser aucune partie pendant la transition. Une fois les identifiants
 * éphémères en place, les `VITE_TURN_*` sont à vider.
 */
export function buildIceConfiguration(
  runtimeIceServers?: unknown,
  staticTurn: StaticTurnSettings = {}
): RTCConfiguration {
  const runtime = sanitizeIceServers(runtimeIceServers);
  if (runtime.length > 0) {
    return { iceServers: [...PUBLIC_STUN_SERVERS, ...runtime] };
  }

  const legacyTurn: RTCIceServer[] = staticTurn.url
    ? [{ urls: staticTurn.url, username: staticTurn.username, credential: staticTurn.credential }]
    : [];
  return { iceServers: [...PUBLIC_STUN_SERVERS, ...legacyTurn] };
}
