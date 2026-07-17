// ProtoPCB web app controller — replaces Code/gui.py's Tkinter shell. This file is purely the
// view layer: render a screen, wire up its events, move to the next screen. The matching pipeline
// (parsing, rendering, opencv.js) runs entirely inside worker.js — the main thread never loads
// opencv.js, and background-tab timer throttling can't stretch a running search.
import { parseSchematic, getOrderedComponentsList } from './lib/kicad/schematic.js';

const root = document.getElementById('view-root');

const session = {
  pcbText: null,
  pcbFileName: '',
  schText: null,
  schFileName: '',
  drlText: null,
  drlFileName: '',
  // Doubles on every "Search longer" click; the worker keeps its candidate caches between runs
  // of the same files, so each re-run continues where the previous one was cut off.
  circuitBudgetMs: 240000,
};

// --- worker client -----------------------------------------------------------------------------

let worker = null;
let nextRequestId = 1;

function getWorker() {
  if (!worker) worker = new Worker('worker.js', { type: 'module' });
  return worker;
}

// One in-flight request at a time is all the UI can start (every flow replaces the screen), so a
// plain per-request listener keyed on id is enough — no queue needed.
function runInWorker(type, payload, { onStatus, onProgress } = {}) {
  const id = nextRequestId++;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === 'status') onStatus && onStatus(msg.text);
      else if (msg.type === 'progress') onProgress && onProgress(msg.p);
      else if (msg.type === 'result') {
        w.removeEventListener('message', onMessage);
        resolve(msg);
      } else if (msg.type === 'error') {
        w.removeEventListener('message', onMessage);
        reject(new Error(msg.message));
      }
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, type, ...payload });
  });
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function setView(node) {
  root.replaceChildren(node);
}

function bitmapToCanvas(bitmap, className = '') {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  if (className) canvas.className = className;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
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

function renderErrorView(err) {
  console.error(err);
  const view = el(`
    <section>
      <h1>Something went wrong</h1>
      <div class="error-box"></div>
      <div class="actions"><button class="secondary" id="btn-restart">Start over</button></div>
    </section>
  `);
  view.querySelector('.error-box').textContent = (err && err.message) || String(err);
  view.querySelector('#btn-restart').addEventListener('click', () => renderUploadView());
  setView(view);
}

// --- Screen 3a: component selector (mirrors gui.py's ComponentSelectorPage) --------------------

function runComponentSelectorFlow() {
  try {
    // Pure text parsing — fast enough to stay on the main thread.
    const schematic = parseSchematic(session.schText);
    const { refArrSorted } = getOrderedComponentsList(schematic);

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
    const loading = renderLoadingView(`Matching ${ref}…`);
    const { data, images } = await runInWorker(
      'componentMatch',
      { pcbText: session.pcbText, drlText: session.drlText, ref, footprintId },
      { onStatus: (t) => loading.setStatus(t), onProgress: (p) => loading.onProgress(p) },
    );
    renderComponentResultView(data, images);
  } catch (err) {
    renderErrorView(err);
  }
}

function renderComponentResultView(data, images) {
  const { ref, footprintId, unavailable, matchCount, best } = data;
  const view = el(`
    <section>
      <h1>Matches for ${ref}</h1>
      <p class="subtitle">${unavailable ? '' : `${matchCount} candidate location${matchCount === 1 ? '' : 's'} found on the board.`}</p>
      <div class="board-view" id="board-view"></div>
      <div class="result-meta" id="match-meta"></div>
      <div class="actions"><button class="secondary" id="btn-restart">Start over</button></div>
    </section>
  `);

  const boardView = view.querySelector('#board-view');
  const tracesCanvas = bitmapToCanvas(images.traces);
  tracesCanvas.style.maxWidth = '100%';
  boardView.appendChild(tracesCanvas);

  const meta = view.querySelector('#match-meta');
  if (unavailable) {
    meta.innerHTML = `<span class="badge warn">Footprint not available</span> The uploaded board has no "${footprintId.split(':').pop()}" footprint anywhere on it, so there's nothing to search for. This tool can currently only match footprints that already exist somewhere on the board — try a different component, or a board more likely to include this part.`;
  } else if (matchCount === 0) {
    meta.innerHTML = '<span class="badge warn">No match found</span> Try a different component or double-check the uploaded board.';
  } else {
    meta.innerHTML = `<span class="badge ok">Best match</span> score ${(best.score * 100).toFixed(1)}% · orientation ${best.orientation}&deg; · side ${best.fb} · at (${best.coordinates.x}, ${best.coordinates.y})`;
    if (images.overlay) boardView.appendChild(bitmapToCanvas(images.overlay, 'overlay'));
  }

  view.querySelector('#btn-restart').addEventListener('click', () => renderUploadView());
  setView(view);
}

// --- Screen 3b: circuit match (mirrors gui.py's runCircuitAnalysis -> VidCircuitDraft) ---------

async function runCircuitMatchFlow({ searchLonger = false } = {}) {
  try {
    if (searchLonger) session.circuitBudgetMs *= 2;
    else session.circuitBudgetMs = 240000;
    const loading = renderLoadingView(searchLonger ? 'Searching further…' : 'Running circuit match…');
    const { data, images } = await runInWorker(
      'circuitMatch',
      { pcbText: session.pcbText, schText: session.schText, drlText: session.drlText, searchBudgetMs: session.circuitBudgetMs },
      { onStatus: (t) => loading.setStatus(t), onProgress: (p) => loading.onProgress(p) },
    );
    renderCircuitResultView(data, images);
  } catch (err) {
    renderErrorView(err);
  }
}

function renderCircuitResultView(data, images) {
  const { totalNets, satisfiedNets, netsNeedingIntervention, unmatchableComponents, incompleteComponents, searchTimedOut, compatibilityPercent } = data.compatibility;
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
      <div class="actions" id="result-actions"><button class="secondary" id="btn-restart">Start over</button></div>
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
  const searchIncomplete = incompleteComponents.length > 0 || searchTimedOut;
  if (incompleteComponents.length > 0) {
    view.querySelector('#incomplete').innerHTML =
      `<div class="result-meta"><span class="badge warn">Search incomplete</span> ran out of time before finishing the search for: ${incompleteComponents.join(', ')}. ` +
      `The percentage above may understate real compatibility — use "Search longer" below to continue (results so far are kept).</div>`;
  } else if (searchTimedOut) {
    view.querySelector('#incomplete').innerHTML =
      `<div class="result-meta"><span class="badge warn">Search incomplete</span> the search ran out of time before checking every possibility. The percentage above may understate real compatibility — use "Search longer" below to continue.</div>`;
  }

  if (unmatchableComponents.length > 0) {
    const list = unmatchableComponents.map((c) => `${c.ref} (${c.footprintId.split(':').pop()})`).join(', ');
    view.querySelector('#unmatchable').innerHTML =
      `<div class="result-meta"><span class="badge warn">Missing footprints</span> the board has no matching footprint for: ${list}.</div>`;
  }

  const boardView = view.querySelector('#board-view');
  const tracesCanvas = bitmapToCanvas(images.traces);
  tracesCanvas.style.maxWidth = '100%';
  boardView.appendChild(tracesCanvas);
  if (images.overlay) boardView.appendChild(bitmapToCanvas(images.overlay, 'overlay'));

  const netList = view.querySelector('#net-list');
  for (const net of data.nets) {
    const nodesText = net.nodes.length > 0 ? net.nodes.join(', ') : '(no board location found for this net)';
    const badge = net.incomplete && !net.hasInterventions
      ? ' <span class="badge warn">unmatched</span>'
      : net.hasInterventions
        ? ' <span class="badge warn">needs added wire</span>'
        : '';
    const row = el(`
      <div class="net-row">
        <strong>${net.net}</strong> — ${nodesText}${badge}
      </div>
    `);
    netList.appendChild(row);
  }

  if (searchIncomplete) {
    const btnLonger = el('<button class="primary" id="btn-search-longer">Search longer</button>');
    btnLonger.addEventListener('click', () => runCircuitMatchFlow({ searchLonger: true }));
    view.querySelector('#result-actions').prepend(btnLonger);
  }

  view.querySelector('#btn-restart').addEventListener('click', () => renderUploadView());
  setView(view);
}

// --- boot ---------------------------------------------------------------------------------------

renderUploadView();
