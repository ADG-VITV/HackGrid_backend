/** Password verification for the static organiser roster. */
import { scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/**
 * Verify the `scrypt$salt$hex-digest` format stored in admins.password_hash.
 * Invalid stored values deliberately fail closed.
 */
export function verifyAdminPassword(password, passwordHash) {
  if (typeof password !== "string" || typeof passwordHash !== "string") return false;

  const [algorithm, salt, digest] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !salt || !/^[a-f0-9]{128}$/i.test(digest ?? "")) return false;

  const expected = Buffer.from(digest, "hex");
  const actual = scryptSync(password, salt, KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
