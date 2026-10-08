import { describe, expect, it } from 'vitest';
import { allowedTaskEngines, isFakeDemo, taskEngineForMode } from '../src/demo-mode';

describe('explicit temporary fake demo', () => {
  it('recognizes the explicit query alongside other harmless parameters', () => {
    expect(isFakeDemo('?demo=fake')).toBe(true);
    expect(isFakeDemo('?view=tasks&demo=fake')).toBe(true);
  });

  it.each(['', '?demo=', '?demo=claude', '?demo=Fake', '?other=fake', '?demo=fake&demo=claude', '?demo=fake&demo=fake'])('does not label an absent, unsupported or ambiguous marker as a demo: %s', (search) => {
    expect(isFakeDemo(search)).toBe(false);
  });

  it('limits demo choices and coerces a loaded Claude default or draft to fake', () => {
    expect(allowedTaskEngines(true)).toEqual(['fake']);
    expect(taskEngineForMode('claude', true)).toBe('fake');
    expect(taskEngineForMode('fake', true)).toBe('fake');
  });

  it('preserves normal engine choices and the selected real engine', () => {
    expect(allowedTaskEngines(false)).toEqual(['fake', 'claude']);
    expect(taskEngineForMode('claude', false)).toBe('claude');
    expect(taskEngineForMode('fake', false)).toBe('fake');
  });
});
