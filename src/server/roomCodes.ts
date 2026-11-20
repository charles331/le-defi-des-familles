/**
 * Les codes de salon : ce qui s'accepte d'un client ou du disque.
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

/** Le code tel qu'un joueur le tape (casse, espaces), ou `null` s'il n'en a pas la forme. */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const code = raw.toUpperCase().trim();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}
