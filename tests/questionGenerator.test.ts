import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENAI_PACK_SCHEMA,
  buildOpenAiRequest,
  buildQuestionGenerationPrompt,
  createQuestionGenerator,
  extractOpenAiOutputText,
  resolveAiProviderConfig,
} from '../src/server/questionGenerator';

test('Gemini reste le fournisseur par défaut pour ne pas changer le déploiement', () => {
  const config = resolveAiProviderConfig({ GEMINI_API_KEY: 'gemini-secret' });

  assert.equal(config.provider, 'gemini');
  assert.equal(config.apiKeyName, 'GEMINI_API_KEY');
  assert.equal(config.apiKey, 'gemini-secret');
  assert.equal(config.model, 'gemini-2.5-flash');
});

test('AI_PROVIDER=openai sélectionne la clé et le modèle OpenAI', () => {
  const config = resolveAiProviderConfig({
    AI_PROVIDER: ' OpenAI ',
    OPENAI_API_KEY: 'openai-secret',
    OPENAI_MODEL: 'gpt-custom',
  });

  assert.equal(config.provider, 'openai');
  assert.equal(config.apiKeyName, 'OPENAI_API_KEY');
  assert.equal(config.apiKey, 'openai-secret');
  assert.equal(config.model, 'gpt-custom');
});

test('un fournisseur inconnu est refusé avec une erreur exploitable dans Railway', () => {
  assert.throws(
    () => resolveAiProviderConfig({ AI_PROVIDER: 'autre' }),
    /AI_PROVIDER doit valoir "gemini" ou "openai"/,
  );
});

test('la clé du fournisseur sélectionné est obligatoire', () => {
  assert.throws(
    () => createQuestionGenerator({ AI_PROVIDER: 'openai' }),
    /OPENAI_API_KEY non configurée pour AI_PROVIDER=openai/,
  );
});

test('le prompt partagé conserve les règles éditoriales quel que soit le fournisseur', () => {
  const prompt = buildQuestionGenerationPrompt('Astérix', 15, 'les personnages');

  assert.match(prompt, /exactement 15 questions/);
  assert.match(prompt, /Astérix/);
  assert.match(prompt, /Angle prioritaire.*les personnages/);
  assert.match(prompt, /Exactement 4 options/);
  assert.match(prompt, /Rutger Hauer.*Blade Runner.*cinema/);
  assert.match(prompt, /autoportant/);
  // Les formats variés sont proposés au générateur.
  assert.match(prompt, /boolean/);
  assert.match(prompt, /open/);
});

test('la requête OpenAI utilise Responses et une sortie JSON strictement structurée', () => {
  const request = buildOpenAiRequest('gpt-5.6-terra', 'Génère le pack.', 'low');

  assert.equal(request.model, 'gpt-5.6-terra');
  assert.deepEqual(request.reasoning, { effort: 'low' });
  assert.deepEqual((request.text as any).format.schema, OPENAI_PACK_SCHEMA);
  assert.equal((request.text as any).format.strict, true);
});

test('le texte structuré est extrait de la réponse HTTP OpenAI', () => {
  const text = extractOpenAiOutputText({
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: '{"questions":[]}' }],
    }],
  });

  assert.equal(text, '{"questions":[]}');
});

test('le générateur OpenAI envoie la bonne clé et retourne le tableau de cartes', async () => {
  let capturedUrl = '';
  let capturedHeaders: HeadersInit | undefined;
  let capturedBody: any;
  const fakeFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      output: [{
        content: [{
          type: 'output_text',
          text: JSON.stringify({ questions: [{ question: 'Question test' }] }),
        }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const generator = createQuestionGenerator({
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'openai-secret',
    OPENAI_MODEL: 'gpt-test',
  }, fakeFetch);

  const questions = await generator.generateBatch('Astérix', 1);

  assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
  assert.equal((capturedHeaders as Record<string, string>).Authorization, 'Bearer openai-secret');
  assert.equal(capturedBody.model, 'gpt-test');
  assert.deepEqual(questions, [{ question: 'Question test' }]);
});

test('le générateur Gemini appelle v1beta avec la sortie structurée, malgré le défaut v1 du SDK 3', async () => {
  // Le SDK passe par le fetch global, pas par celui qu'on injecte au générateur.
  const realFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedBody: any;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify([{ question: 'Question test' }]) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const generator = createQuestionGenerator({ GEMINI_API_KEY: 'gemini-secret', GEMINI_MODEL: 'gemini-test' });
    const questions = await generator.generateBatch('Astérix', 1);

    assert.match(capturedUrl, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-test:generateContent/);
    assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(capturedBody.generationConfig.responseSchema.type, 'ARRAY');
    assert.deepEqual(questions, [{ question: 'Question test' }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
