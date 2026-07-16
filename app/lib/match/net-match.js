// Port of Code/NetMatch.py — extends single-component matches (ComponentMatch.py) into full
// net-level matches: finding a consistent set of component placements/orientations across a
// board such that every node in a schematic net ends up electrically connected via real traces.
//
// `visualize_net_matches` (cv2.imshow debug popups) is intentionally not ported — there is no
// desktop window in a browser; Phase 3's UI is the real replacement for that visualization.
import { genPadMap, connectedPads } from './pcb-board.js';
import { toGray, bitwiseNot, findContours, matFromImageSource } from './cv-helpers.js';
import { ComponentMatching } from './component-match.js';
import { renderFootprint } from '../kicad/renderer.js';

// The wall-clock deadline alone isn't enough to bound findWireInterventions's recursion: once a
// ref's candidates are cache-hits (near-instant), a pathological case — e.g. the board's main
// component having zero real matches, so nothing is pre-assigned and every net's every node needs
// a from-scratch reconnection search — can run through many thousands of recursive attempts
// (each allocating its own matchCpy/ComponentMatching/canvas state) fast enough to exhaust the
// WASM heap well before the deadline ever fires. `budget` counts attempts across the whole
// intervention phase (shared the same way the deadline is, in circuit-matching.js) so it always
// terminates on total exploration size, independent of how fast any single step happens to be.
function consumeBudget(budget) {
  if (!budget) return false;
  budget.attempts++;
  return budget.attempts > budget.maxAttempts;
}

export class NetMatching {
  constructor(nodeArr, net) {
    this.nodes = nodeArr; // [{ref, pin, footprint, 'total pins'}]
    this.net = net; // net name (string)
    this.cmData = {}; // { ref: { pins: [...], matches: [...] } }
  }

  // mirrors process_PCB_png_files, adapted to take already-rendered canvases instead of file
  // paths (kept for API parity with the Python class; CircuitMatch.js will more commonly call
  // initializePcbVars directly with data already built by PCBBoard).
  processPcbImages(maskCanvas, tracesCanvas) {
    const pcbMat = matFromImageSource(tracesCanvas);
    const maskMat = matFromImageSource(maskCanvas);

    const maskGray = toGray(maskMat);
    const invMaskGray = bitwiseNot(maskGray);
    const { contours: maskContours } = findContours(invMaskGray, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    this.padMap = genPadMap(maskContours);

    const traceGray = toGray(pcbMat);
    const { contours: traceContours, hierarchy } = findContours(traceGray, cv.RETR_TREE, cv.CHAIN_APPROX_NONE);

    this.traceMap = connectedPads(this.padMap, traceContours, hierarchy, toGray(bitwiseNot(pcbMat)));
    this.pcbMat = pcbMat;
    this.maskMat = maskMat;
    this.maskContours = maskContours;
    this.traceContours = traceContours;
  }

  // mirrors initialize_pcb_vars
  initializePcbVars(maskMat, maskContours, pcbMat, traceContours, padMap, traceMap) {
    this.maskMat = maskMat;
    this.maskContours = maskContours;
    this.pcbMat = pcbMat;
    this.traceContours = traceContours;
    this.padMap = padMap;
    this.traceMap = traceMap;
  }

  // Shared by run_cm_on_nodes/run_cm_via_traces/run_net_cms_from_cm: builds (and caches) a
  // ComponentMatching instance for a node's footprint, replacing the Python's repeated
  // `kicad-cli fp export svg` + `gen_footprint_PNG` + `initialize_fp_from_file` block with a
  // direct call into app/lib/kicad/renderer.js — no subprocess, no filesystem round-trip.
  buildComponentMatchingFor(node, footprintLookup) {
    const cm = new ComponentMatching();
    cm.pcbBoard = this.pcbBoard;
    const footprint = footprintLookup(node.footprint);
    const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: 48 });
    cm.initializeFootprint(fpCanvas, footprint);
    return cm;
  }

  // mirrors run_cm_on_nodes. `footprintLookup(footprintId) -> parsedFootprint` replaces the
  // Python's `footprints_dir + ":".pretty"` file-path resolution.
  async runCmOnNodes(footprintLookup, { onProgress = null } = {}) {
    for (const node of this.nodes) {
      if (this.cmData[node.ref]) {
        this.cmData[node.ref].pins.push(node.pin);
        continue;
      }
      const cm = this.buildComponentMatchingFor(node, footprintLookup);
      let matches = await cm.getMatches({ onProgress });
      matches = cm.sortMatches(matches);
      matches = cm.addTracesDataToMatches(matches);
      this.cmData[node.ref] = { pins: [node.pin], matches, cm };
    }
  }

  // mirrors run_cm_via_traces
  async runCmViaTraces(footprintLookup, { onProgress = null } = {}) {
    this.nodes.sort((a, b) => b['total pins'] - a['total pins']);
    const startingNode = this.nodes[0];

    const cm = this.buildComponentMatchingFor(startingNode, footprintLookup);
    let matches = await cm.getMatches({ onProgress });
    matches = cm.sortMatches(matches);
    matches = cm.addTracesDataToMatches(matches);

    const ref = startingNode.ref;
    this.cmData[ref] = { pins: [startingNode.pin], matches, cm };

    for (const node of this.nodes.slice(1)) {
      if (node.ref === ref) this.cmData[ref].pins.push(node.pin);
      else break;
    }

    const fMatches = [];
    for (const initCm of this.cmData[ref].matches) {
      const initPin = this.cmData[ref].pins[0];
      const netTraces = initCm.touchedTracesDict[initPin];

      if (this.cmData[ref].pins.length > 1) {
        let connected = true;
        for (const subsPin of this.cmData[ref].pins.slice(1)) {
          const subsTraces = initCm.touchedTracesDict[subsPin] || [];
          if (!subsTraces.some((t) => netTraces.includes(t))) connected = false;
        }
        if (connected) fMatches.push(initCm);
      } else {
        fMatches.push(initCm);
      }
    }
    this.cmData[ref].matches = fMatches;

    const cmPinDict = {};
    for (const node of this.nodes) {
      cmPinDict[node.ref] = cmPinDict[node.ref] ? [...cmPinDict[node.ref], node.pin] : [node.pin];
    }

    const netMatchArray = [];

    for (const initCm of this.cmData[ref].matches) {
      const initPin = this.cmData[ref].pins[0];
      const netTraces = [];
      for (const _iPin of this.cmData[ref].pins) {
        for (const tTrace of initCm.touchedTracesDict[initPin]) netTraces.push(tTrace);
      }

      for (const trace of netTraces) {
        const traceNodeMatchArr = [{ ref, matches: [initCm], pins: cmPinDict[ref] }];
        const touchedRefs = [ref];

        for (const node of this.nodes.slice(this.cmData[ref].pins.length)) {
          if (touchedRefs.includes(node.ref)) continue;

          const footprint = footprintLookup(node.footprint);
          const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: 48 });
          cm.initializeFootprint(fpCanvas, footprint);

          const ignorePads = { frontPads: [], backPads: [] };
          if (initCm.fb === 'front') ignorePads.frontPads = ignorePads.frontPads.concat(initCm.padList);
          else ignorePads.backPads = ignorePads.backPads.concat(initCm.padList);

          const { pinsFullTraceMatches } = await cm.getMatchesOnTrace(trace, cmPinDict[node.ref], ignorePads, { onProgress });
          const sortedMatches = cm.sortMatches(pinsFullTraceMatches);

          if (sortedMatches.length > 0) {
            traceNodeMatchArr.push({ ref: node.ref, matches: sortedMatches, pins: cmPinDict[node.ref] });
          }
          touchedRefs.push(node.ref);
        }
        netMatchArray.push({ traces: [trace], nodeArr: traceNodeMatchArr, net: this.net });
      }
    }

    return netMatchArray;
  }

  // mirrors run_net_cms_from_cm
  async runNetCmsFromCm(footprintLookup, initMatch, ref, { onProgress = null } = {}) {
    this.nodes.sort((a, b) => b['total pins'] - a['total pins']);

    const initPins = this.nodes.filter((n) => n.ref === ref).map((n) => n.pin);
    const initPin = initPins[0];
    if (!(initPin in initMatch.touchedTracesDict)) return [];

    const netTracesCheck = initMatch.touchedTracesDict[initPin];
    if (initPins.length > 1) {
      for (const subsPin of initPins.slice(1)) {
        if (!(subsPin in initMatch.touchedTracesDict)) return [];
        const subsTraces = initMatch.touchedTracesDict[subsPin];
        if (!subsTraces.some((t) => netTracesCheck.includes(t))) return [];
      }
    }

    const cmPinDict = {};
    for (const node of this.nodes) {
      cmPinDict[node.ref] = cmPinDict[node.ref] ? [...cmPinDict[node.ref], node.pin] : [node.pin];
    }

    const netTraces = [];
    for (const iPin of initPins) {
      for (const tTrace of initMatch.touchedTracesDict[iPin]) {
        if (!netTraces.includes(tTrace)) netTraces.push(tTrace);
      }
    }

    const cm = new ComponentMatching();
    cm.pcbBoard = this.pcbBoard;

    const netMatchArray = [];
    const traceNodeMatchArr = [{ ref, matches: [initMatch], pins: cmPinDict[ref] }];
    const touchedRefs = [ref];

    for (const node of this.nodes) {
      if (!touchedRefs.includes(node.ref)) {
        const footprint = footprintLookup(node.footprint);
        const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: 48 });
        cm.initializeFootprint(fpCanvas, footprint);

        const ignorePads = { frontPads: [], backPads: [] };
        if (initMatch.fb === 'front') ignorePads.frontPads = initMatch.padList;
        else ignorePads.backPads = initMatch.padList;

        let matches = [];
        for (const trace of netTraces) {
          const { pinsFullTraceMatches } = await cm.getMatchesOnTrace(trace, cmPinDict[node.ref], ignorePads, { onProgress });
          matches = matches.concat(pinsFullTraceMatches);
        }
        matches = cm.addTracesDataToMatches(matches);
        matches = cm.sortMatches(matches);
        if (matches.length > 0) {
          traceNodeMatchArr.push({ ref: node.ref, matches, pins: cmPinDict[node.ref] });
        }
        touchedRefs.push(node.ref);
      }
      netMatchArray.push({ traces: netTraces, nodeArr: traceNodeMatchArr, net: this.net });
    }

    return netMatchArray;
  }

  // mirrors add_cm_data
  addCmData(fullCmData) {
    for (const node of this.nodes) {
      if (this.cmData[node.ref]) {
        this.cmData[node.ref].pins.push(node.pin);
      } else {
        this.cmData[node.ref] = { pins: [node.pin], matches: fullCmData[node.ref].matches };
      }
    }
  }

  // mirrors search_net_matches
  searchNetMatches() {
    const refList = Object.keys(this.cmData).sort((a, b) => this.cmData[a].matches.length - this.cmData[b].matches.length);
    const netMatches = [];

    const component = this.cmData[refList[0]];
    const pin = component.pins[0];

    for (const match of component.matches) {
      const pIDs = match.padIDs[pin];

      for (const pID of pIDs) {
        for (const [trace, tracePads] of Object.entries(this.traceMap)) {
          if (!tracePads.includes(pID)) continue;

          const nodesInfo = [{ node: `${refList[0]}-${pin}`, match, pads: pIDs }];

          if (component.pins.length > 1) {
            let subPinsConnected = true;
            for (const subsequentPin of component.pins.slice(1)) {
              const subPIDs = match.padIDs[subsequentPin];
              let connectionPresent = false;
              for (const subPID of subPIDs) {
                if (tracePads.includes(subPID)) {
                  connectionPresent = true;
                  nodesInfo.push({ node: `${refList[0]}-${subsequentPin}`, match, pads: subPIDs });
                }
              }
              if (!connectionPresent) {
                subPinsConnected = false;
                break;
              }
            }
            if (!subPinsConnected) continue;
          }

          let refsConnected = true;
          const subRefMatchArr = [];

          for (const subsequentRef of refList.slice(1)) {
            const subsequentComponent = this.cmData[subsequentRef];
            const subCompPins = subsequentComponent.pins;

            let matchForRefFound = false;
            const refMatchArr = [];

            for (const scMatch of subsequentComponent.matches) {
              let scPinsConnected = true;
              const pinsInfo = [];
              for (const subCompPin of subCompPins) {
                const scspIDs = scMatch.padIDs[subCompPin];
                let pinConnection = false;
                for (const scspID of scspIDs) {
                  if (tracePads.includes(scspID)) {
                    pinConnection = true;
                    pinsInfo.push({ node: `${subsequentRef}-${subCompPin}`, match: scMatch, pads: scspIDs });
                  }
                }
                if (!pinConnection) {
                  scPinsConnected = false;
                  break;
                }
              }
              if (scPinsConnected) {
                for (const iPin of pinsInfo) refMatchArr.push(iPin);
                matchForRefFound = true;
              }
            }

            if (!matchForRefFound) {
              refsConnected = false;
              break;
            }
            subRefMatchArr.push(refMatchArr);
          }

          if (refsConnected) {
            const nodesArray = nodesInfo.map((n) => [n]);
            for (const refMatch of subRefMatchArr) nodesArray.push(refMatch);
            netMatches.push({ trace, net: this.net, nodesArray });
          }
        }
      }
    }
    return netMatches;
  }

  // mirrors process_matches: cartesian product of each node's candidate matches, one combination
  // per output entry (odometer-style index increment, same as the Python's `indices` loop).
  processMatches(netMatches) {
    const nMatches = [];
    for (const nMatch of netMatches) {
      const nRefs = nMatch.nodesArray.length;
      const trace = nMatch.trace;
      const indices = new Array(nRefs).fill(0);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const nodesArr = indices.map((idx, i) => nMatch.nodesArray[i][idx]);
        nMatches.push({ trace, nodes: nodesArr, net: nMatch.net });

        let next = nRefs - 1;
        while (next >= 0 && indices[next] + 1 >= nMatch.nodesArray[next].length) next--;
        if (next < 0) break;
        indices[next]++;
        for (let i = next + 1; i < nRefs; i++) indices[i] = 0;
      }
    }
    return nMatches;
  }

  // mirrors process_trace_matches
  processTraceMatches(netMatches) {
    const nMatches = [];
    for (const nMatch of netMatches) {
      const nRefs = nMatch.nodeArr.length;
      const traces = nMatch.traces;
      const indices = new Array(nRefs).fill(0);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const nodesArr = [];
        for (let i = 0; i < nRefs; i++) {
          const entry = nMatch.nodeArr[i];
          const nodeMatch = entry.matches[indices[i]];
          for (const pin of entry.pins) {
            nodesArr.push({ node: `${entry.ref}-${pin}`, match: nodeMatch, pads: nodeMatch.padIDs[pin] });
          }
        }
        nMatches.push({ traces, nodes: nodesArr, net: nMatch.net });

        let next = nRefs - 1;
        while (next >= 0 && indices[next] + 1 >= nMatch.nodeArr[next].matches.length) next--;
        if (next < 0) break;
        indices[next]++;
        for (let i = next + 1; i < nRefs; i++) indices[i] = 0;
      }
    }
    return nMatches;
  }

  // mirrors get_complete_matches
  getCompleteMatches(matches, numNodes) {
    return matches.filter((m) => m.nodes.length === numNodes);
  }

  // mirrors identify_duplicate_match
  identifyDuplicateMatch(netMatch1, netMatch2) {
    if (JSON.stringify(netMatch1.traces) !== JSON.stringify(netMatch2.traces)) return false;
    if (netMatch1.nodes.length !== netMatch2.nodes.length) return false;

    for (const nm1Node of netMatch1.nodes) {
      let nodeNotPresent = true;
      for (const nm2Node of netMatch2.nodes) {
        if (nm1Node.node === nm2Node.node) {
          nodeNotPresent = false;
          if (JSON.stringify(nm1Node.match.padIDs) !== JSON.stringify(nm2Node.match.padIDs)) return false;
          if (JSON.stringify(nm1Node.pads) !== JSON.stringify(nm2Node.pads)) return false;
        }
      }
      if (nodeNotPresent) return false;
    }
    return true;
  }

  // mirrors filter_matches
  filterMatches(netMatches) {
    const filteredMatches = [];
    for (const nMatch of netMatches) {
      if (filteredMatches.some((fMatch) => this.identifyDuplicateMatch(fMatch, nMatch))) continue;

      const cmDict = {};
      const padsTouched = [];
      let badMatch = false;

      for (const node of nMatch.nodes) {
        const ref = node.node.split('-')[0];
        if (cmDict[ref]) {
          if (node.match !== cmDict[ref]) return false; // mirrors Python's early `return False` here verbatim
        } else {
          for (const padArr of Object.values(node.match.padIDs)) {
            for (const pad of padArr) {
              if (padsTouched.includes(pad)) badMatch = true;
              else padsTouched.push(pad);
            }
          }
          cmDict[ref] = node.match;
        }
      }
      if (!badMatch) filteredMatches.push(nMatch);
    }
    return filteredMatches;
  }

  // Shared by all four branches of find_wire_interventions below (list/dict intervention
  // storage x 'cmpnt matches'/'cmpnt match' singular-vs-plural) — the Python repeats this same
  // "try reconnecting the earlier missing node's candidate match(es) through one of its touched
  // traces, then recurse" block four times with only the storage shape differing. Consolidating
  // it removes ~150 lines of copy-paste without changing the search behavior.
  async _tryReconnectViaCandidate(mCm, mPin, mMissingNode, pin, missingNode, cm, match, missingNodeIDs, setIntervention, netMatches, footprintLookup, deadline, getCandidates, budget) {
    const mTouchedTraces = mCm.touchedTracesDict[mPin] || [];
    const [ref] = missingNode.split('-');
    const excludePads = new Set(mCm.padIDs[mPin] || []);
    // Cache-reuse mirrors the fix in findWireInterventions's fallback below: this loop used to call
    // an uncached cm.getMatchesOnTrace (a fresh correlation search) once per candidate reconnection
    // per touched trace — with a dozen+ candidates each touching several traces, that's dozens of
    // full CV searches for what's really just a filter over `ref`'s already-known candidate list.
    const allMatches = getCandidates ? await getCandidates(ref) : null;

    for (const mTouchedTrace of mTouchedTraces) {
      if (performance.now() > deadline || consumeBudget(budget)) return;
      if (this.pcbBoard.getNumPadsOnTraces([mTouchedTrace]) <= 1) continue;

      let mMatches;
      if (allMatches) {
        mMatches = allMatches.filter((m) => {
          const pinTraces = m.touchedTracesDict[pin] || [];
          if (!pinTraces.includes(mTouchedTrace)) return false;
          if (m.fb === 'front' && (m.padIDs[pin] || []).some((p) => excludePads.has(p))) return false;
          return true;
        });
      } else {
        const { pinsFullTraceMatches: mMatchesRaw } = await cm.getMatchesOnTrace(
          mTouchedTrace,
          [pin],
          { frontPads: mCm.padIDs[mPin] || [], backPads: [] },
          { deadline }
        );
        mMatches = cm.sortMatches(mMatchesRaw);
        mMatches = cm.addTracesDataToMatches(mMatches);
      }
      if (mMatches.length === 0) continue;

      for (const mMatch of mMatches) {
        if (performance.now() > deadline || consumeBudget(budget)) return;

        const matchCpy = { ...match, nodes: [...match.nodes] };
        setIntervention(matchCpy, { addWire: { missingNode: mMissingNode, cmpntMatch: mCm } });
        matchCpy.nodes.push({ node: missingNode, match: mMatch, pads: mMatch.padIDs[pin] });

        let missingNodeIDsCpy = missingNodeIDs.filter((id) => id !== mMissingNode && id !== missingNode);

        if (missingNodeIDsCpy.length === 0) {
          netMatches.push(matchCpy);
        }

        const completedMMatches = await this.findWireInterventions(matchCpy, missingNodeIDsCpy, footprintLookup, mTouchedTraces, deadline, getCandidates, budget);
        if (completedMMatches.length > 0) netMatches.push(...completedMMatches);
      }
    }
  }

  // mirrors find_wire_interventions: recursively searches for ways to complete a partial net
  // match — either by finding an unmatched node's component on a trace already in the match, or
  // by chaining through a candidate "add wire" intervention already proposed for another missing
  // node. `footprintLookup(footprintId) -> parsedFootprint` replaces the Python's file-path
  // resolution + `kicad-cli fp export svg` rendering.
  // `getCandidates`, if provided, is an async (ref) => ComponentMatch[] that returns a ref's
  // already-computed full candidate list (e.g. CircuitMatching's `_matchesForRef`, which caches)
  // — letting the expensive fallback below reuse it via a plain local filter instead of
  // re-scanning every trace on the board with its own fresh correlation search.
  // `budget`, if provided, caps total recursive attempts across the whole call tree (see
  // consumeBudget above) — a second, attempt-count-based bound alongside the wall-clock deadline.
  async findWireInterventions(match, missingNodeIDs, footprintLookup, ignoreTraces = [], deadline = Infinity, getCandidates = null, budget = null) {
    if (missingNodeIDs.length === 0) return [];
    if (performance.now() > deadline || consumeBudget(budget)) return [];

    const existingRefs = [];
    const existingRefsDict = {};
    const netMatches = [];
    const ignorePads = { frontPads: [], backPads: [] };

    for (const matchNode of match.nodes) {
      const [mRef, mPin] = matchNode.node.split('-');
      if (matchNode.match.fb === 'front') ignorePads.frontPads = ignorePads.frontPads.concat(matchNode.match.padIDs[mPin]);
      else ignorePads.backPads = ignorePads.backPads.concat(matchNode.match.padIDs[mPin]);

      if (!existingRefs.includes(mRef)) {
        existingRefs.push(mRef);
        existingRefsDict[mRef] = existingRefsDict[mRef] ? [...existingRefsDict[mRef], matchNode.node] : [matchNode.node];
      }
    }

    const numPadsOnTrace = this.pcbBoard.getNumPadsOnTraces(match.traces);

    if (numPadsOnTrace > match.nodes.length) {
      // other nodes might already be satisfiable on the current trace(s)
      for (const missingNode of missingNodeIDs) {
        if (performance.now() > deadline || consumeBudget(budget)) break;
        const [ref, pin] = missingNode.split('-');
        const node = this.nodes.find((n) => n.ref === ref);
        if (!node) continue;

        if (existingRefs.includes(ref)) {
          match.incomplete = true;
          const wireIntervention = { addWire: [missingNode, ...existingRefsDict[ref]] };
          match.interventions = match.interventions ? [...match.interventions, wireIntervention] : [wireIntervention];
        } else {
          // The board may simply not have this footprint anywhere — normal for a salvaged
          // board, not an error. Skip this missing node rather than aborting the whole search.
          let footprint;
          try {
            footprint = footprintLookup(node.footprint);
          } catch {
            continue;
          }

          const cm = new ComponentMatching();
          cm.pcbBoard = this.pcbBoard;
          const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: 48 });
          cm.initializeFootprint(fpCanvas, footprint);

          let matches = [];
          for (const mTrace of match.traces) {
            if (performance.now() > deadline) break;
            const { pinsFullTraceMatches } = await cm.getMatchesOnTrace(mTrace, [pin], ignorePads, { deadline });
            matches = matches.concat(pinsFullTraceMatches);
          }
          matches = cm.sortMatches(matches);
          matches = cm.addTracesDataToMatches(matches);

          for (const cmMatch of matches) {
            if (performance.now() > deadline || consumeBudget(budget)) break;

            const nodeDict = { node: missingNode, match: cmMatch, pads: cmMatch.padIDs[pin] };
            const matchCpy = { ...match, nodes: [...match.nodes, nodeDict] };
            const missingNodeIDsCpy = missingNodeIDs.filter((id) => id !== missingNode);

            const nMatches = await this.findWireInterventions(matchCpy, missingNodeIDsCpy, footprintLookup, [], deadline, getCandidates, budget);
            if (nMatches.length > 0) netMatches.push(...nMatches);
          }
          cm.delete();
        }
      }
    } else {
      for (const missingNode of missingNodeIDs) {
        if (performance.now() > deadline) break;
        const [ref, pin] = missingNode.split('-');
        const node = this.nodes.find((n) => n.ref === ref);
        // As above: a missing board footprint is expected, not fatal — treat it as "no
        // footprint available" (null) rather than letting the lookup throw.
        let footprint = null;
        if (node) {
          try {
            footprint = footprintLookup(node.footprint);
          } catch {
            footprint = null;
          }
        }

        if (existingRefs.includes(ref)) {
          match.incomplete = true;
          const wireIntervention = { addWire: [missingNode, ...existingRefsDict[ref]] };
          match.interventions = match.interventions ? [...match.interventions, wireIntervention] : [wireIntervention];
        } else {
          let matchViaIntervention = false;

          if (match.interventions && footprint) {
            const cm = new ComponentMatching();
            cm.pcbBoard = this.pcbBoard;
            const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: 48 });
            cm.initializeFootprint(fpCanvas, footprint);

            const interventionsList = Array.isArray(match.interventions) ? match.interventions : [match.interventions];

            for (let intIndex = 0; intIndex < interventionsList.length; intIndex++) {
              const intervention = interventionsList[intIndex];
              if (!intervention.addWire) continue;

              const addWire = intervention.addWire;
              if (Array.isArray(addWire)) continue; // plain [missingNode, ...refs] form — nothing to chain through

              const mMissingNode = addWire.missingNode;
              const [, mPin] = mMissingNode.split('-');
              const candidateCms = addWire.cmpntMatches || (addWire.cmpntMatch ? [addWire.cmpntMatch] : []);

              const localMatches = [];
              const setIntervention = Array.isArray(match.interventions)
                ? (m, val) => {
                    m.interventions = [...m.interventions];
                    m.interventions[intIndex] = val;
                  }
                : (m, val) => {
                    m.interventions = val;
                  };

              for (const mCm of candidateCms) {
                if (performance.now() > deadline || consumeBudget(budget)) break;
                await this._tryReconnectViaCandidate(mCm, mPin, mMissingNode, pin, missingNode, cm, match, missingNodeIDs, setIntervention, localMatches, footprintLookup, deadline, getCandidates, budget);
              }
              if (localMatches.length > 0) {
                matchViaIntervention = true;
                netMatches.push(...localMatches);
              }
            }
            cm.delete();
          }

          if (!matchViaIntervention && footprint) {
            let touchedTraces = [...match.traces, ...ignoreTraces];
            for (const matchNode of match.nodes) touchedTraces = touchedTraces.concat(matchNode.match.touchedTracesList);

            let cmMatches = [];
            // getCandidates (when provided) is this ref's already-computed full candidate list —
            // e.g. CircuitMatching's own _matchesForRef cache — so filtering it locally (pure JS,
            // no CV calls) replaces re-scanning every trace on the board with its own fresh
            // correlation search, previously the single most expensive part of this fallback.
            if (getCandidates) {
              const allMatches = await getCandidates(ref);
              cmMatches = allMatches.filter((m) => {
                const pinTraces = m.touchedTracesDict[pin] || [];
                return pinTraces.some((t) => !touchedTraces.includes(t));
              });
            } else {
              const cm = new ComponentMatching();
              cm.pcbBoard = this.pcbBoard;
              const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: 48 });
              cm.initializeFootprint(fpCanvas, footprint);

              for (const [traceID, _traceInfo] of Object.entries(this.pcbBoard.boardConnectionsDict)) {
                if (performance.now() > deadline) break;
                const id = Number(traceID);
                if (touchedTraces.includes(id)) continue;
                if (this.pcbBoard.getNumPadsOnTraces([id]) < 1) continue;

                const { pinsFullTraceMatches } = await cm.getMatchesOnTrace(id, [pin], undefined, { deadline });
                let matches = cm.sortMatches(pinsFullTraceMatches);
                matches = cm.addTracesDataToMatches(matches);
                cmMatches = cmMatches.concat(matches);
              }
              cm.delete();
            }

            if (cmMatches.length > 0) {
              match.incomplete = true;
              const wireIntervention = { addWire: { missingNode, cmpntMatches: cmMatches } };
              match.interventions = match.interventions ? [...match.interventions, wireIntervention] : [wireIntervention];
            }
          }
        }
      }
      netMatches.push(match);
    }

    return netMatches;
  }
}
