// Rasterizes one named copper/mask layer of a parsed board (or a single footprint) to a
// black-on-white <canvas> — the direct replacement for
// `kicad-cli pcb export svg --layers X --black-and-white` / `kicad-cli fp export svg --fp Y --black-and-white`.
// Note: kicad-cli's B.Cu export (as invoked by the original gui.py, without --mirror) is NOT
// flipped — it's the same coordinate frame as the front layer — so no mirroring is applied here either.

function padLayerMatches(padLayers, targetLayer) {
  const side = targetLayer[0]; // 'F' or 'B'
  return padLayers.some((l) => l === targetLayer || l === '*.Cu' || l === `${side}.Cu` || l === '*.Mask');
}

function drawPad(ctx, pad, toPx, pxPerMm) {
  const { px, py } = toPx(pad.boardPos.x, pad.boardPos.y);
  const w = pad.size.x * pxPerMm;
  const h = pad.size.y * pxPerMm;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate((-pad.boardRotation * Math.PI) / 180);

  if (pad.shape === 'circle') {
    ctx.beginPath();
    ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (pad.shape === 'oval') {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, r);
    ctx.fill();
  } else if (pad.shape === 'roundrect') {
    const r = Math.min(w, h) * pad.roundrect_rratio;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, r);
    ctx.fill();
  } else if (pad.shape === 'custom' && pad.primitives && pad.primitives.length) {
    for (const prim of pad.primitives) {
      if (prim.type === 'gr_poly' && prim.pts.length) {
        ctx.beginPath();
        ctx.moveTo(prim.pts[0].x * pxPerMm, prim.pts[0].y * pxPerMm);
        for (const pt of prim.pts.slice(1)) ctx.lineTo(pt.x * pxPerMm, pt.y * pxPerMm);
        ctx.closePath();
        ctx.fill();
      } else if (prim.type === 'gr_circle') {
        const r = Math.hypot(prim.end.x - prim.center.x, prim.end.y - prim.center.y) * pxPerMm;
        ctx.beginPath();
        ctx.arc(prim.center.x * pxPerMm, prim.center.y * pxPerMm, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // anchor pad shape underneath custom primitives (KiCad always includes the anchor)
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.fill();
  } else {
    // rect and any unhandled shape: bounding rect
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }

  // Plated through-hole pads have a drill hole punched through the copper — without this,
  // findContours would see a solid disc instead of the ring kicad-cli actually renders.
  if (pad.drill && pad.drill.size && pad.drill.size.x) {
    const offsetX = (pad.drill.offset && pad.drill.offset.x ? pad.drill.offset.x : 0) * pxPerMm;
    const offsetY = (pad.drill.offset && pad.drill.offset.y ? pad.drill.offset.y : 0) * pxPerMm;
    const dw = pad.drill.size.x * pxPerMm;
    const dh = (pad.drill.size.y || pad.drill.size.x) * pxPerMm;
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.roundRect(offsetX - dw / 2, offsetY - dh / 2, dw, dh, Math.min(dw, dh) / 2);
    ctx.fill();
    ctx.fillStyle = 'black';
  }
  ctx.restore();
}

export function renderLayer(board, targetLayer, { pxPerMm = 20 } = {}) {
  const { bounds } = board;
  const widthMm = bounds.maxX - bounds.minX;
  const heightMm = bounds.maxY - bounds.minY;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(widthMm * pxPerMm));
  canvas.height = Math.max(1, Math.ceil(heightMm * pxPerMm));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  ctx.strokeStyle = 'black';

  const toPx = (x, y) => ({ px: (x - bounds.minX) * pxPerMm, py: (y - bounds.minY) * pxPerMm });

  // zone copper fills first (they sit "under" pads/tracks on a real board)
  for (const zone of board.zones || []) {
    if (!zone.layers.some((l) => l === targetLayer || l === '*.Cu')) continue;
    for (const poly of zone.fillPolys) {
      if (!poly.length) continue;
      ctx.beginPath();
      const p0 = toPx(poly[0].x, poly[0].y);
      ctx.moveTo(p0.px, p0.py);
      for (const pt of poly.slice(1)) {
        const p = toPx(pt.x, pt.y);
        ctx.lineTo(p.px, p.py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      // np_thru_hole pads are non-plated mechanical holes — no copper, so nothing to draw.
      if (pad.type === 'np_thru_hole') continue;
      if (!padLayerMatches(pad.layers, targetLayer)) continue;
      drawPad(ctx, pad, toPx, pxPerMm);
    }
  }

  for (const seg of board.segments || []) {
    if (seg.layer !== targetLayer) continue;
    const s = toPx(seg.start.x, seg.start.y);
    const e = toPx(seg.end.x, seg.end.y);
    ctx.lineWidth = seg.width * pxPerMm;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.px, s.py);
    ctx.lineTo(e.px, e.py);
    ctx.stroke();
  }

  for (const via of board.vias || []) {
    if (!via.layers.includes(targetLayer)) continue;
    const p = toPx(via.pos.x, via.pos.y);
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(p.px, p.py, (via.size * pxPerMm) / 2, 0, Math.PI * 2);
    ctx.fill();
    if (via.drill) {
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.arc(p.px, p.py, (via.drill * pxPerMm) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'black';
    }
  }

  return canvas;
}

// Renders a single standalone footprint (parsed via parseFootprint) centered in its own canvas —
// replaces `kicad-cli fp export svg --fp Y --black-and-white -l F.Cu`.
export function renderFootprint(footprint, targetLayer, { pxPerMm = 40, marginMm = 0.1 } = {}) {
  const matchingPads = footprint.pads.filter((pad) => padLayerMatches(pad.layers, targetLayer));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pad of matchingPads) {
    const halfW = pad.size.x / 2;
    const halfH = pad.size.y / 2;
    for (const dx of [-halfW, halfW]) {
      for (const dy of [-halfH, halfH]) {
        const x = pad.pos.x + dx;
        const y = pad.pos.y + dy;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  minX -= marginMm; minY -= marginMm; maxX += marginMm; maxY += marginMm;

  const board = {
    bounds: { minX, minY, maxX, maxY },
    footprints: [{ pads: matchingPads.map((pad) => ({ ...pad, boardPos: pad.pos, boardRotation: pad.pos.orientation })) }],
    segments: [],
    vias: [],
    zones: [],
  };

  return renderLayer(board, targetLayer, { pxPerMm });
}
