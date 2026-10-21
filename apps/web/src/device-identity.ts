import type { ClientDevice, DeviceConnectResult, DeviceKind, DeviceRole } from '@personal-agent/contracts';

const STORAGE_KEY = 'pa-device-identity-v1';

export interface StoredDeviceIdentity {
  id: string;
  publicKey: string;
  privateKey: string;
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const value of view) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // DOM BufferSource 在 TS 5.9 下不接受 Uint8Array<ArrayBufferLike>，拷到独立 ArrayBuffer。
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function supportsDeviceCrypto(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.generateKey === 'function';
}

export async function loadOrCreateDeviceIdentity(): Promise<StoredDeviceIdentity | null> {
  if (!supportsDeviceCrypto() || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredDeviceIdentity;
      if (parsed.id && parsed.publicKey && parsed.privateKey) return parsed;
    }
  } catch { /* 损坏的本地身份当作没有 */ }
  try {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const publicKey = bytesToBase64Url(spki.subarray(-32));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const identity: StoredDeviceIdentity = { id: await sha256Hex(spki.subarray(-32)), publicKey, privateKey: bytesToBase64Url(pkcs8) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    return identity;
  } catch {
    return null;
  }
}

async function importPrivateKey(encoded: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', base64UrlToBytes(encoded) as BufferSource, { name: 'Ed25519' }, false, ['sign']);
}

export async function signDeviceProof(identity: StoredDeviceIdentity, input: {
  challenge: string; signedAt: number; kind: DeviceKind; name: string;
}): Promise<string> {
  const key = await importPrivateKey(identity.privateKey);
  const payload = new TextEncoder().encode(`personal-agent:device-v1\0${input.challenge}\0${input.signedAt}\0${identity.publicKey}\0${input.kind}\0${input.name}`);
  return bytesToBase64Url(await crypto.subtle.sign({ name: 'Ed25519' }, key, payload));
}

export interface DeviceAuthState {
  identity: StoredDeviceIdentity;
  session?: string;
  device?: ClientDevice;
  role?: DeviceRole;
  pending?: { deviceId: string; status: string };
}

let current: DeviceAuthState | null = null;

export function deviceAuthHeaders(): Record<string, string> {
  if (!current?.session) return {};
  return { 'X-PA-Device-Id': current.identity.id, 'X-PA-Device-Session': current.session };
}

export function currentDeviceAuth(): DeviceAuthState | null {
  return current;
}

export function desktopClientKind(): DeviceKind {
  return typeof window !== 'undefined' && window.personalAgentDesktop?.version === 1 ? 'desktop' : 'browser';
}

export async function connectThisDevice(name = typeof navigator === 'undefined' ? 'Workbench' : navigator.userAgent.slice(0, 80)): Promise<DeviceAuthState | null> {
  const identity = await loadOrCreateDeviceIdentity();
  if (!identity) return null;
  const challengeResponse = await fetch('/api/device/challenge', { credentials: 'same-origin' });
  if (!challengeResponse.ok) return { identity };
  const challengeBody = await challengeResponse.json() as { challenge?: string };
  if (typeof challengeBody.challenge !== 'string') return { identity };
  const signedAt = Date.now();
  const kind = desktopClientKind();
  const signature = await signDeviceProof(identity, { challenge: challengeBody.challenge, signedAt, kind, name });
  const connectResponse = await fetch('/api/device/connect', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey: identity.publicKey, name, kind, challenge: challengeBody.challenge, signedAt, signature }),
  });
  const body = await connectResponse.json().catch(() => ({})) as Partial<DeviceConnectResult> & { code?: string; deviceId?: string; status?: string };
  if (connectResponse.ok && body.device && body.deviceSession) {
    current = { identity, session: body.deviceSession, device: body.device, role: body.role };
    return current;
  }
  current = { identity, pending: { deviceId: body.deviceId ?? identity.id, status: body.status ?? 'pending' } };
  return current;
}

export async function pollDeviceStatus(deviceId: string): Promise<string | undefined> {
  const response = await fetch(`/api/device/status?deviceId=${encodeURIComponent(deviceId)}`, { credentials: 'same-origin' });
  if (!response.ok) return undefined;
  const body = await response.json() as { status?: string };
  return body.status;
}
