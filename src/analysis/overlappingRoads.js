// Overlapping-road check (R6): two roads whose reference lines run on top of
// each other are only legal when both are junction connecting roads. Otherwise
// an overlapping pair indicates duplicated geometry.

import { refPointAt, roadLength, laneWidthAt } from "../xodr/geometry.js";
import { sectionAt } from "../xodr/model.js";

const SAMPLE_STEP = 1.0; // meters between samples along a reference line
const ENDPOINT_MARGIN = 0.01; // meters: ignore only endpoint contact within 1 cm
const MIN_LONGITUDINAL_OVERLAP = 0.01; // meters: require positive footprint overlap

export function checkOverlappingRoads(model, lookups, issues) {
    // Roads that are exempt from the check:
    // - connecting roads assigned to a junction (junction="-1" is a normal
    //   road, including incoming and outgoing junction arms)
    const exempt = new Set();
    for (const road of model.roads) {
        if (road.junction !== undefined && String(road.junction) !== "-1") {
            exempt.add(String(road.id));
        }
    }

    for (let i = 0; i < model.roads.length; i += 1) {
        for (let j = i + 1; j < model.roads.length; j += 1) {
            const roadA = model.roads[i];
            const roadB = model.roads[j];
            // Only two connecting roads may legitimately overlap inside a
            // junction. Junction arms remain subject to this check.
            if (exempt.has(String(roadA.id)) && exempt.has(String(roadB.id))) {
                continue;
            }

            const overlap = measureOverlap(roadA, roadB);
            if (overlap === null) {
                continue;
            }

            issues.push({
                severity: "error",
                category: "road",
                title: "Overlapping roads",
                detail: `Roads ${roadA.id} and ${roadB.id} overlap over ${overlap.meters.toFixed(1)} m`
                    + ` (${overlap.fraction * 100 | 0}% of the shorter road), but they are not both`
                    + ` junction connecting roads. This usually means duplicated road geometry.`,
                location: {
                    roadIds: [roadA.id, roadB.id],
                    position: overlap.midpoint,
                },
            });
        }
    }
}

// Samples road A's reference line and checks how much of it lies on road B's
// reference line. Returns null unless enough of the shorter road overlaps.
function measureOverlap(roadA, roadB) {
    const lengthA = roadLength(roadA);
    const lengthB = roadLength(roadB);
    if (lengthA <= 0 || lengthB <= 0) {
        return null;
    }
    if (!hasLongitudinalOverlap(roadA, roadB)) {
        return null;
    }

    // Sample whichever road is cheaper to walk, test against the other.
    const [sampled, other] = lengthA <= lengthB ? [roadA, roadB] : [roadB, roadA];
    const sampledLength = Math.min(lengthA, lengthB);

    let matches = 0;
    let total = 0;
    let firstMatchS = null;
    let lastMatchS = null;

    const steps = Math.max(2, Math.ceil(sampledLength / SAMPLE_STEP));
    for (let k = 0; k <= steps; k += 1) {
        const s = (sampledLength * k) / steps;
        const point = refPointAt(sampled, s);
        if (!point) {
            continue;
        }
        total += 1;
        if (pointOnRoadSurface(sampled, s, other, point)) {
            matches += 1;
            if (firstMatchS === null) {
                firstMatchS = s;
            }
            lastMatchS = s;
        }
    }

    const overlapMeters = (lastMatchS ?? 0) - (firstMatchS ?? 0);
    if (matches === 0) {
        return null;
    }

    const midS = firstMatchS !== null ? (firstMatchS + lastMatchS) / 2 : sampledLength / 2;
    const midpoint = refPointAt(sampled, midS) || refPointAt(sampled, 0);

    return {
        meters: overlapMeters,
        fraction: matches / total,
        midpoint,
    };
}

function hasLongitudinalOverlap(roadA, roadB) {
    const start = refPointAt(roadA, 0);
    const end = refPointAt(roadA, roadLength(roadA));
    const otherStart = refPointAt(roadB, 0);
    const otherEnd = refPointAt(roadB, roadLength(roadB));
    if (!start || !end || !otherStart || !otherEnd) {
        return false;
    }

    const ux = Math.cos(start.hdg);
    const uy = Math.sin(start.hdg);
    const axis = (point) => point.x * ux + point.y * uy;
    const rangeA = [axis(start), axis(end)].sort((a, b) => a - b);
    const rangeB = [axis(otherStart), axis(otherEnd)].sort((a, b) => a - b);

    return Math.min(rangeA[1], rangeB[1]) - Math.max(rangeA[0], rangeB[0])
        >= MIN_LONGITUDINAL_OVERLAP;
}

// True if the two road footprints can overlap at this reference-line sample.
// Comparing center-line distance with both road half-widths catches parallel
// roads whose surfaces overlap even when their reference lines do not.
function pointOnRoadSurface(sampled, sampledS, other, point) {
    if (!isInterior(sampledS, roadLength(sampled))) {
        return false;
    }

    const length = roadLength(other);
    const steps = Math.max(2, Math.ceil(length / SAMPLE_STEP));
    for (let k = 0; k <= steps; k += 1) {
        const otherS = (length * k) / steps;
        if (!isInterior(otherS, length)) {
            continue;
        }
        const candidate = refPointAt(other, otherS);
        if (!candidate) {
            continue;
        }
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        const allowed = roadHalfWidthAt(sampled, sampledS) + roadHalfWidthAt(other, otherS);
        if (distance <= allowed) {
            return true;
        }
    }
    return false;
}

function isInterior(s, length) {
    return s >= ENDPOINT_MARGIN && s <= length - ENDPOINT_MARGIN;
}

function roadHalfWidthAt(road, s) {
    const section = sectionAt(road, s);
    if (!section) {
        return 0;
    }
    const sIntoSection = Math.max(0, s - section.s);
    const leftWidth = section.left.reduce(
        (total, lane) => total + laneWidthAt(lane, sIntoSection),
        0,
    );
    const rightWidth = section.right.reduce(
        (total, lane) => total + laneWidthAt(lane, sIntoSection),
        0,
    );
    return Math.max(leftWidth, rightWidth);
}
