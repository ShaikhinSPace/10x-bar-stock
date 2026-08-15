// Password hashing for the setup scripts. Must stay byte-compatible with
// verifyPassword() in src/lib/auth.ts — scripts/check.mjs asserts that it does.

import { randomBytes, scryptSync } from "node:crypto";

export const KEY_LEN = 64;

/** Returns "<salt hex>:<scrypt digest hex>". */
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pw, salt, KEY_LEN).toString("hex")}`;
}
