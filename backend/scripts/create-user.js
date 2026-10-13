/* Creates (or resets the password of) a login. There is no public sign-up by design.
 *   docker compose exec backend node scripts/create-user.js you@example.com 'a-strong-password'
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('usage: node scripts/create-user.js <email> <password of 10+ characters>');
  process.exit(1);
}
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => client.query(
    `INSERT INTO users (id, email, password_hash) VALUES (gen_random_uuid()::text, $1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING email`,
    [email.trim().toLowerCase(), bcrypt.hashSync(password, 12)],
  ))
  .then((r) => { console.log(`login ready: ${r.rows[0].email}`); return client.end(); })
  .catch((e) => { console.error(e.message); process.exit(1); });
