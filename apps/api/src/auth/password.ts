import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt rather than argon2id purely to avoid a compiled native dependency in
 * something intended to run on a single machine and be easy to stand back up.
 * The parameters below are the interactive-login figures from the scrypt
 * paper's successors, memory-hard enough to make offline cracking expensive.
 *
 * The stored format carries its own parameters, so they can be raised later
 * without invalidating existing hashes: an old hash still verifies against the
 * cost it was created with, and can be rehashed on next successful login.
 */
const KEY_LENGTH = 64;
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 * 2 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(saltRaw, 'base64');
  const expected = Buffer.from(hashRaw, 'base64');

  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * A dummy verification, run when a login names an unknown account, so that the
 * response takes comparable time either way and the endpoint does not reveal
 * which email addresses exist.
 */
const DUMMY_HASH_PROMISE = hashPassword(randomBytes(32).toString('hex'));

export async function wasteTimeLikeAVerification(password: string): Promise<void> {
  await verifyPassword(password, await DUMMY_HASH_PROMISE);
}
