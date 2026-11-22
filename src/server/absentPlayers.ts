import { GameState } from '../types';
import { advanceTurn } from './gameEngine';
import { READER_RECONNECT_GRACE_MS, resolveReaderId } from './turnRoles';

/**
 * Ce que la partie fait d'un joueur qui a perdu la connexion.
 *
 * Deux trous relevés en partie à plusieurs :
 *
 *  - **le lecteur.** Son rôle suivait la connexion à la seconde près : à la
 *    moindre coupure, la solution partait chez le joueur suivant, qui la gardait.
 *    Le lecteur garde désormais sa carte quelques secondes, puis le rôle passe
 *    une fois pour toutes ;
 *  - **le joueur actif.** Personne ne pouvait jouer à sa place : la table
 *    attendait son retour sans fin. Son tour passe au joueur présent suivant
 *    après une minute.
 *
 * Les deux règles sont pures : le serveur les applique à chaque coupure, à
 * l'échéance, et à chaque balayage des salons pour ne jamais rester bloqué.
 */

/**
 * Laps laissé au joueur actif pour revenir avant que son tour ne passe. Plus long
 * que celui du lecteur : un téléphone qui se met en veille pendant qu'on réfléchit
 * au plateau ne doit pas faire perdre son tour.
 */
export const ABSENT_TURN_GRACE_MS = 60_000;

/** Les phases où un joueur actif est attendu. */
const PLAYING_PHASES = new Set(['rolling', 'moving', 'question', 'evaluating']);

function isAwayFor(
  player: { isConnected: boolean; disconnectedAt?: number | null } | undefined,
  graceMs: number,
  now: number,
): boolean {
  if (!player || player.isConnected) return false;
  // Une coupure sans date — état enregistré avant ce champ — se compte à partir
  // de maintenant plutôt que d'être tranchée sur-le-champ.
  if (typeof player.disconnectedAt !== 'number') return false;
  return now - player.disconnectedAt >= graceMs;
}

/**
 * Le lecteur de la carte en cours est-il parti trop longtemps ? Le rôle passe
 * alors au joueur connecté qui le précède dans l'ordre de la table — et c'est lui
 * qui reçoit désormais la solution. Renvoie vrai quand le lecteur a changé.
 */
export function handOverAbsentReader(state: GameState, now: number): boolean {
  if (state.phase !== 'question' && state.phase !== 'evaluating') return false;
  if (typeof state.readerId !== 'string') return false;

  const reader = state.players.find(player => player.id === state.readerId);
  if (reader && !isAwayFor(reader, READER_RECONNECT_GRACE_MS, now)) return false;

  const next = resolveReaderId(state.players, state.activePlayerIndex);
  if (next === state.readerId) return false;
  state.readerId = next;
  return true;
}

/**
 * Le joueur actif est-il parti trop longtemps ? Son tour passe au joueur connecté
 * suivant, sans réponse ni camembert : sa carte, s'il en avait une, est perdue.
 * Renvoie vrai quand le tour a passé.
 *
 * Rien ne change en pass & play, où un seul appareil fait jouer tout le monde,
 * ni pendant une pause, ni s'il ne reste personne de connecté pour reprendre.
 */
export function skipAbsentActivePlayer(state: GameState, now: number): boolean {
  if (!PLAYING_PHASES.has(state.phase)) return false;
  if (state.isPaused === true || state.settings.isLocalMode === true) return false;

  const count = state.players.length;
  const absent = state.players[state.activePlayerIndex];
  if (!absent || absent.id.startsWith('local_')) return false;
  if (!isAwayFor(absent, ABSENT_TURN_GRACE_MS, now)) return false;

  let nextIndex: number | null = null;
  for (let step = 1; step < count; step += 1) {
    const index = (state.activePlayerIndex + step) % count;
    if (state.players[index]?.isConnected) {
      nextIndex = index;
      break;
    }
  }
  if (nextIndex === null) return false;

  // `advanceTurn` remet la table au lancer et garde le rappel de la carte ; il
  // laisserait rejouer un joueur qui venait de bien répondre, d'où l'index
  // imposé ensuite.
  advanceTurn(state);
  state.activePlayerIndex = nextIndex;
  state.lastTurnEventMessage = `📵 ${absent.name || 'Un joueur'} a perdu la connexion : son tour passe.`;
  return true;
}
