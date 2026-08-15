// Set a new password for an existing user, keeping the account and its log history.
//
//   node --env-file=.env.local scripts/set-password.mjs <username> '<new password>'
//
// Quote the password so the shell doesn't eat characters like ! or $.

import { neon } from "@neondatabase/serverless";
import { hashPassword } from "./hash.mjs";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("usage: node --env-file=.env.local scripts/set-password.mjs <username> '<new password>'");
  process.exit(1);
}
if (password.length < 8) {
  console.error("password must be at least 8 characters");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — is .env.local there?");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
  update users set password_hash = ${hashPassword(password)}
  where lower(username) = ${username.trim().toLowerCase()}
  returning username, name, role`;

if (!rows.length) {
  console.error(`no user called "${username}"`);
  process.exit(1);
}
console.log(`password updated for ${rows[0].username} (${rows[0].name}, ${rows[0].role})`);
