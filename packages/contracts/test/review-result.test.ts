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
    'pass',
    `The tests passed. ${JSON.stringify(passing)}`,
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
