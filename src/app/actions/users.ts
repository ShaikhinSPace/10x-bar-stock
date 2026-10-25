"use server";

import { refresh } from "next/cache";
import { sql } from "@/lib/db";
import { hashPassword, requireOwner } from "@/lib/auth";
import { attempt, type Result } from "./_shared";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

export async function addUser(
  username: string, name: string, password: string, role: "owner" | "staff"
): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const un = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(un)) {
      throw new Error("Username: 3-32 characters, letters/numbers/._- only");
    }
    if (!name.trim()) throw new Error("Enter their name");
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    if (role !== "owner" && role !== "staff") throw new Error("Unknown role");

    const rows = await sql`
      insert into users (username, name, password_hash, role)
      values (${un}, ${name.trim()}, ${hashPassword(password)}, ${role})
      on conflict (username) do nothing returning id`;
    if (!rows.length) throw new Error("That username is taken.");
    refresh();
  });
}

export async function setUserActive(userId: number, active: boolean): Promise<Result> {
  return attempt(async () => {
    const me = await requireOwner();
    if (userId === me.id && !active) throw new Error("You can't deactivate yourself.");
    // Bump session_version on deactivation so any outstanding cookie for this
    // user stops matching — a disabled person shouldn't keep their browser
    // session alive until it expires naturally. Harmless when re-activating
    // (they re-sign-in anyway).
    await sql`update users
      set active = ${active},
          session_version = session_version + case when ${active}::boolean then 0 else 1 end
      where id = ${userId}`;
    refresh();
  });
}

/**
 * Reset a user's password without destroying their history.
 *
 * The disable-and-recreate workaround splits one person's audit trail across
 * two usernames. Instead, hash a new password onto the same user row, bump
 * session_version (every current cookie for them is now invalid), and clear
 * any login-throttle counter against that username.
 *
 * Owner-only. Resets apply to any user including the caller — the caller just
 * gets signed out of their current session when their cookie's version stops
 * matching.
 */
export async function resetPassword(userId: number, password: string): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    const rows = await sql`
      update users
      set password_hash = ${hashPassword(password)},
          session_version = session_version + 1
      where id = ${userId}
      returning username`;
    if (!rows.length) throw new Error("That user is no longer on the list.");
    const un = rows[0].username as string;
    try { await sql`delete from login_attempts where username = ${un}`; }
    catch { /* throttle table may not exist on a fresh DB — harmless */ }
    refresh();
  });
}
