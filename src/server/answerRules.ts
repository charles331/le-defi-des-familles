import { GameSettings, Question } from '../types';
import { isCardReadAloud } from './turnRoles';

/**
 * Ce qu'une réponse reçue vaut vraiment, une fois les règles du tour appliquées.
 *
 * Deux trous relevés par l'audit de sécurité, que l'interface masquait sans les
 * fermer :
 *
 *  - une carte ouverte se juge par celui qui détient la réponse — le lecteur —
 *    avec « Réussi » (0) ou « Raté » (-1). Le serveur acceptait pourtant le 0 du
 *    joueur actif lui-même : il lui suffisait d'envoyer `{ optionIndex: 0 }`
 *    pour se valider sa propre carte. Le joueur actif ne peut plus que passer ;
 *  - le minuteur ne vivait que dans le navigateur : une réponse envoyée bien
 *    après la fin du temps était comptée.
 */

/**
 * Marge accordée au-delà du minuteur : le client soumet à l'échéance, en
 * secondes entières, et sa réponse doit encore traverser le réseau.
 */
export const ANSWER_GRACE_MS = 3000;

export interface AnswerContext {
  question: Pick<Question, 'format'>;
  optionIndex: number;
  /** L'appareil qui répond détient-il la solution (lecteur désigné) ? */
  isReader: boolean;
  settings: Pick<GameSettings, 'timerSeconds' | 'isLocalMode' | 'isReaderMode' | 'enableLiveCamera'>;
  /** Début du décompte, déjà décalé des pauses ; `null` tant que la roue tourne. */
  questionStartTime: number | null;
  now: number;
}

export type AnswerVerdict =
  | { accepted: true; optionIndex: number; late: boolean }
  | { accepted: false; reason: string };

export function judgeAnswer({
  question,
  optionIndex,
  isReader,
  settings,
  questionStartTime,
  now,
}: AnswerContext): AnswerVerdict {
  // Carte ouverte : « Réussi » n'appartient qu'au lecteur. Sans lecteur — il
  // s'est déconnecté en cours de carte —, le joueur actif garde « Passer ».
  if ((question.format ?? 'mcq') === 'open' && optionIndex !== -1 && !isReader) {
    return { accepted: false, reason: 'Seul le lecteur peut valider une carte ouverte.' };
  }

  // Le minuteur, appliqué par le serveur. Trois cas où il ne s'applique pas :
  // aucun minuteur (0), décompte pas encore lancé (roue surprise), et le mode
  // lecteur du pass & play, où le décompte démarre sur l'appareil quand le
  // lecteur se déclare prêt — le serveur n'en connaît pas l'instant.
  const timerSeconds = settings.timerSeconds;
  const localCountdown = settings.isLocalMode === true && isCardReadAloud(settings);
  if (
    optionIndex !== -1
    && timerSeconds > 0
    && questionStartTime !== null
    && !localCountdown
    && now > questionStartTime + timerSeconds * 1000 + ANSWER_GRACE_MS
  ) {
    // Comptée comme un temps écoulé, et non ignorée : ignorer laisserait la
    // table devant une carte que plus personne ne pourrait trancher.
    return { accepted: true, optionIndex: -1, late: true };
  }

  return { accepted: true, optionIndex, late: false };
}
