// Overlapping-road check (R6): two roads whose reference lines run on top of
// each other are only legal when they belong to a junction (e.g. connecting
// roads crossing inside a junction) or touch a direct junction. Otherwise an
// overlapping pair indicates duplicated geometry.

import { refPointAt, roadLength } from "../xodr/geometry.js";

const SAMPLE_STEP = 1.0; // meters between samples along a reference line
const MATCH_DIST = 0.5; // meters: sample counts as "on" the other road
const MIN_OVERLAP_FRACTION = 0.3; // fraction of the shorter road that must match

export function checkOverlappingRoads(model, lookups, issues) {
    const { junctionById } = lookups;

    // Roads that are exempt from the check:
    // - roads assigned to a junction (junction="-1" is a normal road)
    // - roads whose predecessor/successor references a junction
    const exempt = new Set();
    for (const road of model.roads) {
        if (road.junction !== undefined && String(road.junction) !== "-1") {
            exempt.add(String(road.id));
        }
        for (const link of [road.predecessor, road.successor]) {
            if (link?.elementId && junctionById.has(String(link.elementId))) {
                exempt.add(String(road.id));
            }
        }
    }

    for (let i = 0; i < model.roads.length; i += 1) {
        for (let j = i + 1; j < model.roads.length; j += 1) {
            const roadA = model.roads[i];
            const roadB = model.roads[j];
            if (exempt.has(String(roadA.id)) || exempt.has(String(roadB.id))) {
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
                    + ` (${overlap.fraction * 100 | 0}% of the shorter road), but neither belongs to a junction`
                    + ` nor connects to one. This usually means duplicated road geometry.`,
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
        if (pointOnReferenceLine(other, point)) {
            matches += 1;
            if (firstMatchS === null) {
                firstMatchS = s;
            }
            lastMatchS = s;
        }
    }

    if (total === 0 || matches / total < MIN_OVERLAP_FRACTION) {
        return null;
    }

    const midS = firstMatchS !== null ? (firstMatchS + lastMatchS) / 2 : sampledLength / 2;
    const midpoint = refPointAt(sampled, midS) || refPointAt(sampled, 0);

    return {
        meters: ((lastMatchS ?? 0) - (firstMatchS ?? 0)),
        fraction: matches / total,
        midpoint,
    };
}

// True if `point` lies within MATCH_DIST of any sample of `other`'s reference
// line. Uses a coarse-to-fine walk with early exit.
function pointOnReferenceLine(other, point) {
    const length = roadLength(other);
    const steps = Math.max(2, Math.ceil(length / SAMPLE_STEP));
    for (let k = 0; k <= steps; k += 1) {
        const candidate = refPointAt(other, (length * k) / steps);
        if (!candidate) {
            continue;
        }
        if (Math.hypot(candidate.x - point.x, candidate.y - point.y) <= MATCH_DIST) {
            return true;
        }
    }
    return false;
}
