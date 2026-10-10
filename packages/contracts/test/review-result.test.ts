import { describe, expect, it } from 'vitest';
import { parseReviewResult, ReviewResultError } from '../src/index.js';

const passing = { verdict: 'pass', blockers: [], evidence: ['Runtime verification exited 0.'] };
const rework = {
  verdict: 'rework',
  blockers: ['A newly added case fails.'],
  evidence: ['Runtime verification exited 1.'],
};

describe('structured review parsing', () => {
  it('accepts the exact passing and rework JSON structures', () => {
    expect(parseReviewResult(JSON.stringify(passing))).toEqual(passing);
    expect(parseReviewResult(` \n${JSON.stringify(rework)}\n `)).toEqual(rework);
  });

  it('accepts only a standalone JSON markdown fence', () => {
    expect(parseReviewResult(`\`\`\`json\n${JSON.stringify(passing)}\n\`\`\``)).toEqual(passing);
    expect(parseReviewResult(`\`\`\`json\r\n${JSON.stringify(rework, null, 2)}\r\n\`\`\``)).toEqual(rework);
  });

  it.each([
    ["I'll review the changes and actual Runtime verification records.\n\n", JSON.stringify(passing), passing],
    ["I'll review...", JSON.stringify(passing), passing],
    ['The tests passed. ', JSON.stringify(passing), passing],
    ['I inspected "feature.txt".\n', JSON.stringify(passing), passing],
    ['Review complete.\r\n', JSON.stringify(rework, null, 2), rework],
    ['I checked the Runtime evidence.\n\n', `\`\`\`json\n${JSON.stringify(passing)}\n\`\`\``, passing],
    ['An improvement is required.\r\n', `\`\`\`json\r\n${JSON.stringify(rework)}\r\n\`\`\``, rework],
  ])('accepts plain progress prose followed by one complete final result: %s', (prefix, payload, result) => {
    expect(parseReviewResult(`${prefix}${payload}\n `)).toEqual(result);
  });

  it('preserves nested braces, escapes and field-like text inside evidence strings', () => {
    const result = { ...passing, evidence: [
      'Observed {nested {braces}} and [array brackets].',
      'Escaped quotes "verdict": "rework" and a backslash \\ are evidence, not fields.',
      'Literal ```json fence characters and newline\n检查结果。',
    ] };
    expect(parseReviewResult(`I'll review...\n${JSON.stringify(result)}`)).toEqual(result);
  });

  it.each([
    'pass',
    `${JSON.stringify(passing)}\nEverything looks good.`,
    `\`\`\`\n${JSON.stringify(passing)}\n\`\`\``,
    `\`\`\`typescript\n${JSON.stringify(passing)}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(passing)}\n\`\`\`\nAdditional evidence`,
    `\`\`\`json\n${JSON.stringify(passing)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(rework)}\n\`\`\``,
    '{verdict: "pass", blockers: [], evidence: []}',
    '{"verdict":"pass","blockers":[],"evidence":[],}',
    '',
  ])('rejects prose, loose JSON, or unsupported fences: %s', (text) => {
    expect(() => parseReviewResult(text)).toThrow(ReviewResultError);
  });

  it.each([
    `${JSON.stringify(passing)}\n${JSON.stringify(rework)}`,
    `${JSON.stringify(rework)}\n${JSON.stringify(passing)}`,
    `${JSON.stringify(passing)}\n${JSON.stringify(passing)}`,
    `I'll review...\n{invalid JSON}\n${JSON.stringify(passing)}`,
    `I'll review...\n{"verdict":"approved"}\n${JSON.stringify(passing)}`,
    `I'll review...\n{"verdict":"rework"\n${JSON.stringify(passing)}`,
    `Unexpected } in progress.\n${JSON.stringify(passing)}`,
    `Progress with [another candidate].\n${JSON.stringify(passing)}`,
    `null\n${JSON.stringify(passing)}`,
    `0\n${JSON.stringify(passing)}`,
    `"another result"\n${JSON.stringify(passing)}`,
    `I'll review...\nnull\n${JSON.stringify(passing)}`,
    `I'll review...\n"another result"\n${JSON.stringify(passing)}`,
    `I'll review...\n${JSON.stringify(passing)}\nFurther explanation.`,
    `I'll review...\n\`\`\`json\n${JSON.stringify(passing)}\n\`\`\`\nFurther explanation.`,
    `I'll review...\n\`\`\`typescript\n${JSON.stringify(passing)}\n\`\`\``,
    `I'll review...\n\`\`\`json\n${JSON.stringify(passing)}`,
    `I'll review...\n${JSON.stringify(passing)}\n\`\`\`json\n${JSON.stringify(rework)}\n\`\`\``,
    `I'll review...\n\`\`\`json\n${JSON.stringify(rework)}\n\`\`\`\n${JSON.stringify(passing)}`,
    `I'll review...\n${JSON.stringify({ payload: passing })}`,
    `I'll review...\n${JSON.stringify([passing])}`,
    `I'll review...\n${JSON.stringify(JSON.stringify(passing))}`,
    '"' + JSON.stringify(passing),
    '"unfinished\n' + JSON.stringify(passing),
    'Plain progress.\n"unfinished\n' + JSON.stringify(passing),
    `Plain progress.\n"unfinished\n\`\`\`json\n${JSON.stringify(passing)}\n\`\`\``,
  ])('rejects ambiguous, nested, truncated or non-terminal payloads: %s', text => {
    expect(() => parseReviewResult(text)).toThrow(ReviewResultError);
  });

  it.each([
    '{"verdict":"rework","verdict":"pass","blockers":[],"evidence":[]}',
    '{"verdict":"pass","verdict":"rework","blockers":["Required fix"],"evidence":[]}',
    '{"verdict":"pass","blockers":["Unresolved blocker"],"blockers":[],"evidence":[]}',
    '{"verdict":"pass","blockers":[],"evidence":[false],"evidence":[]}',
    '{"verdict":"rework","verdi\\u0063t":"pass","blockers":[],"evidence":[]}',
    '{"verdict":"pass","blockers":null,"bloc\\u006bers":[],"evidence":[]}',
  ])('rejects duplicate fields instead of accepting the last value: %s', text => {
    expect(() => parseReviewResult(`I'll review...\n${text}`)).toThrow(ReviewResultError);
  });

  it.each([
    null,
    [],
    'pass',
    1,
    true,
    {},
    { verdict: 'pass' },
    { verdict: 'pass', blockers: [] },
    { verdict: 'pass', blockers: [], evidence: [], summary: 'Looks good.' },
    { verdict: 'approved', blockers: [], evidence: [] },
    { verdict: true, blockers: [], evidence: [] },
    { verdict: 'pass', blockers: null, evidence: [] },
    { verdict: 'pass', blockers: [], evidence: 'A test passed.' },
    { verdict: 'rework', blockers: [false], evidence: [] },
    { verdict: 'rework', blockers: [''], evidence: [] },
    { verdict: 'rework', blockers: ['  '], evidence: [] },
    { verdict: 'rework', blockers: ['A failure.'], evidence: [1] },
    { verdict: 'rework', blockers: ['A failure.'], evidence: ['\n'] },
    { verdict: 'pass', blockers: ['A contradiction.'], evidence: [] },
    { verdict: 'rework', blockers: [], evidence: ['A vague concern.'] },
  ])('rejects incomplete or contradictory result: %j', (result) => {
    expect(() => parseReviewResult(JSON.stringify(result))).toThrow(ReviewResultError);
    expect(() => parseReviewResult(`I'll review...\n${JSON.stringify(result)}`)).toThrow(ReviewResultError);
  });

  it('does not infer success from a narrative that mentions a passing verdict', () => {
    expect(() => parseReviewResult('The test failed, but my verdict is pass.')).toThrow(ReviewResultError);
  });

  it('reports a stable error code without repeating the untrusted output', () => {
    try {
      parseReviewResult('untrusted output with private context');
      throw new Error('Expected review rejection.');
    } catch (error) {
      expect(error).toMatchObject({ name: 'ReviewResultError', code: 'INVALID_REVIEW_RESULT' });
      expect((error as Error).message).not.toContain('private context');
    }
  });
});
