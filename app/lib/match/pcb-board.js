// Port of Code/PCB_utils.py's pad/trace analysis — mirrors gen_pad_map, connected_pads,
// contour_is_empty, contour_contains_throughhole, and the PCB_Board class. Takes rendered
// canvases (from app/lib/kicad/renderer.js) and parsed holes (from app/lib/kicad/drill.js)
// directly instead of reading PNG/.drl files from disk.
import {
  toGray,
  bitwiseNot,
  findContours,
  centroid,
  pointPolygonTest,
  matFromImageSource,
} from './cv-helpers.js';

// mirrors gen_pad_map: dict of contour index -> {x, y} centroid.
export function genPadMap(contours) {
  const padMap = {};
  contours.forEach((cnt, i) => {
    const c = centroid(cnt);
    if (c) padMap[i] = c;
  });
  return padMap;
}

function containsPoint(hierarchy, rows, idx, contours, x, y) {
  return pointPolygonTest(contours[idx], x, y) === 1;
}

// mirrors contour_is_empty: true if the contour region is mostly black (mean < 100) in traceImg.
function contourIsEmpty(contour, traceGrayMat) {
  const mask = cv.Mat.zeros(traceGrayMat.rows, traceGrayMat.cols, cv.CV_8UC1);
  const contours = new cv.MatVector();
  contours.push_back(contour);
  cv.drawContours(mask, contours, 0, new cv.Scalar(255), -1);
  contours.delete();
  const mean = cv.mean(traceGrayMat, mask);
  mask.delete();
  return mean[0] <= 100;
}

// mirrors contour_contains_throughhole
function contourContainsThroughhole(contour, holeArr) {
  for (const hole of holeArr) {
    if ((hole.isThroughHole || hole.isVia) && pointPolygonTest(contour, hole.pxCoordinates.x, hole.pxCoordinates.y) === 1) {
      return true;
    }
  }
  return false;
}

// Reads opencv.js's hierarchy Mat (4 x N, int32) into the same [next, prev, firstChild, parent]
// tuple-per-row shape the Python code indexes via trace_hierarchy[0][i][...].
function hierarchyRows(hierarchyMat) {
  const data = hierarchyMat.data32S;
  const rows = [];
  for (let i = 0; i < data.length; i += 4) {
    rows.push({ next: data[i], prev: data[i + 1], firstChild: data[i + 2], parent: data[i + 3] });
  }
  return rows;
}

// mirrors connected_pads
export function connectedPads(padMap, traceContours, traceHierarchyMat, traceGrayMat, holeArr = []) {
  const tracesMap = {};
  const hierarchy = hierarchyRows(traceHierarchyMat);

  for (let i = 0; i < hierarchy.length; i++) {
    if (hierarchy[i].parent === -1) continue; // outermost contour - skip

    for (const [padStr, padCenter] of Object.entries(padMap)) {
      const pad = Number(padStr);
      const withinTrace = pointPolygonTest(traceContours[i], padCenter.x, padCenter.y) === 1;
      if (!withinTrace) continue;

      if (hierarchy[i].firstChild !== -1) {
        let innerCnt = hierarchy[i].firstChild;
        let addPoint = true;

        while (hierarchy[innerCnt].next !== -1) {
          if (pointPolygonTest(traceContours[innerCnt], padCenter.x, padCenter.y) === 1) {
            const cntTh = hierarchy[innerCnt].firstChild === -1 ? contourContainsThroughhole(traceContours[innerCnt], holeArr) : false;
            if (!cntTh) {
              addPoint = false;
              break;
            }
          }
          innerCnt = hierarchy[innerCnt].next;
        }

        if (hierarchy[innerCnt].next === -1) {
          if (pointPolygonTest(traceContours[innerCnt], padCenter.x, padCenter.y) === 1) {
            const cntTh = hierarchy[innerCnt].firstChild === -1 ? contourContainsThroughhole(traceContours[innerCnt], holeArr) : false;
            if (!cntTh) addPoint = false;
          }
        }

        if (addPoint) {
          tracesMap[i] = tracesMap[i] ? [...tracesMap[i], pad] : [pad];
        }
      } else if (contourIsEmpty(traceContours[i], traceGrayMat)) {
        continue;
      } else {
        tracesMap[i] = tracesMap[i] ? [...tracesMap[i], pad] : [pad];
      }
    }
  }

  return tracesMap;
}

export class PCBBoard {
  constructor(board) {
    this.board = board; // parsed via app/lib/kicad/board.js
    this.doubleSided = board.footprints.some((fp) => fp.layer === 'B.Cu');
  }

  // mirrors initialize_via_files — takes rendered <canvas> elements (front/back mask + traces)
  // and already-parsed drill holes (app/lib/kicad/drill.js) instead of file paths.
  initializeViaFiles(maskFrontCanvas, traceFrontCanvas, { maskBackCanvas, traceBackCanvas, holes = [] } = {}) {
    this.pcbMat = matFromImageSource(traceFrontCanvas);
    this.maskMat = matFromImageSource(maskFrontCanvas);

    if (this.doubleSided) {
      this.pcbMatBack = matFromImageSource(traceBackCanvas);
      this.maskMatBack = matFromImageSource(maskBackCanvas);
    }

    const maskGray = toGray(this.maskMat);
    const invMaskGray = bitwiseNot(maskGray);
    const maskResult = findContours(invMaskGray, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    this.maskContours = maskResult.contours;
    maskResult.hierarchy.delete();
    maskGray.delete();
    invMaskGray.delete();

    const traceGray = toGray(this.pcbMat);
    const traceResult = findContours(traceGray, cv.RETR_TREE, cv.CHAIN_APPROX_NONE);
    this.traceContours = traceResult.contours;
    this.traceHierarchy = traceResult.hierarchy;
    traceGray.delete();

    if (this.doubleSided) {
      const maskBackGray = toGray(this.maskMatBack);
      const invMaskBackGray = bitwiseNot(maskBackGray);
      const maskBackResult = findContours(invMaskBackGray, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      this.maskBackContours = maskBackResult.contours;
      maskBackResult.hierarchy.delete();
      maskBackGray.delete();
      invMaskBackGray.delete();

      const traceBackGray = toGray(this.pcbMatBack);
      const traceBackResult = findContours(traceBackGray, cv.RETR_TREE, cv.CHAIN_APPROX_NONE);
      this.traceBackContours = traceBackResult.contours;
      this.traceBackHierarchy = traceBackResult.hierarchy;
      traceBackGray.delete();

      if (holes.length > 0) {
        this.createViasProfile(holes);
      } else {
        this.createProfile();
      }
    } else {
      this.createProfile();
    }
  }

  // Frees every WASM Mat this board holds. Required whenever a PCBBoard is discarded — the worker
  // is long-lived now, so a board's Mats (several full-board images plus every contour) would
  // otherwise stay allocated forever after the user switches to a different board.
  delete() {
    const mats = [this.pcbMat, this.maskMat, this.pcbMatBack, this.maskMatBack, this.traceHierarchy, this.traceBackHierarchy];
    for (const m of mats) if (m) m.delete();
    const contourLists = [this.maskContours, this.traceContours, this.maskBackContours, this.traceBackContours];
    for (const list of contourLists) if (list) for (const c of list) c.delete();
  }

  // mirrors create_profile (single-sided, or double-sided without a usable drill file)
  createProfile() {
    const traceGray = toGray(this.pcbMat);
    const invGray = bitwiseNot(traceGray);

    const frontPadMap = genPadMap(this.maskContours);
    const frontTraceMap = connectedPads(frontPadMap, this.traceContours, this.traceHierarchy, invGray);
    this.frontPadMap = frontPadMap;
    traceGray.delete();
    invGray.delete();

    const boardConnectionsDict = {};
    let traceIndex = 0;
    for (const [fTrace, pads] of Object.entries(frontTraceMap)) {
      boardConnectionsDict[traceIndex] = { frontTraces: [Number(fTrace)], backTraces: [], frontPads: pads, backPads: [] };
      traceIndex++;
    }

    if (this.doubleSided) {
      const traceBackGray = toGray(this.pcbMatBack);
      const invBackGray = bitwiseNot(traceBackGray);
      const backPadMap = genPadMap(this.maskBackContours);
      const backTraceMap = connectedPads(backPadMap, this.traceBackContours, this.traceBackHierarchy, invBackGray);
      this.backPadMap = backPadMap;
      traceBackGray.delete();
      invBackGray.delete();

      for (const [bTrace, pads] of Object.entries(backTraceMap)) {
        boardConnectionsDict[traceIndex] = { frontTraces: [], backTraces: [Number(bTrace)], frontPads: [], backPads: pads };
        traceIndex++;
      }
    }

    this.boardConnectionsDict = boardConnectionsDict;
  }

  // mirrors create_vias_profile: classifies each drill hole as a via/through-hole/plain-drill by
  // sampling the mask image color at its pixel position, then unions front/back traces that
  // share a via into single board-connection entries.
  createViasProfile(holeArr) {
    const bounds = this.board.bounds;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    for (const hole of holeArr) {
      const y = ((Math.abs(hole.coordinates.y) - bounds.minY) / height) * this.pcbMat.rows;
      const x = ((hole.coordinates.x - bounds.minX) / width) * this.pcbMat.cols;
      hole.pxCoordinates = { x: Math.abs(Math.round(x)), y: Math.abs(Math.round(y)) };

      const maskPixel = this.maskMat.ucharPtr(hole.pxCoordinates.y, hole.pxCoordinates.x);
      const isWhite = maskPixel[0] === 255 && maskPixel[1] === 255 && maskPixel[2] === 255;
      hole.isVia = isWhite;
      if (!isWhite) hole.isThroughHole = false; // resolved definitively below via trace containment
    }

    this._buildViaConnections(holeArr);
  }

  // mirrors create_updated_vias_profile — same via/trace-union logic, reused after trace cuts
  // update the copper geometry (createViasProfile already classified isVia/isThroughHole once).
  createUpdatedViasProfile() {
    this._buildViaConnections(this.holeArr);
  }

  _buildViaConnections(holeArr) {
    const traceHierarchy = hierarchyRows(this.traceHierarchy);
    const viasDict = {};

    const traceContainingPoint = (contours, hierarchy, x, y) => {
      for (let i = 0; i < hierarchy.length; i++) {
        if (hierarchy[i].parent === -1) continue;
        if (hierarchy[i].firstChild === -1) continue;
        const innerId = hierarchy[i].firstChild;
        if (hierarchy[innerId].firstChild === -1 && pointPolygonTest(contours[i], x, y) === 1) {
          return i;
        }
      }
      return -1;
    };

    for (const hole of holeArr) {
      if (!(hole.isVia || hole.isThroughHole)) continue;
      const traceId = traceContainingPoint(this.traceContours, traceHierarchy, hole.pxCoordinates.x, hole.pxCoordinates.y);
      if (traceId === -1) continue;
      viasDict[traceId] = viasDict[traceId] ? { holes: [...viasDict[traceId].holes, hole] } : { holes: [hole] };
    }
    this.holeArr = holeArr;

    // map each via's front trace to whichever back trace also contains that via's coordinates
    const backHierarchy = hierarchyRows(this.traceBackHierarchy);
    const connectedTracesBack = {};

    for (const [frontTraceId, { holes }] of Object.entries(viasDict)) {
      for (const hole of holes) {
        const backTraceId = traceContainingPoint(this.traceBackContours, backHierarchy, hole.pxCoordinates.x, hole.pxCoordinates.y);
        if (backTraceId === -1) continue;
        connectedTracesBack[backTraceId] = connectedTracesBack[backTraceId]
          ? [...new Set([...connectedTracesBack[backTraceId], Number(frontTraceId)])]
          : [Number(frontTraceId)];
      }
    }

    // union front/back traces that share a via into single board-connection groups
    const boardConnectionsDict = {};
    const touchedFront = [];
    const touchedBack = [];
    let traceIndex = 0;

    for (const [bTraceId, fTraces] of Object.entries(connectedTracesBack)) {
      const connection = { frontTraces: [], backTraces: [Number(bTraceId)], holes: [] };
      let mergedIntoExisting = false;

      for (const fTrace of fTraces) {
        if (!touchedFront.includes(fTrace)) {
          touchedFront.push(fTrace);
          connection.frontTraces.push(fTrace);
          connection.holes = connection.holes.concat(viasDict[fTrace].holes);
        } else {
          for (const [tIndex, existing] of Object.entries(boardConnectionsDict)) {
            if (existing.frontTraces.includes(fTrace)) {
              for (const ff of fTraces) {
                if (!existing.frontTraces.includes(ff)) {
                  existing.frontTraces.push(ff);
                  existing.holes = existing.holes.concat(viasDict[ff].holes);
                }
                if (!touchedFront.includes(ff)) touchedFront.push(ff);
              }
              if (!existing.backTraces.includes(Number(bTraceId))) {
                existing.backTraces.push(Number(bTraceId));
                touchedBack.push(Number(bTraceId));
              }
              mergedIntoExisting = true;
              break;
            }
          }
          break;
        }
      }

      if (!mergedIntoExisting) {
        boardConnectionsDict[traceIndex] = connection;
        touchedBack.push(Number(bTraceId));
        traceIndex++;
      }
    }

    const traceGray = toGray(this.pcbMat);
    const invGray = bitwiseNot(traceGray);
    const frontPadMap = genPadMap(this.maskContours);
    const frontTraceMap = connectedPads(frontPadMap, this.traceContours, this.traceHierarchy, invGray, this.holeArr);

    const traceBackGray = toGray(this.pcbMatBack);
    const invBackGray = bitwiseNot(traceBackGray);
    const backPadMap = genPadMap(this.maskBackContours);
    const backTraceMap = connectedPads(backPadMap, this.traceBackContours, this.traceBackHierarchy, invBackGray, this.holeArr);

    for (const conn of Object.values(boardConnectionsDict)) {
      conn.frontPads = conn.frontTraces.flatMap((t) => frontTraceMap[t] || []);
      conn.backPads = conn.backTraces.flatMap((t) => backTraceMap[t] || []);
    }

    for (const [fTrace, pads] of Object.entries(frontTraceMap)) {
      if (!touchedFront.includes(Number(fTrace))) {
        boardConnectionsDict[traceIndex] = { frontTraces: [Number(fTrace)], backTraces: [], backPads: [], frontPads: pads };
        traceIndex++;
      }
    }
    for (const [bTrace, pads] of Object.entries(backTraceMap)) {
      if (!touchedBack.includes(Number(bTrace))) {
        boardConnectionsDict[traceIndex] = { frontTraces: [], backTraces: [Number(bTrace)], backPads: pads, frontPads: [] };
        traceIndex++;
      }
    }

    this.boardConnectionsDict = boardConnectionsDict;
    this.frontPadMap = frontPadMap;
    this.backPadMap = backPadMap;
    traceGray.delete();
    invGray.delete();
    traceBackGray.delete();
    invBackGray.delete();
  }

  // mirrors integrate_trace_cuts
  integrateTraceCuts(traceCutsDict) {
    if (!this.pcbMatOriginal) {
      this.traceCuts = true;
      this.pcbMatOriginal = this.pcbMat.clone();
      this.traceContoursOriginal = this.traceContours;
      this.traceHierarchyOriginal = this.traceHierarchy;
      this.frontPadMapOriginal = this.frontPadMap;
      this.boardConnectionsDictOriginal = this.boardConnectionsDict;
      if (this.doubleSided && !this.pcbMatBackOriginal) {
        this.pcbMatBackOriginal = this.pcbMatBack.clone();
        this.traceBackContoursOriginal = this.traceBackContours;
        this.traceBackHierarchyOriginal = this.traceBackHierarchy;
        this.backPadMapOriginal = this.backPadMap;
      }
    }

    this.traceCuts = true;
    this.pcbMatPrevious = this.pcbMat.clone();
    this.traceContoursPrevious = this.traceContours;
    this.traceHierarchyPrevious = this.traceHierarchy;
    this.frontPadMapPrevious = this.frontPadMap;
    this.boardConnectionsDictPrevious = this.boardConnectionsDict;
    if (this.doubleSided) {
      this.pcbMatBackPrevious = this.pcbMatBack.clone();
      this.traceBackContoursPrevious = this.traceBackContours;
      this.traceBackHierarchyPrevious = this.traceBackHierarchy;
      this.backPadMapPrevious = this.backPadMap;
    }

    const newPcbMat = this.pcbMat.clone();
    for (const cutCnt of traceCutsDict.frontCuts) {
      const contours = new cv.MatVector();
      contours.push_back(cutCnt);
      cv.drawContours(newPcbMat, contours, 0, new cv.Scalar(255, 255, 255, 255), -1);
      contours.delete();
    }

    if (this.doubleSided) {
      const newPcbMatBack = this.pcbMatBack.clone();
      for (const cutCnt of traceCutsDict.backCuts) {
        const contours = new cv.MatVector();
        contours.push_back(cutCnt);
        cv.drawContours(newPcbMatBack, contours, 0, new cv.Scalar(255, 255, 255, 255), -1);
        contours.delete();
      }
      this.updateProfile(newPcbMat, newPcbMatBack);
    } else {
      this.updateProfile(newPcbMat);
    }
  }

  // mirrors revert
  revert() {
    this.traceCuts = true;
    if (!this.pcbMatPrevious) return;

    this.pcbMat = this.pcbMatPrevious.clone();
    this.traceContours = this.traceContoursPrevious;
    this.traceHierarchy = this.traceHierarchyPrevious;
    this.frontPadMap = this.frontPadMapPrevious;
    this.boardConnectionsDict = this.boardConnectionsDictPrevious;

    if (this.doubleSided) {
      this.pcbMatBack = this.pcbMatBackPrevious.clone();
      this.traceBackContours = this.traceBackContoursPrevious;
      this.traceBackHierarchy = this.traceBackHierarchyPrevious;
      this.backPadMap = this.backPadMapPrevious;
    }
  }

  // mirrors revert_original
  revertOriginal() {
    this.traceCuts = false;
    this.pcbMat = this.pcbMatOriginal.clone();
    this.traceContours = this.traceContoursOriginal;
    this.traceHierarchy = this.traceHierarchyOriginal;
    this.frontPadMap = this.frontPadMapOriginal;
    this.boardConnectionsDict = this.boardConnectionsDictOriginal;

    if (this.doubleSided) {
      this.pcbMatBack = this.pcbMatBackOriginal.clone();
      this.traceBackContours = this.traceBackContoursOriginal;
      this.traceBackHierarchy = this.traceBackHierarchyOriginal;
      this.backPadMap = this.backPadMapOriginal;
    }
  }

  // mirrors update_profile
  updateProfile(pcbMat, pcbMatBack = null) {
    this.pcbMat = pcbMat;
    const traceGray = toGray(this.pcbMat);
    const result = findContours(traceGray, cv.RETR_TREE, cv.CHAIN_APPROX_NONE);
    this.traceContours = result.contours;
    this.traceHierarchy = result.hierarchy;

    if (pcbMatBack) {
      this.pcbMatBack = pcbMatBack;
      const traceBackGray = toGray(this.pcbMatBack);
      const backResult = findContours(traceBackGray, cv.RETR_TREE, cv.CHAIN_APPROX_NONE);
      this.traceBackContours = backResult.contours;
      this.traceBackHierarchy = backResult.hierarchy;
      this.createUpdatedViasProfile();
    } else {
      this.createProfile();
    }
  }

  // mirrors get_num_pads_on_traces
  getNumPadsOnTraces(traces) {
    let numPads = 0;
    for (const trace of traces) {
      const conn = this.boardConnectionsDict[trace];
      numPads += conn.frontPads.length + conn.backPads.length;
    }
    return numPads;
  }
}
