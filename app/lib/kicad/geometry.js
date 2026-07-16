// Shared point math, ported from kicad_mod.py's _rotatePoint/_movePoint.
export function rotatePoint(point, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const x = point.x;
  const y = point.y;
  return {
    ...point,
    x: x * Math.cos(radians) - y * Math.sin(radians),
    y: y * Math.cos(radians) + x * Math.sin(radians),
  };
}

export function movePoint(point, offset) {
  return { ...point, x: point.x + offset.x, y: point.y + offset.y };
}
