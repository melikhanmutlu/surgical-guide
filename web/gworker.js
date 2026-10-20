/* Background thread of the studio: the guide kernel (gkernel.js), the guide mesh simplification (geom.js
   decimateGen) and the bone surfaces (geom.js surfaceNets), so the page stays responsive while they run. One request at a time: { id, op, ... } -> { id, out } or
   { id, error }. Each request is answered with the buffers moved, not copied. */
'use strict';
self.window = self;   // (seat.js publishes itself on window)
importScripts('geom.js', 'seat.js', 'gkernel.js');
self.onmessage = e => {
  const m = e.data;
  try {
    if (m.op === 'guide') { const out = GKernel.run(m.K); self.postMessage({ id: m.id, out }, GKernel.transfer(out)); return; }
    if (m.op === 'nets') { const out = G.surfaceNets(m.field, m.nx, m.ny, m.nz, m.level, m.box || undefined); self.postMessage({ id: m.id, out }, [out.positions.buffer, out.indices.buffer]); return; }
    if (m.op === 'blurNets') { const f = G.blur(m.mask, m.nx, m.ny, m.nz), out = G.surfaceNets(f, m.nx, m.ny, m.nz); self.postMessage({ id: m.id, out }, [out.positions.buffer, out.indices.buffer]); return; }
    if (m.op === 'lite') {
      const it = G.decimateGen({ positions: m.positions, indices: m.indices }, m.tol); let r;
      do r = it.next(); while (!r.done);
      self.postMessage({ id: m.id, out: r.value }, [r.value.positions.buffer, r.value.indices.buffer]); return;
    }
    throw new Error('unknown request ' + m.op);
  } catch (err) { self.postMessage({ id: m.id, error: String((err && err.stack) || err) }); }
};
