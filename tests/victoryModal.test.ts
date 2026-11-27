import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VictoryModal } from '../src/components/VictoryModal';
import { createGameState, createPlayer, testSettings } from './fixtures';

/**
 * L'écran de victoire affichait « /6 Camemberts » en dur : une partie réglée à
 * quatre camemberts se concluait sur « 4/6 », comme si le vainqueur n'avait pas
 * fini. Il suit désormais l'objectif choisi au salon.
 */
function renderVictory(wedgesToWin: number) {
  const winner = { ...createPlayer('Laura'), wedges: ['histoire', 'sciences', 'art', 'sports'] as never[], score: 900 };
  const other = { ...createPlayer('Charles'), wedges: ['cinema'] as never[], score: 300 };
  const gameState = createGameState({
    phase: 'game_over',
    settings: { ...testSettings, wedgesToWin },
    players: [other, winner],
    winnerId: winner.id,
  });
  // Texte brut : React sépare les morceaux d'une même ligne par des commentaires.
  return renderToStaticMarkup(createElement(VictoryModal, { gameState, onPlayAgain: () => {}, onReturnToLobby: () => {} }))
    .replace(/<!-- -->/g, '');
}

test('le classement final compte les camemberts sur l’objectif de la partie', () => {
  const html = renderVictory(4);
  assert.match(html, /4\/4 camemberts \(900 pts\)/);
  assert.match(html, /1\/4 camemberts \(300 pts\)/);
  assert.match(html, /Les 4 camemberts récoltés/);
  assert.doesNotMatch(html, /\/6/);
});

test('avec l’objectif par défaut, rien ne change', () => {
  assert.match(renderVictory(6), /4\/6 camemberts/);
});

test('un seul camembert à gagner s’écrit au singulier', () => {
  const html = renderVictory(1);
  assert.match(html, /4\/1 camembert \(/);
  assert.match(html, /Le camembert récolté/);
});
