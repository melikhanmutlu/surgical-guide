// Minimal test runner (no dependencies): test(name, fn), run() prints one line per test and a summary.
// Exit code 1 when any test fails. A test that throws or whose assertion fails is FAIL.
import assert from 'node:assert/strict';
export { assert };
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new assert.AssertionError({ message: `${msg || ''} expected ${b} ± ${tol}, got ${a}`, actual: a, expected: b }); };
export async function run(suite) {
  let pass = 0, fail = 0; const fails = [];
  for (const t of tests) {
    const t0 = Date.now();
    try { await t.fn(); pass++; console.log(`  ok   ${t.name} (${Date.now() - t0} ms)`); }
    catch (e) { fail++; fails.push(t.name); console.log(`  FAIL ${t.name}\n       ${String(e && e.message || e).split('\n').join('\n       ')}`); }
  }
  console.log(`\n${suite}: ${pass} passed, ${fail} failed, ${tests.length} total`);
  if (fails.length) console.log('Failed: ' + fails.join(' | '));
  process.exitCode = fail ? 1 : 0;
  return { pass, fail };
}
