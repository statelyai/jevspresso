import type { JevRequest } from '@xstate/jev';
import { describe, expect, it } from 'vitest';
import { clefAnswers, validateAskModelInput } from './jev';
import type { ModelId } from './models';

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
