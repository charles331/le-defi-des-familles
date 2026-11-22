import React from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { SeatRequestView } from '../types';
import { AVATARS } from '../data/avatars';
import { soundManager } from '../utils/sound';

/**
 * Les demandes d'entrée, des deux côtés de la porte.
 *
 * Un prénom ne prouve pas qui revient : quand l'organisateur est là, c'est lui
 * qui reconnaît la personne et lui rend sa place (`src/server/seatRequests.ts`).
 * Le bandeau ne bloque pas le jeu — l'organisateur peut finir son geste avant
 * de répondre —, et la demande expire seule au bout de deux minutes.
 */
export const SeatRequestBanner: React.FC<{
  requests: SeatRequestView[];
  onAnswer: (requestId: string, accept: boolean) => void;
}> = ({ requests, onAnswer }) => {
  if (requests.length === 0) return null;
  return (
    <div
      className="fixed inset-x-0 top-2 z-[70] flex flex-col items-center gap-2 px-4 pointer-events-none"
      role="status"
      aria-live="polite"
    >
      {requests.map(request => {
        const avatar = AVATARS.find(a => a.id === request.avatarId) || AVATARS[0];
        const wedges = request.wedgeCount === 0
          ? ''
          : request.wedgeCount === 1 ? ' et son camembert' : ` et ses ${request.wedgeCount} camemberts`;
        return (
          <div
            key={request.id}
            className="pointer-events-auto w-full max-w-md rounded-3xl border border-amber-500/40 bg-slate-900 p-4 text-white shadow-2xl animate-fadeIn"
          >
            <div className="flex items-center gap-3">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                style={{ backgroundColor: request.color }}
              >
                {avatar.emoji}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-black leading-snug">
                  {request.kind === 'reclaim'
                    ? `${request.name} demande à revenir`
                    : `${request.name} demande à rejoindre la partie`}
                </p>
                <p className="text-[11px] leading-snug text-slate-400">
                  {request.kind === 'reclaim'
                    ? `Acceptez si c’est bien cette personne : sa place${wedges} lui sera rendue.`
                    : 'Acceptez si vous connaissez cette personne : elle démarre au centre, sans camembert.'}
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { soundManager.playClick(); onAnswer(request.id, true); }}
                className="tap-target flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 py-2.5 text-sm font-black text-white hover:bg-emerald-400"
              >
                <Check className="h-4 w-4" /> Accepter
              </button>
              <button
                type="button"
                onClick={() => { soundManager.playClick(); onAnswer(request.id, false); }}
                className="tap-target flex items-center justify-center gap-1.5 rounded-xl bg-slate-800 py-2.5 text-sm font-black text-slate-200 hover:bg-slate-700"
              >
                <X className="h-4 w-4" /> Refuser
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Ce que voit celui qui attend la réponse de l'organisateur. */
export const SeatRequestWaiting: React.FC<{
  pending: { roomCode: string; name: string; kind: 'reclaim' | 'join' } | null;
  onCancel: () => void;
}> = ({ pending, onCancel }) => {
  if (!pending) return null;
  return (
    <div className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 animate-fadeIn">
      <div
        className="my-auto w-full max-w-md space-y-4 rounded-3xl border border-amber-500/40 bg-slate-900 p-6 text-center text-white shadow-2xl"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-amber-400" />
        <h3 className="text-lg font-black">En attente de l’organisateur…</h3>
        <p className="text-sm leading-relaxed text-slate-300">
          {pending.kind === 'reclaim'
            ? `La place de ${pending.name} est à reprendre dans le salon ${pending.roomCode} : l’organisateur doit confirmer que c’est bien vous.`
            : `La partie du salon ${pending.roomCode} a commencé : l’organisateur doit accepter votre arrivée.`}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl bg-slate-800 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-700"
        >
          Annuler
        </button>
      </div>
    </div>
  );
};
