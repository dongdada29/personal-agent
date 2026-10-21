/**
 * BoxService：把“本机宿主适配器 + 云端部署”汇总成同一个部署列表，并负责后台管理操作与桌面会话。
 *
 * - 状态查询有并发去重与短缓存，避免多个页面轮询时反复调用 colima / docker；
 * - VM / 容器管理动作在后台执行，同一部署同时只允许一个操作，页面轮询看结果；
 * - 桌面：启动前按 L0 实测策略准入（默认并发 2、硬上限 3、内存压力 warn 拒绝、0.7GB/桌面预算）；
 *   每次打开都生成新的一次性网关令牌，经 stdin 交给 box（第二行是 VNC 口令），
 *   与网关握手后再由服务端完成 VncAuth；口令不进日志、不进 API；
 *   统计查看者，无人查看超过 idleStopMinutes 的桌面自动停止；
 * - 错误只记录固定错误码，不记录命令输出；令牌不写日志、不返回给浏览器。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { ensurePrivateDirectory } from '@personal-agent/runtime';
import type {
  BoxAction, BoxDeployment, BoxDeploymentList, BoxDesktop, BoxDesktopPolicy, BoxOperation, CreateCloudBoxCommand,
} from '@personal-agent/contracts';
import { defaultCommandRunner, type CommandRunner } from './command.js';
import { BoxStore, type CloudDeploymentRecord } from './box-store.js';
import { AgentBroker, CloudAgentAdapter, CloudSshAdapter } from './cloud-adapters.js';
import { gateHandshake, newDesktopToken } from './gate.js';
import { authenticateRfb, RfbAuthError } from '../rfb-preauth.js';
import { BOX_NAMES, BoxError, resolveBoxNames, type BoxNames, type BoxSnapshot, type HostAdapter } from './host-adapter.js';
import { localAdapterFor } from './local-adapters.js';
import { admitDesktop, desktopPolicyFromEnv } from './policy.js';

export const LOCAL_DEPLOYMENT_ID = 'local';

export interface BoxServiceOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** 测试注入；默认按平台选择。传 null 表示本机没有可用的本地适配器。 */
  localAdapter?: HostAdapter | null;
  now?: () => number;
  cacheMs?: number;
  /** 覆盖桌面策略（默认取 PA_BOX_CONCURRENT_DESKTOPS / PA_BOX_DESKTOP_IDLE_MINUTES 或内置默认值）。 */
  desktopPolicy?: Partial<BoxDesktopPolicy>;
  env?: NodeJS.ProcessEnv;
  /** 覆盖容器名等；默认 BOX_NAMES（容器 pa-box-desktop）。 */
  names?: Partial<BoxNames>;
  /** 空闲停机扫描间隔；0 表示不自动扫描（测试中手动调用 sweepIdleDesktops）。 */
  sweepIntervalMs?: number;
}

const localNames: Record<string, string> = { colima: '本机 · Colima（macOS）', wsl2: '本机 · WSL2（Windows）', podman: '本机 · Podman（Linux）', docker: '本机 · Docker（Linux）' };

interface DesktopSession { running: boolean; viewers: number; lastActiveAt: number }

export interface DesktopStream {
  stream: Duplex;
  /** 查看者断开时调用一次：减少查看者计数并刷新空闲计时。 */
  release(): void;
}

const failedSnapshot = (containerName = BOX_NAMES.container): BoxSnapshot => ({ host: { state: 'error', detail: '状态查询失败。' }, container: { state: 'unknown', name: containerName },
  desktops: [], gateReady: false, memoryPressure: 'unknown' });

export class BoxService {
  readonly store: BoxStore;
  readonly broker = new AgentBroker();
  readonly platform: NodeJS.Platform;
  readonly policy: BoxDesktopPolicy;
  readonly names: BoxNames;
  private readonly run: CommandRunner;
  private readonly local: HostAdapter | undefined;
  private readonly operations = new Map<string, BoxOperation>();
  private readonly cache = new Map<string, { at: number; value: Promise<BoxSnapshot> }>();
  private readonly sessions = new Map<string, DesktopSession>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly sweepTimer: NodeJS.Timeout | undefined;
  /** 每桌面 VNC 口令（内存 + 0600 文件）。明文不进日志、不进响应。 */
  private readonly passwords = new Map<string, string>();
  private readonly secretsFile: string;

  constructor(options: BoxServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? defaultCommandRunner;
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? 2_000;
    this.policy = desktopPolicyFromEnv(options.env ?? process.env, options.desktopPolicy);
    this.names = resolveBoxNames(options.env ?? process.env, options.names);
    this.local = options.localAdapter === null ? undefined : options.localAdapter ?? localAdapterFor(this.platform, this.run, this.names);
    this.store = new BoxStore(join(options.dataDir, 'box.sqlite'), this.now);
    this.secretsFile = join(options.dataDir, 'box-vnc-secrets.json');
    this.loadPasswords();
    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => { void this.sweepIdleDesktops(); }, interval);
      this.sweepTimer.unref();
    }
  }

  private adapterFor(id: string): { adapter: HostAdapter; record?: CloudDeploymentRecord } {
    if (id === LOCAL_DEPLOYMENT_ID) {
      if (!this.local) throw new BoxError('BOX_DEPLOYMENT_NOT_FOUND', '本机平台没有可用的宿主适配器。', 404);
      return { adapter: this.local };
    }
    const record = this.store.get(id);
    if (!record) throw new BoxError('BOX_DEPLOYMENT_NOT_FOUND', '部署不存在。', 404);
    const adapter = record.connection === 'ssh'
      ? new CloudSshAdapter(record.endpoint!, this.run, this.names)
      : new CloudAgentAdapter(record.id, this.store, this.broker, this.now, this.names);
    return { adapter, record };
  }

  private snapshot(id: string, adapter: HostAdapter, fresh = false): Promise<BoxSnapshot> {
    const cached = this.cache.get(id);
    if (!fresh && cached && this.now() - cached.at < this.cacheMs) return cached.value;
    const value = adapter.status().catch(() => failedSnapshot(this.names.container)).then(snapshot => { this.observe(id, snapshot); return snapshot; });
    this.cache.set(id, { at: this.now(), value });
    return value;
  }

  /** 用最新快照校正桌面会话：第一次看到正在运行的桌面时，从此刻开始计算空闲时间。 */
  private observe(id: string, snapshot: BoxSnapshot): void {
    const seen = new Set<string>();
    for (const desktop of snapshot.desktops) {
      const key = `${id}/${desktop.id}`;
      seen.add(key);
      const session = this.sessions.get(key);
      if (desktop.running && !session) this.sessions.set(key, { running: true, viewers: 0, lastActiveAt: this.now() });
      else if (session) {
        if (desktop.running && !session.running) session.lastActiveAt = this.now();
        session.running = desktop.running;
      }
    }
    // 容器停止 / 被删除时 ctl 不再返回桌面：对应会话视为已停止（查看者连接会随网关断开而释放）。
    if (snapshot.container.state !== 'unknown') {
      for (const [key, session] of this.sessions) if (key.startsWith(`${id}/`) && !seen.has(key)) session.running = false;
    }
  }

  private presentDesktops(id: string, snapshot: BoxSnapshot): BoxDesktop[] {
    const idleMs = this.policy.idleStopMinutes * 60_000;
    return snapshot.desktops.map(desktop => {
      const session = this.sessions.get(`${id}/${desktop.id}`);
      const viewers = session?.viewers ?? 0;
      const number = Number(desktop.id.slice(1));
      return { id: desktop.id, label: `桌面 ${number}`, display: `:${number}`, state: desktop.running ? 'running' : 'stopped',
        streamable: snapshot.gateReady, viewers,
        ...(desktop.running && session && viewers === 0 ? { idleStopAt: new Date(session.lastActiveAt + idleMs).toISOString() } : {}) };
    });
  }

  private present(id: string, adapter: HostAdapter, snapshot: BoxSnapshot, record?: CloudDeploymentRecord): BoxDeployment {
    const operation = this.operations.get(id);
    const busy = operation && !operation.finishedAt;
    return {
      id, kind: adapter.kind, adapter: adapter.id,
      name: record?.name ?? localNames[adapter.id] ?? '本机 box',
      ...(record ? { providerLabel: record.providerLabel, endpoint: record.endpoint, authRef: record.authRef, connection: record.connection,
        createdAt: record.createdAt, registered: record.connection === 'ssh' ? true : !!record.registeredAt, lastHeartbeatAt: record.lastHeartbeatAt ?? null } : {}),
      host: snapshot.host, container: snapshot.container,
      desktops: this.presentDesktops(id, snapshot),
      desktopPolicy: { ...this.policy },
      memoryPressure: snapshot.memoryPressure,
      actions: busy ? [] : adapter.actions(snapshot),
      ...(operation ? { operation } : {}),
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  async list(): Promise<BoxDeploymentList> {
    const entries: { id: string; adapter: HostAdapter; record?: CloudDeploymentRecord }[] = [];
    if (this.local) entries.push({ id: LOCAL_DEPLOYMENT_ID, adapter: this.local });
    for (const record of this.store.list()) entries.push({ id: record.id, ...this.adapterFor(record.id) });
    const deployments = await Promise.all(entries.map(async entry => this.present(entry.id, entry.adapter, await this.snapshot(entry.id, entry.adapter), entry.record)));
    return { platform: this.platform, deployments };
  }

  async get(id: string): Promise<BoxDeployment> {
    const { adapter, record } = this.adapterFor(id);
    return this.present(id, adapter, await this.snapshot(id, adapter), record);
  }

  addCloud(command: CreateCloudBoxCommand): { deployment: CloudDeploymentRecord; created: boolean } {
    const { record, created } = this.store.create(command);
    return { deployment: record, created };
  }

  removeCloud(id: string): void {
    if (id === LOCAL_DEPLOYMENT_ID) throw new BoxError('BOX_INPUT_INVALID', '本机部署不能移除。', 400);
    if (!this.store.remove(id)) throw new BoxError('BOX_DEPLOYMENT_NOT_FOUND', '部署不存在。', 404);
    this.broker.forget(id);
    this.cache.delete(id);
    this.operations.delete(id);
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${id}/`)) this.sessions.delete(key);
  }

  /** 在后台执行；立即返回操作记录。动作必须属于当前状态允许的集合。 */
  async perform(id: string, action: BoxAction): Promise<BoxOperation> {
    const { adapter } = this.adapterFor(id);
    const current = this.operations.get(id);
    if (current && !current.finishedAt) throw new BoxError('BOX_OPERATION_RUNNING', '该部署已有操作在进行中。', 409);
    const snapshot = await this.snapshot(id, adapter, true);
    if (!adapter.actions(snapshot).includes(action)) throw new BoxError('BOX_ACTION_UNAVAILABLE', '当前状态下不能执行该操作，请刷新后重试。', 409);
    const operation: BoxOperation = { action, startedAt: new Date(this.now()).toISOString() };
    this.operations.set(id, operation);
    void adapter.perform(action).then(
      () => { operation.ok = true; },
      (error: unknown) => { operation.ok = false; operation.errorCode = error instanceof BoxError ? error.code : 'BOX_ACTION_FAILED'; },
    ).finally(() => { operation.finishedAt = new Date(this.now()).toISOString(); this.cache.delete(id); });
    return operation;
  }

  /** 同一桌面的启动 / 打开 / 停止串行执行：令牌轮换与握手之间不能被另一次打开插队。 */
  private exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key); });
    return next;
  }

  private validDesktopId(desktopId: string): void {
    if (!/^d[1-9]$/.test(desktopId) || Number(desktopId.slice(1)) > this.policy.max) throw new BoxError('BOX_DESKTOP_NOT_FOUND', '桌面不存在。', 404);
  }

  private loadPasswords(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.secretsFile, 'utf8')) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.length >= 8 && !value.includes('\n')) this.passwords.set(key, value);
      }
    } catch { /* 首次启动或文件损坏：下次启动桌面会重新生成口令 */ }
  }

  private persistPasswords(): void {
    ensurePrivateDirectory(dirname(this.secretsFile));
    writeFileSync(this.secretsFile, JSON.stringify(Object.fromEntries(this.passwords)), { mode: 0o600 });
  }

  private forgetPassword(key: string): void {
    this.passwords.delete(key);
    this.persistPasswords();
  }

  /** 8 个可打印字符：VNC DES 只用前 8 字节。从不记录、不回显。 */
  private passwordFor(key: string): string {
    const existing = this.passwords.get(key);
    if (existing) return existing;
    const next = randomBytes(8).toString('base64url').slice(0, 8);
    this.passwords.set(key, next);
    this.persistPasswords();
    return next;
  }

  /** 准入通过后启动（或只轮换令牌）；返回本次使用的新令牌与 VNC 口令。 */
  private async ensureDesktop(
    id: string,
    adapter: HostAdapter,
    desktopId: string,
    options: { startIfStopped?: boolean } = {},
  ): Promise<{ token: string; password: string }> {
    const snapshot = await this.snapshot(id, adapter, true);
    const running = snapshot.desktops.some(item => item.id === desktopId && item.running);
    if (!running && options.startIfStopped === false) {
      throw new BoxError('PERMISSION_DENIED', '只读设备只能观看已经在运行的桌面。', 403);
    }
    const refusal = admitDesktop(snapshot, desktopId, this.policy);
    if (refusal) throw refusal;
    const token = newDesktopToken();
    const key = `${id}/${desktopId}`;
    const password = this.passwordFor(key);
    await adapter.desktop('start', desktopId, token, password);
    this.cache.delete(id);
    const session = this.sessions.get(key);
    if (session) { session.running = true; session.lastActiveAt = this.now(); }
    else this.sessions.set(key, { running: true, viewers: 0, lastActiveAt: this.now() });
    return { token, password };
  }

  async startDesktop(id: string, desktopId: string): Promise<BoxDeployment> {
    this.validDesktopId(desktopId);
    const { adapter, record } = this.adapterFor(id);
    await this.exclusive(`${id}/${desktopId}`, () => this.ensureDesktop(id, adapter, desktopId));
    return this.present(id, adapter, await this.snapshot(id, adapter, true), record);
  }

  async stopDesktop(id: string, desktopId: string): Promise<BoxDeployment> {
    this.validDesktopId(desktopId);
    const { adapter, record } = this.adapterFor(id);
    await this.exclusive(`${id}/${desktopId}`, async () => {
      await adapter.desktop('stop', desktopId);
      const session = this.sessions.get(`${id}/${desktopId}`);
      if (session) session.running = false;
      this.passwords.delete(`${id}/${desktopId}`);
      this.persistPasswords();
      this.cache.delete(id);
    });
    return this.present(id, adapter, await this.snapshot(id, adapter, true), record);
  }

  /**
   * 打开桌面串流：准入 → 新令牌经 stdin 写入 box → 连接网关 → 令牌前导握手。
   * 返回的流之后只承载 RFB 字节；WebSocket 由路由层终结。
   * allowStart=false（observer）：桌面没在跑就拒绝，绝不顺便启动。
   */
  async openDesktopStream(id: string, desktopId: string, options: { allowStart?: boolean } = {}): Promise<DesktopStream> {
    this.validDesktopId(desktopId);
    const { adapter } = this.adapterFor(id);
    const key = `${id}/${desktopId}`;
    const allowStart = options.allowStart !== false;
    const connect = async (startIfStopped: boolean) => {
      const { token, password } = await this.ensureDesktop(id, adapter, desktopId, { startIfStopped });
      const gate = await adapter.openGate();
      try {
        const raw = await gateHandshake(gate, desktopId, token);
        return await authenticateRfb(raw, password);
      } catch (error) {
        gate.destroy();
        throw error;
      }
    };
    const stream = await this.exclusive(key, async () => {
      try {
        return await connect(allowStart);
      } catch (error) {
        // 口令文件丢失或换了数据目录后，容器里还是旧 rfbauth。操作员打开时轮换口令并重启桌面再试一次。
        if (!(error instanceof RfbAuthError) || !allowStart) throw error;
        this.forgetPassword(key);
        try { await adapter.desktop('stop', desktopId); } catch { /* 停不掉也继续用新口令拉起 */ }
        const session = this.sessions.get(key);
        if (session) session.running = false;
        this.cache.delete(id);
        return connect(true);
      }
    });
    const session = this.sessions.get(key)!;
    session.viewers += 1;
    let released = false;
    return { stream, release: () => {
      if (released) return;
      released = true;
      session.viewers = Math.max(0, session.viewers - 1);
      session.lastActiveAt = this.now();
    } };
  }

  /** 记录查看者活动（有 RFB 数据往来时调用，节流由调用方负责）。 */
  touchDesktop(id: string, desktopId: string): void {
    const session = this.sessions.get(`${id}/${desktopId}`);
    if (session) session.lastActiveAt = this.now();
  }

  /** 停止无人查看、空闲超过 idleStopMinutes 的桌面。返回被停止的桌面键。 */
  async sweepIdleDesktops(): Promise<string[]> {
    const idleMs = this.policy.idleStopMinutes * 60_000;
    const stopped: string[] = [];
    for (const [key, session] of [...this.sessions]) {
      if (!session.running || session.viewers > 0 || this.now() - session.lastActiveAt < idleMs) continue;
      const [id, desktopId] = key.split('/');
      try {
        const { adapter } = this.adapterFor(id);
        await this.exclusive(key, async () => {
          if (!session.running || session.viewers > 0 || this.now() - session.lastActiveAt < idleMs) return;
          await adapter.desktop('stop', desktopId);
          session.running = false;
          this.cache.delete(id);
          stopped.push(key);
        });
      } catch (error) {
        // 部署已移除时清掉会话；其他失败（离线、超时）留到下一轮重试。
        if (error instanceof BoxError && error.code === 'BOX_DEPLOYMENT_NOT_FOUND') this.sessions.delete(key);
      }
    }
    return stopped;
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.broker.close();
    this.store.close();
  }
}
