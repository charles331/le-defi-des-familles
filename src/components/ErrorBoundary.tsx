import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { GAME_NAME_PARTS } from '../config/brand';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Change à chaque « Réessayer » pour remonter l'application à neuf. */
  attempt: number;
}

/**
 * Filet de sécurité autour de toute l'application.
 *
 * Sans lui, une seule donnée malformée reçue du serveur — un emoji qui arrive
 * sous forme d'objet, une couleur qui n'est pas une chaîne — levait une
 * exception au rendu, et React démontait l'arbre entier : écran blanc, chez
 * tous les joueurs à la fois puisque tous reçoivent le même état.
 *
 * L'écran de secours ne perd pas la place du joueur. Le jeton de session vit
 * dans le `localStorage` (`tp_fam_session`) et `App` le renvoie au serveur à
 * chaque connexion : recharger la page, ou simplement remonter `App` (ce qui
 * rouvre une socket neuve), le ramène à sa chaise avec un état frais.
 *
 * Ce composant est une classe parce que React n'offre `componentDidCatch` et
 * `getDerivedStateFromError` qu'aux composants classe.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // Le projet n'embarque pas `@types/react` : `Component` arrive non typé, et
  // TypeScript ignore donc `props` et `setState`. On les déclare ici plutôt
  // que d'ajouter une dépendance pour ce seul composant classe.
  declare readonly props: Readonly<ErrorBoundaryProps>;
  declare setState: (
    update: (state: ErrorBoundaryState) => Partial<ErrorBoundaryState>
  ) => void;

  state: ErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Journalisé en console pour qu'un parent puisse nous montrer l'erreur
    // exacte : c'est le seul indice qui reste une fois l'écran remplacé.
    console.error('[Le jeu a rencontré une erreur]', error, info.componentStack);
  }

  private retry = () => {
    this.setState(state => ({ error: null, attempt: state.attempt + 1 }));
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      // La clé force un montage neuf après « Réessayer » : on ne réutilise
      // aucun état local de l'arbre qui vient de planter.
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }

    return (
      <div
        role="alert"
        className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-slate-950 p-4 animate-fadeIn"
      >
        <div className="relative my-auto w-full max-w-md space-y-5 rounded-3xl border-4 border-amber-500 bg-slate-900 p-6 text-center text-white shadow-2xl">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-tr from-amber-400 to-orange-500 text-4xl shadow-xl ring-4 ring-amber-300">
            <span aria-hidden="true">🎲</span>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-black uppercase tracking-widest text-amber-400">
              {GAME_NAME_PARTS.lead} {GAME_NAME_PARTS.accent}
            </p>
            <h1 className="text-2xl font-black">Oups, le plateau s'est renversé</h1>
            <p className="text-sm text-slate-300">
              Un souci d'affichage a interrompu le jeu sur cet écran. Votre place est gardée :
              en rechargeant, vous retrouvez la partie là où elle en est.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="tap-target w-full rounded-2xl bg-amber-400 px-5 py-3 font-black text-slate-950 shadow-lg transition-colors hover:bg-amber-300"
            >
              Recharger
            </button>
            <button
              type="button"
              onClick={this.retry}
              className="tap-target w-full rounded-2xl border border-slate-700 px-5 py-2.5 text-sm font-bold text-slate-300 transition-colors hover:bg-slate-800"
            >
              Réessayer sans recharger
            </button>
          </div>
        </div>
      </div>
    );
  }
}
