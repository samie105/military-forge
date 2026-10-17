/**
 * The Ed25519 key that signs access tokens. Production reads it from `ACCESS_TOKEN_PRIVATE_KEY`
 * (config refuses to start without it). Development generates one on first start and keeps it in
 * `.data/dev-keys.json`, so `tsx watch` restarts don't log everyone out; tests get a throwaway one.
 * Milestone B's join tickets use the same format with their own key.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function signingKeyFromPem(pem: string): SigningKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`expected an Ed25519 private key, got ${privateKey.asymmetricKeyType}`);
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function generateSigningKey(): SigningKey {
  return generateKeyPairSync('ed25519');
}

export function privateKeyPem(key: SigningKey): string {
  return key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** Dev only: load the key from `file`, or create it there. */
export function loadOrCreateDevKey(file: string): SigningKey {
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { privateKeyPem: string };
    return signingKeyFromPem(saved.privateKeyPem);
  }
  const key = generateSigningKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ privateKeyPem: privateKeyPem(key) }, null, 2), { mode: 0o600 });
  return key;
}
