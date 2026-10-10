/* Guide angle on the slices: where a slice shows the guide's seating plane (the slice is roughly perpendicular to the
   seating normal and passes near the guide), the guide axis is drawn with a round handle at its end; dragging the
   handle turns the guide on the bone (the same value as "Guide açısı" and the 3D ring). The guide is re-formed to seat
   at the new angle when the drag ends. */
'use strict';
(function () {
  const St = window.Studio; if (!St) return;
  const { S, V } = St, COL = '#a77bff';
  const deg = THREE.MathUtils.radToDeg, rad = THREE.MathUtils.degToRad;
  // axis line endpoints and handle in canvas pixels for this view, or null when the guide is not shown here
  function geom(v, T, A) {
    if (!S.guideOn || !S.anchor || !St.parts.guide || !S.vol) return null;
    const { u, n } = St.frameAxes(), p = S.anchor.p, sp = S.vol.sp;
    const i0 = A.toIdx([p.x, p.y, p.z]), i1 = A.toIdx(p.clone().addScaledVector(n, 10).toArray());
    const along = Math.abs((i1[v.axis] - i0[v.axis]) * sp[v.axis]) / 10;
    if (along < 0.6) return null;                                  // seating plane seen edge-on
    if (Math.abs((A.st.cur[v.axis] - i0[v.axis]) * sp[v.axis]) > 20) return null;   // slice far from the guide
    const half = S.g.L / 2 + 6, px = w => { const im = A.idxToImg(v, A.toIdx(w.toArray())); return [T.fx(im[0]), T.fy(im[1])]; };
    return { a: px(p.clone().addScaledVector(u, -half)), b: px(p.clone().addScaledVector(u, half)), c: px(p) };
  }
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    const g = geom(v, T, A); if (!g) return;
    ctx.save(); ctx.strokeStyle = COL; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(...g.a); ctx.lineTo(...g.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = COL; ctx.beginPath(); ctx.arc(...g.b, 6 * dpr, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * dpr; ctx.stroke();
    ctx.font = `${11 * dpr}px "IBM Plex Mono", monospace`; ctx.fillStyle = COL; ctx.fillText(`${Math.round(S.g.rot)}°`, g.b[0] + 9 * dpr, g.b[1] - 6 * dpr);
    ctx.restore();
  });
  let base = null;
  (window.SliceHandles = window.SliceHandles || []).push({
    hit(v, X, Y, T, A) {
      const g = geom(v, T, A), dpr = Math.min(devicePixelRatio, 2);
      if (!g || Math.hypot(X - g.b[0], Y - g.b[1]) > 10 * dpr) return false;
      // the axis at angle 0, so the drag can set the angle directly
      const { u, n } = St.frameAxes(), u0 = u.clone().applyAxisAngle(n, -rad(S.g.rot));
      base = { u0, v0: V().crossVectors(n, u0), n }; return true;
    },
    drag(w) {
      if (!base) return;
      const d = V(...w).sub(S.anchor.p); d.addScaledVector(base.n, -d.dot(base.n)); if (d.lengthSq() < 4) return;
      let a = deg(Math.atan2(d.dot(base.v0), d.dot(base.u0)));
      St.setGuideRot(a);
    },
    end() { base = null; },
  });
})();
