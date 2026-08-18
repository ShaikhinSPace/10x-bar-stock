// One-shot: create the schema, seed the 124 items, create a login.
// Reorder levels: one case (24) for beer, 1 for everything else — see README.
// Safe to re-run — the schema is `if not exists`, items upsert, the user is skipped if taken.
//
//   node --env-file=.env.local scripts/setup.mjs <username> <password> "<Full Name>" [owner|staff]
//
// Role defaults to owner. Also the way to reset a forgotten password: disable the old
// account in Manage, then create a fresh one here.

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { hashPassword } from "./hash.mjs";

// With no arguments: schema + items only. With arguments: also create the login.
const [username, password, name, role = "owner"] = process.argv.slice(2);
const makeUser = Boolean(username || password || name);
if (makeUser && (!username || !password || !name)) {
  console.error('usage: node --env-file=.env.local scripts/setup.mjs <username> <password> "<Full Name>" [owner|staff]');
  process.exit(1);
}
if (makeUser && password.length < 8) {
  console.error("password must be at least 8 characters");
  process.exit(1);
}
if (makeUser && role !== "owner" && role !== "staff") {
  console.error(`role must be "owner" or "staff", got "${role}"`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — is .env.local there?");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// The schema file is one multi-statement script, so it goes through .query() not the tag.
// ponytail: strip `--` comments, then split on `;`. Fine because no string literal in
// schema.sql contains `;` or `--`; use a real SQL parser if that ever stops being true.
const schema = readFileSync(new URL("../src/lib/schema.sql", import.meta.url), "utf8")
  .replace(/--[^\n]*/g, "");
const statements = schema.split(";").map((s) => s.trim()).filter(Boolean);
if (!statements.length) {
  throw new Error("No schema statements found in schema.sql");
}
for (const stmt of statements) {
  await sql.query(stmt);
}
console.log(`schema ok (${statements.length} statements executed)`);


const items = JSON.parse(
  readFileSync(new URL("../src/lib/seed-items.json", import.meta.url), "utf8")
);

for (const it of items) {
  await sql`
    insert into items (name, cat, store, rl) values (${it.name}, ${it.cat}, ${it.store}, ${it.rl})
    on conflict (name) do nothing`;
}
console.log(`items ok (${items.length} seeded, bars start at 0)`);

if (makeUser) {
  const un = username.trim().toLowerCase();
  const existing = await sql`select id from users where username = ${un}`;
  if (existing.length) {
    console.log(`user "${un}" already exists — left alone`);
  } else {
    await sql`
      insert into users (username, name, password_hash, role)
      values (${un}, ${name.trim()}, ${hashPassword(password)}, ${role})`;
    console.log(`${role} "${un}" created`);
  }
} else {
  const [{ count }] = await sql`select count(*) from users`;
  if (count === "0" || count === 0) {
    console.log('no users yet — rerun with:  ... scripts/setup.mjs <username> <password> "<Name>"');
  }
}

const [{ count }] = await sql`select count(*) from items`;
console.log(`done — ${count} items in the database`);
