/**
 * Les garde-fous du serveur temps réel contre un client qui abuse : débit
 * d'événements, codes de salon essayés à l'aveugle, salons créés en série,
 * origine des connexions.
 *
 * Fonctions et classes pures, sans socket.io : le temps est passé en paramètre,
 * ce qui les rend testables sans attendre (`tests/socketGuards.test.ts`).
 */

/**
 * Seau à jetons : `capacity` événements d'affilée, puis `refillPerSecond` par
 * seconde. Une rafale courte passe — un clic répété, une salve de candidats
 * WebRTC — mais pas un flot continu.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Compte des échecs par clé sur une fenêtre glissante. Une clé qui dépasse le
 * plafond est bloquée jusqu'à ce que ses échecs les plus anciens sortent de la
 * fenêtre. Le nombre de clés suivies est borné, pour que le compteur lui-même
 * ne devienne pas une fuite de mémoire.
 */
export class FailureWindow {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter(at => now - at < this.windowMs);
    if (kept.length > 0) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Enregistre un échec ; vrai si la clé a désormais dépassé le plafond. */
  record(key: string, now: number): boolean {
    const kept = this.recent(key, now);
    kept.push(now);
    if (!this.failures.has(key) && this.failures.size >= this.maxKeys) {
      // La plus ancienne clé cède sa place : une Map garde l'ordre d'insertion.
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.failures.set(key, kept);
    return kept.length > this.maxFailures;
  }

  isBlocked(key: string, now: number): boolean {
    return this.recent(key, now).length > this.maxFailures;
  }
}

/**
 * La clé d'un client pour les quotas : son adresse, et pour l'IPv6 son
 * préfixe /64.
 *
 * Un fournisseur attribue d'ordinaire un /64 entier à une box : compter adresse
 * par adresse laisserait une seule maison changer d'adresse à chaque salon. Une
 * adresse IPv4 transportée en IPv6 (`::ffff:1.2.3.4`) est ramenée à sa forme
 * IPv4, pour ne pas compter deux fois la même machine.
 */
export function addressKey(rawAddress: string): string {
  const address = rawAddress.trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!address.includes(':')) return address;

  // Développe les « :: » pour lire les quatre premiers groupes.
  const [head, tail = ''] = address.toLowerCase().split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = address.includes('::')
    ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    : headGroups;
  return `${groups.slice(0, 4).map(group => (group || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * L'adresse du client derrière le proxy de Railway.
 *
 * Même règle qu'Express avec `trust proxy 1` (server.ts) : un seul proxy de
 * confiance, qui *ajoute* l'adresse qu'il voit à la fin de `X-Forwarded-For`.
 * Seule la dernière entrée est donc sûre ; les précédentes viennent du client
 * et se falsifient à volonté. Sans en-tête — développement local —, l'adresse
 * de la connexion fait foi.
 */
export function clientAddress(
  socketAddress: string,
  forwardedFor: string | string[] | undefined,
): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const entries = (header ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  const address = entries.length > 0 ? entries[entries.length - 1] : socketAddress;
  return addressKey(address || 'inconnue');
}

/**
 * Une connexion socket.io vient-elle d'une page autorisée ?
 *
 * Le serveur acceptait toutes les origines (`origin: '*'`) : n'importe quel site
 * pouvait ouvrir une connexion depuis le navigateur d'un visiteur. La page du jeu
 * est servie par ce même serveur — Vite en middleware en développement, `dist`
 * en production —, donc la même origine suffit ; `PUBLIC_ORIGIN` (liste séparée
 * par des virgules) en ajoute d'autres si le front est un jour hébergé ailleurs.
 *
 * Un client sans en-tête `Origin` n'est pas un navigateur : l'origine ne le
 * concerne pas, et les autres garde-fous s'appliquent à lui comme à tous.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  hosts: Array<string | string[] | undefined>,
  publicOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    const parsed = new URL(origin);
    if (publicOrigins.includes(parsed.origin)) return true;
    originHost = parsed.host.toLowerCase();
  } catch {
    return false;
  }
  return hosts
    .flatMap(value => (Array.isArray(value) ? value : [value]))
    .flatMap(value => (value ?? '').split(','))
    .map(value => value.trim().toLowerCase())
    .some(host => host !== '' && host === originHost);
}

/** `PUBLIC_ORIGIN`, découpée et normalisée. */
export function parsePublicOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .flatMap(entry => {
      try {
        return [new URL(entry).origin];
      } catch {
        return [];
      }
    });
}
