/**
 * Ce que le serveur accepte d'un client, et ce qu'il accepte de relire du disque.
 *
 * Les handlers socket.io faisaient confiance au type annoncé par TypeScript, qui
 * n'existe plus une fois sur le réseau. Un prénom envoyé sous forme d'objet, une
 * couleur numérique ou une question de pack `null` traversaient jusqu'à l'état de
 * la partie : le serveur plantait au premier `.trim()` ou `.toLowerCase()`, et
 * comme l'état est sauvegardé toutes les trois secondes, la même donnée le faisait
 * replanter à chaque redémarrage. L'audit de sécurité de novembre 2026 l'a
 * reproduit en une ligne.
 *
 * Tout passe donc ici avant d'entrer dans un salon, et `roomStore` repasse par les
 * mêmes fonctions au rechargement : une donnée qu'on n'accepterait pas d'un client
 * n'est pas non plus acceptée du disque. Fonctions pures, sans dépendance au
 * réseau, testées dans `tests/inputValidation.test.ts`.
 */

import { AVATARS, PLAYER_COLORS } from '../data/avatars';
import { BOARD_CATEGORY_COUNT, DEFAULT_BOARD_CATEGORIES } from '../data/boards';
import {
  DEFAULT_BONUS_MODE,
  DEFAULT_QUESTION_TIMER_SECONDS,
  DEFAULT_READER_MODE,
} from '../config/gameSettings';
import { CATEGORIES } from '../data/categories';
import { QUESTION_TIMER_OPTIONS } from '../utils/questionTimer';
import { CategoryId, DifficultyLevel, GameSettings, Player, Question, QuestionFormat } from '../types';

/** Le champ prénom du salon est limité à dix-huit caractères (`Lobby.tsx`). */
export const MAX_PLAYER_NAME_LENGTH = 18;
/** Même borne que la route de génération des packs. */
export const MAX_THEME_NAME_LENGTH = 100;
export const MAX_CUSTOM_QUESTION_LENGTH = 300;
export const MAX_CUSTOM_OPTION_LENGTH = 120;
export const MAX_CUSTOM_EXPLANATION_LENGTH = 400;
export const MAX_CUSTOM_ANSWER_LENGTH = 120;
/** Un pack de la génération en compte soixante au plus. */
export const MAX_QUESTIONS_PER_PACK = 60;
/** Thèmes actifs retenus dans les réglages : bien plus que les trois packs possibles. */
export const MAX_ACTIVE_THEME_NAMES = 12;

export const DIFFICULTIES: readonly DifficultyLevel[] = ['enfant', 'ado', 'adulte'];
const FORMATS: readonly QuestionFormat[] = ['mcq', 'boolean', 'open'];
const AVATAR_IDS = new Set(AVATARS.map(avatar => avatar.id));
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Les couleurs que propose l'interface ; toute autre couleur hexadécimale reste admise. */
export const KNOWN_PLAYER_COLORS: readonly string[] = PLAYER_COLORS.map(color => color.value);

/**
 * Caractères de contrôle, et marques de direction bidirectionnelle.
 *
 * Les seconds ne se voient pas : un prénom « \u202EelleT » s'affiche « Telle » et peut
 * se faire passer pour un autre joueur, ou renverser la fin d'un bandeau qui le
 * cite (« … a retrouvé sa place »).
 */
const INVISIBLE_OR_CONTROL = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** M\u00eame classe, sans le drapeau `g` dont `test()` retiendrait la position. */
const HAS_INVISIBLE_OR_CONTROL = new RegExp(INVISIBLE_OR_CONTROL.source);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Nettoie un texte libre : contrôles et marques bidi retirés, espaces réunis,
 * bornes retirées, longueur plafonnée en caractères (et non en unités UTF-16,
 * pour ne jamais couper un emoji en deux). `null` si ce n'est pas une chaîne ou
 * s'il ne reste rien.
 */
export function cleanText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(INVISIBLE_OR_CONTROL, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length > maxLength ? chars.slice(0, maxLength).join('').trim() : cleaned;
}

/** Un prénom de joueur, ou `null` s'il est absent ou vide. */
export function sanitizePlayerName(raw: unknown): string | null {
  return cleanText(raw, MAX_PLAYER_NAME_LENGTH);
}

export function sanitizeAvatarId(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && AVATAR_IDS.has(raw) ? raw : fallback;
}

export function sanitizeColor(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && HEX_COLOR.test(raw) ? raw : fallback;
}

export function isDifficulty(raw: unknown): raw is DifficultyLevel {
  return typeof raw === 'string' && (DIFFICULTIES as readonly string[]).includes(raw);
}

export function sanitizeDifficulty(raw: unknown, fallback: DifficultyLevel): DifficultyLevel {
  return isDifficulty(raw) ? raw : fallback;
}

/**
 * Une catégorie connue. `Object.hasOwn` et non `in` : `'constructor' in
 * CATEGORIES` est vrai, et la catégorie « constructor » faisait tomber le rendu.
 */
export function isKnownCategory(raw: unknown): raw is CategoryId {
  return typeof raw === 'string' && Object.hasOwn(CATEGORIES, raw);
}

export interface PlayerProfile {
  /** `null` : pas de prénom exploitable, à l'appelant de choisir le repli. */
  name: string | null;
  avatarId: string;
  color: string;
  difficulty: DifficultyLevel;
}

/** Le profil qu'un client annonce en créant ou en rejoignant un salon. */
export function sanitizePlayerProfile(
  raw: unknown,
  defaults: { avatarId: string; color: string; difficulty: DifficultyLevel },
): PlayerProfile {
  const source = isPlainObject(raw) ? raw : {};
  return {
    name: sanitizePlayerName(source.name),
    avatarId: sanitizeAvatarId(source.avatarId, defaults.avatarId),
    color: sanitizeColor(source.color, defaults.color),
    difficulty: sanitizeDifficulty(source.difficulty, defaults.difficulty),
  };
}

export function sanitizeThemeName(raw: unknown): string | null {
  return cleanText(raw, MAX_THEME_NAME_LENGTH);
}

/** Texte borné *sans troncature* : une carte coupée en plein mot est fausse. */
function boundedText(raw: unknown, maxLength: number): string | null {
  const text = cleanText(raw, Number.POSITIVE_INFINITY);
  return text !== null && Array.from(text).length <= maxLength ? text : null;
}

/**
 * Une carte de pack personnalisé, refaite champ par champ, ou `null`.
 *
 * Rien du client n'est recopié tel quel : l'identifiant est donné par le serveur
 * (deux packs n'entrent jamais en collision avec la banque ni entre eux), le
 * thème est celui du pack, et la forme dépend du format — quatre propositions au
 * plus pour un QCM, deux pour un Vrai/Faux, aucune pour une carte ouverte, qui
 * porte alors sa réponse. Une carte dont l'index de réponse sort des
 * propositions est refusée plutôt que réparée : la deviner serait mentir à la
 * table.
 *
 * `id` permet de conserver l'identifiant d'une carte relue du disque, que
 * `usedQuestionIds` référence déjà.
 */
export function sanitizeCustomQuestion(
  raw: unknown,
  context: { id: string; themePack: string },
): Question | null {
  if (!isPlainObject(raw)) return null;

  const question = boundedText(raw.question, MAX_CUSTOM_QUESTION_LENGTH);
  if (!question) return null;
  if (!isKnownCategory(raw.categoryId)) return null;

  const format: QuestionFormat = raw.format === undefined ? 'mcq' : raw.format as QuestionFormat;
  if (!FORMATS.includes(format)) return null;

  let options: string[] = [];
  let correctAnswerIndex = 0;
  let answer: string | undefined;
  if (format === 'open') {
    answer = boundedText(raw.answer, MAX_CUSTOM_ANSWER_LENGTH) ?? undefined;
    if (!answer) return null;
    // Une carte ouverte se juge « réussi » (0) ou « raté » (-1) : l'index est fixe.
  } else {
    if (!Array.isArray(raw.options)) return null;
    const expected = format === 'boolean' ? [2, 2] : [2, 4];
    if (raw.options.length < expected[0] || raw.options.length > expected[1]) return null;
    for (const option of raw.options) {
      const text = boundedText(option, MAX_CUSTOM_OPTION_LENGTH);
      if (!text) return null;
      options.push(text);
    }
    if (!Number.isInteger(raw.correctAnswerIndex)) return null;
    correctAnswerIndex = raw.correctAnswerIndex as number;
    if (correctAnswerIndex < 0 || correctAnswerIndex >= options.length) return null;
  }

  let explanation: string | undefined;
  if (raw.explanation !== undefined && raw.explanation !== null && raw.explanation !== '') {
    explanation = boundedText(raw.explanation, MAX_CUSTOM_EXPLANATION_LENGTH) ?? undefined;
    if (!explanation) return null;
  }

  const clean: Question = {
    id: context.id,
    categoryId: raw.categoryId,
    question,
    options,
    correctAnswerIndex,
    difficulty: sanitizeDifficulty(raw.difficulty, 'adulte'),
    themePack: context.themePack,
  };
  if (explanation) clean.explanation = explanation;
  if (format !== 'mcq') clean.format = format;
  if (answer) clean.answer = answer;
  return clean;
}

/** Un identifiant relu du disque : court, imprimable, sans surprise. */
function storedId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 100 && !HAS_INVISIBLE_OR_CONTROL.test(raw)
    ? raw
    : null;
}

const finiteOr = (raw: unknown, fallback: number): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;

/**
 * Un joueur relu de la sauvegarde, ou `null` s'il est inutilisable.
 *
 * Le prénom et l'identifiant sont indispensables ; le reste retombe sur une
 * valeur neutre plutôt que de faire perdre le siège — ses camemberts valent
 * mieux qu'un avatar inconnu.
 */
export function reviveStoredPlayer(raw: unknown): Player | null {
  if (!isPlainObject(raw)) return null;
  // Le prénom relu n'est pas tronqué en silence : s'il dépasse, il n'a pas été
  // écrit par ce serveur.
  const id = storedId(raw.id);
  const name = sanitizePlayerName(raw.name);
  if (!id || !name) return null;

  const wedges = Array.isArray(raw.wedges) ? raw.wedges.filter(isKnownCategory) : [];
  const bonuses: Player['bonuses'] = {};
  if (isPlainObject(raw.bonuses)) {
    for (const [type, count] of Object.entries(raw.bonuses)) {
      if (['fifty_fifty', 'camembert_joker', 'big_leap'].includes(type)
        && Number.isInteger(count) && (count as number) >= 0 && (count as number) <= 99) {
        bonuses[type as keyof typeof bonuses] = count as number;
      }
    }
  }

  return {
    id,
    name,
    avatarId: sanitizeAvatarId(raw.avatarId, AVATARS[0].id),
    color: sanitizeColor(raw.color, KNOWN_PLAYER_COLORS[0]),
    difficulty: sanitizeDifficulty(raw.difficulty, 'adulte'),
    wedges: [...new Set(wedges)],
    currentTileId: Number.isInteger(raw.currentTileId) ? raw.currentTileId as number : 0,
    isHost: raw.isHost === true,
    isReady: raw.isReady === true,
    score: finiteOr(raw.score, 0),
    correctAnswersCount: finiteOr(raw.correctAnswersCount, 0),
    totalAnswersCount: finiteOr(raw.totalAnswersCount, 0),
    isConnected: false,
    bonuses,
  };
}

/**
 * Un pack relu de la sauvegarde. Ses cartes gardent leur identifiant, que
 * `usedQuestionIds` référence ; une carte devenue illisible est écartée seule.
 */
export function reviveStoredPack(raw: unknown): { name: string; questions: Question[] } | null {
  if (!isPlainObject(raw)) return null;
  const name = sanitizeThemeName(raw.name);
  if (!name || !Array.isArray(raw.questions)) return null;
  const questions: Question[] = [];
  for (const candidate of raw.questions.slice(0, MAX_QUESTIONS_PER_PACK * 3)) {
    const id = isPlainObject(candidate) ? storedId(candidate.id) : null;
    if (!id) continue;
    const question = sanitizeCustomQuestion(candidate, { id, themePack: name });
    if (question) questions.push(question);
  }
  return { name, questions };
}

/**
 * Les noms de thèmes actifs : des chaînes nettoyées, sans doublon, et jamais
 * plus que de packs possibles — la liste grossissait sans fin à chaque ajout.
 */
export function sanitizeThemeNames(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const name = sanitizeThemeName(candidate);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

/**
 * Ne retient d'un envoi de réglages que ce qui est jouable.
 *
 * `update-settings` fusionnait le message du client tel quel dans les réglages du
 * salon. C'était l'entrée la plus permissive du serveur, et rien n'y était borné :
 * un nombre de camemberts au-delà des catégories du plateau rendait la partie
 * ingagnable, une durée de chrono négative cassait le décompte, et une catégorie
 * inconnue traversait jusqu'au plateau où le rendu la refusait. Aucune de ces
 * valeurs n'est atteignable depuis l'interface — c'est bien pour cela qu'un client
 * obsolète ou un salon repris du disque pouvait les produire sans qu'on le voie.
 *
 * Une clé absente reste absente : on ne réécrit jamais un réglage que l'hôte n'a
 * pas touché.
 */
export function sanitizeSettings(raw: unknown): Partial<GameSettings> {
  const clean: Partial<GameSettings> = {};
  if (!isPlainObject(raw)) return clean;
  const patch = raw as Partial<GameSettings>;
  const bool = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined;

  if (patch.boardType !== undefined && ['wheel', 'snake', 'star'].includes(patch.boardType)) {
    clean.boardType = patch.boardType;
  }
  if (Array.isArray(patch.selectedCategories)) {
    // Les identifiants inconnus tombent, les doublons aussi, et l'on ne garde
    // jamais plus que les six places du plateau.
    const vues: CategoryId[] = [];
    for (const categoryId of patch.selectedCategories) {
      if (!isKnownCategory(categoryId) || vues.includes(categoryId)) continue;
      if (vues.length >= BOARD_CATEGORY_COUNT) break;
      vues.push(categoryId);
    }
    clean.selectedCategories = vues;
  }
  if (typeof patch.timerSeconds === 'number'
    && (QUESTION_TIMER_OPTIONS as readonly number[]).includes(patch.timerSeconds)) {
    clean.timerSeconds = patch.timerSeconds;
  }
  if (typeof patch.wedgesToWin === 'number'
    && Number.isInteger(patch.wedgesToWin)
    && patch.wedgesToWin >= 1
    && patch.wedgesToWin <= BOARD_CATEGORY_COUNT) {
    clean.wedgesToWin = patch.wedgesToWin;
  }
  if (Array.isArray(patch.customThemePackNames)) {
    clean.customThemePackNames = sanitizeThemeNames(patch.customThemePackNames, MAX_ACTIVE_THEME_NAMES);
  }
  for (const key of ['isLocalMode', 'isReaderMode', 'enableLiveCamera', 'enableBonuses'] as const) {
    const value = bool(patch[key]);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/**
 * Les réglages d'un salon neuf. `create-room` les reçoit du client et les
 * fusionnait tels quels, sans passer par `sanitizeSettings` : c'était une
 * seconde porte, ouverte, sur les mêmes réglages.
 */
export function defaultSettings(roomCode: string, isLocalMode: boolean): GameSettings {
  return {
    roomCode,
    boardType: 'wheel',
    selectedCategories: [...DEFAULT_BOARD_CATEGORIES],
    timerSeconds: DEFAULT_QUESTION_TIMER_SECONDS,
    wedgesToWin: BOARD_CATEGORY_COUNT,
    isLocalMode,
    isReaderMode: DEFAULT_READER_MODE,
    enableLiveCamera: false,
    enableBonuses: DEFAULT_BONUS_MODE,
  };
}

/** Des réglages relus du disque, repassés par le même filtre qu'un envoi client. */
export function reviveStoredSettings(raw: unknown, roomCode: string): GameSettings {
  const settings: GameSettings = {
    ...defaultSettings(roomCode, false),
    // Une sauvegarde d'avant le mode bonus n'avait pas la clé : elle valait non.
    enableBonuses: false,
    ...sanitizeSettings(raw),
    roomCode,
  };
  const legacyTheme = isPlainObject(raw) ? sanitizeThemeName(raw.customThemePackName) : null;
  if (legacyTheme) settings.customThemePackName = legacyTheme;
  return settings;
}
