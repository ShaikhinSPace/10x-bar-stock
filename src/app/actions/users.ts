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
    await sql`update users set active = ${active} where id = ${userId}`;
    refresh();
  });
}
