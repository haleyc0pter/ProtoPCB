// Parses .kicad_sch for placed components (mirrors sch_reader.py's get_starting_symbol/get_symbol)
// and derives net connectivity directly from wires/junctions/labels/power-symbols/pins.
//
// This replaces `kicad-cli sch export netlist` + sch_reader.py's .net-file reading — there is no
// browser-side substitute for KiCad's own netlist exporter, so this is graph-connectivity built
// from the schematic geometry itself. Output shape matches sch_reader.get_connections's net
// dicts ({name, node arr: [{ref, pin, footprint, total pins}]}) so the matching code in Phase 2
// needs minimal changes to consume it.
//
// Simplifications vs. full KiCad semantics (acceptable for the single-sheet breakout-board style
// designs this tool targets): no hierarchical-sheet traversal, no symbol mirroring of pin
// positions, no bus unrolling.
import { parseSexpr, getArray } from './sexpr.js';
import { rotatePoint } from './geometry.js';

function xy(arr) {
  return { x: arr[1], y: arr[2] };
}

function getProperty(symbolNode, propName) {
  for (const prop of getArray(symbolNode, 'property')) {
    if (prop[1] === propName) return prop[2];
  }
  return '';
}

// Collect `pin` nodes directly under a symbol node (mirrors kicad_mod.py-style pin extraction).
function collectPinsForNode(node) {
  return getArray(node, 'pin').map((pin) => {
    const at = getArray(pin, 'at', 2)[0];
    const numberNode = getArray(pin, 'number')[0];
    return {
      number: String(numberNode ? numberNode[1] : ''),
      localX: at[1],
      localY: at[2],
      localRot: at[3] || 0,
      electricalType: pin[1],
    };
  });
}

// Multi-unit parts (op-amps, logic gates, multi-gang connectors) split their REAL pins across
// nested per-unit sub-symbols named "{baseName}_{unit}_{style}" (e.g. "TL074_1_1" = unit 1, style
// 1) instead of listing them directly on the top-level symbol — each op-amp gate of a quad op-amp
// only owns a few of the chip's pins, with a separate sub-symbol (often a dedicated "power" unit)
// holding the shared supply pins. A placed instance's own `(unit N)` field says which one it is.
// Simple, single-unit parts (most passives/ICs) have no nested sub-symbols and keep their pins
// directly on the top-level node instead.
function parseLibSymbols(data) {
  const libSymbolsNode = getArray(data, 'lib_symbols')[0];
  const byId = new Map();
  if (!libSymbolsNode) return byId;
  for (const sym of getArray(libSymbolsNode, 'symbol')) {
    const libId = sym[1];
    const subUnits = getArray(sym, 'symbol');
    if (subUnits.length === 0) {
      byId.set(libId, { pins: collectPinsForNode(sym), unitPins: null });
      continue;
    }
    const unitPins = new Map();
    for (const subSym of subUnits) {
      const parts = String(subSym[1]).split('_');
      const unitNum = Number(parts[parts.length - 2]);
      if (!unitPins.has(unitNum)) unitPins.set(unitNum, []);
      unitPins.get(unitNum).push(...collectPinsForNode(subSym));
    }
    byId.set(libId, { pins: null, unitPins });
  }
  return byId;
}

export function parseSchematic(text) {
  const data = parseSexpr(text);
  const libSymbols = parseLibSymbols(data);

  // Placed symbol instances live at the top level of the sheet, distinct from lib_symbols'
  // (unplaced) definitions — identified by having an `at` and a `lib_id`.
  const components = [];
  for (const sym of getArray(data, 'symbol')) {
    const libIdNode = getArray(sym, 'lib_id', 2)[0];
    const atNode = getArray(sym, 'at', 2)[0];
    if (!libIdNode || !atNode) continue;

    const libId = libIdNode[1];
    const ref = getProperty(sym, 'Reference');
    const value = getProperty(sym, 'Value');
    const footprint = getProperty(sym, 'Footprint');
    const at = { x: atNode[1], y: atNode[2], rot: atNode[3] || 0 };
    const mirrorNode = getArray(sym, 'mirror', 2)[0];
    const mirror = mirrorNode ? mirrorNode[1] : null; // 'x', 'y', or null

    const libEntry = libSymbols.get(libId);
    let libPins = [];
    if (libEntry) {
      if (libEntry.unitPins) {
        const unitNode = getArray(sym, 'unit', 2)[0];
        const unitNum = unitNode ? unitNode[1] : 1;
        libPins = libEntry.unitPins.get(unitNum) || [];
      } else {
        libPins = libEntry.pins;
      }
    }
    const pins = libPins.map((pin) => {
      // KiCad symbol library pins are authored Y-up; the schematic sheet is Y-down, so the
      // local Y must be flipped before rotating/translating into sheet coordinates. A placed
      // instance may additionally be mirrored across the local X or Y axis.
      let lx = pin.localX;
      let ly = -pin.localY;
      if (mirror === 'y') lx = -lx;
      if (mirror === 'x') ly = -ly;
      const rotated = rotatePoint({ x: lx, y: ly }, -at.rot);
      return { ...pin, absPos: { x: at.x + rotated.x, y: at.y + rotated.y } };
    });

    components.push({ ref, value, footprint, libId, at, pins, isPower: ref.startsWith('#') });
  }

  const wires = getArray(data, 'wire').map((w) => {
    const ptsNode = getArray(w, 'pts')[0];
    const pts = getArray(ptsNode, 'xy').map(xy);
    return { start: pts[0], end: pts[1] };
  });

  const junctions = getArray(data, 'junction').map((j) => xy(getArray(j, 'at', 2)[0]));

  const labels = [];
  for (const key of ['label', 'global_label', 'hierarchical_label']) {
    for (const node of getArray(data, key)) {
      const at = getArray(node, 'at', 2)[0];
      labels.push({ text: node[1], pos: xy(at) });
    }
  }

  return { components, wires, junctions, labels, libSymbols };
}

// mirrors sch_reader.get_starting_symbol: the component with the most pins.
export function getStartingSymbol(schematic) {
  let best = null;
  for (const c of schematic.components) {
    if (c.isPower) continue;
    if (!best || c.pins.length > best.pins.length) best = c;
  }
  return best ? { name: best.libId, footprint: best.footprint } : null;
}

// mirrors sch_reader.get_symbol: looks up a component's lib_id by its schematic reference.
export function getSymbolByRef(schematic, ref) {
  const c = schematic.components.find((c) => c.ref === ref);
  return c ? c.libId : '';
}

// --- net derivation -------------------------------------------------------

const key = (pt) => `${pt.x.toFixed(3)},${pt.y.toFixed(3)}`;

// true if `p` lies on the segment from `a` to `b` (collinear and between the endpoints, within a
// small tolerance for floating-point noise in the schematic file's coordinates).
function pointOnSegment(p, a, b, eps = 0.01) {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > eps) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  if (dot < -eps) return false;
  const lenSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (dot > lenSq + eps) return false;
  return true;
}

// A label's own `(at x y)` is frequently placed partway along a wire it labels — not necessarily
// at either endpoint — since KiCad only requires a label to touch the wire, anywhere on it. Wire
// connectivity is built purely from endpoints (see deriveNets below), so a label sitting mid-wire
// needs to resolve to that wire's own union-find node instead of its own, otherwise-unconnected
// point, or it silently fails to join the net it's actually labeling.
function effectiveKeyForPoint(pt, wires) {
  for (const wire of wires) {
    if (pointOnSegment(pt, wire.start, wire.end)) return key(wire.start);
  }
  return key(pt);
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// Builds nets purely from schematic geometry: wire endpoints, junctions, and pins that share a
// coordinate are the same net; same-text labels are the same net wherever they appear; all
// instances of the same power symbol (ref starting with "#", e.g. GND/VCC) share one global net.
export function deriveNets(schematic) {
  const uf = new UnionFind();
  const pinNodeKey = (compIdx, pinIdx) => `pin:${compIdx}:${pinIdx}`;

  // wire segments: union their two endpoints
  for (const wire of schematic.wires) {
    uf.union(key(wire.start), key(wire.end));
  }

  // pins: union each pin's node with its coordinate's wire-graph node
  schematic.components.forEach((comp, ci) => {
    comp.pins.forEach((pin, pi) => {
      uf.union(pinNodeKey(ci, pi), key(pin.absPos));
    });
  });

  // labels at a coordinate join that coordinate's net; same label text anywhere joins together
  const labelRepresentative = new Map(); // text -> union-find key chosen to represent it
  for (const label of schematic.labels) {
    const coordKey = effectiveKeyForPoint(label.pos, schematic.wires);
    if (!labelRepresentative.has(label.text)) {
      labelRepresentative.set(label.text, coordKey);
    } else {
      uf.union(coordKey, labelRepresentative.get(label.text));
    }
  }

  // power symbols (GND, VCC, ...): every instance of the same value shares one global net
  const powerRepresentative = new Map(); // value -> pin node key
  schematic.components.forEach((comp, ci) => {
    if (!comp.isPower) return;
    comp.pins.forEach((pin, pi) => {
      const nodeKey = pinNodeKey(ci, pi);
      if (!powerRepresentative.has(comp.value)) {
        powerRepresentative.set(comp.value, nodeKey);
      } else {
        uf.union(nodeKey, powerRepresentative.get(comp.value));
      }
    });
  });

  // group pins by their net root
  const netsByRoot = new Map();
  schematic.components.forEach((comp, ci) => {
    if (comp.isPower) return; // power symbols themselves aren't netlist components with footprints
    comp.pins.forEach((pin, pi) => {
      const root = uf.find(pinNodeKey(ci, pi));
      if (!netsByRoot.has(root)) netsByRoot.set(root, []);
      netsByRoot.get(root).push({
        ref: comp.ref,
        pin: pin.number,
        footprint: comp.footprint,
        'total pins': comp.pins.length,
      });
    });
  });

  // name a net after any label that landed in its group, else a synthetic "NetN" name
  // (mirrors the "Net..." naming sch_reader.get_connections expects from KiCad's own exporter).
  const netRootForLabel = new Map();
  for (const [text, coordKey] of labelRepresentative) {
    netRootForLabel.set(uf.find(coordKey), text);
  }

  let n = 1;
  const nets = [];
  for (const [root, nodeArr] of netsByRoot) {
    if (nodeArr.length < 1) continue;
    const name = netRootForLabel.get(root) || `Net-${n++}`;
    nets.push({ name, 'node arr': nodeArr.filter((node) => node['total pins'] > 0) });
  }
  return nets;
}

// mirrors sch_reader.get_ordered_components_list. A multi-unit part (op-amp, logic gate,
// multi-gang connector) is placed as several schematic.components entries sharing one ref — one
// per internal unit — but there's only ONE physical footprint on the board to search for, so refs
// are deduplicated here (unlike deriveNets, which needs each unit's own separate pins/positions
// for correct net connectivity and is unaffected by this).
export function getOrderedComponentsList(schematic) {
  const componentsWithPins = schematic.components.filter((c) => !c.isPower);
  const byRef = new Map();
  for (const c of componentsWithPins) {
    if (!byRef.has(c.ref)) byRef.set(c.ref, { ref: c.ref, footprint: c.footprint, pinCount: 0 });
    byRef.get(c.ref).pinCount += c.pins.length;
  }
  const refEntries = [...byRef.values()];
  const sorted = [...refEntries].sort((a, b) => b.pinCount - a.pinCount);
  const refArrSorted = sorted.filter((c) => c.pinCount !== 0).map((c) => c.ref);
  const footprintDict = {};
  for (const c of refEntries) {
    if (!footprintDict[c.footprint]) footprintDict[c.footprint] = [];
    footprintDict[c.footprint].push(c.ref);
  }
  return { refArrSorted, footprintDict };
}
