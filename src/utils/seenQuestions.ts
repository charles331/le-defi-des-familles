/**
 * Les cartes que cet appareil a vues, gardées d'une partie à l'autre.
 *
 * Le serveur n'a pas de compte joueur : c'est l'appareil qui se souvient, et qui
 * partage sa liste en entrant dans un salon (`share-seen-questions`). Le salon
 * sert alors d'abord des cartes que personne autour de la table n'a encore vues
 * (`src/server/seenQuestions.ts`).
 *
 * Une simple commodité : en navigation privée, ou si le stockage est refusé, le
 * jeu joue comme avant, sans mémoire.
 */

export const SEEN_QUESTIONS_STORAGE_KEY = 'ddf_seen_questions';

/** Même plafond que le serveur : les plus anciennes cartes sortent de la liste. */
export const MAX_SEEN_QUESTIONS = 1500;

export function loadSeenQuestionIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_QUESTIONS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Ajoute une carte en fin de liste — la plus récente —, sans doublon. */
export function withSeenQuestion(ids: readonly string[], questionId: string): string[] {
  const next = ids.filter((id) => id !== questionId);
  next.push(questionId);
  return next.slice(-MAX_SEEN_QUESTIONS);
}

export function recordSeenQuestion(questionId: string): void {
  try {
    localStorage.setItem(
      SEEN_QUESTIONS_STORAGE_KEY,
      JSON.stringify(withSeenQuestion(loadSeenQuestionIds(), questionId)),
    );
  } catch {
    // Stockage plein ou refusé : la partie continue sans mémoire.
  }
}
