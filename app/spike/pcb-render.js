// Spike: parse a .kicad_pcb (footprints/pads/segments) and rasterize one copper layer
// to a black-on-white canvas — replaces `kicad-cli pcb export svg --black-and-white`.
import { parseSexpr, getArray } from './sexpr.js';

function rotatePoint(x, y, degrees) {
  const r = (degrees * Math.PI) / 180;
  return { x: x * Math.cos(r) - y * Math.sin(r), y: y * Math.cos(r) + x * Math.sin(r) };
}

function padLayers(pad) {
  const found = getArray(pad, 'layers');
  return found.length ? found[0].slice(1) : [];
}

function layerMatches(padLayerList, targetLayer) {
  const side = targetLayer[0]; // 'F' or 'B'
  return padLayerList.some((l) => l === targetLayer || l === `*.Cu` || l === `${side}.Cu` || l === `*.Mask`);
}

export function parseBoard(text) {
  const data = parseSexpr(text);

  const footprints = getArray(data, 'footprint').map((fp) => {
    const atArr = getArray(fp, 'at', 2)[0];
    const at = { x: atArr[1], y: atArr[2], rot: atArr[3] || 0 };
    const pads = getArray(fp, 'pad').map((pad) => {
      const [, number, type, shape] = pad;
      const localAt = getArray(pad, 'at', 2)[0];
      const size = getArray(pad, 'size', 2)[0];
      const rratioArr = getArray(pad, 'roundrect_rratio', 2)[0];
      return {
        number,
        type,
        shape,
        localX: localAt[1],
        localY: localAt[2],
        localRot: localAt[3] || 0,
        sizeX: size[1],
        sizeY: size[2],
        roundrectRatio: rratioArr ? rratioArr[1] : 0,
        layers: padLayers(pad),
      };
    });
    return { at, pads };
  });

  const segments = getArray(data, 'segment').map((seg) => {
    const start = getArray(seg, 'start', 2)[0];
    const end = getArray(seg, 'end', 2)[0];
    const width = getArray(seg, 'width', 2)[0];
    const layerArr = getArray(seg, 'layer', 2)[0];
    return {
      start: { x: start[1], y: start[2] },
      end: { x: end[1], y: end[2] },
      width: width[1],
      layer: layerArr[1],
    };
  });

  // Board bounds from Edge.Cuts gr_line / gr_rect (mirrors PCB_utils.get_board_bounds)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const key of ['gr_line', 'gr_rect']) {
    for (const node of getArray(data, key)) {
      const layerArr = getArray(node, 'layer', 2)[0];
      if (!layerArr || layerArr[1] !== 'Edge.Cuts') continue;
      const s = getArray(node, 'start', 2)[0];
      const e = getArray(node, 'end', 2)[0];
      consider(s[1], s[2]);
      consider(e[1], e[2]);
    }
  }

  return { footprints, segments, bounds: { minX, minY, maxX, maxY } };
}

export function renderLayer(board, targetLayer, pxPerMm = 20) {
  const { bounds } = board;
  const widthMm = bounds.maxX - bounds.minX;
  const heightMm = bounds.maxY - bounds.minY;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(widthMm * pxPerMm);
  canvas.height = Math.ceil(heightMm * pxPerMm);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  ctx.strokeStyle = 'black';

  const toPx = (x, y) => ({ px: (x - bounds.minX) * pxPerMm, py: (y - bounds.minY) * pxPerMm });

  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!layerMatches(pad.layers, targetLayer)) continue;

      // pad local -> footprint-relative (rotate by footprint angle) -> board coords (translate)
      const rotated = rotatePoint(pad.localX, pad.localY, -fp.at.rot);
      const worldX = fp.at.x + rotated.x;
      const worldY = fp.at.y + rotated.y;
      const totalRot = fp.at.rot + pad.localRot;
      const { px, py } = toPx(worldX, worldY);

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((-totalRot * Math.PI) / 180);

      const w = pad.sizeX * pxPerMm;
      const h = pad.sizeY * pxPerMm;

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
        const r = Math.min(w, h) * pad.roundrectRatio;
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, r);
        ctx.fill();
      } else {
        // rect and unhandled custom shapes: draw bounding rect as an approximation for the spike
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.restore();
    }
  }

  for (const seg of board.segments) {
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

  return canvas;
}
