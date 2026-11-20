import { GameState, Player, SeatRequestView } from '../types';
import { findAbandonedSeat, normalizeSeatName } from './seats';

/**
 * Qui peut s'asseoir à la table, et qui doit d'abord demander.
 *
 * La reprise par prénom (`findAbandonedSeat`) rend sa place à quelqu'un qui
 * revient d'un autre navigateur. Mais elle la rendait à quiconque tapait le bon
 * prénom avec le code du salon : dès qu'un joueur perdait le réseau, un intrus
 * prenait ses camemberts — et si c'était l'organisateur, il devenait
 * organisateur et recevait le jeton de génération des packs. L'audit de
 * sécurité l'a reproduit sans difficulté.
 *
 * La règle retenue :
 *
 *  - le siège de l'organisateur ne se reprend **jamais** au prénom, seulement
 *    avec son jeton de session (ou par une fusion qu'il fait lui-même) ;
 *  - quand l'organisateur est là, une reprise au prénom et toute arrivée après
 *    le salon deviennent une **demande** qu'il accepte ou refuse ;
 *  - quand il n'est pas là, la reprise d'un siège ordinaire reste automatique :
 *    une famille dont l'organisateur a perdu le réseau ne doit pas rester
 *    bloquée à la porte ;
 *  - dans le salon, avant le lancement, arrive qui veut, comme avant.
 *
 * Les fonctions sont pures ; `gameSocketServer.ts` les applique.
 */

export type ArrivalDecision =
  /** Reprise immédiate d'un siège abandonné (organisateur absent). */
  | { kind: 'reclaim'; seat: Player }
  /** Reprise d'un siège abandonné, soumise à l'organisateur. */
  | { kind: 'ask-reclaim'; seat: Player }
  /** Nouveau joueur, admis tout de suite. */
  | { kind: 'join' }
  /** Nouveau joueur en cours de partie, soumis à l'organisateur. */
  | { kind: 'ask-join' }
  | { kind: 'refuse'; message: string };

export interface ArrivalContext {
  /** Identifiant du siège de l'organisateur. */
  hostSeatId: string;
  /** L'organisateur a-t-il un appareil connecté en ce moment ? */
  hostConnected: boolean;
}

export const HOST_NAME_REFUSAL =
  'Ce prénom est celui de l’organisateur : sa place ne se reprend que depuis son appareil. Choisissez un autre prénom.';
export const NAME_TAKEN_REFUSAL =
  'Ce prénom est déjà pris à cette table. Si c’est le vôtre, patientez quelques secondes puis réessayez, ou ajoutez une initiale.';

export function decideArrival(
  state: GameState,
  name: string | null,
  { hostSeatId, hostConnected }: ArrivalContext,
): ArrivalDecision {
  const wanted = normalizeSeatName(name ?? '');
  if (wanted) {
    const sameName = state.players.filter(player => normalizeSeatName(player.name) === wanted);
    if (sameName.some(player => player.id === hostSeatId || player.isHost)) {
      return { kind: 'refuse', message: HOST_NAME_REFUSAL };
    }
    // Un joueur présent — ou un joueur du pass & play, qui ne se déconnecte
    // jamais — porte déjà ce prénom : deux « Christelle » à la table, c'est la
    // confusion assurée, et souvent la même personne dont l'ancienne connexion
    // n'est pas encore tombée.
    if (sameName.some(player => player.isConnected || player.id.startsWith('local_'))) {
      return { kind: 'refuse', message: NAME_TAKEN_REFUSAL };
    }
    const seat = findAbandonedSeat(state, wanted);
    if (seat) return hostConnected ? { kind: 'ask-reclaim', seat } : { kind: 'reclaim', seat };
  }
  if (state.phase === 'lobby' || !hostConnected) return { kind: 'join' };
  return { kind: 'ask-join' };
}

/** Une demande en attente de l'organisateur. */
export interface SeatRequest {
  id: string;
  /** L'appareil qui demande, et qui recevra la place. */
  socketId: string;
  kind: 'reclaim' | 'join';
  /** Le siège visé par une reprise ; `null` pour une arrivée. */
  seatId: string | null;
  name: string;
  avatarId: string;
  color: string;
  difficulty: Player['difficulty'];
  createdAt: number;
}

/** Deux minutes : le temps que l'organisateur voie la demande et réponde. */
export const SEAT_REQUEST_TTL_MS = 2 * 60 * 1000;
/** Une table de famille n'attend jamais plus de quelques retours à la fois. */
export const MAX_SEAT_REQUESTS_PER_ROOM = 5;

export function isExpired(request: SeatRequest, now: number): boolean {
  return now - request.createdAt >= SEAT_REQUEST_TTL_MS;
}

/** Ce que l'organisateur voit d'une demande : jamais l'identifiant d'un socket. */
export function describeSeatRequest(request: SeatRequest, state: GameState): SeatRequestView {
  const seat = request.seatId ? state.players.find(player => player.id === request.seatId) : undefined;
  return {
    id: request.id,
    kind: request.kind,
    name: seat?.name ?? request.name,
    avatarId: seat?.avatarId ?? request.avatarId,
    color: seat?.color ?? request.color,
    wedgeCount: seat?.wedges.length ?? 0,
  };
}
