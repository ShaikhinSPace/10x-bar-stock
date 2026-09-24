"use server";

import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { clearLoginFailures, endSession, loginLockRemaining, recordLoginFailure, startSession, verifyPassword } from "@/lib/auth";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

export async function login(_prev: string | null, form: FormData): Promise<string | null> {
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!username || !password) return "Enter your username and password.";

  // Brute-force throttle: refuse before touching the password once locked.
  const lock = await loginLockRemaining(username);
  if (lock > 0) {
    const mins = Math.ceil(lock / 60);
    return `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
  }

  const rows = await sql`
    select id, password_hash from users where lower(username) = ${username} and active`;
  // Same message either way — don't leak which usernames exist.
  if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
    await recordLoginFailure(username);
    return "That username and password don't match.";
  }
  await clearLoginFailures(username);
  await startSession(rows[0].id);
  // Land where the role belongs: the owner gets the dashboard, a barback goes
  // straight to the run screen, which is the whole of their app.
  const [me] = await sql`select role from users where id = ${rows[0].id}`;
  redirect(me.role === "owner" ? "/dashboard" : "/stock/run"); // throws — keep outside any try/catch
}

export async function logout() {
  await endSession();
  redirect("/login");
}
