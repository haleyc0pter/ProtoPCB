// ProtoPCB web app controller — replaces Code/gui.py's Tkinter shell. Business logic lives in
// lib/kicad (parsing/rendering) and lib/match (component/net/circuit matching); this file is
// purely the view layer: render a screen, wire up its events, move to the next screen.
import { parseBoard, isBoardDoubleSided } from './lib/kicad/board.js';
import { renderLayer, renderFootprint } from './lib/kicad/renderer.js';
import { parseDrillFile } from './lib/kicad/drill.js';
import { parseSchematic, deriveNets, getOrderedComponentsList, getSymbolByRef } from './lib/kicad/schematic.js';
import { PCBBoard } from './lib/match/pcb-board.js';
import { ComponentMatching } from './lib/match/component-match.js';
import { CircuitMatching } from './lib/match/circuit-matching.js';

const PX_PER_MM = 48;
const root = document.getElementById('view-root');

const session = {
  pcbText: null,
  pcbFileName: '',
  schText: null,
  schFileName: '',
  drlText: null,
  drlFileName: '',
};

async function waitForOpenCv() {
  await window.cvReadyPromise;
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function setView(node) {
  root.replaceChildren(node);
}

// --- Screen 1: upload (mirrors gui.py's StartPage2) -------------------------------------------

function renderUploadView() {
  const view = el(`
    <section>
      <h1>ProtoPCB</h1>
      <p class="subtitle">Match a schematic against a salvaged PCB — entirely in your browser.</p>

      <div class="field">
        <label for="pcb-file">Candidate board (.kicad_pcb)</label>
        <input type="file" id="pcb-file" accept=".kicad_pcb" />
        <div class="file-name" id="pcb-file-name"></div>
      </div>

      <div class="field">
        <label for="sch-file">Target schematic (.kicad_sch)</label>
        <input type="file" id="sch-file" accept=".kicad_sch" />
        <div class="file-name" id="sch-file-name"></div>
      </div>

      <div class="field">
        <label for="drl-file">Drill file (.drl) — optional, improves via/through-hole detection on double-sided boards</label>
        <input type="file" id="drl-file" accept=".drl" />
        <div class="file-name" id="drl-file-name"></div>
      </div>

      <div class="actions">
        <button class="secondary" id="btn-select-component" disabled>Select Component from Schematic</button>
        <button class="primary" id="btn-circuit-match" disabled>Run Circuit Match Analysis</button>
      </div>
    </section>
  `);

  const pcbInput = view.querySelector('#pcb-file');
  const schInput = view.querySelector('#sch-file');
  const drlInput = view.querySelector('#drl-file');
  const btnComponent = view.querySelector('#btn-select-component');
  const btnCircuit = view.querySelector('#btn-circuit-match');

  const updateButtons = () => {
    const ready = !!session.pcbText && !!session.schText;
    btnComponent.disabled = !ready;
    btnCircuit.disabled = !ready;
  };

  pcbInput.addEventListener('change', async () => {
    const file = pcbInput.files[0];
    if (!file) return;
    session.pcbText = await file.text();
    session.pcbFileName = file.name;
    view.querySelector('#pcb-file-name').textContent = file.name;
    updateButtons();
  });

  schInput.addEventListener('change', async () => {
    const file = schInput.files[0];
    if (!file) return;
    session.schText = await file.text();
    session.schFileName = file.name;
    view.querySelector('#sch-file-name').textContent = file.name;
    updateButtons();
  });

  drlInput.addEventListener('change', async () => {
    const file = drlInput.files[0];
    if (!file) return;
    session.drlText = await file.text();
    session.drlFileName = file.name;
    view.querySelector('#drl-file-name').textContent = file.name;
  });

  btnComponent.addEventListener('click', () => runComponentSelectorFlow());
  btnCircuit.addEventListener('click', () => runCircuitMatchFlow());

  setView(view);
}

// --- Screen 2: loading (mirrors gui.py's LoadingScreen) ----------------------------------------

function renderLoadingView(title) {
  const view = el(`
    <section>
      <h1>${title}</h1>
      <div class="loading-panel">
        <div class="spinner"></div>
        <div class="bar-track"><div class="bar-fill" id="bar-fill"></div></div>
        <div class="loading-status" id="loading-status">starting…</div>
      </div>
    </section>
  `);
  setView(view);

  const barFill = view.querySelector('#bar-fill');
  const status = view.querySelector('#loading-status');

  return {
    setStatus(text) {
      status.textContent = text;
    },
    onProgress({ orientationIndex = 0, orientationTotal = 1, rowsDone = 0, totalRows = 1 } = {}) {
      const pct = ((orientationIndex + rowsDone / totalRows) / orientationTotal) * 100;
      barFill.style.width = `${pct.toFixed(1)}%`;
      status.textContent = `orientation ${orientationIndex + 1}/${orientationTotal} · row ${rowsDone}/${totalRows} · ${pct.toFixed(0)}%`;
    },
  };
}

// opencv.js's embind layer throws raw WASM exception pointers (a bare number) for C++-side
// errors instead of a normal Error — cv.exceptionFromPtr decodes those into a readable message.
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

function renderErrorView(err) {
  console.error(err);
  const view = el(`
    <section>
      <h1>Something went wrong</h1>
      <div class="error-box"></div>
      <div class="actions"><button class="secondary" id="btn-restart">Start over</button></div>
    </section>
  `);
  view.querySelector('.error-box').textContent = describeError(err);
  view.querySelector('#btn-restart').addEventListener('click', () => renderUploadView());
  setView(view);
}

// --- Shared board/schematic preparation --------------------------------------------------------

async function prepareBoard() {
  const board = parseBoard(session.pcbText);
  const holes = session.drlText ? parseDrillFile(session.drlText) : [];

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

// footprintLookup: given a footprint ID ("<lib>:<name>"), find a placed instance of that
// footprint on the *candidate* board and return a localized (origin-centered) copy suitable for
// renderFootprint — there is no separate footprint library to browse in this browser-only tool,
// only whatever footprints already exist on the uploaded board.
// .kicad_pcb files vary on whether a footprint's name includes its library ("Package_SO:SOIC-8_...",
// the normal native-KiCad form) or is bare ("C0402", seen on Eagle-imported boards) — compare by
// the part after the last colon on both sides so either form matches the other.
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

// --- Screen 3a: component selector (mirrors gui.py's ComponentSelectorPage) --------------------

async function runComponentSelectorFlow() {
  try {
    await waitForOpenCv();
    const loading = renderLoadingView('Reading schematic…');
    const schematic = parseSchematic(session.schText);
    const { refArrSorted, footprintDict } = getOrderedComponentsList(schematic);

    const view = el(`
      <section>
        <h1>Select a component</h1>
        <p class="subtitle">Pick a component from the schematic to search for a matching footprint on the uploaded board.</p>
        <ul class="pick-list" id="component-list"></ul>
      </section>
    `);
    const list = view.querySelector('#component-list');

    for (const ref of refArrSorted) {
      const comp = schematic.components.find((c) => c.ref === ref);
      const item = el(`
        <li>
          <span><span class="ref">${ref}</span><br/><span class="footprint">${comp ? comp.footprint : ''}</span></span>
          <button class="secondary" data-ref="${ref}">Find matches</button>
        </li>
      `);
      item.querySelector('button').addEventListener('click', () => runComponentMatchFlow(ref, comp.footprint));
      list.appendChild(item);
    }

    setView(view);
  } catch (err) {
    renderErrorView(err);
  }
}

async function runComponentMatchFlow(ref, footprintId) {
  try {
    await waitForOpenCv();
    const loading = renderLoadingView(`Matching ${ref}…`);
    loading.setStatus('Parsing board and rendering layers…');

    const { board, pcbBoard, tracesCanvas } = await prepareBoard();
    const footprintLookup = makeFootprintLookup(board);

    let footprint;
    try {
      footprint = footprintLookup(footprintId);
    } catch {
      // The uploaded board doesn't have this footprint anywhere on it — this tool can currently
      // only search for footprints the board itself already has (no bundled standard-footprint
      // library yet), so report that plainly instead of a stack trace.
      renderComponentResultView(ref, [], null, tracesCanvas, {
        unavailable: true,
        footprintId,
      });
      return;
    }

    const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: PX_PER_MM });
    const cm = new ComponentMatching();
    cm.pcbBoard = pcbBoard;
    cm.initializeFootprint(fpCanvas, footprint);

    loading.setStatus('Searching for matches…');
    let matches = await cm.getMatches({ onProgress: (p) => loading.onProgress(p) });
    matches = cm.sortMatches(matches);
    matches = cm.addTracesDataToMatches(matches);

    renderComponentResultView(ref, matches, cm, tracesCanvas);
  } catch (err) {
    renderErrorView(err);
  }
}

function renderComponentResultView(ref, matches, cm, tracesCanvas, { unavailable = false, footprintId = '' } = {}) {
  const view = el(`
    <section>
      <h1>Matches for ${ref}</h1>
      <p class="subtitle">${unavailable ? '' : `${matches.length} candidate location${matches.length === 1 ? '' : 's'} found on the board.`}</p>
      <div class="board-view" id="board-view"></div>
      <div class="result-meta" id="match-meta"></div>
      <div class="actions"><button class="secondary" id="btn-restart">Start over</button></div>
    </section>
  `);

  tracesCanvas.style.maxWidth = '100%';
  view.querySelector('#board-view').appendChild(tracesCanvas);

  const meta = view.querySelector('#match-meta');
  if (unavailable) {
    meta.innerHTML = `<span class="badge warn">Footprint not available</span> The uploaded board has no "${footprintId.split(':').pop()}" footprint anywhere on it, so there's nothing to search for. This tool can currently only match footprints that already exist somewhere on the board — try a different component, or a board more likely to include this part.`;
  } else if (matches.length === 0) {
    meta.innerHTML = '<span class="badge warn">No match found</span> Try a different component or double-check the uploaded board.';
  } else {
    const best = matches[0];
    meta.innerHTML = `<span class="badge ok">Best match</span> score ${(best.score * 100).toFixed(1)}% · orientation ${best.orientation}&deg; · side ${best.fb} · at (${best.coordinates.x}, ${best.coordinates.y})`;

    const overlay = cm.getTransparentOverlay(best);
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'overlay';
    cv.imshow(overlayCanvas, overlay); // cv.imshow sizes the canvas to match the Mat itself
    view.querySelector('#board-view').appendChild(overlayCanvas);
  }

  view.querySelector('#btn-restart').addEventListener('click', () => renderUploadView());
  setView(view);
}

// --- Screen 3b: circuit match (mirrors gui.py's runCircuitAnalysis -> VidCircuitDraft) ---------

async function runCircuitMatchFlow() {
  try {
    await waitForOpenCv();
    const loading = renderLoadingView('Running circuit match…');
    loading.setStatus('Parsing board and schematic…');

    const { board, pcbBoard, tracesCanvas } = await prepareBoard();
    const schematic = parseSchematic(session.schText);
    const netArr = deriveNets(schematic).map((n) => ({ name: n.name, 'node arr': n['node arr'] }));
    const { refArrSorted, footprintDict } = getOrderedComponentsList(schematic);
    const footprintLookup = makeFootprintLookup(board);

    loading.setStatus(`Searching for a circuit match across ${netArr.length} nets, ${refArrSorted.length} components…`);

    const cirM = new CircuitMatching(refArrSorted, footprintDict, netArr);
    cirM.pcbBoard = pcbBoard;

    const result = await cirM.findCircuitMatch(footprintLookup, { onProgress: (p) => loading.onProgress(p) });

    renderCircuitResultView(result, cirM, tracesCanvas);
  } catch (err) {
    renderErrorView(err);
  }
}

function renderCircuitResultView(match, cirM, tracesCanvas) {
  const { totalNets, satisfiedNets, netsNeedingIntervention, unmatchableComponents, incompleteComponents, searchTimedOut, compatibilityPercent } = match.compatibility;
  const complete = compatibilityPercent === 100;

  const view = el(`
    <section>
      <h1>Circuit match result</h1>
      <div class="result-meta" id="summary"></div>
      <div id="incomplete"></div>
      <div id="unmatchable"></div>
      <div class="board-view" id="board-view"></div>
      <h2 style="margin-top:24px">Nets</h2>
      <div class="net-list" id="net-list"></div>
      <div class="actions"><button class="secondary" id="btn-restart">Start over</button></div>
    </section>
  `);

  const summary = view.querySelector('#summary');
  summary.innerHTML = complete
    ? `<span class="badge ok">${compatibilityPercent}% compatible</span> all ${totalNets} nets satisfied with no board modifications needed.`
    : `<span class="badge warn">${compatibilityPercent}% compatible</span> ${satisfiedNets}/${totalNets} nets fully satisfied` +
      (netsNeedingIntervention > 0 ? `, ${netsNeedingIntervention} more possible with an added wire` : '') +
      `. This board doesn't have every part the schematic needs — that's normal for reused boards, not an error.`;

  // incompleteComponents means the search ran out of time before it finished checking whether
  // that component is on the board — a real "0% for this part" would instead show up as
  // unmatchable (footprint truly absent) or simply missing from the nets below with no note here.
  // Conflating the two would report "this board is incompatible" when the honest answer is
  // "we don't know yet, the search needs more time."
  if (incompleteComponents.length > 0) {
    view.querySelector('#incomplete').innerHTML =
      `<div class="result-meta"><span class="badge warn">Search incomplete</span> ran out of time before finishing the search for: ${incompleteComponents.join(', ')}. ` +
      `The percentage above may understate real compatibility — try again to search further (results so far are kept).</div>`;
  } else if (searchTimedOut) {
    view.querySelector('#incomplete').innerHTML =
      `<div class="result-meta"><span class="badge warn">Search incomplete</span> the search ran out of time before checking every possibility. The percentage above may understate real compatibility — try again to search further.</div>`;
  }

  if (unmatchableComponents.length > 0) {
    const list = unmatchableComponents.map((c) => `${c.ref} (${c.footprintId.split(':').pop()})`).join(', ');
    view.querySelector('#unmatchable').innerHTML =
      `<div class="result-meta"><span class="badge warn">Missing footprints</span> the board has no matching footprint for: ${list}.</div>`;
  }

  tracesCanvas.style.maxWidth = '100%';
  view.querySelector('#board-view').appendChild(tracesCanvas);

  if (match.circuitArr.length > 0) {
    const overlays = cirM.getTransparentOverlay(match.circuitArr);
    const overlayFront = Array.isArray(overlays) ? overlays[0] : overlays;
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'overlay';
    overlayCanvas.width = tracesCanvas.width;
    overlayCanvas.height = tracesCanvas.height;
    cv.imshow(overlayCanvas, overlayFront);
    view.querySelector('#board-view').appendChild(overlayCanvas);
  }

  const netList = view.querySelector('#net-list');
  for (const net of match.circuitArr) {
    const nodesText = net.nodes.length > 0 ? net.nodes.map((n) => n.node).join(', ') : '(no board location found for this net)';
    const badge = net.incomplete && !net.interventions
      ? ' <span class="badge warn">unmatched</span>'
      : net.interventions
        ? ' <span class="badge warn">needs added wire</span>'
        : '';
    const row = el(`
      <div class="net-row">
        <strong>${net.net}</strong> — ${nodesText}${badge}
      </div>
    `);
    netList.appendChild(row);
  }

  view.querySelector('#btn-restart').addEventListener('click', () => renderUploadView());
  setView(view);
}

// --- boot ---------------------------------------------------------------------------------------

renderUploadView();
