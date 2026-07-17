// Thin ergonomics layer over opencv.js (loaded globally as `cv`) that mirrors the small set of
// cv2 calls the Python matching code (PCB_utils.py, ComponentMatch.py, NetMatch.py,
// CircuitMatch.py) actually uses. Keeping this as a separate layer means the ported algorithm
// files can stay close to their Python originals instead of being buried in opencv.js plumbing.

// Yields control back to the browser so it can repaint (a loading screen, a progress bar) during
// the long correlation/search loops in component-match.js et al. — without this, an 86-second
// match run freezes the tab solid since opencv.js's WASM calls are all synchronous.
//
// Deliberately setTimeout, not requestAnimationFrame: rAF callbacks are paused/throttled by the
// browser whenever the tab isn't visible/foregrounded, which turned a "yield every ~100ms" loop
// into an indefinite hang the moment the tab lost visibility — confirmed by progress freezing at
// an exact, unchanging value across a 15s+ window. setTimeout keeps firing regardless of tab
// visibility (background tabs may clamp it to a minimum ~1s, but it still resolves).
export function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// cv.imread requires the element to be attached to the DOM (some opencv.js builds look it up by
// id). Renderer output is an in-memory, unattached <canvas>, so read its pixels directly instead.
export function matFromImageSource(imgOrCanvas) {
  const isDomCanvas = typeof HTMLCanvasElement !== 'undefined' && imgOrCanvas instanceof HTMLCanvasElement;
  const isOffscreen = typeof OffscreenCanvas !== 'undefined' && imgOrCanvas instanceof OffscreenCanvas;
  if (isDomCanvas || isOffscreen) {
    const ctx = imgOrCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, imgOrCanvas.width, imgOrCanvas.height);
    return cv.matFromImageData(imageData);
  }
  return cv.imread(imgOrCanvas);
}

export function toGray(mat) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  return gray;
}

export function bitwiseNot(mat) {
  const out = new cv.Mat();
  cv.bitwise_not(mat, out);
  return out;
}

export function bitwiseAnd(a, b) {
  const out = new cv.Mat();
  cv.bitwise_and(a, b, out);
  return out;
}

// mirrors cv2.findContours(img, mode, method) -> returns a plain JS array of Mats (one per
// contour) plus the raw hierarchy Mat, instead of opencv.js's MatVector, so calling code can use
// normal array methods (map/filter/for..of) like the Python does with the tuple it gets back.
export function findContours(mat, mode = cv.RETR_EXTERNAL, method = cv.CHAIN_APPROX_NONE) {
  const contoursVec = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mat, contoursVec, hierarchy, mode, method);
  const contours = [];
  for (let i = 0; i < contoursVec.size(); i++) contours.push(contoursVec.get(i));
  contoursVec.delete();
  return { contours, hierarchy };
}

// mirrors cv2.moments(contour) -> {cx, cy} centroid, or null if the contour has zero area
// (mirrors the Python code's own M['m00'] > 0 guard pattern).
export function centroid(contour) {
  const m = cv.moments(contour, false);
  if (!(m.m00 > 0)) return null;
  return { x: Math.trunc(m.m10 / m.m00), y: Math.trunc(m.m01 / m.m00) };
}

export function contourArea(contour) {
  const m = cv.moments(contour, false);
  return m.m00;
}

// mirrors cv2.pointPolygonTest(contour, point, False) -> 1 (inside), 0 (on edge), -1 (outside)
export function pointPolygonTest(contour, x, y) {
  return cv.pointPolygonTest(contour, new cv.Point(x, y), false);
}

export function boundingRect(contour) {
  const r = cv.boundingRect(contour);
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

export function newBlackMat(rows, cols) {
  return cv.Mat.zeros(rows, cols, cv.CV_8UC1);
}

export function drawFilledContour(mat, contour, colorValue = 255) {
  const contours = new cv.MatVector();
  contours.push_back(contour);
  cv.drawContours(mat, contours, 0, new cv.Scalar(colorValue, colorValue, colorValue, 255), -1);
  contours.delete();
}

export function drawLine(mat, x1, y1, x2, y2, colorValue, thickness) {
  cv.line(mat, new cv.Point(x1, y1), new cv.Point(x2, y2), new cv.Scalar(colorValue, colorValue, colorValue, 255), thickness);
}

export function copyMakeBorder(mat, border, colorValue = 255) {
  const out = new cv.Mat();
  cv.copyMakeBorder(
    mat,
    out,
    border,
    border,
    border,
    border,
    cv.BORDER_CONSTANT,
    new cv.Scalar(colorValue, colorValue, colorValue, 255)
  );
  return out;
}

// Counts pixels equal to `value` — mirrors np.sum(img == value), summing across *all* channels of
// whatever Mat is passed in (RGBA from canvas sources here), same as the Python original naively
// summing over cv2.imread's 3-channel BGR arrays.
//
// The images this is ever called on are strictly binary (0/255) per channel, so for value===255
// this uses a native WASM fast path: cv.mean(mat) gives the per-channel average, and
// mean * totalPixelsPerChannel is exactly 255 * (count of 255s in that channel) — so summing that
// across channels and dividing by 255 recovers the same count the manual loop computes, without
// looping over every byte in JS. (cv.countNonZero would be the obvious choice but requires
// single-channel input and throws on RGBA; verified this cv.mean approach against the manual loop
// on real Mat data before relying on it, after an earlier countNonZero attempt broke on RGBA.)
export function countPixelsEqual(mat, value) {
  if (value === 255) {
    const means = cv.mean(mat);
    const totalPixels = mat.rows * mat.cols;
    let sum = 0;
    for (let c = 0; c < mat.channels(); c++) sum += means[c] * totalPixels;
    return Math.round(sum / 255);
  }
  let count = 0;
  const data = mat.data;
  for (let i = 0; i < data.length; i++) if (data[i] === value) count++;
  return count;
}

// mirrors cv2.minMaxLoc(mat) for a single-channel float64 Mat of correlation scores.
export function minMaxLoc(mat) {
  const r = cv.minMaxLoc(mat);
  return { minVal: r.minVal, maxVal: r.maxVal, minLoc: r.minLoc, maxLoc: r.maxLoc };
}

// Fills a filled circle with `colorValue` directly into a Float64 correlation Mat (used to
// "black out" a location so the match-finding loop doesn't get stuck on it), mirroring
// cv2.circle(res, max_loc, radius, color=0, thickness=FILLED) on a float32 Mat.
export function blackoutCircle(mat, x, y, radius) {
  cv.circle(mat, new cv.Point(x, y), radius, new cv.Scalar(0, 0, 0, 0), -1);
}

// mirrors ComponentMatch.py's `rotation()`: rotates an image about its center, expanding the
// canvas so nothing is cropped, matching cv2.warpAffine's behavior.
export function rotateImage(mat, angleDegrees) {
  const w = mat.cols;
  const h = mat.rows;
  const center = new cv.Point(w / 2, h / 2);
  const rad = (angleDegrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const bw = Math.round(h * sin + w * cos);
  const bh = Math.round(h * cos + w * sin);

  const rot = cv.getRotationMatrix2D(center, angleDegrees, 1);
  // rot is a 2x3 CV_64F Mat: adjust translation like the Python does with rot[0,2]/rot[1,2]
  rot.doublePtr(0, 2)[0] += bw / 2 - center.x;
  rot.doublePtr(1, 2)[0] += bh / 2 - center.y;

  const dst = new cv.Mat();
  const dsize = new cv.Size(bw, bh);
  cv.warpAffine(mat, dst, rot, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
  rot.delete();
  return dst;
}

export function cropMat(mat, x, y, w, h) {
  return mat.roi(new cv.Rect(x, y, w, h));
}

export function shape(mat) {
  return { h: mat.rows, w: mat.cols };
}

export function newTransparentCanvasMat(rows, cols) {
  return new cv.Mat(rows, cols, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));
}

// Fills a single contour (not a whole MatVector) — owns and frees its own temporary vector
// internally so callers never need to build/leak a MatVector just to draw one contour.
export function fillContourAt(mat, contour, colorRgb, thickness = -1) {
  const vec = new cv.MatVector();
  vec.push_back(contour);
  cv.drawContours(mat, vec, 0, new cv.Scalar(colorRgb[0], colorRgb[1], colorRgb[2], 255), thickness);
  vec.delete();
}

export function drawContourAtOffset(mat, contour, colorRgb, thickness, offsetX, offsetY) {
  const vec = new cv.MatVector();
  vec.push_back(contour);
  cv.drawContours(mat, vec, 0, new cv.Scalar(colorRgb[0], colorRgb[1], colorRgb[2], 255), thickness, cv.LINE_8, new cv.Mat(), 0, new cv.Point(offsetX, offsetY));
  vec.delete();
}
