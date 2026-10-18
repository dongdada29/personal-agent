import type { AuthSession, TaskEngine } from '@personal-agent/contracts';

/**
 * This marker describes the UI; only the server can enforce an isolated demo.
 * A server-declared fake-only demo session always wins, so public visitors
 * without `?demo=fake` still see the fake-only workbench.
 */
export function isFakeDemo(search: string, session?: Pick<AuthSession, 'demo'>): boolean {
  if (session?.demo === 'fake') return true;
  const values = new URLSearchParams(search).getAll('demo');
  return values.length === 1 && values[0] === 'fake';
}

export function allowedTaskEngines(fakeDemo: boolean): TaskEngine[] {
  return fakeDemo ? ['fake'] : ['fake', 'claude'];
}

export function taskEngineForMode(engine: TaskEngine, fakeDemo: boolean): TaskEngine {
  return fakeDemo ? 'fake' : engine;
}
