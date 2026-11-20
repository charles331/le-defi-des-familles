/**
 * Les réactions que la table peut s'envoyer pendant la partie.
 *
 * Le serveur les relaie à tout le salon : il n'accepte donc que celles que
 * l'interface propose. Avant, il relayait n'importe quelle valeur, et un objet
 * à la place d'un emoji faisait planter le rendu de chaque écran du salon.
 *
 * Partagée par le serveur et la barre de réactions (`LiveChat.tsx`) ; un test
 * vérifie que les deux listes ne divergent pas.
 */
export const REACTION_EMOJIS = ['👏', '🎉', '🎯', '🤔', '😂', '🔥', '🏆', '😱'] as const;

export type ReactionEmoji = typeof REACTION_EMOJIS[number];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && (REACTION_EMOJIS as readonly string[]).includes(value);
}

/** Une réaction par seconde et par appareil : assez pour applaudir, pas pour inonder. */
export const REACTION_MIN_INTERVAL_MS = 1000;
