// Port of Code/CircuitMatch.py's CircuitMatching class.
//
// The search algorithm (get_matches_fifo / get_next_match_fifo / get_next_net_fifo /
// get_mwi_fifo2 / find_wire_interventions / recursive_search_from_match, ~2,800 lines combined)
// is NOT a line-for-line port. That code is a resumable backtracking search that saves its own
// call stack (`last_loc`) so a later call can rewind and try the next-best alternative, mutually
// recursive across this file and net-match.js. Per discussion, it's replaced here with a plain
// recursive backtracking search (findCircuitMatch) that reaches the same end result — a
// CircuitMatch assigning every net's components consistently, falling back to wire-intervention
// completion via NetMatching.findWireInterventions when no perfect assignment exists — without
// replicating the exact save/resume mechanics. "Find the next-best match" can still be supported
// later by re-running the search with previously-returned combinations excluded.
//
// file-persistence (fill_cm_data/generate_components_file/load_component_matches_from_file/
// save_matches/load_matches), run_cm_via_traces(_queue), get_mwi_fifo/get_mwi_fifo_all,
// get_matches_with_interventions, find_circuit_matches, and visualize_matches are not ported —
// confirmed via gui.py's actual call sites to be dead/superseded/desktop-only code.
import { CircuitMatch } from './circuit-match.js';
import { ComponentMatching } from './component-match.js';
import { NetMatching } from './net-match.js';
import { renderFootprint } from '../kicad/renderer.js';
import { newTransparentCanvasMat, fillContourAt, drawContourAtOffset } from './cv-helpers.js';

export class CircuitMatching {
  constructor(sortedRefs, footprintsDict, netArr) {
    this.sortedRefs = sortedRefs;
    this.footprintsDict = footprintsDict; // { footprintId: [ref, ...] }
    this.netArr = netArr; // [{ name, 'node arr': [{ref, pin, footprint, 'total pins'}] }]
    this.cmData = {};
    this.cmDict = {}; // ref -> sorted/traced ComponentMatch[]
    this.unmatchableRefs = new Map(); // ref -> { footprintId, reason } for refs with no board footprint
    this.incompleteRefs = new Set(); // refs whose candidate search was cut short by the deadline (not confirmed absent)
    this.currentBestMatch = null;
    this.finished = false;
  }

  refFootprintId(ref) {
    for (const [fp, refs] of Object.entries(this.footprintsDict)) {
      if (refs.includes(ref)) return fp;
    }
    return null;
  }

  _freeCandidatesForRef(ref) {
    for (const match of this.cmDict[ref] || []) {
      if (match.fpContours) for (const c of match.fpContours) c.delete();
    }
    delete this.cmDict[ref];
    delete this.cmData[ref];
  }

  // Forgets cached candidate lists for refs whose search was cut short by an earlier deadline, so
  // a follow-up run with a fresh budget genuinely re-searches them instead of trusting the
  // truncated list — this is what makes "try again to search further" mean something. Refs whose
  // search completed keep their cache (re-searching those would find the same answer slower).
  invalidateIncompleteRefs() {
    for (const ref of this.incompleteRefs) this._freeCandidatesForRef(ref);
    this.incompleteRefs.clear();
  }

  // Frees every cached candidate's Mats — required when discarding this instance, since the
  // worker owning it is long-lived and WASM heap memory doesn't get garbage-collected.
  dispose() {
    for (const ref of Object.keys(this.cmDict)) this._freeCandidatesForRef(ref);
  }

  // Builds (and caches) the candidate ComponentMatch list for one ref, mirroring the repeated
  // cm_dict-cache-then-ComponentMatching.get_matches() pattern used throughout get_matches_fifo.
  //
  // A board only rarely has every footprint a schematic needs — that's the normal case for this
  // tool (reusing salvaged e-waste), not an error condition. Rather than let a missing footprint
  // template throw and abort the whole search, this records the ref as "unmatchable" and returns
  // no candidates for it, so the search still finds the best match achievable with what the board
  // actually has, and the result can report which components/nets couldn't be covered.
  async _matchesForRef(ref, footprintLookup, onProgress, deadline = Infinity) {
    if (this.cmDict[ref]) return this.cmDict[ref];
    if (this.unmatchableRefs.has(ref)) return [];

    const footprintId = this.refFootprintId(ref);
    let footprint;
    try {
      footprint = footprintLookup(footprintId);
    } catch (err) {
      this.unmatchableRefs.set(ref, { footprintId, reason: err.message });
      this.cmDict[ref] = [];
      return [];
    }

    const cm = new ComponentMatching();
    cm.pcbBoard = this.pcbBoard;
    const fpCanvas = renderFootprint(footprint, 'F.Cu', { pxPerMm: 48 });
    cm.initializeFootprint(fpCanvas, footprint);

    // Not cached under a "ran out of time" flag — a cut-short search's candidates are genuinely
    // incomplete, but re-searching for them later wouldn't be cheaper, so the existing cache
    // behavior (reuse whatever was found) applies here the same as a completed search.
    let matches = await cm.getMatches({ onProgress, deadline });
    if (matches.ranOutOfTime) this.incompleteRefs.add(ref);
    matches = cm.sortMatches(matches);
    matches = cm.addTracesDataToMatches(matches);
    this.cmDict[ref] = matches;
    this.cmData[ref] = { matches };
    // cm itself is never referenced again (matches/its derived data are what callers use) — this
    // ref's own template Mats would otherwise stay allocated for the whole CircuitMatching
    // instance's lifetime, and getCandidates (net-match.js's wire-intervention search) can call
    // this for many refs across a single search, so leaving them unfreed adds up fast.
    cm.delete();
    return matches;
  }

  // Does every fully-assigned net (all its refs present in `assignment`) actually connect —
  // i.e. is there a trace shared by all of the net's node pins under this ref->match assignment?
  _netSatisfied(net, assignment) {
    let commonTraces = null;
    for (const node of net['node arr']) {
      const match = assignment[node.ref];
      if (!match) return null; // not fully assigned yet — can't judge this net
      const traces = match.touchedTracesDict[node.pin] || [];
      commonTraces = commonTraces === null ? traces : commonTraces.filter((t) => traces.includes(t));
      if (commonTraces.length === 0) return false;
    }
    return commonTraces.length > 0;
  }

  // mirrors the net/pad conflict checks scattered through get_matches_fifo/filter_matches: no two
  // refs in the assignment may claim the same physical pad.
  _padsConflict(assignment) {
    const touched = { front: new Set(), back: new Set() };
    for (const match of Object.values(assignment)) {
      const bucket = match.fb === 'front' ? touched.front : touched.back;
      for (const pad of match.padList) {
        if (bucket.has(pad)) return true;
        bucket.add(pad);
      }
    }
    return false;
  }

  // The simplified equivalent of get_matches_fifo + get_next_match_fifo + get_next_net_fifo:
  // plain backtracking search over sortedRefs (most-constrained component first, same heuristic
  // as the original), pruning on net-connectivity/pad-conflict as soon as a net is fully assigned.
  // Falls back to wire-intervention completion (via NetMatching, ported in net-match.js) on the
  // best partial assignment found if no perfect assignment exists.
  //
  // Bounded by a wall-clock budget (default 4 min): with several components each having many
  // candidate positions, naive backtracking branches combinatorially and can take far longer than
  // any reasonable wait — this guarantees the search always terminates and reports its best
  // finding, rather than running indefinitely (observed as "never finishes loading" in practice).
  // 90s was tried first and was too tight: the correlation scan for a single busy component (e.g.
  // an 8-pad SOIC across 8 orientations) can alone take well over a minute, so a short budget cut
  // the search off before it ever got candidates for the very first component — which, combined
  // with the missing incompleteRefs signal below, showed up as a false "0% compatible" for a board
  // that was never actually fully checked.
  async findCircuitMatch(footprintLookup, { onProgress = null, searchBudgetMs = 240000 } = {}) {
    this.currentBestMatch = null;
    let bestAssignment = {};
    let bestSatisfiedCount = -1;
    const deadline = performance.now() + searchBudgetMs;
    let timedOut = false;

    const trackBest = (assignment) => {
      const satisfied = this.netArr.filter((n) => this._netSatisfied(n, assignment) === true).length;
      if (satisfied > bestSatisfiedCount) {
        bestSatisfiedCount = satisfied;
        bestAssignment = { ...assignment };
        this.currentBestMatch = { match: this._buildPartialCircuitMatch(bestAssignment), missingNets: this.netArr.length - satisfied };
      }
    };

    const search = async (i, assignment) => {
      if (performance.now() > deadline) {
        timedOut = true;
        return null;
      }
      if (i === this.sortedRefs.length) return { ...assignment };

      const ref = this.sortedRefs[i];
      const candidates = await this._matchesForRef(ref, footprintLookup, onProgress, deadline);

      for (const candidate of candidates) {
        if (performance.now() > deadline) {
          timedOut = true;
          return null;
        }

        const next = { ...assignment, [ref]: candidate };
        if (this._padsConflict(next)) continue;

        let prunedByNet = false;
        for (const net of this.netArr) {
          const result = this._netSatisfied(net, next);
          if (result === false) {
            prunedByNet = true;
            break;
          }
        }
        if (prunedByNet) continue;

        trackBest(next);
        const result = await search(i + 1, next);
        if (result) return result;
        if (timedOut) return null;
      }
      return null;
    };

    const fullAssignment = await search(0, {});
    if (fullAssignment) {
      this.finished = true;
      const match = this._buildCircuitMatch(fullAssignment);
      match.compatibility = this._buildCompatibilitySummary(match.circuitArr);
      match.compatibility.searchTimedOut = false;
      return match;
    }

    // no perfect assignment (or the search ran out of time) — try completing the best partial
    // assignment found so far via wire interventions, itself under the remaining time budget.
    const remainingBudget = Math.max(0, deadline - performance.now());
    const match = await this._completeViaInterventions(bestAssignment, footprintLookup, onProgress, remainingBudget);
    match.compatibility = this._buildCompatibilitySummary(match.circuitArr);
    // this.incompleteRefs covers the case candidates.length===0 due to a cut-short scan, which the
    // backtracking loop's own `timedOut` flag never sees (its deadline checks only fire once a
    // candidate list is non-empty and being iterated) — without this, a component whose search was
    // simply never finished reads identically to "confirmed absent from the board".
    match.compatibility.searchTimedOut = timedOut || this.incompleteRefs.size > 0;
    return match;
  }

  // Summarizes how well the board covers the schematic — the tool's normal outcome is partial
  // coverage (a salvaged board rarely has every needed part), so this is reported as useful
  // information rather than treated as a failure.
  //
  // A net only counts as "satisfied" if it actually has every node it needs, no interventions,
  // and isn't flagged incomplete — `_completeViaInterventions`'s fallback for a net with zero
  // possible completions carries `incomplete: true` but no `interventions` and possibly zero
  // nodes, so checking `!net.interventions` alone would wrongly count a totally-unmatched net
  // as satisfied (caught by testing against a schematic the board shares no footprints with).
  _buildCompatibilitySummary(circuitArr) {
    const expectedNodeCount = new Map(this.netArr.map((n) => [n.name, n['node arr'].length]));
    const totalNets = this.netArr.length;

    const isSatisfied = (net) => !net.incomplete && !net.interventions && net.nodes.length === (expectedNodeCount.get(net.net) ?? 0);

    const satisfiedNets = circuitArr.filter(isSatisfied).length;
    const netsNeedingIntervention = circuitArr.filter((net) => !isSatisfied(net) && net.interventions).length;
    const unmatchableComponents = [...this.unmatchableRefs.entries()].map(([ref, info]) => ({ ref, ...info }));
    const incompleteComponents = [...this.incompleteRefs];
    return {
      totalNets,
      satisfiedNets,
      netsNeedingIntervention,
      incompleteComponents,
      unmatchableComponents,
      compatibilityPercent: totalNets > 0 ? Math.round((satisfiedNets / totalNets) * 100) : 0,
    };
  }

  // requires every net's refs to already be present in `assignment` (only ever called with a
  // full assignment, from findCircuitMatch's success path).
  _buildCircuitMatch(assignment) {
    const circuitArr = this.netArr.map((net) => this._buildNetEntry(net, assignment));
    return new CircuitMatch(circuitArr);
  }

  // partial variant used by trackBest's "current best match so far" preview: only includes nets
  // whose refs are *all* already assigned, skipping the rest rather than crashing on them.
  _buildPartialCircuitMatch(assignment) {
    const circuitArr = this.netArr
      .filter((net) => net['node arr'].every((n) => assignment[n.ref]))
      .map((net) => this._buildNetEntry(net, assignment));
    return new CircuitMatch(circuitArr).circuitArr;
  }

  _buildNetEntry(net, assignment) {
    const nodes = net['node arr'].map((n) => {
      const match = assignment[n.ref];
      return { node: `${n.ref}-${n.pin}`, match, pads: match.padIDs[n.pin] };
    });
    const traces = [...new Set(nodes.flatMap((n) => n.match.touchedTracesDict[n.node.split('-')[1]] || []))];
    return { traces, nodes, net: net.name };
  }

  // For any net not fully/consistently satisfiable by the best partial assignment, run
  // NetMatching.findWireInterventions (net-match.js) to search for a jumper-wire completion.
  // `remainingBudgetMs` bounds the whole loop (one deadline, not re-granted per net — otherwise a
  // single expensive net could consume the whole budget and the next net would get a fresh
  // allowance, defeating the point of having one at all). But a large board with many nets needing
  // several never-yet-cached components each (e.g. 65+ components) showed the opposite failure:
  // the first 2-3 nets needing several fresh (uncached) component searches ate the *entire* shared
  // budget, leaving every other net at 0ms — not because they were combinatorially expensive, but
  // because a handful of individual component searches on a large board took several seconds each.
  // `maxPerNetMs` caps any single net's share of the remaining budget, so a slow net can't starve
  // every net after it — and since _matchesForRef caches per ref across the whole call, a capped
  // net's partial work still speeds up every later net that happens to share a component.
  async _completeViaInterventions(bestAssignment, footprintLookup, onProgress, remainingBudgetMs = 30000) {
    const circuitArr = [];
    const deadline = performance.now() + remainingBudgetMs;
    const maxPerNetMs = 20000;
    const searchBudget = { attempts: 0, maxAttempts: 5000 };

    for (const net of this.netArr) {
      const assignedNodes = net['node arr'].filter((n) => bestAssignment[n.ref]);
      const nodes = assignedNodes.map((n) => {
        const match = bestAssignment[n.ref];
        return { node: `${n.ref}-${n.pin}`, match, pads: match.padIDs[n.pin] };
      });
      const missingNodeIDs = net['node arr'].filter((n) => !bestAssignment[n.ref]).map((n) => `${n.ref}-${n.pin}`);
      const traces = [...new Set(nodes.flatMap((n) => n.match.touchedTracesDict[n.node.split('-')[1]] || []))];

      let netMatchDict = { traces, nodes, net: net.name };

      if (missingNodeIDs.length > 0 && performance.now() < deadline) {
        const netDeadline = Math.min(deadline, performance.now() + maxPerNetMs);
        const nm = new NetMatching(net['node arr'], net.name);
        nm.pcbBoard = this.pcbBoard;
        const getCandidates = (r) => this._matchesForRef(r, footprintLookup, onProgress, netDeadline);
        const completed = await nm.findWireInterventions(netMatchDict, missingNodeIDs, footprintLookup, [], netDeadline, getCandidates, searchBudget);
        netMatchDict = completed.length > 0 ? completed[0] : { ...netMatchDict, incomplete: true };
      } else if (missingNodeIDs.length > 0) {
        netMatchDict = { ...netMatchDict, incomplete: true };
      }

      circuitArr.push(netMatchDict);
    }

    const match = new CircuitMatch(circuitArr);
    this.finished = true;
    return match;
  }

  // mirrors get_full_matches
  getFullMatches(matches, numNets) {
    return matches.map((m) => (m instanceof CircuitMatch ? m.circuitArr : m)).filter((arr) => arr.length === numNets);
  }

  // mirrors get_missing_nets
  getMissingNets(validMatch) {
    const matchedNetNames = validMatch.map((n) => n.net);
    return this.netArr.filter((n) => !matchedNetNames.includes(n.name));
  }

  // mirrors filter_duplicates (simplified equality check: same nets, same pad assignments per
  // ref — sufficient to dedupe since this search never revisits an assignment twice by
  // construction, but kept for API parity with the original's post-processing step).
  filterDuplicates(matches) {
    const seen = [];
    const fMatches = [];
    for (const match of matches) {
      const cirMatch = match instanceof CircuitMatch ? match : new CircuitMatch(match);
      const key = JSON.stringify({
        nets: cirMatch.nets,
        refs: cirMatch.refs.map((r) => [r, cirMatch.refDict[r].padIDs]),
      });
      if (!seen.includes(key)) {
        seen.push(key);
        fMatches.push(match);
      }
    }
    return fMatches;
  }

  // --- visualization overlays -------------------------------------------------------------

  // Shared by getTransparentOverlay/getNetsTransparentOverlay: draws one net's traces (with
  // inner-hole punch-outs), component footprint outlines, and any "add wire" intervention
  // highlighting onto the given front/back RGBA mats.
  _drawNetOverlay(matFront, matBack, net, lineWidth, interventionsDrawnRef) {
    const board = this.pcbBoard;

    // Fills a trace contour, then punches out (draws black over) any inner hole contours it
    // has — mirrors the repeated hierarchy-walk in get_transparent_overlay/get_nets_transparent_overlay.
    const drawTraceWithHoles = (mat, contours, hierarchyMat, traceIdx) => {
      const hierarchy = hierarchyMat.data32S;
      fillContourAt(mat, contours[traceIdx], [255, 0, 0]);
      let firstChild = hierarchy[traceIdx * 4 + 2];
      if (firstChild !== -1) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          fillContourAt(mat, contours[firstChild], [0, 0, 0]);
          const next = hierarchy[firstChild * 4 + 0];
          if (next === -1) break;
          firstChild = next;
        }
      }
    };

    for (const traceID of net.traces) {
      const conn = board.boardConnectionsDict[traceID];
      for (const fTrace of conn.frontTraces) drawTraceWithHoles(matFront, board.traceContours, board.traceHierarchy, fTrace);
      if (board.doubleSided) {
        for (const bTrace of conn.backTraces) drawTraceWithHoles(matBack, board.traceBackContours, board.traceBackHierarchy, bTrace);
      }
    }

    for (const node of net.nodes) {
      const mat = node.match.fb === 'front' ? matFront : matBack;
      for (const fpCnt of node.match.fpContours) {
        drawContourAtOffset(mat, fpCnt, [0, 0, 255], lineWidth, node.match.coordinates.x, node.match.coordinates.y);
      }
    }

    if (net.interventions) {
      const interventionsList = Array.isArray(net.interventions) ? net.interventions : [net.interventions];
      for (const intervention of interventionsList) {
        if (!intervention.addWire) continue;
        const addWire = intervention.addWire;

        if (Array.isArray(addWire)) {
          const [ref, pin] = addWire[0].split('-');
          const node = net.nodes.find((n) => n.node.split('-')[0] === ref);
          if (!node) continue;
          const cm = node.match;
          const mat = cm.fb === 'front' ? matFront : matBack;
          const maskContours = cm.fb === 'front' ? board.maskContours : board.maskBackContours;
          interventionsDrawnRef.v = Math.min(255, interventionsDrawnRef.v + 50);
          for (const fpCnt of cm.fpContours) drawContourAtOffset(mat, fpCnt, [0, 0, 255], lineWidth, cm.coordinates.x, cm.coordinates.y);
          for (const padID of cm.padIDs[pin]) fillContourAt(mat, maskContours[padID], [0, 255, interventionsDrawnRef.v]);
          for (const oMissingNode of addWire.slice(1)) {
            const oPin = oMissingNode.split('-')[1];
            for (const padID of cm.padIDs[oPin]) fillContourAt(mat, maskContours[padID], [0, 255, interventionsDrawnRef.v], lineWidth);
          }
        } else if (addWire.cmpntMatch) {
          const cm = addWire.cmpntMatch;
          const mat = cm.fb === 'front' ? matFront : matBack;
          const maskContours = cm.fb === 'front' ? board.maskContours : board.maskBackContours;
          const pin = addWire.missingNode.split('-')[1];
          interventionsDrawnRef.v = Math.min(255, interventionsDrawnRef.v + 50);
          for (const fpCnt of cm.fpContours) drawContourAtOffset(mat, fpCnt, [0, 0, 255], lineWidth, cm.coordinates.x, cm.coordinates.y);
          for (const padID of cm.padIDs[pin]) fillContourAt(mat, maskContours[padID], [0, 255, interventionsDrawnRef.v]);
          for (const node of net.nodes) {
            const nMat = node.match.fb === 'front' ? matFront : matBack;
            const nMaskContours = node.match.fb === 'front' ? board.maskContours : board.maskBackContours;
            for (const pad of node.pads) fillContourAt(nMat, nMaskContours[pad], [0, 255, interventionsDrawnRef.v], lineWidth);
          }
        }
      }
    }
  }

  // mirrors get_transparent_overlay
  getTransparentOverlay(match) {
    const board = this.pcbBoard;
    const { rows, cols } = board.pcbMat;
    const lineWidth = Math.max(1, Math.trunc(Math.sqrt(rows * cols) / 240));

    const matFront = newTransparentCanvasMat(rows, cols);
    const matBack = board.doubleSided ? newTransparentCanvasMat(rows, cols) : null;
    const interventionsDrawnRef = { v: 0 };

    for (const net of match) this._drawNetOverlay(matFront, matBack, net, lineWidth, interventionsDrawnRef);

    return board.doubleSided ? [matFront, matBack] : matFront;
  }

  // mirrors get_nets_transparent_overlay
  getNetsTransparentOverlay(match) {
    const board = this.pcbBoard;
    const { rows, cols } = board.pcbMat;
    const lineWidth = Math.max(1, Math.trunc(Math.sqrt(rows * cols) / 240));
    const netViewDict = {};

    for (const net of match) {
      const matFront = newTransparentCanvasMat(rows, cols);
      const matBack = board.doubleSided ? newTransparentCanvasMat(rows, cols) : null;
      const interventionsDrawnRef = { v: 0 };
      this._drawNetOverlay(matFront, matBack, net, lineWidth, interventionsDrawnRef);
      netViewDict[`${net.net} View`] = board.doubleSided ? [matFront, matBack] : matFront;
    }

    return netViewDict;
  }

  // mirrors get_cuts_overlay
  getCutsOverlay(interventions) {
    const board = this.pcbBoard;
    const { rows, cols } = board.pcbMat;
    const matFront = newTransparentCanvasMat(rows, cols);
    const matBack = board.doubleSided ? newTransparentCanvasMat(rows, cols) : null;

    for (const interventionNet of interventions) {
      const list = Array.isArray(interventionNet.interventions) ? interventionNet.interventions : [interventionNet.interventions];
      for (const intervention of list) {
        if (!intervention.traceCuts) continue;
        for (const fCut of intervention.traceCuts.frontCuts) {
          fillContourAt(matFront, fCut, [255, 255, 0]);
          const m = cv.moments(fCut, false);
          if (m.m00 === 0) continue;
          cv.circle(matFront, new cv.Point(m.m10 / m.m00, m.m01 / m.m00), 30, new cv.Scalar(255, 0, 0, 255), 10);
        }
        if (board.doubleSided) {
          for (const bCut of intervention.traceCuts.backCuts) {
            fillContourAt(matBack, bCut, [255, 255, 0]);
            const m = cv.moments(bCut, false);
            if (m.m00 === 0) continue;
            cv.circle(matBack, new cv.Point(m.m10 / m.m00, m.m01 / m.m00), 30, new cv.Scalar(255, 0, 0, 255), 10);
          }
        }
      }
    }

    return board.doubleSided ? [matFront, matBack] : matFront;
  }
}
