import { randomBytes } from 'node:crypto';

/**
 * 短时、一次性票据（对齐 OpenClaw Gateway 的 createOneTimeTicketStore）。
 *
 * - mint 时生成 32 字节 base64url（43 字符），只把明文交给调用方一次；
 * - consume 成功后删除，过期、已用、格式不对或 accept() 不匹配都返回 undefined；
 * - accept() 失败时票据仍保留，供真正的持有者再次消费；
 * - 只活在内存里：进程重启后未用票据全部作废，调用方应重新申请。
 */
export const ONE_TIME_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface OneTimeTicket<T> {
  token: string;
  expiresAtMs: number;
  payload: T;
}

interface TicketEntry<T> {
  payload: T;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createOneTimeTicketStore<T>(opts: {
  ttlMs: number;
  now?: () => number;
  onExpire?: (payload: T, token: string) => void;
}) {
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, TicketEntry<T>>();

  const remove = (token: string): TicketEntry<T> | undefined => {
    const entry = entries.get(token);
    if (!entry) return undefined;
    entries.delete(token);
    clearTimeout(entry.timer);
    return entry;
  };

  const expire = (token: string): void => {
    const entry = remove(token);
    if (entry) opts.onExpire?.(entry.payload, token);
  };

  return {
    mint(payload: T, options: { ttlMs?: number; nowMs?: number } = {}): OneTimeTicket<T> {
      const token = randomBytes(32).toString('base64url');
      const ttlMs = options.ttlMs ?? opts.ttlMs;
      const expiresAtMs = (options.nowMs ?? now()) + ttlMs;
      const timer = setTimeout(() => expire(token), Math.max(1, ttlMs));
      timer.unref?.();
      entries.set(token, { payload, expiresAtMs, timer });
      return { token, expiresAtMs, payload };
    },
    /**
     * 单次消费。accept 返回 false 时不删除票据（让真正的持有者还能用）。
     * 过期票据走 onExpire，返回 undefined。
     */
    consume(token: string, nowMs?: number, accept?: (payload: T) => boolean): T | undefined {
      const currentTimeMs = nowMs ?? now();
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!ONE_TIME_TICKET_PATTERN.test(normalized)) return undefined;
      const pending = entries.get(normalized);
      if (!pending) return undefined;
      if (pending.expiresAtMs <= currentTimeMs) {
        expire(normalized);
        return undefined;
      }
      if (accept && !accept(pending.payload)) return undefined;
      const entry = remove(normalized);
      if (!entry) return undefined;
      if (entry.expiresAtMs <= currentTimeMs) {
        opts.onExpire?.(entry.payload, normalized);
        return undefined;
      }
      return entry.payload;
    },
    peek(token: string, nowMs?: number): T | undefined {
      const currentTimeMs = nowMs ?? now();
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!ONE_TIME_TICKET_PATTERN.test(normalized)) return undefined;
      const entry = entries.get(normalized);
      if (!entry || entry.expiresAtMs <= currentTimeMs) return undefined;
      return entry.payload;
    },
    delete(token: string): boolean {
      return remove(token) !== undefined;
    },
    clear(): void {
      for (const token of [...entries.keys()]) expire(token);
    },
    get size() {
      return entries.size;
    },
  };
}

export type OneTimeTicketStore<T> = ReturnType<typeof createOneTimeTicketStore<T>>;
