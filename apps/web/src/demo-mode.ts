import type { TaskEngine } from '@personal-agent/contracts';

/** This marker describes the UI; only the server can enforce an isolated demo. */
export function isFakeDemo(search: string): boolean {
  const values = new URLSearchParams(search).getAll('demo');
  return values.length === 1 && values[0] === 'fake';
}

export function allowedTaskEngines(fakeDemo: boolean): TaskEngine[] {
  return fakeDemo ? ['fake'] : ['fake', 'claude'];
}

export function taskEngineForMode(engine: TaskEngine, fakeDemo: boolean): TaskEngine {
  return fakeDemo ? 'fake' : engine;
}
