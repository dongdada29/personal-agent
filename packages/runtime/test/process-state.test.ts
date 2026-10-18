import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { processAlive, processGroupAlive } from '../src/process-state.js';

const filesystem = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), mount: vi.fn(), link: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: (path: string, ...args: unknown[]) => path === '/proc/self/mountinfo'
    ? filesystem.mount(path, ...args) : filesystem.read(path, ...args),
  readdirSync: filesystem.list, readlinkSync: filesystem.link,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let kill: MockInstance<typeof process.kill>;
const failure = (code: string) => Object.assign(new Error('Synthetic process inspection failure'), { code });
const procMount = (options = 'rw') => `42 1 0:27 / /proc rw,nosuid,nodev,noexec - proc proc ${options}\n`;

function stat(pid: number, pgid: number, state = 'S', name = 'fixture', startTime = '100', threads = 1): string {
  const fields = [state, '1', String(pgid), ...Array<string>(47).fill('0')];
  fields[19] = startTime;
  fields[17] = String(threads);
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}
function records(rows: Record<number, string | Error>) {
  filesystem.list.mockReturnValue(['self', 'net', ...Object.keys(rows)]);
  filesystem.read.mockImplementation((path: string) => {
    const match = /^\/proc\/(\d+)\/stat$/u.exec(path);
    if (!match) throw new Error('Only process stat may be read');
    const row = rows[Number(match[1])];
    if (row instanceof Error) throw row;
    if (row === undefined) throw failure('ENOENT');
    return row;
  });
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  filesystem.read.mockReset(); filesystem.list.mockReset();
  filesystem.mount.mockReset().mockReturnValue(procMount());
  filesystem.link.mockReset().mockReturnValue(String(process.pid));
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => { kill.mockRestore(); Object.defineProperty(process, 'platform', originalPlatform); });

describe('Linux process execution state', () => {
  it.each(['R', 'S', 'D', 'T', 't', 'I', 'X', 'Q'])('keeps %s processes blocking and releases a confirmed zombie', state => {
    records({ 101: stat(101, 101, state), 102: stat(102, 101, 'Z') });
    expect(processAlive(101)).toBe(true);
    expect(processAlive(102)).toBe(false);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it('parses parenthesis and newline characters in comm without shifting the group or state', () => {
    records({ 101: stat(101, 77, 'Z', 'name ) Z 1 999 (nested)\n tail') });
    expect(processAlive(101)).toBe(false);
    expect(processGroupAlive(77)).toBe(false);
    expect(filesystem.read.mock.calls.every(([path]) => /^\/proc\/\d+\/stat$/u.test(String(path)))).toBe(true);
  });

  it('blocks a zombie thread-group leader that still has sibling threads', () => {
    records({ 101: stat(101, 101, 'Z', 'fixture', '100', 2) });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
  });

  it.each([0, -1, 1.5])('blocks an invalid thread count %s', threads => {
    records({ 101: stat(101, 101, 'Z', 'fixture', '100', threads) });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
  });

  it('confirms a missing PID with ESRCH without reading proc', () => {
    kill.mockImplementation(() => { throw failure('ESRCH'); });
    expect(processAlive(101)).toBe(false);
    expect(filesystem.read).not.toHaveBeenCalled();
    expect(filesystem.link).not.toHaveBeenCalled();
  });

  it('handles stat disappearance only when a second signal-zero check confirms ESRCH', () => {
    records({ 101: failure('ENOENT') });
    kill.mockImplementationOnce(() => true).mockImplementationOnce(() => { throw failure('ESRCH'); });
    expect(processAlive(101)).toBe(false);
    expect(kill.mock.calls).toEqual([[101, 0], [101, 0]]);
  });

  it.each(['EPERM', 'EACCES', 'EIO', 'ENOENT'])('blocks a %s stat failure when absence cannot be confirmed', code => {
    records({ 101: failure(code) });
    expect(processAlive(101)).toBe(true);
  });

  it.each(['EPERM', 'EACCES', 'EINVAL'])('blocks a %s signal-zero failure', code => {
    kill.mockImplementation(() => { throw failure(code); });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
    expect(filesystem.read).not.toHaveBeenCalled();
  });

  it.each([
    '101 (fixture) Z 1 101',
    stat(999, 101, 'Z'),
    stat(101, 101, 'Z').replace('(fixture)', 'fixture'),
    stat(101, 101, 'Z').replace('Z 1 101', 'Z 1 not-a-group'),
    stat(101, 101, 'Z').replace('Z 1 101', '? 1 101'),
    stat(101, 101, 'Z').replace('Z 1 101', 'Z -1 101'),
  ])('blocks malformed or mismatched stat data', row => {
    records({ 101: row });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
  });
});

describe('Linux complete process group inspection', () => {
  it('releases a stable all-zombie group while ignoring readable processes in other groups', () => {
    records({ 101: stat(101, 101, 'Z'), 102: stat(102, 101, 'Z'), 201: stat(201, 200, 'S') });
    expect(processGroupAlive(101)).toBe(false);
  });

  it('blocks a zombie owner with an active descendant, and an orphaned active group without its owner', () => {
    records({ 101: stat(101, 101, 'Z'), 102: stat(102, 101, 'S') });
    expect(processGroupAlive(101)).toBe(true);
    records({ 102: stat(102, 101, 'S') });
    expect(processGroupAlive(101)).toBe(true);
  });

  it('blocks an incomplete proc view when no matching member is visible but the group still exists', () => {
    records({ 201: stat(201, 200, 'S') });
    expect(processGroupAlive(101)).toBe(true);
    kill.mockImplementationOnce(() => true).mockImplementationOnce(() => { throw failure('ESRCH'); });
    expect(processGroupAlive(101)).toBe(false);
  });

  it.each(['EACCES', 'EPERM', 'ENOENT', 'EIO'])('blocks when /proc cannot be enumerated: %s', code => {
    filesystem.list.mockImplementation(() => { throw failure(code); });
    expect(processGroupAlive(101)).toBe(true);
  });

  it('blocks when even an unrelated listed PID cannot be inspected', () => {
    records({ 101: stat(101, 101, 'Z'), 201: failure('EACCES') });
    expect(processGroupAlive(101)).toBe(true);
  });

  it('ignores a disappearing listed process only after confirming ESRCH', () => {
    records({ 101: stat(101, 101, 'Z'), 201: failure('ENOENT') });
    kill.mockImplementation((pid: number) => { if (pid === 201) throw failure('ESRCH'); return true; });
    expect(processGroupAlive(101)).toBe(false);
    kill.mockImplementation(() => true);
    expect(processGroupAlive(101)).toBe(true);
  });

  it.each([1, 2])('blocks a new PID appearing after inspection pass %s', pass => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.list.mockReset();
    filesystem.list.mockReturnValueOnce(['101']);
    if (pass === 2) filesystem.list.mockReturnValueOnce(['101']);
    filesystem.list.mockReturnValue(['101', '102']);
    expect(processGroupAlive(101)).toBe(true);
  });

  it('rechecks existing members instead of relying on the first all-zombie observation', () => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.read.mockReturnValueOnce(stat(101, 101, 'Z')).mockReturnValue(stat(101, 101, 'S'));
    expect(processGroupAlive(101)).toBe(true);
  });

  it('blocks PID reuse even when the replacement is also a zombie in the same group', () => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.read.mockReturnValueOnce(stat(101, 101, 'Z', 'fixture', '100'))
      .mockReturnValue(stat(101, 101, 'Z', 'fixture', '200'));
    expect(processGroupAlive(101)).toBe(true);
  });

  it('blocks malformed numeric proc entries rather than silently ignoring them', () => {
    filesystem.list.mockReturnValue(['101', '99999999999999999999']);
    expect(processGroupAlive(101)).toBe(true);
  });
});

describe('Linux proc visibility and PID namespace', () => {
  it.each(['hidepid=0', 'hidepid=off'])('permits explicitly unfiltered procfs: %s', option => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.mount.mockReturnValue(procMount(`rw,${option}`));
    expect(processGroupAlive(101)).toBe(false);
  });

  it.each(['1', '2', '4', 'noaccess', 'invisible', 'ptraceable'])('blocks hidepid=%s with a visible zombie and hidden active member', hidepid => {
    records({ 101: stat(101, 101, 'Z'), 102: stat(102, 101, 'S') });
    filesystem.list.mockReturnValue(['101']);
    filesystem.mount.mockReturnValue(procMount(`rw,hidepid=${hidepid}`));
    expect(processGroupAlive(101)).toBe(true);
    expect(filesystem.list).not.toHaveBeenCalled();
  });

  it.each([
    '', 'unknown mountinfo', procMount().replace(' - proc ', ' - tmpfs '),
    procMount().replace(' / /proc ', ' /subtree /proc '), procMount('rw,hidepid=unknown'),
    procMount('rw,hidepid'), procMount() + procMount(),
    procMount().replace(' / /proc ', ' / /other '),
  ])('blocks unsupported or malformed mount information', mountinfo => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.mount.mockReturnValue(mountinfo);
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
  });

  it.each(['EACCES', 'EIO'])('blocks unreadable mount information: %s', code => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.mount.mockImplementation(() => { throw failure(code); });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
  });

  it.each(['/proc/101', '/proc/101/stat', '/proc/self/stat'])('blocks an overmount masking process information at %s', point => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.mount.mockReturnValue(procMount() + `43 42 0:28 / ${point} rw - tmpfs tmpfs rw\n`);
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
  });

  it('permits standard non-process proc submounts and unrecognized optional mount tags', () => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.mount.mockReturnValue(procMount().replace(' - proc ', ' shared:7 future:tag - proc ')
      + '43 42 0:28 / /proc/sys ro - proc proc rw\n');
    expect(processAlive(101)).toBe(false);
    expect(processGroupAlive(101)).toBe(false);
  });

  it('blocks a filtered remount during a previously unfiltered scan', () => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.mount.mockReturnValueOnce(procMount()).mockReturnValue(procMount('rw,hidepid=2'));
    expect(processAlive(101)).toBe(true);
    filesystem.mount.mockReturnValueOnce(procMount()).mockReturnValue(procMount('rw,hidepid=2'));
    expect(processGroupAlive(101)).toBe(true);
  });

  it.each(['different-pid', '../123'])('blocks both PID and group inspection with a mismatched proc self link: %s', self => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.link.mockReturnValue(self);
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
    expect(filesystem.read).not.toHaveBeenCalled();
  });

  it('blocks both PID and group inspection when the proc self link is unreadable', () => {
    records({ 101: stat(101, 101, 'Z') });
    filesystem.link.mockImplementation(() => { throw failure('EACCES'); });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
  });

  it('accepts kernel-confirmed ESRCH without needing proc visibility or namespace access', () => {
    kill.mockImplementation(() => { throw failure('ESRCH'); });
    expect(processAlive(101)).toBe(false);
    expect(processGroupAlive(101)).toBe(false);
    expect(filesystem.link).not.toHaveBeenCalled(); expect(filesystem.mount).not.toHaveBeenCalled();
  });
});

describe('portable process state', () => {
  it('preserves signal-zero behavior outside Linux and never reads proc', () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
    expect(kill.mock.calls).toEqual([[101, 0], [-101, 0]]);
    kill.mockImplementation(() => { throw failure('EPERM'); });
    expect(processAlive(101)).toBe(true);
    expect(processGroupAlive(101)).toBe(true);
    kill.mockImplementation(() => { throw failure('ESRCH'); });
    expect(processAlive(101)).toBe(false);
    expect(processGroupAlive(101)).toBe(false);
    expect(filesystem.read).not.toHaveBeenCalled(); expect(filesystem.list).not.toHaveBeenCalled();
    expect(filesystem.mount).not.toHaveBeenCalled(); expect(filesystem.link).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('blocks invalid identifiers %s without making process calls', id => {
    expect(processAlive(id)).toBe(true);
    expect(processGroupAlive(id)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(filesystem.read).not.toHaveBeenCalled(); expect(filesystem.list).not.toHaveBeenCalled();
  });
});
