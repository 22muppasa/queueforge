import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const backend = new URL('../backend/', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const database = `queueforge_test_${randomBytes(6).toString('hex')}`;

if (!/^queueforge_test_[a-f0-9]{12}$/.test(database)) throw new Error('Refusing unsafe test database name');

async function dockerCompose(...args) {
  return execFile('docker', ['compose', ...args], { cwd: root, timeout: 120_000, windowsHide: true });
}

let created = false;
try {
  await dockerCompose('up', '-d', 'postgres');
  await dockerCompose('exec', '-T', 'postgres', 'createdb', '-U', 'queueforge', database);
  created = true;
  const vitest = new URL('../backend/node_modules/vitest/vitest.mjs', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
  const result = await execFile(process.execPath, [vitest, 'run'], {
    cwd: backend,
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, TEST_DATABASE_URL: `postgresql://queueforge:queueforge-local-only@localhost:54329/${database}` },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  if (created) {
    await dockerCompose('exec', '-T', 'postgres', 'dropdb', '--force', '-U', 'queueforge', database);
  }
}
