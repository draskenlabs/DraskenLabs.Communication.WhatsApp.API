import { execFileSync } from 'child_process';

/**
 * Bring the test database up to the schema the migrations describe.
 *
 * Run once for the whole suite rather than per file: `migrate deploy` is
 * idempotent, but it is also the slowest thing here. This is also the first
 * real check on every migration in the repository — a statement Postgres will
 * not accept fails the suite before a test runs.
 */
export default function globalSetup(): void {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST is required.\n\n' +
        '  createdb wa_console_test\n' +
        '  DATABASE_URL_TEST=postgresql://user:pass@127.0.0.1:5432/wa_console_test npm run test:int\n\n' +
        'The suite truncates the database it points at, so it never falls back ' +
        'to DATABASE_URL.',
    );
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
