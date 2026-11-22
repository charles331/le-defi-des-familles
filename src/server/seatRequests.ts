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
  /** Adresse du demandeur (un /64 en IPv6), voir `socketGuards.clientAddress`. */
  addressKey: string;
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

/**
 * Trois demandes à la fois depuis une même adresse : une famille qui revient à
 * trois sur le même Wi-Fi passe — à deux, le troisième enfant était refusé —,
 * un client qui ouvre dix connexions pour remplir la file — et faire refuser
 * les vrais joueurs (« l'organisateur a déjà plusieurs demandes ») — ne passe
 * pas.
 */
export const MAX_SEAT_REQUESTS_PER_ADDRESS = 3;
/**
 * Après un refus, le même prénom attend trois minutes depuis la même adresse ;
 * le reste de la maison, trente secondes seulement. Un refus qui valait pour
 * toute l'adresse bloquait trois minutes une famille entière sur un clic de
 * travers — mais sans aucun délai d'adresse, l'intrus éconduit redéposait sa
 * demande dans la seconde, sous un autre prénom.
 */
export const SEAT_REFUSAL_COOLDOWN_MS = 3 * 60 * 1000;
export const ADDRESS_REFUSAL_COOLDOWN_MS = 30 * 1000;

/** Les refus d'un salon : adresse seule, et adresse + prénom. */
export type SeatRefusals = Map<string, number>;

function refusalKeyForName(addressKey: string, name: string): string {
  return `${addressKey}|${normalizeSeatName(name)}`;
}

/** Jusqu'à quand cette adresse, sous ce prénom, attend-elle encore ? */
export function refusedUntil(
  refusals: SeatRefusals | undefined,
  addressKey: string,
  name: string,
): number | undefined {
  if (!refusals) return undefined;
  const byAddress = refusals.get(addressKey);
  const byName = refusals.get(refusalKeyForName(addressKey, name));
  if (byAddress === undefined && byName === undefined) return undefined;
  return Math.max(byAddress ?? 0, byName ?? 0);
}

/** Retient un refus de l'organisateur, et oublie les refus échus. */
export function recordRefusal(refusals: SeatRefusals, addressKey: string, name: string, now: number): void {
  for (const [key, until] of refusals) if (until <= now) refusals.delete(key);
  refusals.set(addressKey, now + ADDRESS_REFUSAL_COOLDOWN_MS);
  refusals.set(refusalKeyForName(addressKey, name), now + SEAT_REFUSAL_COOLDOWN_MS);
}

// Sans durée : le délai va de trente secondes (autre prénom de la maison) à
// trois minutes (le prénom refusé). « Quelques minutes » trompait le premier.
export const REFUSED_RECENTLY =
  'L’organisateur a refusé une demande venue de votre connexion. Réessayez un peu plus tard.';
export const TOO_MANY_FROM_ADDRESS =
  'Plusieurs demandes venues de votre connexion attendent déjà l’organisateur. Patientez un instant.';
export const QUEUE_FULL =
  'L’organisateur a déjà plusieurs demandes en attente. Réessayez dans un instant.';

/**
 * Une nouvelle demande peut-elle entrer dans la file d'un salon ?
 *
 * Une par connexion (la nouvelle remplace l'ancienne : l'appelant retire
 * d'abord celles de la connexion), trois par adresse, cinq par salon, et aucune
 * pendant le délai qui suit un refus de l'organisateur.
 */
export function admitSeatRequest(
  requests: readonly SeatRequest[],
  candidate: { socketId: string; addressKey: string },
  refusedUntil: number | undefined,
  now: number,
): { ok: true } | { ok: false; message: string } {
  if (refusedUntil !== undefined && refusedUntil > now) return { ok: false, message: REFUSED_RECENTLY };
  const pending = requests.filter(request => !isExpired(request, now));
  if (pending.some(request => request.socketId === candidate.socketId)) {
    return { ok: false, message: TOO_MANY_FROM_ADDRESS };
  }
  const fromAddress = pending.filter(request => request.addressKey === candidate.addressKey).length;
  if (fromAddress >= MAX_SEAT_REQUESTS_PER_ADDRESS) return { ok: false, message: TOO_MANY_FROM_ADDRESS };
  if (pending.length >= MAX_SEAT_REQUESTS_PER_ROOM) return { ok: false, message: QUEUE_FULL };
  return { ok: true };
}

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
