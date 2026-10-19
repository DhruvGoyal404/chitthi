// Sets the chitthi_api login role's password to the one in DATABASE_URL, connecting with the
// owner credentials in MIGRATION_DATABASE_URL. Dev and CI only; production sets the password in
// its secret store. Run after `npm run db:migrate` (which creates the role).
import pg from 'pg';

const apiUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!apiUrl || !ownerUrl) {
  console.error('DATABASE_URL and MIGRATION_DATABASE_URL must both be set (see .env.example)');
  process.exit(1);
}
const api = new URL(apiUrl);
if (decodeURIComponent(api.username) !== 'chitthi_api') {
  console.error('DATABASE_URL must connect as chitthi_api (the owner role is for migrations and tests only)');
  process.exit(1);
}
const password = decodeURIComponent(api.password);
if (password.length < 16) {
  console.error('the chitthi_api password in DATABASE_URL must be at least 16 characters');
  process.exit(1);
}

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
try {
  // ALTER ROLE takes no bind parameters; escapeLiteral quotes the value safely.
  await owner.query(`ALTER ROLE chitthi_api PASSWORD ${owner.escapeLiteral(password)}`);
} finally {
  await owner.end();
}

// Prove the API can now log in, and that it is not privileged beyond chitthi_app.
const check = new pg.Client({ connectionString: apiUrl });
await check.connect();
try {
  const { rows: [r] } = await check.query(
    `SELECT current_user AS who, r.rolsuper AS super, pg_has_role(current_user, 'chitthi_app', 'USAGE') AS app
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  if (r.who !== 'chitthi_api' || r.super || !r.app) {
    console.error('chitthi_api is misconfigured', r);
    process.exit(1);
  }
  console.log('chitthi_api password set; login verified (member of chitthi_app, not superuser)');
} finally {
  await check.end();
}
