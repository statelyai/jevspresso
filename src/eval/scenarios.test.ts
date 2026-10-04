import { describe, expect, it } from 'vitest';
import { baristaMock as mock } from './mock';
import { runScenario, SCENARIOS } from './scenarios';

describe('scenarios', () => {
  // Every scenario runs to an end with the mock barista: the scenarios and the
  // driver are sound. How well real Jev does is for `/eval`; the mock's rules
  // are crude, so only on plain orders is getting it right asked of it.
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s: runs to an end', async (_, scenario) => {
    const result = await runScenario(scenario, mock);
    expect(result.error).toBeUndefined();
    expect(result.stalled).toBe(false);
    if (scenario.id === 'plain' || scenario.id === 'rush') expect(result).toMatchObject({ ok: true, wrong: 0 });
  });
});
