/** Prints a fresh Ed25519 signing key as an env line: `pnpm --filter @military-forge/api keygen >> .env` */
import { generateSigningKey, privateKeyPem } from '../src/auth/keys';

const pem = privateKeyPem(generateSigningKey()).trim().replaceAll('\n', '\\n');
console.log(`ACCESS_TOKEN_PRIVATE_KEY="${pem}"`);
