// Port of the .kicad_pcb-specific parts of Code/PCB_utils.py (get_board_bounds, is_board_fb)
// plus new board-level geometry extraction (tracks/zones) needed to replace `kicad-cli pcb export svg`.
import { parseSexpr, getArray } from './sexpr.js';
import { parseFootprint } from './footprint.js';
import { rotatePoint } from './geometry.js';

function xy(arr) {
  return { x: arr[1], y: arr[2] };
}

// Places a parsed footprint's pads/graphics into board coordinates using the footprint's
// own (at x y [rot]) — mirrors how gui.py/PCB_utils treat footprint placement.
function placeFootprint(fpNode) {
  const nameNode = fpNode[1];
  const layerArr = getArray(fpNode, 'layer', 2)[0];
  const atArr = getArray(fpNode, 'at', 2)[0];
  const at = { x: atArr[1], y: atArr[2], rot: atArr[3] || 0 };
  const layer = layerArr ? layerArr[1] : 'F.Cu';
  const parsed = parseFootprint(fpNode);

  const pads = parsed.pads.map((pad) => {
    const rotated = rotatePoint({ x: pad.pos.x, y: pad.pos.y }, -at.rot);
    return {
      ...pad,
      boardPos: { x: at.x + rotated.x, y: at.y + rotated.y },
      boardRotation: at.rot + pad.pos.orientation,
    };
  });

  return { name: nameNode, layer, at, pads };
}

function boundsFromGrItems(data) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const onEdgeCuts = (node) => {
    const layerArr = getArray(node, 'layer', 2)[0];
    return layerArr && layerArr[1] === 'Edge.Cuts';
  };

  for (const node of getArray(data, 'gr_rect')) {
    if (!onEdgeCuts(node)) continue;
    const s = getArray(node, 'start', 2)[0];
    const e = getArray(node, 'end', 2)[0];
    consider(s[1], s[2]);
    consider(e[1], e[2]);
  }
  for (const node of getArray(data, 'gr_line')) {
    if (!onEdgeCuts(node)) continue;
    const s = getArray(node, 'start', 2)[0];
    const e = getArray(node, 'end', 2)[0];
    consider(s[1], s[2]);
    consider(e[1], e[2]);
  }
  // gr_arc isn't handled in the original PCB_utils.get_board_bounds (left commented out there),
  // but several real boards use arcs for rounded Edge.Cuts corners, so include start/mid/end
  // as a cheap approximation rather than silently under-cropping those boards.
  for (const node of getArray(data, 'gr_arc')) {
    if (!onEdgeCuts(node)) continue;
    for (const key of ['start', 'mid', 'end']) {
      const p = getArray(node, key, 2)[0];
      if (p) consider(p[1], p[2]);
    }
  }

  return { minX, minY, maxX, maxY };
}

export function parseBoard(text) {
  const data = parseSexpr(text);

  const footprints = getArray(data, 'footprint').map(placeFootprint);

  const segments = getArray(data, 'segment').map((seg) => {
    const start = getArray(seg, 'start', 2)[0];
    const end = getArray(seg, 'end', 2)[0];
    const width = getArray(seg, 'width', 2)[0];
    const layer = getArray(seg, 'layer', 2)[0];
    const net = getArray(seg, 'net', 2)[0];
    return {
      start: xy(start),
      end: xy(end),
      width: width[1],
      layer: layer[1],
      net: net ? net[1] : null,
    };
  });

  const vias = getArray(data, 'via').map((via) => {
    const at = getArray(via, 'at', 2)[0];
    const size = getArray(via, 'size', 2)[0];
    const drill = getArray(via, 'drill', 2)[0];
    const layersArr = getArray(via, 'layers', 2)[0];
    return {
      pos: xy(at),
      size: size ? size[1] : 0,
      drill: drill ? drill[1] : 0,
      layers: layersArr ? layersArr.slice(1) : [],
    };
  });

  // Zone copper fill polygons (per-layer), e.g. ground pours.
  const zones = getArray(data, 'zone').map((zone) => {
    const layerArr = getArray(zone, 'layer', 2)[0];
    const layersArr = getArray(zone, 'layers', 2)[0];
    const layers = layerArr ? [layerArr[1]] : layersArr ? layersArr.slice(1) : [];
    const fillPolys = getArray(zone, 'filled_polygon').map((fp) => {
      const ptsNode = getArray(fp, 'pts')[0];
      return ptsNode ? getArray(ptsNode, 'xy').map(xy) : [];
    });
    return { layers, fillPolys };
  });

  const bounds = boundsFromGrItems(data);

  return { footprints, segments, vias, zones, bounds };
}

// mirrors PCB_utils.is_board_fb: true if any footprint sits on the back copper layer.
export function isBoardDoubleSided(board) {
  return board.footprints.some((fp) => fp.layer === 'B.Cu');
}
