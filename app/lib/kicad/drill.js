// Excellon .drl parser — replaces identifyHoles.py's use of the `gerber` package.
// Returns Hole objects (diameter, isPlated, isVia, coordinates), mirroring identifyHoles.py's
// getHolesFromDRL. `isVia` always starts false here too — PCB_utils classifies vias later by
// sampling the rendered mask image color at each hole's coordinates, not from the drill file.

export class Hole {
  constructor({ diameter, isPlated, isVia = false, coordinates }) {
    this.diameter = diameter;
    this.isPlated = isPlated;
    this.isVia = isVia;
    this.coordinates = coordinates; // {x, y}
  }
}

export function parseDrillFile(text) {
  const lines = text.split(/\r?\n/);

  const tools = new Map(); // tool number -> { diameter, plated }
  const holes = [];

  let units = 'METRIC';
  let currentTool = null;
  let pendingPlated = null; // set by an "; #@! TA.AperFunction,(Non)Plated,..." comment line
  let inHeader = true;
  let pendingSlotStart = null;

  const coordRegex = /X(-?\d*\.?\d+)?Y(-?\d*\.?\d+)?/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith(';')) {
      const m = line.match(/TA\.AperFunction,(Plated|NonPlated)/);
      if (m) pendingPlated = m[1] === 'Plated';
      continue;
    }

    if (line === '%') {
      inHeader = false;
      continue;
    }

    if (line === 'METRIC' || line.startsWith('METRIC')) {
      units = 'METRIC';
      continue;
    }
    if (line === 'INCH' || line.startsWith('INCH')) {
      units = 'INCH';
      continue;
    }

    // Tool definition, e.g. "T1C0.300"
    const toolDef = line.match(/^T(\d+)C([\d.]+)/);
    if (toolDef && inHeader) {
      const num = parseInt(toolDef[1], 10);
      let diameter = parseFloat(toolDef[2]);
      if (units === 'INCH') diameter *= 25.4;
      tools.set(num, { diameter, plated: pendingPlated !== null ? pendingPlated : true });
      pendingPlated = null;
      continue;
    }

    // Tool selection, e.g. "T1"
    const toolSel = line.match(/^T(\d+)$/);
    if (toolSel) {
      currentTool = parseInt(toolSel[1], 10);
      continue;
    }

    // Slot cycle: "G85X..Y.." following a coordinate marks the slot's end point.
    if (line.startsWith('G85')) {
      const m = line.match(coordRegex);
      if (m && pendingSlotStart) {
        const end = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
        const tool = tools.get(currentTool) || { diameter: 0, plated: true };
        holes.push(
          new Hole({
            diameter: tool.diameter,
            isPlated: tool.plated,
            coordinates: { x: (pendingSlotStart.x + end.x) / 2, y: (pendingSlotStart.y + end.y) / 2 },
          })
        );
        pendingSlotStart = null;
      }
      continue;
    }

    // Plain coordinate hit, e.g. "X114.0Y-93.2"
    const coordMatch = line.match(coordRegex);
    if (coordMatch && (line.startsWith('X') || line.startsWith('Y'))) {
      const x = coordMatch[1] !== undefined ? parseFloat(coordMatch[1]) : null;
      const y = coordMatch[2] !== undefined ? parseFloat(coordMatch[2]) : null;
      // Look ahead handled via pendingSlotStart for G85; for a plain hit, record directly.
      if (line.includes('G85')) continue; // handled above
      pendingSlotStart = { x, y }; // in case the *next* line is a G85 slot end
      const tool = tools.get(currentTool) || { diameter: 0, plated: true };
      holes.push(new Hole({ diameter: tool.diameter, isPlated: tool.plated, coordinates: { x, y } }));
      continue;
    }
  }

  return holes;
}

// mirrors identifyHoles.py's findViasFromDrlFile: assumes the smallest drill size present is the via size.
export function findSmallestDiameterHoles(holes) {
  let smallest = Infinity;
  let result = [];
  for (const hole of holes) {
    if (hole.diameter < smallest) {
      smallest = hole.diameter;
      result = [hole.coordinates];
    } else if (hole.diameter === smallest) {
      result.push(hole.coordinates);
    }
  }
  return result;
}
