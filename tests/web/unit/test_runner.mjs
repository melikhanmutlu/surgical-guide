// The test runner itself (lib/t.mjs): a hung async test fails with a timeout instead of stalling the run, and a failing
// suite exits non-zero (Denetim 4: unit runner hardening).
//   node test_runner.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { test, run, assert } from './lib/t.mjs';

const T = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 't.mjs')).href;
const child = (src, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', src],
  { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });

test('a hung test fails after its timeout and the others still run', () => {
  const r = child(`import { test, run } from '${T}';
    test('ok', () => {}); test('hangs', () => new Promise(() => {}), { timeout: 200 }); test('after', async () => {});
    await run('child');`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL hangs\n\s+timed out after 200 ms/);
  assert.match(r.stdout, /child: 2 passed, 1 failed, 3 total/);
});

test('T_TIMEOUT sets the default limit', () => {
  const r = child(`import { test, run } from '${T}'; test('slow', () => new Promise(r => setTimeout(r, 2000))); await run('child');`,
    { T_TIMEOUT: '100' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /timed out after 100 ms/);
});

test('a passing suite exits 0', () => {
  const r = child(`import { test, run } from '${T}'; test('ok', async () => {}); await run('child');`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// Denetim 7 (2026-10-25): run_all.sh listed "test_slicenav" without its extension; node could not find it, the suite
// never ran and every full run ended "SOME UNIT SUITES FAILED". Every name in the list is a file here, and every
// test_*.mjs here is in the list.
test('run_all.sh lists every unit suite of this folder, each by a file name that exists', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url)), sh = fs.readFileSync(path.join(dir, 'run_all.sh'), 'utf8');
  const m = sh.match(/^for t in (.+); do$/m); assert.ok(m, 'the suite list line');
  const listed = m[1].trim().split(/\s+/);
  const missing = listed.filter(n => !fs.existsSync(path.join(dir, n)));
  const unlisted = fs.readdirSync(dir).filter(n => /^test_.*\.mjs$/.test(n) && !listed.includes(n));
  assert.deepEqual({ missing, unlisted }, { missing: [], unlisted: [] });
});

await run('test_runner');
