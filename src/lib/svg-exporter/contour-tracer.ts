import type { RegionInfo } from "../image-processor/region-segmenter";

export const DEFAULT_RDP_EPSILON = 0.9;
export const MIN_RDP_EPSILON = 0.4;
export const MAX_RDP_EPSILON = 2.0;
export const CHAIKIN_SHARP_ANGLE_DEG = 75;
const CHAIKIN_COS_THRESHOLD = Math.cos((CHAIKIN_SHARP_ANGLE_DEG * Math.PI) / 180);

export interface Point2D {
  x: number;
  y: number;
}

export interface TracedPathResult {
  d: string;
  subPathCount: number;
  vertexCount: number;
}

// Directed step vectors for East (0), South (1), West (2), North (3)
const STEP_DX = [1, 0, -1, 0] as const;
const STEP_DY = [0, 1, 0, -1] as const;

function formatCoord(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Losslessly removes collinear intermediate vertices on horizontal/vertical
 * or straight segments of a closed polygon loop.
 */
function compactCollinearLoop(points: Point2D[]): Point2D[] {
  const n = points.length;
  if (n <= 3) return points;

  const result: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    // Cross product === 0 and same direction means curr is collinear
    if (dx1 * dy2 - dy1 * dx2 === 0 && dx1 * dx2 + dy1 * dy2 > 0) {
      continue;
    }
    result.push(curr);
  }

  return result.length >= 3 ? result : points;
}

function perpendicularDistanceSq(
  point: Point2D,
  lineStart: Point2D,
  lineEnd: Point2D,
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const px = point.x - lineStart.x;
    const py = point.y - lineStart.y;
    return px * px + py * py;
  }

  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq;
  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  const ex = point.x - projX;
  const ey = point.y - projY;
  return ex * ex + ey * ey;
}

function rdpOpenChain(
  points: Point2D[],
  startIdx: number,
  endIdx: number,
  epsilonSq: number,
  keepFlags: Uint8Array,
): void {
  // Iterative stack avoids recursion depth overflow on large perimeters
  const stack: Array<[number, number]> = [[startIdx, endIdx]];

  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    if (e - s <= 1) continue;

    let maxDistSq = -1;
    let maxIdx = -1;

    const pStart = points[s];
    const pEnd = points[e];

    for (let i = s + 1; i < e; i++) {
      const dSq = perpendicularDistanceSq(points[i], pStart, pEnd);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        maxIdx = i;
      }
    }

    if (maxIdx !== -1 && maxDistSq > epsilonSq) {
      keepFlags[maxIdx] = 1;
      stack.push([s, maxIdx], [maxIdx, e]);
    }
  }
}

/**
 * Simplifies a closed polygon loop using a diameter-split Ramer-Douglas-Peucker
 * pass so closed-curve seam points do not introduce artificial kinks.
 */
export function simplifyClosedLoopRdp(
  loop: Point2D[],
  epsilon: number,
): Point2D[] {
  const compacted = compactCollinearLoop(loop);
  const n = compacted.length;

  if (n <= 4 || epsilon <= 0) {
    return compacted;
  }

  // Two-pass approximate polygon diameter split
  let anchorA = 0;
  let maxDistA = -1;
  for (let i = 1; i < n; i++) {
    const dx = compacted[i].x - compacted[0].x;
    const dy = compacted[i].y - compacted[0].y;
    const dSq = dx * dx + dy * dy;
    if (dSq > maxDistA) {
      maxDistA = dSq;
      anchorA = i;
    }
  }

  let anchorB = (anchorA + Math.floor(n / 2)) % n;
  let maxDistB = -1;
  for (let i = 0; i < n; i++) {
    if (i === anchorA) continue;
    const dx = compacted[i].x - compacted[anchorA].x;
    const dy = compacted[i].y - compacted[anchorA].y;
    const dSq = dx * dx + dy * dy;
    if (dSq > maxDistB) {
      maxDistB = dSq;
      anchorB = i;
    }
  }

  // Reorder loop so anchorA is index 0 and anchorB is splitIdx
  const ordered: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    ordered.push(compacted[(anchorA + i) % n]);
  }
  const splitIdx = (anchorB - anchorA + n) % n;
  const closedChain = [...ordered, ordered[0]];

  const keepFlags = new Uint8Array(closedChain.length);
  keepFlags[0] = 1;
  keepFlags[splitIdx] = 1;
  keepFlags[n] = 1;

  const epsSq = epsilon * epsilon;
  rdpOpenChain(closedChain, 0, splitIdx, epsSq, keepFlags);
  rdpOpenChain(closedChain, splitIdx, n, epsSq, keepFlags);

  const simplified: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    if (keepFlags[i] === 1) {
      simplified.push(closedChain[i]);
    }
  }

  // Never collapse a valid closed polygon below a triangle
  return simplified.length >= 3 ? simplified : compacted;
}

/**
 * Light angle-preserving Chaikin corner-cutting smoothing on a closed loop.
 * Obtuse corners (>= 75 deg) are softly chamfered into smooth vector curves,
 * while sharp corners (< 75 deg, e.g. star tips & cat ears) stay razor sharp.
 */
export function applySelectiveChaikinSmoothing(
  loop: Point2D[],
  passes: number = 1,
): Point2D[] {
  let current = loop;

  for (let pass = 0; pass < passes; pass++) {
    const n = current.length;
    if (n < 4) break;

    const nextLoop: Point2D[] = [];

    for (let i = 0; i < n; i++) {
      const prev = current[(i - 1 + n) % n];
      const curr = current[i];
      const next = current[(i + 1) % n];

      const ux = prev.x - curr.x;
      const uy = prev.y - curr.y;
      const wx = next.x - curr.x;
      const wy = next.y - curr.y;

      const uLen = Math.hypot(ux, uy);
      const wLen = Math.hypot(wx, wy);

      if (uLen === 0 || wLen === 0) {
        nextLoop.push(curr);
        continue;
      }

      const cosTheta = (ux * wx + uy * wy) / (uLen * wLen);
      // If cosTheta > cos(75 deg), interior vertex angle is < 75 deg -> preserve sharp corner
      if (cosTheta > CHAIKIN_COS_THRESHOLD) {
        nextLoop.push(curr);
        continue;
      }

      // Skip corner-cutting on tiny micro-segments (< 1.5px) to avoid degenerate kinks
      if (uLen < 1.5 && wLen < 1.5) {
        nextLoop.push(curr);
        continue;
      }

      const cut = 0.22;
      nextLoop.push(
        {
          x: curr.x + ux * cut,
          y: curr.y + uy * cut,
        },
        {
          x: curr.x + wx * cut,
          y: curr.y + wy * cut,
        },
      );
    }

    current = nextLoop;
  }

  return current;
}

/**
 * Traces all outer and inner-hole boundary loops for a set of regionIds
 * from regionMap using an exact directed pixel-corner edge graph,
 * then simplifies each loop with RDP + optional selective Chaikin smoothing.
 */
export function traceRegionGroupToSvgPath(params: {
  regionMap: Int32Array;
  width: number;
  height: number;
  regionIds: number[];
  sourceRegions: RegionInfo[];
  epsilon?: number;
  smoothCurves?: boolean;
}): TracedPathResult {
  const { regionMap, width, height, regionIds, sourceRegions } = params;
  const epsilon = Math.max(
    0,
    Math.min(4, params.epsilon ?? DEFAULT_RDP_EPSILON),
  );
  const smoothCurves = params.smoothCurves ?? true;

  if (regionIds.length === 0 || width <= 0 || height <= 0) {
    return { d: "", subPathCount: 0, vertexCount: 0 };
  }

  // Build O(1) region membership lookup and union bounding box
  let maxRegionId = sourceRegions.length;
  for (const id of regionIds) {
    if (id > maxRegionId) maxRegionId = id;
  }

  const memberMask = new Uint8Array(maxRegionId + 1);
  let gMinX = width;
  let gMinY = height;
  let gMaxX = -1;
  let gMaxY = -1;

  for (const id of regionIds) {
    if (id <= 0 || id > maxRegionId) continue;
    memberMask[id] = 1;
    const reg = sourceRegions[id - 1];
    if (reg) {
      if (reg.boundingBox.minX < gMinX) gMinX = reg.boundingBox.minX;
      if (reg.boundingBox.minY < gMinY) gMinY = reg.boundingBox.minY;
      if (reg.boundingBox.maxX > gMaxX) gMaxX = reg.boundingBox.maxX;
      if (reg.boundingBox.maxY > gMaxY) gMaxY = reg.boundingBox.maxY;
    }
  }

  if (gMaxX < gMinX || gMaxY < gMinY) {
    gMinX = 0;
    gMinY = 0;
    gMaxX = width - 1;
    gMaxY = height - 1;
  }

  const bw = gMaxX - gMinX + 1;
  const bh = gMaxY - gMinY + 1;
  const vw = bw + 1;
  const vh = bh + 1;

  // Materialize a flat binary foreground buffer once for fast O(1) edge mask indexing
  const fgBuf = new Uint8Array(bw * bh);
  for (let ly = 0; ly < bh; ly++) {
    const srcRow = (gMinY + ly) * width + gMinX;
    const dstRow = ly * bw;
    for (let lx = 0; lx < bw; lx++) {
      const rid = regionMap[srcRow + lx];
      if (rid > 0 && rid <= maxRegionId && memberMask[rid] === 1) {
        fgBuf[dstRow + lx] = 1;
      }
    }
  }

  // 4-bit outgoing edge mask per grid vertex: bit0=East, bit1=South, bit2=West, bit3=North
  const edgeMask = new Uint8Array(vw * vh);
  let edgeCount = 0;

  for (let vy = 0; vy < vh; vy++) {
    const vRow = vy * vw;
    for (let vx = 0; vx < vw; vx++) {
      const tl = vx > 0 && vy > 0 ? fgBuf[(vy - 1) * bw + (vx - 1)] : 0;
      const tr = vx < bw && vy > 0 ? fgBuf[(vy - 1) * bw + vx] : 0;
      const bl = vx > 0 && vy < bh ? fgBuf[vy * bw + (vx - 1)] : 0;
      const br = vx < bw && vy < bh ? fgBuf[vy * bw + vx] : 0;

      let bits = 0;
      if (br === 1 && tr === 0) {
        bits |= 1; // East
        edgeCount++;
      }
      if (bl === 1 && br === 0) {
        bits |= 2; // South
        edgeCount++;
      }
      if (tl === 1 && bl === 0) {
        bits |= 4; // West
        edgeCount++;
      }
      if (tr === 1 && tl === 0) {
        bits |= 8; // North
        edgeCount++;
      }
      if (bits !== 0) {
        edgeMask[vRow + vx] = bits;
      }
    }
  }

  if (edgeCount === 0) {
    return { d: "", subPathCount: 0, vertexCount: 0 };
  }

  const subPaths: string[] = [];
  let totalVertices = 0;

  // Walk every disjoint directed boundary cycle (outer loops + interior holes)
  for (let startVy = 0; startVy < vh; startVy++) {
    for (let startVx = 0; startVx < vw; startVx++) {
      const startV = startVy * vw + startVx;
      while (edgeMask[startV] !== 0) {
        const mask = edgeMask[startV];
        let startDir = 0;
        if ((mask & 1) !== 0) startDir = 0;
        else if ((mask & 2) !== 0) startDir = 1;
        else if ((mask & 4) !== 0) startDir = 2;
        else startDir = 3;

        const rawLoop: Point2D[] = [];
        let currVx = startVx;
        let currVy = startVy;
        let currDir = startDir;
        let steps = 0;
        const maxSteps = edgeCount + 4;

        while (steps < maxSteps) {
          rawLoop.push({ x: gMinX + currVx, y: gMinY + currVy });

          // Advance along currDir
          currVx += STEP_DX[currDir];
          currVy += STEP_DY[currDir];
          steps++;

          const currV = currVy * vw + currVx;
          const vMask = edgeMask[currV];

          // Turn right first to stay strictly on one side of saddle vertices
          const candidates = [
            (currDir + 1) & 3,
            currDir,
            (currDir + 3) & 3,
          ];
          let nextDir = -1;
          for (const cand of candidates) {
            if ((vMask & (1 << cand)) !== 0) {
              nextDir = cand;
              break;
            }
          }

          if (nextDir === -1) {
            break;
          }

          if (currVx === startVx && currVy === startVy && nextDir === startDir) {
            // Completed closed cycle back onto start edge; consume start edge & finish
            edgeMask[startV] &= ~(1 << startDir);
            break;
          }

          edgeMask[currV] &= ~(1 << nextDir);
          currDir = nextDir;
        }

        // Safety ensure start edge is cleared even if loop terminated early
        edgeMask[startV] &= ~(1 << startDir);

        if (rawLoop.length >= 3) {
          const simplified = simplifyClosedLoopRdp(rawLoop, epsilon);
          const finalLoop =
            smoothCurves && epsilon > 0
              ? applySelectiveChaikinSmoothing(simplified, 1)
              : simplified;
          totalVertices += finalLoop.length;

          const parts: string[] = [
            `M${formatCoord(finalLoop[0].x)} ${formatCoord(finalLoop[0].y)}`,
          ];
          for (let i = 1; i < finalLoop.length; i++) {
            parts.push(
              `L${formatCoord(finalLoop[i].x)} ${formatCoord(finalLoop[i].y)}`,
            );
          }
          parts.push("Z");
          subPaths.push(parts.join(""));
        }
      }
    }
  }

  return {
    d: subPaths.join(""),
    subPathCount: subPaths.length,
    vertexCount: totalVertices,
  };
}
