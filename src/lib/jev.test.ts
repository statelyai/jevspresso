import type { JevRequest } from '@xstate/jev';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, clefAnswers, routeFor, validateAskModelInput } from './jev';
import type { PageKeys } from './key';
import { modelInfo, type ModelId } from './models';

const request = { state: {}, questions: {} } as JevRequest;
const answers = { urgent: { type: 'noul', noul: 0.9 } } as never;

describe('Clef REST responses', () => {
  it('reads answers from the Cloudflare result response envelope', () => {
    expect(clefAnswers({ result: { response: { answers } } })).toBe(answers);
  });

  it('keeps the existing response fallbacks', () => {
    expect(clefAnswers({ result: { answers } })).toBe(answers);
    expect(clefAnswers({ answers })).toBe(answers);
  });
});

describe('model validation', () => {
  it.each(['unknown', 'constructor'])('rejects unsupported model %s', (model) => {
    expect(() => validateAskModelInput({ model: model as ModelId, request })).toThrow(`Unknown model: ${model}`);
  });
});

describe('routes', () => {
  const ENV = ['TYPESAFE_API_KEY', 'KEV_BASE_URL', 'KEV_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY'];
  beforeEach(() => ENV.forEach((k) => vi.stubEnv(k, '')));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const via = (model: ModelId, keys?: PageKeys) => routeFor(modelInfo(model), keys)?.via ?? null;

  it("takes the server's keys before yours, and of each, the maker's own before a gateway's", () => {
    expect(via('jev')).toBe(null);
    expect(via('jev', { vercel: { key: 'v' }, typesafe: { key: 't' } })).toBe('typesafe');
    expect(via('jev', { vercel: { key: 'v' } })).toBe('vercel');
    vi.stubEnv('OPENROUTER_API_KEY', 'or');
    expect(via('jev', { typesafe: { key: 't' } })).toBe('openrouter');
    vi.stubEnv('TYPESAFE_API_KEY', 'ts');
    expect(via('jev')).toBe('typesafe');
  });

  it('reaches a model through a gateway only if the gateway carries it', () => {
    expect(via('clef', { vercel: { key: 'v' } })).toBe(null);
    expect(via('clef', { openrouter: { key: 'o' } })).toBe('openrouter');
    expect(routeFor(modelInfo('kev'), { openrouter: { key: 'o' } })).toMatchObject({ via: 'openrouter', model: 'jaredpalmer/kev-4b' });
    expect(routeFor(modelInfo('openai'), { vercel: { key: 'v' } })).toMatchObject({ via: 'vercel', model: 'openai/gpt-6-luna-decisions' });
  });

  it('splits a request over a model’s question limit, and puts the answers back together', async () => {
    const bodies: { model: string; questions: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'noul', noul: 1 }])) }));
    });
    const questions = Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`q${i}`, { type: 'noul', instructions: '?' }]));
    const answers = await ask('clef', {}, questions, { openrouter: { key: 'o' } });
    expect(bodies.map((b) => [b.model, Object.keys(b.questions).length])).toEqual([
      ['cloudflare/clef', 64],
      ['cloudflare/clef', 17],
    ]);
    expect(Object.keys(answers)).toHaveLength(81);
  });

  it('says what to set when nothing reaches a model', async () => {
    await expect(ask('kev', {}, {})).rejects.toThrow('No key for Kev: set KEV_BASE_URL or OPENROUTER_API_KEY, or give one on the page.');
  });
});
