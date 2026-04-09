/**
 * One-shot test runner: ensures .env exists, starts Postgres, applies
 * migrations, then invokes vitest. Safe to run repeatedly.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function step(label: string) {
  console.log(`\n\u001b[36m> ${label}\u001b[0m`);
}

function run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`\u001b[31mfailed: ${cmd} ${args.join(' ')}\u001b[0m`);
    process.exit(r.status ?? 1);
  }
  return r.status ?? 0;
}

// 1) .env
step('ensure .env');
const envPath = join(root, '.env');
if (!existsSync(envPath)) {
  copyFileSync(join(root, '.env.example'), envPath);
  console.log('  created .env from .env.example');
} else {
  console.log('  .env already present');
}

// 2) Postgres
step('start Postgres (docker compose up -d)');
run('docker', ['compose', 'up', '-d']);

// 3) Wait for Postgres to accept connections.
step('wait for Postgres to be ready');
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
  const r = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres'],
    { cwd: root, shell: true },
  );
  if (r.status === 0) {
    ready = true;
    break;
  }
  // small sleep
  spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [
    process.platform === 'win32' ? '/c' : '-c',
    process.platform === 'win32' ? 'timeout /t 1 /nobreak >nul' : 'sleep 1',
  ]);
}
if (!ready) {
  console.error('\u001b[31mPostgres did not become ready within 30s\u001b[0m');
  process.exit(1);
}
console.log('  Postgres is ready');

// 4) Migrations
step('run migrations');
run('npm', ['run', 'migrate']);

// 5) Vitest
step('vitest');
const vitestArgs = process.argv.slice(2);
const child = spawn('npx', ['vitest', 'run', ...vitestArgs], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
