/**
 * Assemblage d'un pack de questions généré par l'IA.
 *
 * Le générateur ne validait que la forme : 4 options, un index, un texte non
 * vide. Toutes les règles éditoriales de l'ADR 0001 — longueurs, format
 * d'association, réponse révélée, explication informative, faits reformulés,
 * moules d'énoncé — restaient hors de son chemin. Elles s'appliquent ici, avec
 * les mêmes fonctions que l'audit de la banque rédigée.
 */

import { CATEGORY_IDS, normalizeCategoryId } from '../data/categories';
import {
  MAX_ADULT_OPTION_LENGTH,
  MAX_ADULT_QUESTION_LENGTH,
  MAX_BARE_NUMBER_RATIO,
  MAX_OPEN_ANSWER_LENGTH,
  MAX_SKELETON_REUSE,
  comparableAnswer,
  editorialRejectionReason,
  isBareNumberCard,
  normalize,
  paraphrasesSameFact,
  questionSkeleton,
} from '../data/questionRules';
import { DifficultyLevel, Question, QuestionFormat } from '../types';

const DIFFICULTY_ORDER: DifficultyLevel[] = ['enfant', 'ado', 'adulte'];

/**
 * Une anecdote « Le saviez-vous ? » tient en deux ou trois phrases. Au-delà,
 * c'est le modèle qui déraille — ou qu'on a fait dérailler — et la carte part
 * au rebut plutôt que d'afficher un roman à une table d'enfants.
 */
export const MAX_GENERATED_EXPLANATION_LENGTH = 500;

const GENERATED_FORMATS: QuestionFormat[] = ['mcq', 'boolean', 'open'];

/** Caractères de contrôle (sauf espaces ordinaires) : rien à faire sur une carte. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;

export function normalizeDifficulty(raw: unknown): DifficultyLevel {
  const clean = String(raw ?? '').toLowerCase().trim();
  if (clean.includes('enf') || clean.includes('facile') || clean.includes('easy')) return 'enfant';
  if (clean.includes('ado') || clean.includes('moyen') || clean.includes('medium')) return 'ado';
  return 'adulte';
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > maxLength || CONTROL_CHARACTERS.test(text)) return null;
  return text;
}

/**
 * Traduit une carte brute du modèle en `Question`, ou `null` si sa forme ne
 * tient pas. Le schéma JSON demandé au fournisseur n'est qu'une prière : le
 * modèle peut s'en écarter, et le thème qu'on lui passe vient d'un inconnu.
 * Seuls les champs attendus, avec le bon type et dans leurs bornes, passent ;
 * le contrôle éditorial (`assembleGeneratedPack`) vient ensuite.
 */
export function parseGeneratedCandidate(raw: unknown, id: string, themePack: string): Question | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const card = raw as Record<string, unknown>;

  const question = cleanText(card.question, MAX_ADULT_QUESTION_LENGTH);
  if (!question) return null;

  const format = card.format === undefined || card.format === '' ? 'mcq' : card.format;
  if (!GENERATED_FORMATS.includes(format as QuestionFormat)) return null;

  if (!Array.isArray(card.options) || card.options.length > 4) return null;
  const options: string[] = [];
  for (const option of card.options) {
    const text = cleanText(option, MAX_ADULT_OPTION_LENGTH);
    if (text === null) return null;
    options.push(text);
  }

  const correctAnswerIndex = card.correctAnswerIndex;
  if (typeof correctAnswerIndex !== 'number' || !Number.isInteger(correctAnswerIndex)) return null;
  const maxIndex = format === 'open' ? 0 : options.length - 1;
  if (correctAnswerIndex < 0 || correctAnswerIndex > maxIndex) return null;

  const explanation = cleanText(card.explanation, MAX_GENERATED_EXPLANATION_LENGTH);
  if (!explanation) return null;

  if (typeof card.categoryId !== 'string' || typeof card.difficulty !== 'string') return null;

  const parsed: Question = {
    id,
    categoryId: normalizeCategoryId(card.categoryId),
    question,
    options,
    correctAnswerIndex,
    explanation,
    difficulty: normalizeDifficulty(card.difficulty),
    themePack,
  };
  if (format !== 'mcq') parsed.format = format as QuestionFormat;
  if (format === 'open') {
    const answer = cleanText(card.answer, MAX_OPEN_ANSWER_LENGTH);
    if (!answer) return null;
    parsed.answer = answer;
  }
  return parsed;
}

/** Applique `parseGeneratedCandidate` à un lot, en comptant les cartes mal formées. */
export function parseGeneratedCandidates(
  rawCards: unknown[],
  themePack: string,
  stamp = Date.now(),
): { candidates: Question[]; malformed: number } {
  const candidates: Question[] = [];
  let malformed = 0;
  rawCards.forEach((raw, index) => {
    const parsed = parseGeneratedCandidate(raw, `gen_${stamp}_${index}`, themePack);
    if (parsed) candidates.push(parsed);
    else malformed += 1;
  });
  return { candidates, malformed };
}

/**
 * Indices qui rendent une carte explicitement cinématographique, même lorsque
 * son univers parle de robots, d'espace, d'histoire ou de cuisine. Les modèles
 * confondent parfois le décor d'une œuvre avec le savoir réellement testé :
 * « quel androïde est interprété par Rutger Hauer ? » teste Blade Runner, pas
 * les sciences. La correction reste volontairement étroite pour ne pas
 * deviner la catégorie des cas ambigus.
 */
const OBVIOUS_CINEMA_CUE = /\b(?:film|serie|acteur|actrice|realisateur|realisatrice|interprete|interpretee|interpreter|interpretait|incarne|incarnee|incarner|incarnait|role|episode|saison|oscar|box office|bande originale)\b/u;

export function correctObviousGeneratedCategory(question: Question): Question {
  if (question.categoryId === 'cinema' || !OBVIOUS_CINEMA_CUE.test(normalize(question.question))) {
    return question;
  }
  return { ...question, categoryId: 'cinema' };
}

/**
 * Ce que la banque officielle sait déjà, injecté pour que l'assemblage reste
 * testable sans charger les 5 360 cartes.
 */
export interface KnownFactIndex {
  /** L'énoncé figure-t-il déjà, au mot près, dans la banque rédigée ? */
  hasQuestionText(normalizedQuestion: string): boolean;
  /** Énoncés officiels de la même catégorie qui portent déjà cette réponse. */
  questionsSharingAnswer(answerKey: string): string[];
}

export interface PackAssemblyResult {
  questions: Question[];
  /** Motif de rejet -> nombre de cartes concernées, pour les journaux. */
  rejections: Map<string, number>;
  examined: number;
}

export function answerKeyOf(question: Question): string {
  const answer = (question.format ?? 'mcq') === 'open'
    ? (question.answer ?? '')
    : (question.options[question.correctAnswerIndex] ?? '');
  return `${question.categoryId}|${comparableAnswer(answer)}`;
}

export const EMPTY_KNOWN_FACTS: KnownFactIndex = {
  hasQuestionText: () => false,
  questionsSharingAnswer: () => [],
};

/**
 * Répartit la coupe finale entre les trois niveaux, à tour de rôle.
 *
 * Couper à la file livrerait un pack dont les premières cartes — donc un seul
 * niveau, l'IA les produisant groupées — écraseraient la progression enfant /
 * ado / adulte sur laquelle repose le tirage en jeu.
 */
function trimBalanced(questions: Question[], count: number): Question[] {
  if (questions.length <= count) return questions;

  const buckets = DIFFICULTY_ORDER.map(
    (difficulty) => questions.filter((question) => question.difficulty === difficulty),
  );
  const kept: Question[] = [];
  for (let round = 0; kept.length < count; round += 1) {
    let servedThisRound = false;
    for (const bucket of buckets) {
      if (kept.length >= count) break;
      const candidate = bucket[round];
      if (!candidate) continue;
      kept.push(candidate);
      servedThisRound = true;
    }
    if (!servedThisRound) break;
  }
  // Ordre d'origine conservé : le pack reste lisible dans les journaux.
  return questions.filter((question) => kept.includes(question));
}

/**
 * Retient les cartes conformes, puis ramène le pack à `targetCount`.
 *
 * Les candidats sont examinés dans l'ordre reçu : le résultat est déterministe,
 * ce qui rend la chaîne rejouable et testable.
 */
export function assembleGeneratedPack(
  candidates: Question[],
  targetCount: number,
  known: KnownFactIndex = EMPTY_KNOWN_FACTS,
): PackAssemblyResult {
  const rejections = new Map<string, number>();
  const reject = (reason: string): void => {
    rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
  };

  const kept: Question[] = [];
  const keptTexts = new Set<string>();
  const keptByAnswer = new Map<string, string[]>();
  const skeletonsByCategory = new Map<string, Map<string, number>>();
  const maxBareCards = Math.floor(targetCount * MAX_BARE_NUMBER_RATIO);
  let bareCards = 0;

  for (const rawCandidate of candidates) {
    const candidate = correctObviousGeneratedCategory(rawCandidate);
    const structuralReason = editorialRejectionReason(candidate);
    if (structuralReason) {
      reject(structuralReason);
      continue;
    }
    if (!CATEGORY_IDS.includes(candidate.categoryId)) {
      reject('catégorie invalide');
      continue;
    }

    const normalizedText = normalize(candidate.question);
    if (keptTexts.has(normalizedText) || known.hasQuestionText(normalizedText)) {
      reject('question déjà posée');
      continue;
    }

    const answerKey = answerKeyOf(candidate);
    const sameAnswer = [
      ...(keptByAnswer.get(answerKey) ?? []),
      ...known.questionsSharingAnswer(answerKey),
    ];
    if (sameAnswer.some((other) => paraphrasesSameFact(other, candidate.question))) {
      reject('fait déjà posé sous une autre formulation');
      continue;
    }

    const skeletons = skeletonsByCategory.get(candidate.categoryId) ?? new Map<string, number>();
    const skeleton = questionSkeleton(candidate.question);
    if ((skeletons.get(skeleton) ?? 0) >= MAX_SKELETON_REUSE) {
      reject('moule d’énoncé sur-utilisé');
      continue;
    }

    if ((candidate.format ?? 'mcq') === 'mcq' && isBareNumberCard(candidate.options)) {
      if (bareCards >= maxBareCards) {
        reject('quatre options numériques nues');
        continue;
      }
      bareCards += 1;
    }

    kept.push(candidate);
    keptTexts.add(normalizedText);
    keptByAnswer.set(answerKey, [...(keptByAnswer.get(answerKey) ?? []), candidate.question]);
    skeletons.set(skeleton, (skeletons.get(skeleton) ?? 0) + 1);
    skeletonsByCategory.set(candidate.categoryId, skeletons);
  }

  return {
    questions: trimBalanced(kept, targetCount),
    rejections,
    examined: candidates.length,
  };
}

/** Résumé d'une passe d'assemblage, pour une seule ligne de journal. */
export function describeRejections(rejections: Map<string, number>): string {
  if (rejections.size === 0) return 'aucun rejet';
  return [...rejections.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');
}
