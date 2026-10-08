import type { AuthSession, Device, PairingTicket } from '@personal-agent/contracts';

/** Whitelist the public session shape and fail closed for incomplete paired sessions. */
export function verifiedSession(value: unknown, now = Date.now()): AuthSession {
  if (!value || typeof value !== 'object') throw new Error('Invalid session');
  const input = value as Partial<AuthSession>;
  if (input.mode === 'loopback') return { mode: 'loopback' };
  const device = input.device;
  if (input.mode !== 'paired' || !device || typeof input.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.csrfToken)) throw new Error('Invalid paired session');
  if (typeof device.id !== 'string' || !device.id || typeof device.name !== 'string' || !device.name || typeof device.createdAt !== 'string' || typeof device.expiresAt !== 'string' || !Number.isFinite(Date.parse(device.createdAt)) || !Number.isFinite(Date.parse(device.expiresAt)) || Date.parse(device.expiresAt) <= now || device.revokedAt !== null) throw new Error('Inactive device');
  const publicDevice: Device = { id: device.id, name: device.name, createdAt: device.createdAt, expiresAt: device.expiresAt, revokedAt: null };
  return { mode: 'paired', device: publicDevice, csrfToken: input.csrfToken };
}

export class AuthSessionMemory {
  private current: AuthSession | null = null;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  get session(): AuthSession | null { return this.current; }
  get generation(): number { return this.revision; }

  set(value: AuthSession): void {
    const sameIdentity = this.current?.mode === value.mode && this.current.device?.id === value.device?.id && this.current.csrfToken === value.csrfToken;
    if (!sameIdentity) this.revision += 1;
    this.current = value;
  }

  drop(): void {
    this.current = null;
    this.revision += 1;
    // The CSRF reference is gone before a subscriber can render or issue requests.
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const authSession = new AuthSessionMemory();
export function notifyAuthRequired(): void { authSession.drop(); }

interface FragmentLocation { pathname: string; search: string; hash: string }
interface FragmentHistory { replaceState(data: unknown, unused: string, url: string): void }

/** Clear every fragment synchronously; only /pair can use its named ticket. */
export function consumePairingFragment(location: FragmentLocation, history: FragmentHistory): string | null {
  const hash = location.hash;
  if (hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (location.pathname !== '/pair' || !hash) return null;
  const parameters = new URLSearchParams(hash.slice(1));
  if (parameters.getAll('ticket').length !== 1) return null;
  const ticket = parameters.get('ticket');
  return ticket && ticket.length <= 256 && /^[A-Za-z0-9_-]+$/.test(ticket) ? ticket : null;
}

/** Same-document links must retire the previous form and clear the new fragment too. */
export function observePairingNavigation(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, location: FragmentLocation, history: FragmentHistory, onPairPage: (ticket: string | null) => void): () => void {
  let consumedOnPopState = false;
  const navigate = (event: Event) => {
    const hasFragment = Boolean(location.hash);
    // Chromium dispatches popstate then hashchange for one history navigation.
    // The first handler has already erased the fragment; its second event must keep the new ticket.
    if (event.type === 'hashchange' && !hasFragment && consumedOnPopState) { consumedOnPopState = false; return; }
    consumedOnPopState = event.type === 'popstate' && hasFragment;
    const ticket = consumePairingFragment(location, history);
    if (location.pathname === '/pair') onPairPage(ticket);
  };
  target.addEventListener('hashchange', navigate);
  target.addEventListener('popstate', navigate);
  return () => {
    target.removeEventListener('hashchange', navigate);
    target.removeEventListener('popstate', navigate);
  };
}

export function isLocalHttpDevelopment(protocol: string, hostname: string): boolean {
  return protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

export function pairingTicketLink(ticket: PairingTicket | null, origin: string, now = Date.now()): string | null {
  if (!ticket?.ticket || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= now) return null;
  return `${origin}/pair#ticket=${encodeURIComponent(ticket.ticket)}`;
}

export function sessionExpiresIn(session: AuthSession | null, now = Date.now()): number | null {
  if (session?.mode !== 'paired' || !session.device) return null;
  const expiresAt = Date.parse(session.device.expiresAt);
  return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : 0;
}
