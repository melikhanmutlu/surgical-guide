// Minimal test runner (no dependencies): test(name, fn), run() prints one line per test and a summary.
// Exit code 1 when any test fails. A test that throws or whose assertion fails is FAIL; so is one still running after
// T_TIMEOUT ms (environment, default 300000; a hung promise no longer stalls the whole run). test(name, fn, {timeout})
// sets one test's limit. A synchronous endless loop cannot be interrupted from here: the runner's outer timeout catches it.
import assert from 'node:assert/strict';
export { assert };
const tests = [];
const T_TIMEOUT = +(process.env.T_TIMEOUT || 300000);
export function test(name, fn, opt = {}) { tests.push({ name, fn, timeout: opt.timeout || T_TIMEOUT }); }
function limited(t) {
  let timer;
  const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${t.timeout} ms`)), t.timeout); });
  return Promise.race([Promise.resolve().then(t.fn), late]).finally(() => clearTimeout(timer));
}
export const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new assert.AssertionError({ message: `${msg || ''} expected ${b} ± ${tol}, got ${a}`, actual: a, expected: b }); };
export async function run(suite) {
  let pass = 0, fail = 0; const fails = [];
  for (const t of tests) {
    const t0 = Date.now();
    try { await limited(t); pass++; console.log(`  ok   ${t.name} (${Date.now() - t0} ms)`); }
    catch (e) { fail++; fails.push(t.name); console.log(`  FAIL ${t.name}\n       ${String(e && e.message || e).split('\n').join('\n       ')}`); }
  }
  console.log(`\n${suite}: ${pass} passed, ${fail} failed, ${tests.length} total`);
  if (fails.length) console.log('Failed: ' + fails.join(' | '));
  process.exitCode = fail ? 1 : 0;
  return { pass, fail };
}
