import { createHash, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPrivateKey, createPublicKey } from 'node:crypto';

/**
 * Ed25519 设备身份（对齐 OpenClaw Gateway 的设备密钥 + 签名挑战）。
 *
 * 设备 ID = SHA-256(原始 32 字节公钥) 的 64 位十六进制，稳定且不泄露私钥。
 * 签名载荷固定为 `personal-agent:device-v1` 加挑战、时间戳、公钥、kind、名称，
 * 避免把同一签名复用到别的实例或接口。
 */
export const DEVICE_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const DEVICE_ID_PATTERN = /^[a-f0-9]{64}$/u;
export const DEVICE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type DeviceKind = 'desktop' | 'browser';

export interface DeviceKeyPair {
  publicKey: string;
  privateKey: string;
  id: string;
}

export function deviceIdFromPublicKey(publicKey: string): string {
  if (!DEVICE_PUBLIC_KEY_PATTERN.test(publicKey)) throw new Error('Device public key is invalid');
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const encoded = rawPublic.toString('base64url');
  return {
    publicKey: encoded,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    id: deviceIdFromPublicKey(encoded),
  };
}

export function deviceProofPayload(input: {
  challenge: string;
  signedAt: number;
  publicKey: string;
  kind: DeviceKind;
  name: string;
}): Buffer {
  return Buffer.from(`personal-agent:device-v1\0${input.challenge}\0${input.signedAt}\0${input.publicKey}\0${input.kind}\0${input.name}`, 'utf8');
}

function privateKeyFrom(encoded: string) {
  return createPrivateKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'pkcs8' });
}

function publicKeyFrom(encoded: string) {
  // 32 字节 raw Ed25519 公钥包进 SPKI（RFC 8410）。
  const raw = Buffer.from(encoded, 'base64url');
  if (raw.length !== 32) throw new Error('Device public key is invalid');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

export function signDeviceProof(privateKey: string, input: Parameters<typeof deviceProofPayload>[0]): string {
  return nodeSign(null, deviceProofPayload(input), privateKeyFrom(privateKey)).toString('base64url');
}

export function verifyDeviceProof(publicKey: string, signature: string, input: Parameters<typeof deviceProofPayload>[0]): boolean {
  if (!DEVICE_PUBLIC_KEY_PATTERN.test(publicKey) || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) return false;
  try {
    return nodeVerify(null, deviceProofPayload(input), publicKeyFrom(publicKey), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
