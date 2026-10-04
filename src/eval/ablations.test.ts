import type { JevRequest } from '@xstate/jev';
import { describe, expect, it } from 'vitest';
import { ABLATIONS } from './ablations';
import { baristaMock } from './mock';
import { runScenario, SCENARIOS } from './scenarios';

/** A real request: the first one Jev gets with the front full of empty cups (asked as an ablation's agent would ask it). */
async function firstRequest(agent?: string): Promise<JevRequest> {
  let request: JevRequest | undefined;
  await runScenario(SCENARIOS.find((s) => s.id === 'cups-in-the-way')!, async (r) => ((request ??= r), baristaMock(r)), {
    maxDecisions: 1,
    agent: ABLATIONS.find((a) => a.id === agent)?.agent,
  });
  return request!;
}

const strip = (id: string, r: JevRequest) => ABLATIONS.find((a) => a.id === id)!.strip!(r);
const text = (r: JevRequest) => JSON.stringify(r);

describe('ablations', () => {
  it('each takes out its part, and only that', async () => {
    const r = await firstRequest();
    expect(Object.keys(r.questions)).toContain('action');
    expect(text(r)).toMatch(/Not possible right now/);
    expect(text(strip('no-refused', r))).not.toMatch(/Not possible right now/);
    expect(text(r)).toMatch(/"next":/);
    expect(text(strip('no-next', r))).not.toMatch(/"next":|\.next:/);
    expect(text(r)).toMatch(/"blockedBy":/);
    expect(text(strip('no-blocked', r))).not.toMatch(/"blockedBy":|\.blockedBy:/);
    expect(text(strip('no-lookahead', r))).not.toMatch(/afterwards:/);
    // Plain: options, descriptions, state and the fuller goal; nothing per option beyond its description.
    const plain = strip('plain', r);
    expect(text(plain)).not.toMatch(/afterwards:|once done|Not possible right now|"next":|"blockedBy":/);
    expect(JSON.stringify(plain.questions)).toMatch(/How the bar works/);
    const plainTwo = strip('plain', await firstRequest('hierarchical'));
    expect((plainTwo.questions.event_type as { criteria: Record<string, string> }).criteria['barista.addChocolate']).toMatch(
      /^barista\.addChocolate \(add chocolate to a cup\), one of \d+: c1; c2; c3/,
    );
    // Plain plus outcomes: each option says only what it comes to once done.
    const outcome = strip('plain-outcome', r);
    expect(text(outcome)).not.toMatch(/afterwards:|\.next:|\.blockedBy:/);
    expect(text(outcome)).toMatch(/once done: /);
    expect(text(plain).length).toBeLessThan(text(outcome).length);
    expect(text(outcome).length).toBeLessThan(text(r).length);
    // Variant questions keep their premise when the refused moves go.
    const variant = Object.entries(strip('no-refused', await firstRequest('hierarchical')).questions).find(([id]) => id.startsWith('variant:'))?.[1] as { instructions: string };
    expect(variant.instructions).toMatch(/Assume the action taken is/);
    // The rest of the request is untouched.
    expect(strip('no-refused', r).state).toEqual(r.state);
  });
});
