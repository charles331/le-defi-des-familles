import { GameState, Question } from '../types';

/**
 * Les cartes déjà vues ailleurs, pour ne pas les resservir d'une partie à l'autre.
 *
 * La mémoire du jeu ne dépassait pas la partie : « Rejouer » oubliait les cartes
 * posées, et chaque nouveau salon repartait de toute la banque. Une famille qui
 * joue chaque semaine retombait donc sur les mêmes questions, surtout au niveau
 * enfant, à cent trente-cinq cartes par catégorie.
 *
 * Il n'y a pas de compte joueur : c'est chaque **appareil** qui retient les cartes
 * qu'il a vues (`src/utils/seenQuestions.ts`) et les partage en entrant dans un
 * salon. Le salon les met en réserve : il sert d'abord les cartes que personne
 * autour de la table n'a vues, puis les autres, si le niveau n'a plus rien de
 * neuf — jamais il ne bloque une partie faute de carte inédite.
 */

/** Ce qu'un appareil peut partager : de quoi couvrir des dizaines de parties. */
export const MAX_SHARED_SEEN_IDS = 1500;

const QUESTION_ID = /^[\w-]{1,80}$/;

/**
 * Les identifiants envoyés par un appareil, réduits à ceux de cartes que ce salon
 * peut servir. Le reste — identifiants inconnus, cartes d'un thème d'un autre
 * salon, données mal formées — est écarté sans bruit.
 */
export function sanitizeSeenQuestionIds(raw: unknown, servable: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  // Les plus récentes sont en fin de liste : ce sont elles qu'on garde.
  for (const value of raw.slice(-MAX_SHARED_SEEN_IDS)) {
    if (typeof value === 'string' && QUESTION_ID.test(value) && servable.has(value)) ids.add(value);
  }
  return [...ids];
}

/**
 * Ajoute à la réserve du salon les cartes vues par un appareil. Les identifiants
 * étant restreints aux cartes du salon, la réserve ne peut pas dépasser sa banque.
 */
export function rememberSeenQuestions(
  state: Pick<GameState, 'seenQuestionIds' | 'questionsPool'>,
  raw: unknown,
): number {
  const servable = new Set(state.questionsPool.map((question) => question.id));
  const ids = sanitizeSeenQuestionIds(raw, servable);
  const merged = new Set(state.seenQuestionIds ?? []);
  const before = merged.size;
  for (const id of ids) merged.add(id);
  state.seenQuestionIds = [...merged];
  return merged.size - before;
}

/**
 * Les candidates que personne n'a vues, s'il en reste ; sinon toutes. Préférer,
 * jamais exclure : une carte déjà vue la semaine dernière vaut mieux qu'une
 * question d'un autre niveau.
 */
export function preferUnseen(candidates: Question[], seen: ReadonlySet<string>): Question[] {
  if (seen.size === 0) return candidates;
  const unseen = candidates.filter((question) => !seen.has(question.id));
  return unseen.length > 0 ? unseen : candidates;
}
