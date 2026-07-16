// Port of Code/kicad_mod.py's KicadMod pad/graphics extraction. Works on any `(footprint ...)`
// s-expression subtree — whether it came from a standalone .kicad_mod file or is embedded
// inside a .kicad_pcb (both use identical syntax for footprint contents).
import { getArray, hasValue } from './sexpr.js';

function xy(arr) {
  return { x: arr[1], y: arr[2] };
}

export function getPads(sexprData) {
  return getArray(sexprData, 'pad').map((pad) => {
    const padDict = { number: pad[1], type: pad[2], shape: pad[3] };

    const at = getArray(pad, 'at', 2)[0];
    padDict.pos = { x: at[1], y: at[2], orientation: at[3] || 0 };

    const size = getArray(pad, 'size', 2)[0];
    padDict.size = { x: size[1], y: size[2] };

    const layers = getArray(pad, 'layers', 2)[0];
    padDict.layers = layers ? layers.slice(1) : [];

    const rratio = getArray(pad, 'roundrect_rratio', 2)[0];
    padDict.roundrect_rratio = rratio ? rratio[1] : 0;

    const drill = getArray(pad, 'drill')[0];
    padDict.drill = {};
    if (drill) {
      const offset = getArray(drill, 'offset', 2)[0];
      padDict.drill.offset = offset ? { x: offset[1], y: offset[2] } : {};
      padDict.drill.shape = hasValue(drill, 'oval') ? 'oval' : 'circular';
      const nums = drill.filter((d) => typeof d === 'number');
      if (nums.length) {
        padDict.drill.size = { x: nums[0], y: nums.length > 1 ? nums[1] : nums[0] };
      } else {
        padDict.drill.size = {};
      }
    }

    if (padDict.shape === 'custom') {
      padDict.options = {};
      const options = getArray(pad, 'options')[0];
      if (options) {
        const clearance = getArray(options, 'clearance', 2)[0];
        const anchor = getArray(options, 'anchor', 2)[0];
        if (clearance) padDict.options.clearance = clearance[1];
        if (anchor) padDict.options.anchor = anchor[1];
      }

      padDict.primitives = [];
      const primitivesNode = getArray(pad, 'primitives')[0];
      if (primitivesNode) {
        for (const primitive of primitivesNode.slice(1)) {
          const p = { type: primitive[0] };
          const w = getArray(primitive, 'width', 2)[0];
          p.width = w ? w[1] : 0;

          if (primitive[0] === 'gr_poly') {
            p.pts = [];
            const ptsNode = getArray(primitive, 'pts')[0];
            for (const pt of ptsNode.slice(1)) {
              if (pt[0] === 'xy') p.pts.push(xy(pt));
              else if (pt[0] === 'arc') {
                for (const name of ['start', 'mid', 'end']) {
                  const s = getArray(pt, name, 2)[0];
                  if (s) p.pts.push(xy(s));
                }
              }
            }
          } else if (primitive[0] === 'gr_line') {
            const s = getArray(primitive, 'start', 2)[0];
            const e = getArray(primitive, 'end', 2)[0];
            p.start = s ? xy(s) : {};
            p.end = e ? xy(e) : {};
          } else if (primitive[0] === 'gr_arc') {
            const s = getArray(primitive, 'start', 2)[0];
            const mid = getArray(primitive, 'mid', 2)[0];
            const e = getArray(primitive, 'end', 2)[0];
            p.start = s ? xy(s) : {};
            p.mid = mid ? xy(mid) : {};
            p.end = e ? xy(e) : {};
          } else if (primitive[0] === 'gr_circle') {
            const c = getArray(primitive, 'center', 2)[0];
            const e = getArray(primitive, 'end', 2)[0];
            p.center = c ? xy(c) : {};
            p.end = e ? xy(e) : {};
          }
          padDict.primitives.push(p);
        }
      }
    }

    return padDict;
  });
}

export function getLines(sexprData) {
  return getArray(sexprData, 'fp_line').map((line) => {
    const start = getArray(line, 'start', 2)[0];
    const end = getArray(line, 'end', 2)[0];
    const layer = getArray(line, 'layer', 2)[0];
    const width = getArray(line, 'width', 2)[0];
    return {
      start: xy(start),
      end: xy(end),
      layer: layer ? layer[1] : '',
      width: width ? width[1] : 0,
    };
  });
}

export function getRects(sexprData) {
  return getArray(sexprData, 'fp_rect').map((rect) => {
    const start = getArray(rect, 'start', 2)[0];
    const end = getArray(rect, 'end', 2)[0];
    const layer = getArray(rect, 'layer', 2)[0];
    const width = getArray(rect, 'width', 2)[0];
    return {
      start: xy(start),
      end: xy(end),
      layer: layer ? layer[1] : '',
      width: width ? width[1] : 0,
    };
  });
}

export function getCircles(sexprData) {
  return getArray(sexprData, 'fp_circle').map((circle) => {
    const center = getArray(circle, 'center', 2)[0];
    const end = getArray(circle, 'end', 2)[0];
    const layer = getArray(circle, 'layer', 2)[0];
    const width = getArray(circle, 'width', 2)[0];
    return {
      center: xy(center),
      end: xy(end),
      layer: layer ? layer[1] : '',
      width: width ? width[1] : 0,
    };
  });
}

export function getPolys(sexprData) {
  return getArray(sexprData, 'fp_poly').map((poly) => {
    const ptsNode = getArray(poly, 'pts')[0];
    const points = ptsNode ? getArray(ptsNode, 'xy').map(xy) : [];
    const layer = getArray(poly, 'layer', 2)[0];
    const width = getArray(poly, 'width', 2)[0];
    return { points, layer: layer ? layer[1] : '', width: width ? width[1] : 0 };
  });
}

// 3-point circle fit + sweep angle, ported from kicad_mod.py's _getArcs
function arcCenterAndAngle(p1, p2, p3) {
  let rx, ry;
  if (Math.sqrt((p1.x - p3.x) ** 2 + (p1.y - p3.y) ** 2) < 1e-7) {
    rx = 0.5 * (p1.x + p2.x);
    ry = 0.5 * (p1.y + p2.y);
  } else {
    const A = 2 * (p1.x * (p2.y - p3.y) - p1.y * (p2.x - p3.x) + p2.x * p3.y - p3.x * p2.y);
    rx =
      ((p1.x ** 2 + p1.y ** 2) * (p2.y - p3.y) +
        (p2.x ** 2 + p2.y ** 2) * (p3.y - p1.y) +
        (p3.x ** 2 + p3.y ** 2) * (p1.y - p2.y)) /
      A;
    ry =
      ((p1.x ** 2 + p1.y ** 2) * (p3.x - p2.x) +
        (p2.x ** 2 + p2.y ** 2) * (p1.x - p3.x) +
        (p3.x ** 2 + p3.y ** 2) * (p2.x - p1.x)) /
      A;
  }

  let diff = Math.atan2(p3.y - ry, p3.x - rx) - Math.atan2(p1.y - ry, p1.x - rx);
  if (diff < 0) diff = 2 * Math.PI + diff;

  return { center: { x: rx, y: ry }, angle: diff };
}

export function getArcs(sexprData) {
  return getArray(sexprData, 'fp_arc').map((arc) => {
    const start = xy(getArray(arc, 'start', 2)[0]);
    const end = xy(getArray(arc, 'end', 2)[0]);
    const mid = xy(getArray(arc, 'mid', 2)[0]);
    const { center, angle } = arcCenterAndAngle(start, mid, end);
    const layer = getArray(arc, 'layer', 2)[0];
    const width = getArray(arc, 'width', 2)[0];
    return { start, mid, end, center, angle, layer: layer ? layer[1] : '', width: width ? width[1] : 0 };
  });
}

// Full footprint model, mirroring KicadMod's public fields.
export function parseFootprint(sexprData) {
  return {
    name: String(sexprData[1]),
    pads: getPads(sexprData),
    lines: getLines(sexprData),
    rects: getRects(sexprData),
    circles: getCircles(sexprData),
    polys: getPolys(sexprData),
    arcs: getArcs(sexprData),
  };
}
