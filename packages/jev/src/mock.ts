import type { JevAnswer, JevRequest, JevResponse, JevText } from './types';

/**
 * Heuristic for the mock. Per question type, the returned number means:
 * choice → a logit for `option`; noul → P(yes); score → a level index.
 * Return `undefined` for the neutral default.
 */
export type MockScorer = (args: {
  questionId: string;
  option?: string;
  /** For choice questions: the option's text, as Jev reads it (with its lookahead). */
  criterion?: JevText;
  state: unknown;
}) => number | undefined;

function softmax(scores: Record<string, number>): Record<string, number> {
  const entries = Object.entries(scores);
  const max = Math.max(...entries.map(([, v]) => v));
  const exps = entries.map(([k, v]) => [k, Math.exp(v - max)] as const);
  const sum = exps.reduce((acc, [, v]) => acc + v, 0);
  return Object.fromEntries(exps.map(([k, v]) => [k, Number((v / sum).toFixed(4))]));
}

function confidenceOf(probabilities: Record<string, number>): number {
  const [top = 0, second = 0] = Object.values(probabilities).sort((a, b) => b - a);
  return Number(Math.min(1, top - second + top * 0.3).toFixed(3));
}

/** Answers in exactly the shape Jev returns, from a heuristic plus a little noise. */
export function mockAnswers(request: JevRequest, score: MockScorer = () => undefined): JevResponse {
  const answers: Record<string, JevAnswer> = {};
  for (const [questionId, q] of Object.entries(request.questions)) {
    if (q.type === 'choice') {
      const probabilities = softmax(
        Object.fromEntries(
          Object.keys(q.criteria).map((option) => [
            option,
            (score({ questionId, option, criterion: q.criteria[option], state: request.state }) ?? 1) +
              Math.random() * 0.5,
          ]),
        ),
      );
      const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
      answers[questionId] = { type: 'choice', choice, probabilities, confidence: confidenceOf(probabilities) };
    } else if (q.type === 'noul') {
      const p = score({ questionId, state: request.state }) ?? 0.5;
      answers[questionId] = { type: 'noul', noul: Math.min(1, Math.max(0, p)) };
    } else {
      const top = q.criteria.length - 1;
      const level = Math.min(top, Math.max(0, score({ questionId, state: request.state }) ?? top / 2));
      const probabilities = softmax(
        Object.fromEntries(q.criteria.map((_, i) => [String(i), -Math.abs(i - level) * 2])),
      );
      answers[questionId] = {
        type: 'score',
        score: Number(level.toFixed(2)),
        confidence: confidenceOf(probabilities),
        legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), typeof c === 'string' ? c : JSON.stringify(c)])),
        probabilities,
      };
    }
  }
  return { answers, mock: true };
}
