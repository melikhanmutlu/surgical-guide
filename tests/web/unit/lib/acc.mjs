// Measured accuracies of the malleolar fracture tests (plan M0.2): each suite saves its numbers under its own name in
// ANKLE_ACC_DIR (default: <tmp>/ankle_acc); tools/ankle_accuracy.mjs gathers them into ankle_accuracy.json with the
// plan's example acceptance limits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const ACC_DIR = process.env.ANKLE_ACC_DIR || path.join(os.tmpdir(), 'ankle_acc');
export function saveAcc(section, obj) {
  try { fs.mkdirSync(ACC_DIR, { recursive: true }); fs.writeFileSync(path.join(ACC_DIR, section + '.json'), JSON.stringify(obj, null, 1)); }
  catch (e) { console.log(`  (accuracy not saved: ${e.message})`); }
}
