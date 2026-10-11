// Loads the app's classic browser scripts (web/*.js) into a bare node vm context ("window" only: pure modules such as
// geom.js and bones.js need no DOM). Each script is run in the same context, so `G`, `Bones` ... are shared like in the page.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = process.env.SG_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function plain(...files) {
  const g = { console, performance, setTimeout, clearTimeout };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  const load = f => vm.runInContext(fs.readFileSync(path.join(REPO, 'web', f), 'utf8'), ctx, { filename: f });
  files.forEach(load);
  return { ctx, g, load, eval: s => vm.runInContext(s, ctx) };
}
