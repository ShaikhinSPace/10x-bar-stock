import "server-only";
import { cookies } from "next/headers";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sql } from "./db";
import type { SessionUser } from "./model";

// ponytail: scrypt + an HMAC-signed cookie instead of an auth library. ~10 staff,
// username/password only, no OAuth or password reset. Swap in Auth.js if either arrives.

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error(
    "SESSION_SECRET must be set to at least 32 characters (openssl rand -hex 32). " +
      "Locally: .env.local. On Vercel: Settings > Environment Variables, then redeploy."
  );
}

const COOKIE = "bar_session";
const MAX_AGE_S = 60 * 60 * 24 * 30; // a month; bar staff shouldn't re-login mid-shift

export type Session = SessionUser;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

const signature = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

export async function startSession(userId: number) {
  const body = `${userId}.${Date.now() + MAX_AGE_S * 1000}`;
  (await cookies()).set(COOKIE, `${body}.${signature(body)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  const at = raw.lastIndexOf(".");
  const body = raw.slice(0, at);
  const sig = Buffer.from(raw.slice(at + 1), "hex");
  const want = Buffer.from(signature(body), "hex");
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;

  const [idStr, expStr] = body.split(".");
  if (Number(expStr) < Date.now()) return null;

  const rows = await sql`
    select id, name, username, role from users
    where id = ${Number(idStr)} and active`;
  return (rows[0] as Session) ?? null;
}

/* ---------------- login brute-force throttle ---------------- */

// 5 misses locks the username for 15 minutes. Small enough that a real staffer who
// fat-fingers a password a few times isn't stopped, tight enough that online guessing
// is hopeless on top of scrypt's per-attempt cost. Keyed by attempted username, so an
// unknown name is throttled identically and existence still isn't leaked.
// ponytail: username-scoped, so someone who knows a name could lock that one person out
// for 15 min (a nuisance, not a breach). Fine for ~10 internal staff; scope by IP too if
// this ever faces the open internet.
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** Seconds until this username can try again, or 0 if it's not locked. */
export async function loginLockRemaining(username: string): Promise<number> {
  try {
    const [row] = await sql`select locked_until from login_attempts where username = ${username}`;
    const until = row?.locked_until ? new Date(row.locked_until as string).getTime() : 0;
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  } catch (e) {
    // The throttle store must NEVER be able to take down sign-in. If login_attempts is
    // missing or the query errors, degrade to "not locked" so login still works — the
    // throttle is simply off until the store is healthy again. (This exact failure — a
    // missing login_attempts table on a fresh prod branch — 500'd login before.)
    console.error("[throttle] loginLockRemaining failed, allowing login:", e);
    return 0;
  }
}

/**
 * Count one failed attempt. The window is rolling: a failure more than LOCK_MS after
 * the last one (or after a lock already expired) starts the count over at 1 rather
 * than resurrecting a stale streak. Read-then-write, not one atomic statement — two
 * simultaneous failures could under-count by one, which is harmless for a throttle.
 */
export async function recordLoginFailure(username: string): Promise<void> {
  try {
    const [row] = await sql`
      select fails, updated_at, locked_until from login_attempts where username = ${username}`;
    const now = Date.now();
    const stale = !row
      || new Date(row.updated_at as string).getTime() < now - LOCK_MS
      || (row.locked_until != null && new Date(row.locked_until as string).getTime() < now);
    const fails = stale ? 1 : Number(row.fails) + 1;
    const lockedUntil = fails >= MAX_FAILS ? new Date(now + LOCK_MS).toISOString() : null;
    await sql`
      insert into login_attempts (username, fails, locked_until, updated_at)
      values (${username}, ${fails}, ${lockedUntil}, now())
      on conflict (username) do update set
        fails = ${fails}, locked_until = ${lockedUntil}, updated_at = now()`;
    // Opportunistic sweep of long-abandoned rows (guessed/junk usernames) so the table
    // can't grow without bound; only runs on a failure, which is already the rare path.
    await sql`delete from login_attempts where updated_at < now() - interval '1 day'`;
  } catch (e) {
    // A throttle-store failure must not surface to the user mid-login — swallow it.
    console.error("[throttle] recordLoginFailure failed:", e);
  }
}

/** Clear the counter — called on a successful sign-in. */
export async function clearLoginFailures(username: string): Promise<void> {
  try {
    await sql`delete from login_attempts where username = ${username}`;
  } catch (e) {
    console.error("[throttle] clearLoginFailures failed:", e);
  }
}

/** Use at the top of every Server Action — they are reachable by direct POST. */
export async function requireUser(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new Error("Not signed in");
  return s;
}

export async function requireOwner(): Promise<Session> {
  const s = await requireUser();
  if (s.role !== "owner") throw new Error("Owners only");
  return s;
}
