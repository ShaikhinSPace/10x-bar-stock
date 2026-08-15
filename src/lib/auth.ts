import "server-only";
import { cookies } from "next/headers";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sql } from "./db";
import type { SessionUser } from "./model";

// ponytail: scrypt + an HMAC-signed cookie instead of an auth library. ~10 staff,
// username/password only, no OAuth or password reset. Swap in Auth.js if either arrives.

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be set to at least 32 chars — see .env.example");
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
