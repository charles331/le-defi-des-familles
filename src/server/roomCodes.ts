import { randomInt as cryptoRandomInt } from 'crypto';

/**
 * Les codes de salon : leur tirage, et ce qui s'accepte d'un client ou du disque.
 *
 * Un code est la seule clé d'un salon privé. Sa forme est vérifiée avant toute
 * recherche, pour qu'une chaîne géante ou un objet n'atteigne jamais la table des
 * salons ni les journaux.
 */

/** Alphabet sans ambiguïté à l'oral ni à l'écran : ni I/1, ni O/0. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_PREFIX = 'FAM-';

/**
 * Quatre caractères pour les salons créés avant novembre 2026, encore rejoignables
 * tant qu'ils vivent ; six pour les nouveaux.
 */
const ROOM_CODE_PATTERN = /^FAM-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4,6}$/;

/**
 * Six caractères tirés par `crypto.randomInt`, soit 32⁶ ≈ un milliard de codes.
 *
 * Il en avait quatre, tirés par `Math.random` : un million de codes pour deux
 * cent cinquante salons au plus, sans limite d'essais — un salon tombait en
 * quelques milliers de tentatives. Le limiteur d'échecs (`socketGuards.ts`)
 * fait le reste.
 */
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(
  isTaken: (code: string) => boolean,
  randomInt: (max: number) => number = cryptoRandomInt,
): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET.charAt(randomInt(ROOM_CODE_ALPHABET.length));
    }
    const candidate = `${ROOM_CODE_PREFIX}${code}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error('Impossible de générer un code de salon unique.');
}

/** Le code tel qu'un joueur le tape (casse, espaces), ou `null` s'il n'en a pas la forme. */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const code = raw.toUpperCase().trim();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}
