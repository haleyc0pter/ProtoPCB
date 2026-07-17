// Parses .kicad_sch for placed components (mirrors sch_reader.py's get_starting_symbol/get_symbol)
// and derives net connectivity directly from wires/junctions/labels/power-symbols/pins.
//
// This replaces `kicad-cli sch export netlist` + sch_reader.py's .net-file reading — there is no
// browser-side substitute for KiCad's own netlist exporter, so this is graph-connectivity built
// from the schematic geometry itself. Output shape matches sch_reader.get_connections's net
// dicts ({name, node arr: [{ref, pin, footprint, total pins}]}) so the matching code in Phase 2
// needs minimal changes to consume it.
//
// Simplifications vs. full KiCad semantics (acceptable for the breakout-board style designs this
// tool targets): no symbol mirroring of pin positions, no bus unrolling, and hierarchical sheets
// are supported single-instance only (a sheet placed twice would need per-instance ref
// annotation, which this flattening ignores).
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

// Parses one sheet's worth of schematic text into tagged entity lists. `sheetId` namespaces
// everything from this sheet so coordinates on different sheets can never accidentally collide
// during net derivation ('' for the root sheet).
function parseSheet(text, sheetId) {
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
        // unit 0 sub-symbols are KiCad's "common to every unit" section — a single-unit part is
        // often authored as one `_0_1` sub-symbol holding all its pins, so unit 0 must always be
        // included alongside the placed instance's own unit.
        libPins = [...(libEntry.unitPins.get(0) || []), ...(libEntry.unitPins.get(unitNum) || [])];
      } else {
        libPins = libEntry.pins;
      }
    }
    const pins = libPins.map((pin) => {
      // KiCad symbol library pins are authored Y-up; the schematic sheet is Y-down, so the
      // local Y must be flipped before rotating/translating into sheet coordinates. A placed
      // instance may additionally be mirrored — KiCad applies the mirror in sheet coordinates
      // AFTER the rotation (mirror-then-rotate flips which pin lands where for rotated 2-pin
      // parts; confirmed against kicad-cli's netlist for a rot-90 + mirror-x resistor).
      const rotated = rotatePoint({ x: pin.localX, y: -pin.localY }, -at.rot);
      if (mirror === 'x') rotated.y = -rotated.y;
      if (mirror === 'y') rotated.x = -rotated.x;
      return { ...pin, absPos: { x: at.x + rotated.x, y: at.y + rotated.y } };
    });

    components.push({ ref, value, footprint, libId, at, pins, isPower: ref.startsWith('#'), sheetId });
  }

  const wires = getArray(data, 'wire').map((w) => {
    const ptsNode = getArray(w, 'pts')[0];
    const pts = getArray(ptsNode, 'xy').map(xy);
    return { start: pts[0], end: pts[1], sheetId };
  });

  const junctions = getArray(data, 'junction').map((j) => ({ ...xy(getArray(j, 'at', 2)[0]), sheetId }));

  const labels = [];
  for (const labelType of ['label', 'global_label', 'hierarchical_label']) {
    for (const node of getArray(data, labelType)) {
      const at = getArray(node, 'at', 2)[0];
      labels.push({ text: node[1], pos: xy(at), type: labelType, sheetId });
    }
  }

  // (sheet ...) blocks: placed sub-sheet instances. Each carries the child filename and the
  // parent-side connection pins (name + position on this sheet's wires).
  const sheetRefs = getArray(data, 'sheet').map((sheetNode) => {
    const uuidNode = getArray(sheetNode, 'uuid', 2)[0];
    const pins = getArray(sheetNode, 'pin').map((pin) => ({
      name: pin[1],
      pos: xy(getArray(pin, 'at', 2)[0]),
    }));
    return {
      file: getProperty(sheetNode, 'Sheetfile'),
      name: getProperty(sheetNode, 'Sheetname'),
      uuid: uuidNode ? uuidNode[1] : `${sheetId}/anon-${Math.random()}`,
      pins,
    };
  });

  return { components, wires, junctions, labels, sheetRefs, libSymbols };
}

// `extraSheets` maps uploaded filenames to their text, so hierarchical designs can be flattened:
// each (sheet) block's Sheetfile is resolved against it by basename (accepting the legacy ".sch"
// spelling for a ".kicad_sch" upload, which older projects' sheet blocks still reference).
// Everything is merged into one flat structure; `sheetLinks` records how each child sheet's
// hierarchical labels bridge to pins on its parent sheet, for deriveNets to union across.
export function parseSchematic(text, { extraSheets = {} } = {}) {
  const byBasename = new Map();
  for (const [name, sheetText] of Object.entries(extraSheets)) {
    byBasename.set(name.split('/').pop().toLowerCase(), sheetText);
  }
  const resolveChild = (file) => {
    const base = file.split('/').pop().toLowerCase();
    return byBasename.get(base) ?? byBasename.get(base.replace(/\.sch$/, '.kicad_sch')) ?? null;
  };

  const merged = { components: [], wires: [], junctions: [], labels: [], sheetLinks: [], libSymbols: null };
  const queue = [{ text, sheetId: '', parentSheetId: null, pins: [] }];
  const visited = new Set(['']);

  while (queue.length > 0) {
    const { text: sheetText, sheetId, parentSheetId, pins } = queue.shift();
    const sheet = parseSheet(sheetText, sheetId);
    if (merged.libSymbols === null) merged.libSymbols = sheet.libSymbols;

    merged.components.push(...sheet.components);
    merged.wires.push(...sheet.wires);
    merged.junctions.push(...sheet.junctions);
    merged.labels.push(...sheet.labels);
    if (parentSheetId !== null) merged.sheetLinks.push({ childSheetId: sheetId, parentSheetId, pins });

    for (const ref of sheet.sheetRefs) {
      const childText = resolveChild(ref.file);
      // Flattening keeps each child's Reference-property refs as-is, so a sheet file placed more
      // than once would duplicate every ref inside it — only the first instance is loaded
      // (single-instance hierarchy support, per the header comment).
      if (!childText || visited.has(ref.uuid) || visited.has(childText)) continue;
      visited.add(ref.uuid);
      visited.add(childText);
      queue.push({ text: childText, sheetId: ref.uuid, parentSheetId: sheetId, pins: ref.pins });
    }
  }

  return merged;
}

// Given every uploaded schematic file ([{name, text}]), picks the root sheet: the one no other
// uploaded file references as a Sheetfile. Falls back to the first file (single-file uploads,
// or a set whose references all point outside the upload).
export function pickRootSheet(files) {
  const referenced = new Set();
  for (const f of files) {
    for (const m of f.text.matchAll(/\(property "Sheetfile" "([^"]+)"/g)) {
      const base = m[1].split('/').pop().toLowerCase();
      referenced.add(base);
      referenced.add(base.replace(/\.sch$/, '.kicad_sch'));
    }
  }
  return files.find((f) => !referenced.has(f.name.split('/').pop().toLowerCase())) || files[0];
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

// true if `p` lies within `eps` of the segment from `a` to `b`. This must be a true
// point-to-segment distance — a raw cross-product tolerance scales with segment length, so a
// near-zero-length segment (schematics really contain them, e.g. a 0.0002mm editing artifact)
// would "contain" points tens of mm away and weld unrelated nets together.
function pointOnSegment(p, a, b, eps = 0.01) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2 <= eps * eps;
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
// coordinate (on the same sheet) are the same net; same-text labels are the same net within
// their sheet (globally for global labels); hierarchical labels additionally bridge to the
// matching sheet pin on the parent sheet; all instances of the same power symbol (ref starting
// with "#", e.g. GND/VCC) share one global net across every sheet.
export function deriveNets(schematic) {
  const uf = new UnionFind();
  const pinNodeKey = (compIdx, pinIdx) => `pin:${compIdx}:${pinIdx}`;
  // Coordinates only mean anything within their own sheet — prefix with the sheet id so two
  // sheets that happen to draw at the same (x, y) can never merge by accident.
  const sheetKey = (sheetId, pt) => `${sheetId}|${key(pt)}`;

  const wiresBySheet = new Map();
  for (const wire of schematic.wires) {
    if (!wiresBySheet.has(wire.sheetId)) wiresBySheet.set(wire.sheetId, []);
    wiresBySheet.get(wire.sheetId).push(wire);
  }
  const sheetPointKey = (sheetId, pt) => `${sheetId}|${effectiveKeyForPoint(pt, wiresBySheet.get(sheetId) || [])}`;

  // wire segments: union their two endpoints
  for (const wire of schematic.wires) {
    uf.union(sheetKey(wire.sheetId, wire.start), sheetKey(wire.sheetId, wire.end));
  }

  // pins: union each pin's node with its coordinate's wire-graph node
  schematic.components.forEach((comp, ci) => {
    comp.pins.forEach((pin, pi) => {
      uf.union(pinNodeKey(ci, pi), sheetKey(comp.sheetId, pin.absPos));
    });
  });

  // power symbols (GND, VCC, ...): every instance of the same value shares one global net.
  // Built before label processing so a label named after a power net can join it below.
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

  // Labels at a coordinate join that coordinate's net. Local and hierarchical labels share a
  // per-sheet name namespace (same text on the same sheet is the same net); global labels
  // additionally merge across every sheet; and a label spelled exactly like a power symbol's
  // value joins that power net — KiCad resolves both to the same net name, so e.g. a local
  // "GND" label on a connector pin lands in the same net as every GND power symbol (confirmed
  // against kicad-cli's netlist for exactly that pattern).
  const labelRepresentative = new Map(); // per-sheet: `${sheetId}|${text}` -> union-find key
  const globalRepresentative = new Map(); // global_label text -> union-find key
  for (const label of schematic.labels) {
    const coordKey = sheetPointKey(label.sheetId, label.pos);
    const perSheetName = `${label.sheetId}|${label.text}`;
    if (!labelRepresentative.has(perSheetName)) {
      labelRepresentative.set(perSheetName, coordKey);
    } else {
      uf.union(coordKey, labelRepresentative.get(perSheetName));
    }
    if (label.type === 'global_label') {
      if (!globalRepresentative.has(label.text)) {
        globalRepresentative.set(label.text, coordKey);
      } else {
        uf.union(coordKey, globalRepresentative.get(label.text));
      }
    }
    if (powerRepresentative.has(label.text)) {
      uf.union(coordKey, powerRepresentative.get(label.text));
    }
  }

  // sheet pins: each pin on a placed sub-sheet connects the parent-side wire it sits on with the
  // child sheet's same-named hierarchical label net.
  for (const link of schematic.sheetLinks || []) {
    for (const pin of link.pins) {
      const parentKey = sheetPointKey(link.parentSheetId, pin.pos);
      const childLabelKey = labelRepresentative.get(`${link.childSheetId}|${pin.name}`);
      if (childLabelKey) uf.union(parentKey, childLabelKey);
    }
  }

  // group pins by their net root
  const netsByRoot = new Map();
  schematic.components.forEach((comp, ci) => {
    if (comp.isPower) return; // power symbols themselves aren't netlist components with footprints
    if (comp.ref.endsWith('?')) return; // unannotated symbol — KiCad's own exporter drops these too
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
  for (const [perSheetName, coordKey] of labelRepresentative) {
    const text = perSheetName.slice(perSheetName.indexOf('|') + 1);
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
  const componentsWithPins = schematic.components.filter((c) => !c.isPower && !c.ref.endsWith('?'));
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
