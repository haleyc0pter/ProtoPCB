// Port of Code/ComponentMatch.py — template-matches a single component footprint against a
// board's solder-mask image across 8 rotations, using opencv.js in place of cv2.
// File-based JSON persistence (save_matches/load_matches) is intentionally not ported: matches
// stay in memory as JS objects in the browser rather than being round-tripped through disk.
import {
  toGray,
  bitwiseNot,
  bitwiseAnd,
  findContours,
  centroid,
  contourArea,
  pointPolygonTest,
  boundingRect,
  newBlackMat,
  drawFilledContour,
  drawLine,
  copyMakeBorder,
  countPixelsEqual,
  minMaxLoc,
  blackoutCircle,
  rotateImage,
  cropMat,
  shape,
  matFromImageSource,
  yieldToUI,
} from './cv-helpers.js';

const ORIENTATIONS = [0, 45, 90, 135, 180, 225, 270, 315];

export class ComponentMatch {
  constructor(score, padCenters, padList, coordinates, orientation) {
    this.score = score;
    this.padCenters = padCenters; // { pin: [{x,y}, ...] } once relabeled
    this.padList = padList; // array of pad IDs (mask_contours indices)
    this.coordinates = coordinates; // {x, y} top-left of match
    this.orientation = orientation;
    this.padIDs = {}; // { pin: [padID, ...] }
  }

  copy() {
    const cm = new ComponentMatch(this.score, this.padCenters, this.padList, this.coordinates, this.orientation);
    return Object.assign(cm, this);
  }

  // mirrors ComponentMatch.update_traces: recomputes this single match's touchedTracesDict/List
  // against a (possibly updated, e.g. after a trace cut) pcbBoard.boardConnectionsDict. Reused by
  // CircuitMatch.js's own update_traces, which needs to do the same recomputation for both
  // regular match nodes and "add wire" intervention component matches.
  updateTraces(pcbBoard) {
    this.touchedTracesDict = {};
    this.touchedTracesList = [];

    for (const [pin, pads] of Object.entries(this.padIDs)) {
      for (const pad of pads) {
        for (const [traceID, traceInfo] of Object.entries(pcbBoard.boardConnectionsDict)) {
          const padsKey = this.fb === 'front' ? 'frontPads' : 'backPads';
          if (traceInfo[padsKey].includes(pad)) {
            if (this.touchedTracesDict[pin]) this.touchedTracesDict[pin].push(Number(traceID));
            else this.touchedTracesDict[pin] = [Number(traceID)];
            this.touchedTracesList.push(Number(traceID));
            break;
          }
        }
      }
    }
    return this;
  }
}

export class ComponentMatching {
  constructor() {
    this.padMap = {};
    this.traceMap = {};
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

  // mirrors initialize_fp_from_file, adapted to take an already-rendered footprint canvas
  // (from app/lib/kicad/renderer.js) and the parsed footprint object (from footprint.js)
  // instead of file paths — there's no filesystem in the browser.
  initializeFootprint(footprintCanvas, footprint) {
    this.footprint = footprint;
    const sourceMat = matFromImageSource(footprintCanvas);
    const raw = toGray(sourceMat);
    const rawRgba = new cv.Mat();
    cv.cvtColor(raw, rawRgba, cv.COLOR_GRAY2RGBA);
    this.footprintMat = copyMakeBorder(rawRgba, 2, 255);
    this.fpAlpha = bitwiseNot(this.footprintMat);
    sourceMat.delete();
    raw.delete();
    rawRgba.delete();

    const fpAlphaGray = toGray(this.fpAlpha);
    const { contours } = findContours(fpAlphaGray, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    this.fpContours = contours;
    this.numFpPads = contours.length;
    fpAlphaGray.delete();
  }

  // Frees this instance's own persistent Mats (footprintMat/fpAlpha/fpContours, held for its whole
  // lifetime by initializeFootprint above). Needed by callers that create a short-lived
  // ComponentMatching purely to search one footprint and discard it — e.g. net-match.js's
  // wire-intervention fallback, which can construct many of these across a single recursive
  // search; without this they leak WASM heap memory that JS garbage collection can't reach.
  delete() {
    if (this.footprintMat) this.footprintMat.delete();
    if (this.fpAlpha) this.fpAlpha.delete();
    if (this.fpContours) for (const c of this.fpContours) c.delete();
  }

  // mirrors get_pad_info
  getPadInfo(matchLoc, w, h, matchContours, fpAlphaMat, fb = 'front') {
    let trueMatch = true;
    const padCenters = [];
    const matchPadMap = {};
    const matchAreaMap = {};

    const fpAlphaGray = toGray(fpAlphaMat);
    const { contours: fpContours } = findContours(fpAlphaGray, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    for (const mCnt of matchContours) {
      const mask = newBlackMat(fpAlphaGray.rows, fpAlphaGray.cols);
      drawFilledContour(mask, mCnt);
      const intersection = bitwiseAnd(fpAlphaGray, mask);
      const { contours: intContours } = findContours(intersection, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      mask.delete();
      intersection.delete();

      if (intContours.length === 1) {
        const iCentroid = centroid(intContours[0]);
        const mCentroid = centroid(mCnt);

        if (mCentroid && iCentroid) {
          const mCx = Math.trunc(matchLoc.x + mCentroid.x);
          const mCy = Math.trunc(matchLoc.y + mCentroid.y);

          const maskContours = fb === 'front' ? this.pcbBoard.maskContours : this.pcbBoard.maskBackContours;

          for (const maskCnt of maskContours) {
            const result = pointPolygonTest(maskCnt, mCx, mCy);
            if (result === 1) {
              const pM = centroid(maskCnt);
              const already = padCenters.some((c) => c.x === pM.x && c.y === pM.y);

              if (!already) {
                padCenters.push(pM);
                for (let i = 0; i < fpContours.length; i++) {
                  const idResult = pointPolygonTest(fpContours[i], iCentroid.x, iCentroid.y);
                  if (idResult === 1 || idResult === 0) {
                    if (matchPadMap[i]) {
                      matchPadMap[i].push(pM);
                      matchAreaMap[i] += contourArea(intContours[0]);
                    } else {
                      matchPadMap[i] = [pM];
                      matchAreaMap[i] = contourArea(intContours[0]);
                    }
                  }
                }
              } else {
                for (let i = 0; i < fpContours.length; i++) {
                  const idResult = pointPolygonTest(fpContours[i], iCentroid.x, iCentroid.y);
                  if (idResult === 1 || idResult === 0) {
                    for (const [id, centers] of Object.entries(matchPadMap)) {
                      if (centers.some((c) => c.x === pM.x && c.y === pM.y) && Number(id) !== i) {
                        trueMatch = false;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } else if (intContours.length > 1) {
        trueMatch = false;
      }
      for (const c of intContours) c.delete();
    }

    fpAlphaGray.delete();
    if (fpContours.length > Object.keys(matchPadMap).length) trueMatch = false;

    for (let i = 0; i < fpContours.length; i++) {
      const fArea = contourArea(fpContours[i]);
      const minAreaCoverage = (fArea * 5) / 10;
      if (i in matchAreaMap && matchAreaMap[i] < minAreaCoverage) trueMatch = false;
    }

    return { padCenters, matchPadMap, matchAreaMap, trueMatch, fpContours };
  }

  // mirrors get_list_from_pad_centers
  getListFromPadCenters(padCentersList, padMap) {
    const padList = [];
    for (const center of padCentersList) {
      for (const [padId, padCenter] of Object.entries(padMap)) {
        if (center.x === padCenter.x && center.y === padCenter.y) padList.push(Number(padId));
      }
    }
    return padList;
  }

  // mirrors find_matches / find_matches_incomplete (unified, `numFpPadsOverride` selects the
  // "incomplete match" behavior when passed, matching how the Python duplicates this method).
  // Async and yields periodically during the correlation scan — this loop is the single most
  // expensive part of the whole pipeline (tens of seconds on a real board), and without yielding,
  // the browser tab freezes solid with no way to show a loading/progress UI.
  async findMatches(origMat, fpMat, alphaMat, padMap, orientation, { offset = { x: 0, y: 0 }, fb = 'front', numFpPadsOverride = null, onProgress = null, deadline = Infinity } = {}) {
    const { h, w } = shape(fpMat);
    const incomplete = numFpPadsOverride !== null;
    const requiredPads = incomplete ? numFpPadsOverride : this.numFpPads;

    const { h: imgH, w: imgW } = shape(origMat);

    // cv.matchTemplate requires the search image to be at least as large as the template in both
    // dimensions (it throws otherwise) — the original's manual per-position loop instead just never
    // entered its bounds-checked inner loop, silently yielding zero matches. This happens for real:
    // scoped searches (getMatchesAroundPad/getMatchesOnTrace crop to a small region around specific
    // pads) can end up smaller than the footprint being searched for.
    if (imgH < h || imgW < w) return [];

    const imgInv = bitwiseNot(origMat);
    const templateInv = bitwiseNot(fpMat);
    const fpWhitePix = countPixelsEqual(templateInv, 255);

    const minD = Math.min(h, w);
    const minDi = Math.min(imgH, imgW);
    // Math.max(...) below can still be 0 when both terms truncate to 0 — true for small crops
    // (getMatchesAroundPad/getMatchesOnTrace search a small region around one pad, not the full
    // board) paired with a small template. The resampling loop right after steps `i += rad`, so
    // rad===0 is an infinite loop (confirmed: froze the tab solid on BioAmp-EXG-Pill's connector
    // footprints during wire-intervention search) — clamped to at least 1 (examine every pixel of
    // what's already a tiny region, which is cheap regardless).
    const rad = Math.max(1, incomplete ? Math.max(Math.trunc(minD / 16), Math.trunc(minDi / 100)) : Math.max(Math.trunc(minD / 20), Math.trunc(minDi / 140)));
    // A real match's correlation score stays high across many neighboring pixel/grid-cell shifts
    // (and low-specificity footprints like ground-plane-heavy pads can have dozens of similarly-
    // scoring false-candidate locations across the board), so blacking out only a `rad`-sized dot
    // per detection left hundreds to low-thousands of near-duplicate grid points around each real
    // peak to work through one at a time (each requiring an expensive crop+contour+getPadInfo
    // cycle) — verified empirically (VEML6070/U1: ~1,300 grid points over threshold, collapsing to
    // ~23 genuinely distinct board locations once suppression covers a full template-sized area).
    // Half the template's own smaller dimension clears an entire peak in one hit while staying
    // well under typical spacing between distinct components, so real neighboring parts aren't
    // suppressed into a single detection.
    const suppressRadius = Math.max(rad, Math.round(minD / 2));

    // The score at each candidate top-left position (x,y) is the count of pixels where both the
    // template and the image window underneath it are white, normalized by the template's own
    // white-pixel count. Single-channel binary images make that identical to cv.matchTemplate's
    // TM_CCORR at every position in one native, FFT-backed call: TM_CCORR sums img*templ over the
    // window, and since both are 0/255 that sum is exactly 255*255*(count of overlapping white
    // pixels) — so dividing by 255*255*fpWhitePix recovers the same normalized score the original
    // Python's manual per-position loop computed, in a fraction of the time.
    //
    // The original only ever computed (and the extraction loop below only ever blacks out) a
    // sparse grid spaced `rad` pixels apart — a real match's correlation score stays high across
    // many neighboring pixel shifts, so a *dense* (every-pixel) map paired with a `rad`-sized
    // blackout circle made the extraction loop below iterate over every near-duplicate pixel of
    // one broad peak individually (thousands of expensive crop+contour+getPadInfo cycles instead
    // of one) — resampling the fast dense result back onto the original's sparse grid keeps the
    // matchTemplate speedup while preserving the bounded, one-hit-per-real-match behavior the
    // blackout radius was designed around.
    const imgGray = toGray(imgInv);
    const templGray = toGray(templateInv);
    const corr = new cv.Mat();
    cv.matchTemplate(imgGray, templGray, corr, cv.TM_CCORR);
    const denseRes = new cv.Mat();
    corr.convertTo(denseRes, cv.CV_64FC1, fpWhitePix > 0 ? 1 / (255 * 255 * fpWhitePix) : 0, 0);
    corr.delete();
    imgGray.delete();
    templGray.delete();
    imgInv.delete();
    templateInv.delete();

    const res = new cv.Mat(denseRes.rows, denseRes.cols, cv.CV_64FC1, new cv.Scalar(0));
    for (let i = 0; i < denseRes.rows; i += rad) {
      for (let j = 0; j < denseRes.cols; j += rad) {
        res.doublePtr(i, j)[0] = denseRes.doublePtr(i, j)[0];
      }
    }
    denseRes.delete();

    if (onProgress) onProgress({ stage: 'scanning', rowsDone: 1, totalRows: 1 });
    await yieldToUI();
    let ranOutOfTime = performance.now() > deadline;

    const threshold = incomplete ? 0.3 : 0.15;
    const matchesPadList = [];
    const matchList = [];

    const pcbImg = fb === 'front' ? this.pcbBoard.maskMat : this.pcbBoard.maskMatBack;
    let maxVal = ranOutOfTime ? 0 : 1;
    let lastYield = performance.now();

    while (maxVal > threshold) {
      const mm = minMaxLoc(res);
      maxVal = mm.maxVal;
      if (maxVal <= threshold) break;

      if (performance.now() - lastYield > 100) {
        await yieldToUI();
        lastYield = performance.now();
        if (performance.now() > deadline) {
          ranOutOfTime = true;
          break;
        }
      }

      const maxLoc = mm.maxLoc;
      const matchCrop = cropMat(pcbImg, offset.x + maxLoc.x, offset.y + maxLoc.y, w, h);
      const matchCropGray = toGray(matchCrop);
      const matchInv = bitwiseNot(matchCropGray);
      const { contours: matchContours } = findContours(matchInv, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      const numMatchPads = matchContours.length;

      const passesCountFilter = incomplete ? numMatchPads >= requiredPads : true;

      if (passesCountFilter) {
        const matchLoc = { x: maxLoc.x + offset.x, y: maxLoc.y + offset.y };
        const { padCenters, matchPadMap, matchAreaMap, trueMatch, fpContours } = this.getPadInfo(matchLoc, w, h, matchContours, alphaMat, fb);

        const padList = this.getListFromPadCenters(padCenters, padMap);
        const alreadySeen = matchesPadList.some((p) => JSON.stringify(p) === JSON.stringify(padList));

        if (trueMatch && !alreadySeen && padList.length >= requiredPads) {
          matchesPadList.push(padList);
          const cMatch = new ComponentMatch(maxVal, matchPadMap, padList, matchLoc, orientation);
          cMatch.fpContours = fpContours;
          cMatch.padCoverage = matchAreaMap;
          cMatch.fb = fb;
          if (incomplete) cMatch.incomplete = true;
          matchList.push(cMatch);
        }
      }

      for (const c of matchContours) c.delete();
      matchInv.delete();
      matchCropGray.delete();
      matchCrop.delete();
      blackoutCircle(res, maxLoc.x, maxLoc.y, suppressRadius);
    }

    res.delete();
    matchList.ranOutOfTime = ranOutOfTime;
    return matchList;
  }

  // mirrors get_matches. `onProgress` (optional) is called with {stage, orientationIndex,
  // orientationTotal, ...findMatches progress} so a loading screen can show real progress
  // instead of a bare spinner across what can be a multi-minute search.
  async getMatches({ onProgress = null, deadline = Infinity } = {}) {
    const pinMap = this.getPinMapping(this.fpContours, this.footprint);
    const cmOArr = [];
    let ranOutOfTime = false;

    for (let oi = 0; oi < ORIENTATIONS.length; oi++) {
      if (performance.now() > deadline) {
        ranOutOfTime = true;
        break;
      }
      const orientation = ORIENTATIONS[oi];
      let alpha, template;
      if (orientation === 0) {
        alpha = this.fpAlpha;
        template = this.footprintMat;
      } else {
        alpha = rotateImage(this.fpAlpha, orientation);
        template = bitwiseNot(alpha);
      }

      const wrappedProgress = onProgress
        ? (p) => onProgress({ ...p, orientation, orientationIndex: oi, orientationTotal: ORIENTATIONS.length })
        : null;

      const matchList = await this.findMatches(this.pcbBoard.maskMat, template, alpha, this.pcbBoard.frontPadMap, orientation, {
        onProgress: wrappedProgress,
        deadline,
      });
      if (matchList.ranOutOfTime) ranOutOfTime = true;
      this.applyPinLabeling(orientation, alpha, pinMap, matchList, this.pcbBoard.frontPadMap);
      cmOArr.push(matchList);

      if (this.pcbBoard.doubleSided) {
        if (performance.now() < deadline) {
          const matchBList = await this.findMatches(this.pcbBoard.maskMatBack, template, alpha, this.pcbBoard.backPadMap, orientation, {
            fb: 'back',
            onProgress: wrappedProgress,
            deadline,
          });
          if (matchBList.ranOutOfTime) ranOutOfTime = true;
          this.applyPinLabeling(orientation, alpha, pinMap, matchBList, this.pcbBoard.backPadMap);
          cmOArr.push(matchBList);
        } else {
          ranOutOfTime = true;
        }
      }

      // orientation 0 reuses this.fpAlpha/this.footprintMat directly (owned by this instance,
      // needed for the rest of its lifetime) — only the rotated copies made for other
      // orientations are this call's own to free.
      if (orientation !== 0) {
        alpha.delete();
        template.delete();
      }
    }

    const result = this.filterMatches(cmOArr);
    result.ranOutOfTime = ranOutOfTime;
    return result;
  }

  // shared by get_matches/get_incomplete_matches: relabels a rotation's raw contour-index
  // matches back to true pin numbers, either directly (orientation 0) or via the rotated-contour
  // mapping (mirrors the repeated if/else block in get_matches/get_incomplete_matches).
  applyPinLabeling(orientation, alpha, pinMap, matchList, padMap) {
    if (orientation === 0) {
      this.relabelContours(pinMap, matchList, padMap);
    } else {
      const alphaGray = toGray(alpha);
      const { contours: oFpContours } = findContours(alphaGray, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      const oMap = this.mapPads(this.fpContours, this.fpAlpha, oFpContours, alpha, orientation);
      const pinOMap = this.mapRtCntToPins(pinMap, oMap);
      this.relabelContours(pinOMap, matchList, padMap);
      alphaGray.delete();
      for (const c of oFpContours) c.delete();
    }
  }

  // mirrors get_incomplete_matches
  async getIncompleteMatches(ignorePins, { onProgress = null } = {}) {
    const modifiedTemplate = this.footprintMat.clone();
    const pinMap = this.getPinMapping(this.fpContours, this.footprint);

    const removedCnts = [];
    for (const pin of ignorePins) {
      const found = pinMap.find(([p]) => p === pin);
      if (found) {
        drawFilledContour(modifiedTemplate, this.fpContours[found[1]]);
        removedCnts.push(this.fpContours[found[1]]);
      }
    }

    const modifiedAlpha = bitwiseNot(modifiedTemplate);
    const modAlphaGray = toGray(modifiedAlpha);
    const { contours: modFpContours } = findContours(modAlphaGray, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    modAlphaGray.delete();
    const modNumFpPads = modFpContours.length;
    const mPinMap = this.getPinMapping(modFpContours, this.footprint);

    const cmOArr = [];

    for (const orientation of ORIENTATIONS) {
      let alpha, template;
      if (orientation === 0) {
        alpha = modifiedAlpha;
        template = modifiedTemplate;
      } else {
        alpha = rotateImage(modifiedAlpha, orientation);
        template = bitwiseNot(alpha);
      }

      const matchList = await this.findMatches(this.pcbBoard.maskMat, template, alpha, this.pcbBoard.frontPadMap, orientation, {
        numFpPadsOverride: modNumFpPads,
        onProgress,
      });
      for (const match of matchList) {
        match.pinsMissing = ignorePins;
        match.removedCnts = removedCnts;
      }
      this.applyPinLabeling(orientation, alpha, mPinMap, matchList, this.pcbBoard.frontPadMap);
      cmOArr.push(matchList);

      if (this.pcbBoard.doubleSided) {
        const matchBList = await this.findMatches(this.pcbBoard.maskMatBack, template, alpha, this.pcbBoard.backPadMap, orientation, {
          fb: 'back',
          numFpPadsOverride: modNumFpPads,
          onProgress,
        });
        this.applyPinLabeling(orientation, alpha, pinMap, matchBList, this.pcbBoard.backPadMap);
        cmOArr.push(matchBList);
      }

      if (orientation !== 0) {
        alpha.delete();
        template.delete();
      }
    }

    modifiedAlpha.delete();
    modifiedTemplate.delete();
    for (const c of modFpContours) c.delete();

    let fMap = this.filterMatches(cmOArr);
    fMap = this.addTracesDataToMatches(fMap);

    const ffMap = [];
    for (const match of fMap) {
      if (this.checkIsolatedPins(match)) {
        this.addWarningsMissingPins(match);
        ffMap.push(match);
      }
    }
    return ffMap;
  }

  // mirrors get_matches_with_interventions
  async getMatchesWithInterventions({ onProgress = null } = {}) {
    const matchesDict = {};
    for (let i = 0; i < this.numFpPads; i++) {
      const wrappedProgress = onProgress ? (p) => onProgress({ ...p, pinIndex: i, pinTotal: this.numFpPads }) : null;
      const iMatches = await this.getIncompleteMatches([i], { onProgress: wrappedProgress });
      if (iMatches.length > 0) matchesDict[i] = iMatches;
    }

    const allMatches = [];
    for (const matches of Object.values(matchesDict)) {
      for (const match of matches) {
        if (match.warnings) {
          const warnings = match.warnings.pinsMissing;
          if (warnings.touchedPads) {
            this.findTraceCuts(match, warnings.touchedPads, warnings.touchedTraces);
          } else if (warnings.addSolderPoints) {
            match.interventions = [];
            for (const cnt of match.removedCnts) {
              const mask = newBlackMat(this.footprintMat.rows, this.footprintMat.cols);
              drawFilledContour(mask, cnt);
              const rotatedMask = rotateImage(mask, match.orientation);
              const { contours: solderContours } = findContours(rotatedMask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
              mask.delete();
              rotatedMask.delete();
              // contour[0] is kept for later visualization (stored on the intervention); any
              // further contours found aren't used and can be freed immediately.
              for (const c of solderContours.slice(1)) c.delete();
              match.interventions.push({ type: 'add solder point', contour: solderContours[0] });
            }
          }
        }
      }
      allMatches.push(matches);
    }

    return this.filterMatches(allMatches);
  }

  // mirrors filter_for_matches_on_trace
  filterForMatchesOnTrace(matches, traceID, pins) {
    const fMatches = [];
    for (const match of matches) {
      for (const pin of pins) {
        if (match.touchedTracesDict[pin] && match.touchedTracesDict[pin].includes(traceID)) {
          fMatches.push(match);
          break;
        }
      }
      if (pins.length === 0 && match.touchedTracesList.includes(traceID)) fMatches.push(match);
    }
    return fMatches;
  }

  // mirrors filter_out_traces
  filterOutTraces(matches, traces) {
    return matches.filter((match) => !match.touchedTracesList.some((t) => traces.includes(t)));
  }

  // mirrors get_matches_on_trace
  async getMatchesOnTrace(traceID, pins, ignorePads = { frontPads: [], backPads: [] }, { onProgress = null, deadline = Infinity } = {}) {
    let pinsFullTraceMatches = [];
    let fullTraceMatches = [];
    let fullMatches = [];
    let ranOutOfTime = false;

    if (this.pcbBoard.getNumPadsOnTraces([traceID]) > 10) {
      let matches = await this.getMatches({ onProgress, deadline });
      if (matches.ranOutOfTime) ranOutOfTime = true;
      matches = this.addTracesDataToMatches(matches);
      fullMatches = fullMatches.concat(matches);
      for (const match of matches) {
        if (match.touchedTracesList.includes(traceID)) {
          fullTraceMatches.push(match);
          const pinsCovered = pins.every((pin) => match.touchedTracesDict[pin] && match.touchedTracesDict[pin].includes(traceID));
          if (pinsCovered) pinsFullTraceMatches.push(match);
        }
      }
    } else {
      const conn = this.pcbBoard.boardConnectionsDict[traceID];
      for (const pad of conn.frontPads) {
        if (performance.now() > deadline) {
          ranOutOfTime = true;
          break;
        }
        if (!ignorePads.frontPads.includes(pad)) {
          let matches = await this.getMatchesAroundPad(pad, 'front', { onProgress, deadline });
          if (matches.ranOutOfTime) ranOutOfTime = true;
          matches = this.addTracesDataToMatches(matches);
          const fMatches = this.matchOnPins(matches, pad, pins);
          pinsFullTraceMatches = pinsFullTraceMatches.concat(fMatches);
          fullTraceMatches = fullTraceMatches.concat(matches);
        }
      }
      for (const pad of conn.backPads) {
        if (performance.now() > deadline) {
          ranOutOfTime = true;
          break;
        }
        if (!ignorePads.backPads.includes(pad)) {
          let matches = await this.getMatchesAroundPad(pad, 'back', { onProgress, deadline });
          if (matches.ranOutOfTime) ranOutOfTime = true;
          matches = this.addTracesDataToMatches(matches);
          const fMatches = this.matchOnPins(matches, pad, pins);
          pinsFullTraceMatches = pinsFullTraceMatches.concat(fMatches);
          fullTraceMatches = fullTraceMatches.concat(matches);
        }
      }
    }

    pinsFullTraceMatches = this.filterMatches([pinsFullTraceMatches]);
    fullTraceMatches = this.filterMatches([fullTraceMatches]);

    return { pinsFullTraceMatches, fullTraceMatches, fullMatches, ranOutOfTime };
  }

  // mirrors filter_out_pads
  filterOutPads(matches, ignorePads) {
    return matches.filter((match) => {
      const pads = match.fb === 'front' ? ignorePads.frontPads : ignorePads.backPads;
      return !match.padList.some((p) => pads.includes(p));
    });
  }

  // mirrors find_trace_cuts
  findTraceCuts(match, touchedPads, touchedTraces) {
    const front = match.fb === 'front';
    const maskContours = front ? this.pcbBoard.maskContours : this.pcbBoard.maskBackContours;
    const traceContours = front ? this.pcbBoard.traceContours : this.pcbBoard.traceBackContours;
    const pcbMat = front ? this.pcbBoard.pcbMat : this.pcbBoard.pcbMatBack;
    const padMap = front ? this.pcbBoard.frontPadMap : this.pcbBoard.backPadMap;

    let cutTraceAdded = false;

    const boundsOf = (pads) => {
      let ltX = Infinity, ltY = Infinity, rbX = -1, rbY = -1;
      for (const pad of pads) {
        const { x, y, w, h } = boundingRect(maskContours[pad]);
        ltX = Math.min(ltX, x);
        ltY = Math.min(ltY, y);
        rbX = Math.max(rbX, x + w);
        rbY = Math.max(rbY, y + h);
      }
      return { ltX, ltY, rbX, rbY };
    };

    for (const touchedTrace of touchedTraces) {
      if (!match.touchedTracesList.includes(touchedTrace)) continue;

      const conn = this.pcbBoard.boardConnectionsDict[touchedTrace];
      const padsKey = front ? 'frontPads' : 'backPads';
      const mpPadsInTrace = touchedPads.filter((p) => conn[padsKey].includes(p));
      const cpPadsInTrace = match.padList.filter((p) => conn[padsKey].includes(p));

      const mp = boundsOf(mpPadsInTrace);
      const cp = boundsOf(cpPadsInTrace);

      const cY = Math.trunc(Math.min(cp.rbY, mp.rbY) + (Math.max(cp.ltY, mp.ltY) - Math.min(cp.rbY, mp.rbY)) / 2);
      const cX = Math.trunc(Math.min(cp.rbX, mp.rbX) + (Math.max(cp.ltX, mp.ltX) - Math.min(cp.rbX, mp.rbX)) / 2);

      const tryCut = (drawCut, start, end) => {
        const traceImg = newBlackMat(pcbMat.rows, pcbMat.cols);
        drawFilledContour(traceImg, traceContours[touchedTrace]);
        drawCut(traceImg);
        const { contours: cutTraceContours } = findContours(traceImg, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
        traceImg.delete();

        const touchedIdx = (pads) => {
          const idxs = [];
          for (const pad of pads) {
            const center = padMap[pad];
            cutTraceContours.forEach((cnt, id) => {
              if (pointPolygonTest(cnt, center.x, center.y) === 1) idxs.push(id);
            });
          }
          return idxs;
        };

        const mpTouched = touchedIdx(mpPadsInTrace);
        const cpTouched = touchedIdx(cpPadsInTrace);
        const cutWorked = !cpTouched.some((id) => mpTouched.includes(id));

        if (cutWorked) {
          cutTraceAdded = true;
          if (!match.interventions) match.interventions = [];
          match.interventions.push({ type: 'cut trace', start, end, mpPads: mpPadsInTrace, cpPads: cpPadsInTrace });
        }
        for (const c of cutTraceContours) c.delete();
      };

      if (mp.rbY < cp.ltY || cp.rbY < mp.ltY) {
        const start = { x: Math.min(cp.ltX, mp.ltX), y: cY };
        const end = { x: Math.max(cp.rbX, mp.rbX), y: cY };
        tryCut((img) => drawLine(img, start.x, start.y, end.x, end.y, 0, 2), start, end);
      }

      if (mp.rbX < cp.ltX || cp.rbX < mp.ltX) {
        const start = { x: cX, y: Math.min(cp.ltY, mp.ltY) };
        const end = { x: cX, y: Math.max(cp.rbY, mp.rbY) };
        tryCut((img) => drawLine(img, start.x, start.y, end.x, end.y, 0, 2), start, end);
      }
    }

    return cutTraceAdded;
  }

  // mirrors bounded_coord
  boundedCoord(coord, maxW, maxH) {
    let { x, y } = coord;
    if (x < 0) x = 0;
    if (x > maxW) x = maxW;
    if (y < 0) y = 0;
    if (y > maxH) y = maxH;
    return { x, y };
  }

  // mirrors get_matches_around_pad
  async getMatchesAroundPad(padID, fb = 'front', { onProgress = null, deadline = Infinity } = {}) {
    const front = fb === 'front';
    const pCenter = front ? this.pcbBoard.frontPadMap[padID] : this.pcbBoard.backPadMap[padID];
    const padMap = front ? this.pcbBoard.frontPadMap : this.pcbBoard.backPadMap;
    const maskMat = front ? this.pcbBoard.maskMat : this.pcbBoard.maskMatBack;

    const { h, w } = shape(this.footprintMat);
    const { h: maxH, w: maxW } = shape(maskMat);
    const mDim = Math.max(h, w);

    const lt = this.boundedCoord({ x: pCenter.x - 2 * mDim, y: pCenter.y - 2 * mDim }, maxW, maxH);
    const rb = this.boundedCoord({ x: pCenter.x + 2 * mDim, y: pCenter.y + 2 * mDim }, maxW, maxH);

    const croppedSearchImg = cropMat(maskMat, lt.x, lt.y, rb.x - lt.x, rb.y - lt.y);
    const pinMap = this.getPinMapping(this.fpContours, this.footprint);
    const cmOArr = [];
    let ranOutOfTime = false;

    for (const orientation of ORIENTATIONS) {
      if (performance.now() > deadline) {
        ranOutOfTime = true;
        break;
      }
      let alpha, template;
      if (orientation === 0) {
        alpha = this.fpAlpha;
        template = this.footprintMat;
      } else {
        alpha = rotateImage(this.fpAlpha, orientation);
        template = bitwiseNot(alpha);
      }

      const matchList = await this.findMatches(croppedSearchImg, template, alpha, padMap, orientation, { offset: lt, fb, onProgress, deadline });
      if (matchList.ranOutOfTime) ranOutOfTime = true;
      this.applyPinLabeling(orientation, alpha, pinMap, matchList, padMap);
      cmOArr.push(matchList);

      if (orientation !== 0) {
        alpha.delete();
        template.delete();
      }
    }

    croppedSearchImg.delete();
    const result = this.filterMatches(cmOArr);
    result.ranOutOfTime = ranOutOfTime;
    return result;
  }

  // mirrors match_on_pins
  matchOnPins(matches, padID, pinArr) {
    const fMatches = [];
    for (const match of matches) {
      let addToMatches = true;

      if (pinArr.length > 1) {
        const touchedTraces = match.touchedTracesDict[pinArr[0]] || [];
        for (const pin of pinArr.slice(1)) {
          const sTouched = match.touchedTracesDict[pin] || [];
          if (!sTouched.some((t) => touchedTraces.includes(t))) {
            addToMatches = false;
            break;
          }
        }
      }
      if (!addToMatches) continue;

      let touchesPad = false;
      for (const pin of pinArr) {
        const padsTouched = match.padIDs[pin] || [];
        if (padsTouched.includes(padID)) touchesPad = true;
      }
      if (!touchesPad) addToMatches = false;

      if (addToMatches) fMatches.push(match);
    }
    return fMatches;
  }

  // mirrors add_traces_data_to_matches
  addTracesDataToMatches(matches) {
    const nMatches = [];
    for (const match of matches) {
      match.touchedTracesDict = {};
      match.touchedTracesList = [];
      for (const [pin, pads] of Object.entries(match.padIDs)) {
        for (const pad of pads) {
          for (const [traceID, traceInfo] of Object.entries(this.pcbBoard.boardConnectionsDict)) {
            const padsKey = match.fb === 'front' ? 'frontPads' : 'backPads';
            if (traceInfo[padsKey].includes(pad)) {
              if (match.touchedTracesDict[pin]) match.touchedTracesDict[pin].push(Number(traceID));
              else match.touchedTracesDict[pin] = [Number(traceID)];
              match.touchedTracesList.push(Number(traceID));
              break;
            }
          }
        }
      }
      if (Object.keys(match.touchedTracesDict).length === Object.keys(match.padIDs).length) nMatches.push(match);
    }
    return nMatches;
  }

  // mirrors add_warnings_missing_pins
  addWarningsMissingPins(match) {
    const rotatedFootprint = rotateImage(this.footprintMat, match.orientation);
    const { h, w } = shape(rotatedFootprint);
    rotatedFootprint.delete();
    const maskImg = match.fb === 'front' ? this.pcbBoard.maskMat : this.pcbBoard.maskMatBack;
    const matchCrop = cropMat(maskImg, match.coordinates.x, match.coordinates.y, w, h);
    const matchCropGray = toGray(matchCrop);
    const invMatchCrop = bitwiseNot(matchCropGray);

    const touchedPads = [];
    const touchedTraces = [];
    const touchedPadCenters = [];

    for (const removedCnt of match.removedCnts) {
      const mask = newBlackMat(this.footprintMat.rows, this.footprintMat.cols);
      drawFilledContour(mask, removedCnt);
      const rotatedMask = rotateImage(mask, match.orientation);
      const intersection = bitwiseAnd(invMatchCrop, rotatedMask);
      const { contours: intContours } = findContours(intersection, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      mask.delete();
      rotatedMask.delete();
      intersection.delete();

      for (const intCnt of intContours) {
        const c = centroid(intCnt);
        if (!c) continue;
        const mCx = Math.trunc(match.coordinates.x + c.x);
        const mCy = Math.trunc(match.coordinates.y + c.y);

        const maskContours = match.fb === 'front' ? this.pcbBoard.maskContours : this.pcbBoard.maskBackContours;
        for (const maskCnt of maskContours) {
          if (pointPolygonTest(maskCnt, mCx, mCy) === 1) {
            touchedPadCenters.push(centroid(maskCnt));
          }
        }
      }

      for (const touchedPadCenter of touchedPadCenters) {
        const padMap = match.fb === 'front' ? this.pcbBoard.frontPadMap : this.pcbBoard.backPadMap;
        for (const [padId, padCenter] of Object.entries(padMap)) {
          if (touchedPadCenter.x === padCenter.x && touchedPadCenter.y === padCenter.y) {
            touchedPads.push(Number(padId));
            const padsKey = match.fb === 'front' ? 'frontPads' : 'backPads';
            for (const [traceID, traceInfo] of Object.entries(this.pcbBoard.boardConnectionsDict)) {
              if (traceInfo[padsKey].includes(Number(padId))) {
                touchedTraces.push(Number(traceID));
                break;
              }
            }
          }
        }
      }
      for (const c of intContours) c.delete();
    }

    matchCrop.delete();
    matchCropGray.delete();
    invMatchCrop.delete();

    if (touchedPads.length > 0) {
      match.warnings = { ...(match.warnings || {}), pinsMissing: { touchedTraces, touchedPads } };
    } else {
      match.warnings = { ...(match.warnings || {}), pinsMissing: { addSolderPoints: true } };
    }
  }

  // mirrors relabel_contours
  relabelContours(cntMap, matches, padMap) {
    for (const match of matches) {
      const padCenters = {};
      const padCoverage = {};
      for (const [pin, rotContourIdx] of cntMap) {
        padCenters[pin] = [...match.padCenters[rotContourIdx]];
        padCoverage[pin] = match.padCoverage[rotContourIdx];
      }
      match.padCenters = padCenters;
      match.padCoverage = padCoverage;

      for (const [pin, arrPadCenters] of Object.entries(match.padCenters)) {
        match.padIDs[pin] = this.getListFromPadCenters(arrPadCenters, padMap);
      }
    }
  }

  // mirrors map_rt_cnt_to_pins
  mapRtCntToPins(pinCntMap, origCntMap) {
    const nCntMap = [];
    for (const [pin, oVal] of pinCntMap) {
      for (const [oFrom, oTo] of origCntMap) {
        if (oFrom === oVal) nCntMap.push([pin, oTo]);
      }
    }
    return nCntMap;
  }

  // mirrors get_pin_mapping — uses the already-parsed footprint (footprint.js) instead of
  // re-reading a .kicad_mod file from disk.
  getPinMapping(origFpContours, footprint) {
    const { h, w } = shape(this.fpAlpha);
    const map = [];

    for (const pad of footprint.pads) {
      const x = Math.trunc(pad.pos.x * 48);
      const y = Math.trunc(pad.pos.y * 48);
      const pX = x + Math.trunc(w / 2);
      const pY = y + Math.trunc(h / 2);

      for (let i = 0; i < origFpContours.length; i++) {
        if (pointPolygonTest(origFpContours[i], pX, pY) === 1) map.push([pad.number, i]);
      }
    }
    return map;
  }

  // mirrors map_pads
  mapPads(origContours, origAlpha, rtContours, rtAlpha, rtDegrees) {
    const map = [];
    for (let i = 0; i < origContours.length; i++) {
      const mask = newBlackMat(origAlpha.rows, origAlpha.cols);
      drawFilledContour(mask, origContours[i]);
      const rtMask = rotateImage(mask, rtDegrees);
      const { contours: padContour } = findContours(rtMask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      mask.delete();
      rtMask.delete();
      const c = centroid(padContour[0]);
      for (const pc of padContour) pc.delete();
      if (!c) continue;

      for (let j = 0; j < rtContours.length; j++) {
        if (pointPolygonTest(rtContours[j], c.x, c.y) === 1) map.push([i, j]);
      }
    }
    return map;
  }

  // mirrors min_pin_coverage
  minPinCoverage(coverageDict) {
    return Math.min(...Object.values(coverageDict));
  }

  // mirrors filter_matches
  filterMatches(arrMatches) {
    const fMap = [];
    const rFMatches = [];
    const bMap = [];
    const rBMatches = [];

    const sameCenters = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    for (const matchArr of arrMatches) {
      for (const match of matchArr) {
        if (match.fb === 'front' && !fMap.some((m) => sameCenters(m, match.padCenters))) {
          fMap.push(match.padCenters);
          rFMatches.push(match);
        } else if (match.fb === 'back' && !bMap.some((m) => sameCenters(m, match.padCenters))) {
          bMap.push(match.padCenters);
          rBMatches.push(match);
        } else if (match.fb === 'front') {
          for (const rFMatch of [...rFMatches]) {
            if (sameCenters(rFMatch.padCenters, match.padCenters)) {
              if (this.minPinCoverage(match.padCoverage) > this.minPinCoverage(rFMatch.padCoverage)) {
                rFMatches.splice(rFMatches.indexOf(rFMatch), 1, match);
              }
            }
          }
        } else {
          for (const rBMatch of [...rBMatches]) {
            if (sameCenters(rBMatch.padCenters, match.padCenters)) {
              if (this.minPinCoverage(match.padCoverage) > this.minPinCoverage(rBMatch.padCoverage)) {
                rBMatches.splice(rBMatches.indexOf(rBMatch), 1, match);
              }
            }
          }
        }
      }
    }

    return [...rFMatches, ...rBMatches];
  }

  // mirrors sort_matches
  sortMatches(matches) {
    return [...matches].sort((a, b) => this.minPinCoverage(b.padCoverage) - this.minPinCoverage(a.padCoverage));
  }

  // mirrors check_isolated_pins
  checkIsolatedPins(match, ignorePairs = []) {
    const touchedTraces = [];
    const touchedTracesByPin = {};

    for (const [pin, traces] of Object.entries(match.touchedTracesDict)) {
      for (const trace of traces) {
        if (!touchedTraces.includes(trace)) {
          touchedTraces.push(trace);
          touchedTracesByPin[trace] = touchedTracesByPin[trace] ? [...touchedTracesByPin[trace], pin] : [pin];
        } else {
          const touchedPins = touchedTracesByPin[trace];
          for (const touchedPin of touchedPins) {
            const isIgnored = ignorePairs.some(([a, b]) => a === pin && b === touchedPin);
            if (!isIgnored) return false;
          }
        }
      }
    }
    return true;
  }

  // mirrors get_transparent_overlay — returns an RGBA Mat with connected pads/pin1 highlighted.
  getTransparentOverlay(match) {
    const front = match.fb === 'front';
    const pcbMat = front ? this.pcbBoard.pcbMat : this.pcbBoard.pcbMatBack;
    const padMap = front ? this.pcbBoard.frontPadMap : this.pcbBoard.backPadMap;
    const maskContours = front ? this.pcbBoard.maskContours : this.pcbBoard.maskBackContours;

    const colored = new cv.Mat(pcbMat.rows, pcbMat.cols, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));

    for (const centers of Object.values(match.padCenters)) {
      for (const center of centers) {
        for (const [padId, padCenter] of Object.entries(padMap)) {
          if (center.x === padCenter.x && center.y === padCenter.y) {
            const contours = new cv.MatVector();
            contours.push_back(maskContours[Number(padId)]);
            cv.drawContours(colored, contours, 0, new cv.Scalar(255, 255, 0, 255), -1);
            contours.delete();
          }
        }
      }
    }

    for (const fpCnt of match.fpContours) {
      const contours = new cv.MatVector();
      contours.push_back(fpCnt);
      cv.drawContours(colored, contours, 0, new cv.Scalar(0, 0, 255, 255), 6, cv.LINE_8, new cv.Mat(), 0, new cv.Point(match.coordinates.x, match.coordinates.y));
      contours.delete();
    }

    const pin1Pad = match.padIDs['1'][0];
    const pin1Center = padMap[pin1Pad];
    cv.circle(colored, new cv.Point(pin1Center.x, pin1Center.y), 15, new cv.Scalar(0, 0, 255, 255), -1);

    return colored;
  }
}
