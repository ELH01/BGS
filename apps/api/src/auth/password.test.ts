import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts each hash, so identical passwords do not collide', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('stores its own parameters, so the cost can be raised without invalidating old hashes', async () => {
    const hash = await hashPassword('whatever');
    const [algorithm, n, r, p] = hash.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(2 ** 15);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('handles unicode passwords consistently', async () => {
    // The same text in composed and decomposed forms must not become two
    // different passwords.
    const composed = 'café-passphrase-123';
    const decomposed = 'café-passphrase-123';
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('rejects a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$bad$8$1$xx$yy')).toBe(false);
  });
});
