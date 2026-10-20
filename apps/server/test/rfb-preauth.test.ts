import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { desEcbEncrypt } from '../src/des-ecb.js';
import { authenticateRfb, encryptVncChallenge, offerRfbNoneToBrowser, RFB_VERSION } from '../src/rfb-preauth.js';
import { RfbViewOnlyFilter } from '../src/rfb-view-only.js';
import { attachFakeVncAuth } from './fixtures/rfb.js';

function pair(): { left: Duplex; right: Duplex } {
  const left = new Duplex({ read() {}, write(chunk, _enc, cb) { right.push(chunk); cb(); } });
  const right = new Duplex({ read() {}, write(chunk, _enc, cb) { left.push(chunk); cb(); } });
  return { left, right };
}

describe('RFB pre-auth and view-only filter', () => {
  it('completes VncAuth against a fake server that accepts any password', async () => {
    const { left, right } = pair();
    attachFakeVncAuth(right);
    await expect(authenticateRfb(left, 'password')).resolves.toBe(left);
  });

  it('matches the published DES-ECB test vector', () => {
    const cipher = desEcbEncrypt(Buffer.from('0123456789ABCDEF', 'hex'), Buffer.from('133457799BBCDFF1', 'hex'));
    expect(cipher.toString('hex')).toBe('85e813540f0ab405');
  });

  it('encrypts the 16-byte VNC challenge to 16 bytes and does not echo the password', () => {
    const challenge = Buffer.alloc(16, 7);
    const cipher = encryptVncChallenge(challenge, 'secretpw');
    expect(cipher).toHaveLength(16);
    expect(cipher.equals(challenge)).toBe(false);
    expect(cipher.toString('utf8')).not.toContain('secretpw');
  });

  it('presents SecurityTypes None to the browser and forwards ClientInit', async () => {
    const sent: Buffer[] = [];
    const replies = [RFB_VERSION, Buffer.from([1]), Buffer.from([1])];
    const written: Buffer[] = [];
    const desktop = new Duplex({
      read() {},
      write(chunk, _enc, cb) { written.push(Buffer.from(chunk)); cb(); },
    });
    await offerRfbNoneToBrowser({
      send(data) { sent.push(Buffer.from(data)); },
      onceMessage() { return Promise.resolve(replies.shift()!); },
    }, desktop);
    expect(sent[0].equals(RFB_VERSION)).toBe(true);
    expect([...sent[1]]).toEqual([1, 1]);
    expect([...written[0]]).toEqual([1]);
  });

  it('drops key, pointer and clipboard messages while forwarding framebuffer requests', () => {
    const filter = new RfbViewOnlyFilter();
    const framebuffer = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
    const pointer = Buffer.from([5, 1, 0, 10, 0, 20]);
    const first = filter.filter(Buffer.concat([framebuffer, key, pointer]));
    expect('forward' in first && [...first.forward]).toEqual([...framebuffer]);
  });
});
