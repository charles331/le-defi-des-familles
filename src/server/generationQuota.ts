/**
 * Freins de la génération de thèmes par IA.
 *
 * Chaque génération déclenche jusqu'à une douzaine d'appels payants au
 * fournisseur, et il suffit de créer un salon pour obtenir le droit d'en lancer.
 * Le seul frein était un quota par adresse IP, gardé en mémoire : contourné en
 * changeant d'adresse dans un bloc IPv6 — un abonné en reçoit des milliards —,
 * et sans plafond d'ensemble, la facture n'avait pas de borne. Trois étages
 * désormais, du plus fin au plus large : par salon (server.ts), par adresse
 * (regroupée par /64 en IPv6), et un budget global par jour — en générations,
 * et en tokens réellement facturés par le fournisseur.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

/** Développe une adresse IPv6 (sans zone) en huit groupes, ou `null` si invalide. */
function expandIpv6(address: string): string[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  // Une IPv4 en fin d'adresse (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) compte pour deux groupes.
  const last = tail.length ? tail[tail.length - 1] : head[head.length - 1];
  if (last?.includes('.')) {
    const octets = last.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const groups = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
    if (tail.length) tail.splice(tail.length - 1, 1, ...groups);
    else head.splice(head.length - 1, 1, ...groups);
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => group.toLowerCase().padStart(4, '0'));
}

/**
 * Clé de quota d'une adresse. Une IPv4 compte seule — y compris sous sa forme
 * IPv6 « ::ffff:a.b.c.d » qu'Express rend sur un socket double pile. Une IPv6
 * compte par préfixe /64 : c'est la plus petite tranche qu'un fournisseur
 * attribue à un abonné, qui en change librement l'autre moitié.
 */
export function ipQuotaKey(rawAddress: string | undefined): string {
  const address = (rawAddress ?? '').trim().toLowerCase().replace(/%.*$/, '');
  if (!address) return 'inconnue';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1];
  if (!address.includes(':')) return address;
  const groups = expandIpv6(address);
  if (!groups) return address;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * Fenêtre glissante par clé. Les entrées expirées sont purgées au passage, une
 * fois par fenêtre au plus : sans cela, chaque adresse vue une fois restait
 * dans la `Map` jusqu'au redémarrage.
 */
export class SlidingWindowQuota {
  private readonly attempts = new Map<string, number[]>();
  private lastPurge = 0;

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  consume(key: string, now = Date.now()): boolean {
    if (now - this.lastPurge >= this.windowMs) this.purge(now);
    const active = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (active.length >= this.limit) {
      this.attempts.set(key, active);
      return false;
    }
    active.push(now);
    this.attempts.set(key, active);
    return true;
  }

  purge(now = Date.now()): void {
    this.lastPurge = now;
    for (const [key, timestamps] of this.attempts) {
      const active = timestamps.filter((t) => now - t < this.windowMs);
      if (active.length === 0) this.attempts.delete(key);
      else this.attempts.set(key, active);
    }
  }

  get size(): number {
    return this.attempts.size;
  }
}

export const DEFAULT_MAX_GENERATIONS_PER_DAY = 200;

/**
 * Tokens que le fournisseur peut facturer par jour, toutes générations
 * confondues. Le compte OpenAI du projet a un palier gratuit quotidien —
 * 2,5 millions de tokens pour la famille « mini » (gpt-5.4-mini, le modèle par
 * défaut), 250 000 pour gpt-5.4 — au-delà duquel chaque token est facturé.
 * Compter les générations ne suffisait pas à rester dessous : une génération
 * coûte de trois à douze appels selon le nombre de cartes et les relances. On
 * s'arrête à 2 millions, pour garder la marge des lots déjà partis quand le
 * plafond tombe. Avec un autre modèle, régler `MAX_AI_TOKENS_PER_DAY`.
 */
export const DEFAULT_MAX_AI_TOKENS_PER_DAY = 2_000_000;

/** Entier ≥ 0 (0 coupe la génération), sinon la valeur par défaut donnée. */
export function parseDailyLimit(
  raw: string | undefined,
  fallback = DEFAULT_MAX_GENERATIONS_PER_DAY,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.replace(/[\s_]/g, ''));
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

interface StoredBudget {
  day: string;
  count: number;
}

/** Jour UTC : le compteur repart à zéro à 1 h ou 2 h du matin en Belgique. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Budget global pour la journée : des générations, ou des tokens.
 *
 * Gardé sur disque quand un dossier de données est configuré : sans cela, un
 * redémarrage — qu'un attaquant ne provoque pas, mais qu'un redéploiement
 * provoque — remettrait le compteur à zéro. Si l'écriture échoue, le budget
 * continue en mémoire : mieux vaut un plafond qui oublie qu'un jeu en panne.
 */
export class DailyBudget {
  private state: StoredBudget;
  private persistenceBroken = false;

  constructor(
    readonly limit: number,
    private readonly storePath: string | null = null,
    now = Date.now(),
  ) {
    this.state = { day: utcDay(now), count: 0 };
    if (!storePath) return;
    try {
      const stored = JSON.parse(readFileSync(storePath, 'utf8')) as Partial<StoredBudget>;
      if (stored.day === this.state.day && Number.isInteger(stored.count) && stored.count! >= 0) {
        this.state.count = stored.count!;
      }
    } catch {
      // Premier démarrage, ou fichier illisible : on repart de zéro.
    }
  }

  /** Le budget du jour est-il épuisé ? */
  isExhausted(now = Date.now()): boolean {
    this.rollOver(now);
    return this.state.count >= this.limit;
  }

  /**
   * Décompte ce qui a déjà été dépensé — les tokens d'une réponse reçue. Le
   * compte peut dépasser la limite : un lot parti avant qu'elle tombe est
   * facturé quand même, et ce qui suit doit le savoir.
   */
  add(amount: number, now = Date.now()): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.rollOver(now);
    this.state.count += Math.round(amount);
    this.persist();
  }

  /** Réserve une unité (une génération) ; `false` quand le budget du jour est épuisé. */
  tryConsume(now = Date.now()): boolean {
    if (this.isExhausted(now)) return false;
    this.add(1, now);
    return true;
  }

  private rollOver(now: number): void {
    const day = utcDay(now);
    if (day !== this.state.day) this.state = { day, count: 0 };
  }

  get used(): number {
    return this.state.count;
  }

  private persist(): void {
    if (!this.storePath || this.persistenceBroken) return;
    try {
      mkdirSync(path.dirname(this.storePath), { recursive: true });
      const temp = `${this.storePath}.tmp`;
      writeFileSync(temp, JSON.stringify(this.state), 'utf8');
      renameSync(temp, this.storePath);
    } catch (error) {
      this.persistenceBroken = true;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️  Budget de génération IA non sauvegardé (${detail}) : il reste en mémoire.`);
    }
  }
}

/** Fichier d'un budget, seulement si `DATA_DIR` est explicitement configuré. */
export function dailyBudgetStorePath(
  dataDir = process.env.DATA_DIR,
  fileName = 'generation-budget.json',
): string | null {
  return dataDir?.trim() ? path.join(dataDir.trim(), fileName) : null;
}
