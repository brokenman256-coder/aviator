// One-time helper: prints an INSERT statement for the default admin account,
// hashed the same way the Worker verifies it (Web Crypto PBKDF2). Run once
// against your D1 database after the schema migration:
//
//   node seed-admin.mjs "admin@zenithmarkets.local" "admin" "your-password" > seed.sql
//   wrangler d1 execute aviator-db --remote --file=./seed.sql
//
import { hashPassword } from "./src/crypto-utils.js";

const [email, username, password] = process.argv.slice(2);
if (!email || !username || !password) {
  console.error("Usage: node seed-admin.mjs <email> <username> <password>");
  process.exit(1);
}

const { hash, salt } = await hashPassword(password);
const now = new Date().toISOString();

const escape = (s) => s.replace(/'/g, "''");

console.log(
  `INSERT INTO users (username, email, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at) ` +
    `VALUES ('${escape(username)}', '${escape(email)}', '${hash}', '${salt}', 1, 1, 0, 0, '${now}') ` +
    `ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt, is_admin = 1, is_verified = 1;`
);
