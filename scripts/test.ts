/**
 * Test runner. The e2e suite uses Testcontainers to spin up its own throwaway
 * Postgres, so this script just delegates to vitest. A Docker daemon must be
 * running and reachable.
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const vitestArgs = process.argv.slice(2);
const child = spawn('npx', ['vitest', 'run', ...vitestArgs], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
