// Standalone Phase 4 validation harness: runs the full circuit-match pipeline (same code path as
// app.js's runCircuitMatchFlow) against a board+schematic pair without going through the DOM, so a
// batch of Evaluation Files boards can be driven from a single script.
import { parseBoard, isBoardDoubleSided } from '../lib/kicad/board.js';
import { renderLayer } from '../lib/kicad/renderer.js';
import { parseDrillFile } from '../lib/kicad/drill.js';
import { parseSchematic, deriveNets, getOrderedComponentsList } from '../lib/kicad/schematic.js';
import { PCBBoard } from '../lib/match/pcb-board.js';
import { CircuitMatching } from '../lib/match/circuit-matching.js';

const PX_PER_MM = 48;

function shortFootprintName(name) {
  return name.split(':').pop();
}

function makeFootprintLookup(board) {
  return (footprintId) => {
    const shortName = shortFootprintName(footprintId);
    const instance = board.footprints.find((fp) => shortFootprintName(fp.name) === shortName);
    if (!instance) throw new Error(`No matching footprint "${shortName}" found on the uploaded board.`);
    const at = instance.at;
    return {
      name: shortName,
      pads: instance.pads.map((p) => ({
        ...p,
        pos: { x: p.boardPos.x - at.x, y: p.boardPos.y - at.y, orientation: p.boardRotation - at.rot },
      })),
    };
  };
}

export async function runEval(label, pcbText, schText, drlText) {
  const start = performance.now();
  try {
    const board = parseBoard(pcbText);
    const holes = drlText ? parseDrillFile(drlText) : [];

    const maskCanvas = renderLayer(board, 'F.Mask', { pxPerMm: PX_PER_MM });
    const tracesCanvas = renderLayer(board, 'F.Cu', { pxPerMm: PX_PER_MM });

    const pcbBoard = new PCBBoard(board);
    if (isBoardDoubleSided(board)) {
      const maskBackCanvas = renderLayer(board, 'B.Mask', { pxPerMm: PX_PER_MM });
      const tracesBackCanvas = renderLayer(board, 'B.Cu', { pxPerMm: PX_PER_MM });
      pcbBoard.initializeViaFiles(maskCanvas, tracesCanvas, { maskBackCanvas, traceBackCanvas: tracesBackCanvas, holes });
    } else {
      pcbBoard.initializeViaFiles(maskCanvas, tracesCanvas, { holes });
    }
    const schematic = parseSchematic(schText);
    const netArr = deriveNets(schematic).map((n) => ({ name: n.name, 'node arr': n['node arr'] }));
    const { refArrSorted, footprintDict } = getOrderedComponentsList(schematic);
    const footprintLookup = makeFootprintLookup(board);

    const cirM = new CircuitMatching(refArrSorted, footprintDict, netArr);
    cirM.pcbBoard = pcbBoard;

    const result = await cirM.findCircuitMatch(footprintLookup, {});
    const elapsedMs = Math.round(performance.now() - start);
    return { label, ok: true, elapsedMs, componentCount: refArrSorted.length, netCount: netArr.length, compatibility: result.compatibility };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return { label, ok: false, elapsedMs, error: err.message || String(err) };
  }
}
