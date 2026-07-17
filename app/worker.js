// Web Worker owning the entire matching pipeline (parse → render → opencv match), so the main
// thread never runs WASM work and never loads opencv.js at all. Running here instead of the page
// matters beyond responsiveness: browsers throttle main-thread timers in background tabs, which
// stretched a ~4-minute match to ~40 minutes when the tab lost focus — worker timers are exempt.
//
// Protocol (all messages carry the request `id` they belong to):
//   in:  { id, type: 'componentMatch', pcbText, drlText, ref, footprintId }
//        { id, type: 'circuitMatch',  pcbText, schText, drlText }
//   out: { id, type: 'status',   text }
//        { id, type: 'progress', p }                   — same shape onProgress produced before
//        { id, type: 'result',   data, images }        — plain JSON + ImageBitmaps (transferred)
//        { id, type: 'error',    message }
import { parseBoard, isBoardDoubleSided } from './lib/kicad/board.js';
import { renderLayer, renderFootprint } from './lib/kicad/renderer.js';
import { parseDrillFile } from './lib/kicad/drill.js';
import { parseSchematic, deriveNets, getOrderedComponentsList } from './lib/kicad/schematic.js';
import { PCBBoard } from './lib/match/pcb-board.js';
import { ComponentMatching } from './lib/match/component-match.js';
import { CircuitMatching } from './lib/match/circuit-matching.js';

const PX_PER_MM = 48;

// opencv.js is a classic UMD script (its factory breaks under module `import`, where top-level
// `this` is undefined), and module workers have no importScripts — so fetch it and run it via
// indirect eval, which executes in global scope exactly like the <script> tag the docs build
// expects. `Module.onRuntimeInitialized` must be registered before the script runs.
let cvReadyPromise = null;
function ensureOpenCv() {
  if (!cvReadyPromise) {
    cvReadyPromise = (async () => {
      let runtimeResolve;
      const runtimeReady = new Promise((resolve) => { runtimeResolve = resolve; });
      self.Module = { onRuntimeInitialized: runtimeResolve };
      const source = await (await fetch('./lib/opencv.js')).text();
      (0, eval)(source);
      await runtimeReady;
    })();
  }
  return cvReadyPromise;
}

// opencv.js's embind layer throws raw WASM exception pointers (a bare number) for C++-side
// errors instead of a normal Error — decode those into a readable message before posting, since
// the pointer is meaningless outside this worker's WASM heap.
function describeError(err) {
  if (typeof err === 'number' && typeof cv !== 'undefined' && cv.exceptionFromPtr) {
    try {
      return cv.exceptionFromPtr(err).msg;
    } catch {
      return `Unrecognized native error code: ${err}`;
    }
  }
  return (err && err.stack) || String(err);
}

function shortFootprintName(name) {
  return name.split(':').pop();
}

// Same semantics as before the worker split (see git history of app.js): footprints are looked up
// on the uploaded board itself — there is no separate footprint library in this browser-only tool.
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

function prepareBoard(pcbText, drlText) {
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

  return { board, pcbBoard, tracesCanvas };
}

// RGBA overlay Mat (CV_8UC4) → ImageBitmap the main thread can draw directly.
function matToImageBitmap(mat) {
  const imageData = new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
  return createImageBitmap(imageData);
}

// Progress can fire per correlation row — cap postMessage traffic to ~10/s so the search loop
// isn't dominated by structured-clone overhead.
function makeProgressPoster(id) {
  let lastPost = 0;
  return (p) => {
    const now = performance.now();
    if (now - lastPost < 100) return;
    lastPost = now;
    postMessage({ id, type: 'progress', p });
  };
}

// One cached circuit-match session, keyed on the uploaded file contents. Re-running the same
// board+schematic pair reuses the CircuitMatching instance's per-component candidate caches, so
// "search longer" continues from previous work instead of starting over — components whose search
// already completed cost ~0 on the re-run, and cut-short ones get re-searched with the new budget.
let circuitSession = null;

// djb2 — collisions across the handful of files a user uploads in one session are not a concern.
function textKey(...texts) {
  let h = 5381;
  for (const t of texts) {
    const s = t || '';
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    h = (h * 33) ^ 0xff;
  }
  return h >>> 0;
}

function disposeCircuitSession() {
  if (!circuitSession) return;
  circuitSession.cirM.dispose();
  circuitSession.pcbBoard.delete();
  circuitSession = null;
}

async function handleComponentMatch({ id, pcbText, drlText, ref, footprintId }) {
  const status = (text) => postMessage({ id, type: 'status', text });

  status('Parsing board and rendering layers…');
  const { board, pcbBoard, tracesCanvas } = prepareBoard(pcbText, drlText);
  const tracesBitmap = tracesCanvas.transferToImageBitmap();
  const footprintLookup = makeFootprintLookup(board);

  let footprint;
  try {
    footprint = footprintLookup(footprintId);
  } catch {
    pcbBoard.delete();
    postMessage(
      { id, type: 'result', data: { ref, footprintId, unavailable: true, matchCount: 0, best: null }, images: { traces: tracesBitmap } },
      [tracesBitmap],
    );
    return;
  }

  const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: PX_PER_MM });
  const cm = new ComponentMatching();
  cm.pcbBoard = pcbBoard;
  cm.initializeFootprint(fpCanvas, footprint);

  status('Searching for matches…');
  let matches = await cm.getMatches({ onProgress: makeProgressPoster(id) });
  matches = cm.sortMatches(matches);
  matches = cm.addTracesDataToMatches(matches);

  const best = matches[0] || null;
  const data = {
    ref,
    footprintId,
    unavailable: false,
    matchCount: matches.length,
    best: best ? { score: best.score, orientation: best.orientation, fb: best.fb, coordinates: best.coordinates } : null,
  };

  const images = { traces: tracesBitmap };
  const transfers = [tracesBitmap];
  if (best) {
    const overlayMat = cm.getTransparentOverlay(best);
    images.overlay = await matToImageBitmap(overlayMat);
    overlayMat.delete();
    transfers.push(images.overlay);
  }
  for (const m of matches) {
    if (m.fpContours) for (const c of m.fpContours) c.delete();
  }
  cm.delete();
  pcbBoard.delete();

  postMessage({ id, type: 'result', data, images }, transfers);
}

async function handleCircuitMatch({ id, pcbText, schText, drlText, searchBudgetMs }) {
  const status = (text) => postMessage({ id, type: 'status', text });
  const key = textKey(pcbText, schText, drlText);

  let cirM, footprintLookup, netArr, refArrSorted, tracesBitmap;
  if (circuitSession && circuitSession.key === key) {
    // Same files as the previous run: keep the candidate caches, re-search only what was cut
    // short. The traces canvas can't be kept (transferToImageBitmap detaches it), so re-render
    // it from the cached parsed board — that's milliseconds, unlike the search.
    ({ cirM, footprintLookup, netArr, refArrSorted } = circuitSession);
    cirM.invalidateIncompleteRefs();
    tracesBitmap = renderLayer(circuitSession.board, 'F.Cu', { pxPerMm: PX_PER_MM }).transferToImageBitmap();
    status(`Resuming search (keeping previous results) across ${netArr.length} nets, ${refArrSorted.length} components…`);
  } else {
    disposeCircuitSession();
    status('Parsing board and schematic…');
    const { board, pcbBoard, tracesCanvas } = prepareBoard(pcbText, drlText);
    tracesBitmap = tracesCanvas.transferToImageBitmap();

    const schematic = parseSchematic(schText);
    netArr = deriveNets(schematic).map((n) => ({ name: n.name, 'node arr': n['node arr'] }));
    const parsed = getOrderedComponentsList(schematic);
    refArrSorted = parsed.refArrSorted;
    footprintLookup = makeFootprintLookup(board);

    cirM = new CircuitMatching(refArrSorted, parsed.footprintDict, netArr);
    cirM.pcbBoard = pcbBoard;
    circuitSession = { key, board, pcbBoard, cirM, footprintLookup, netArr, refArrSorted };
    status(`Searching for a circuit match across ${netArr.length} nets, ${refArrSorted.length} components…`);
  }

  const result = await cirM.findCircuitMatch(footprintLookup, {
    onProgress: makeProgressPoster(id),
    ...(searchBudgetMs ? { searchBudgetMs } : {}),
  });

  const data = {
    compatibility: result.compatibility,
    nets: result.circuitArr.map((net) => ({
      net: net.net,
      nodes: net.nodes.map((n) => n.node),
      incomplete: !!net.incomplete,
      hasInterventions: !!net.interventions,
    })),
  };

  const images = { traces: tracesBitmap };
  const transfers = [tracesBitmap];
  if (result.circuitArr.length > 0) {
    const overlays = cirM.getTransparentOverlay(result.circuitArr);
    const overlayFront = Array.isArray(overlays) ? overlays[0] : overlays;
    images.overlay = await matToImageBitmap(overlayFront);
    transfers.push(images.overlay);
    if (Array.isArray(overlays)) for (const o of overlays) o.delete();
    else overlays.delete();
  }

  postMessage({ id, type: 'result', data, images }, transfers);
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    await ensureOpenCv();
    if (msg.type === 'componentMatch') await handleComponentMatch(msg);
    else if (msg.type === 'circuitMatch') await handleCircuitMatch(msg);
    else throw new Error(`Unknown worker request type: ${msg.type}`);
  } catch (err) {
    postMessage({ id: msg.id, type: 'error', message: describeError(err) });
  }
};
