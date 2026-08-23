// Evaluates OpenDRIVE reference-line geometry and lane boundary polylines.
// All results are in the OpenDRIVE world frame: x, y on the ground plane,
// z up (elevation). The header <offset> transform is applied on top.

import { profileEntryAt, evalCubic } from "./model.js";

const SAMPLE_STEP = 1.0; // meters between samples along a geometry

let worldOffset = { x: 0, y: 0, z: 0, hdg: 0 };

// The header <offset> is an inertial frame transform. It shifts the whole
// world (often by hundreds of km for UTM-referenced files), which wrecks
// float32 GPU precision (zig-zag rendering). We keep it only for reporting;
// rendering uses the local frame, which is identical up to this transform.
export function setWorldOffset(offset) {
    worldOffset = offset && Number.isFinite(offset.x) ? offset : { x: 0, y: 0, z: 0, hdg: 0 };
}

export function getWorldOffset() {
    return worldOffset;
}

// Point on the reference line at s: { x, y, z, hdg, pitch }
export function refPointAt(road, s) {
    const geoms = road.geometries;
    if (geoms.length === 0) {
        return null;
    }

    let geo = geoms[0];
    for (const candidate of geoms) {
        if (candidate.s <= s + 1e-9) {
            geo = candidate;
        } else {
            break;
        }
    }

    const ds = Math.min(s - geo.s, geo.length);
    let local = { x: 0, y: 0, theta: 0 };

    switch (geo.type) {
        case "line":
            local = { x: ds, y: 0, theta: 0 };
            break;
        case "arc": {
            const k = geo.curvature;
            if (Math.abs(k) < 1e-9) {
                local = { x: ds, y: 0, theta: 0 };
            } else {
                local = {
                    x: Math.sin(k * ds) / k,
                    y: (1 - Math.cos(k * ds)) / k,
                    theta: k * ds,
                };
            }
            break;
        }
        case "spiral": {
            local = spiralPoint(geo, ds);
            break;
        }
        case "poly3": {
            // v(u) = a + b*u + c*u^2 + d*u^3 in the local frame; u approximates x.
            const u = ds;
            local = {
                x: u,
                y: evalCubic({ a: geo.a, b: geo.b, c: geo.c, d: geo.d }, u),
                theta: Math.atan(evalCubic({ a: geo.b, b: 2 * geo.c, c: 3 * geo.d, d: 0 }, u)),
            };
            break;
        }
        case "paramPoly3": {
            const p = geo.pRange === "arclength" ? Math.max(ds, 0) : Math.min(Math.max(ds / Math.max(geo.length, 1e-9), 0), 1);
            const u = evalCubic({ a: geo.aU, b: geo.bU, c: geo.cU, d: geo.dU }, p);
            const v = evalCubic({ a: geo.aV, b: geo.bV, c: geo.cV, d: geo.dV }, p);
            const du = evalCubic({ a: geo.bU, b: 2 * geo.cU, c: 3 * geo.dU, d: 0 }, p);
            const dv = evalCubic({ a: geo.bV, b: 2 * geo.cV, c: 3 * geo.dV, d: 0 }, p);
            local = { x: u, y: v, theta: Math.atan2(dv, du) };
            break;
        }
        default:
            local = { x: ds, y: 0, theta: 0 };
    }

    const cosH = Math.cos(geo.hdg);
    const sinH = Math.sin(geo.hdg);

    // Deliberately NOT applying worldOffset here: geometry x/y are already
    // consistent within the local frame, and applying a UTM-scale translation
    // destroys float32 precision in the GPU (zig-zag artifacts).
    return {
        x: geo.x + local.x * cosH - local.y * sinH,
        y: geo.y + local.x * sinH + local.y * cosH,
        z: elevationAt(road, s),
        hdg: geo.hdg + local.theta,
        pitch: -Math.atan(elevationSlopeAt(road, s)),
    };
}

// Fresnel-integral based clothoid point for a spiral segment.
function spiralPoint(geo, ds) {
    const k1 = geo.curvStart;
    const k2 = geo.curvEnd;
    const dk = (k2 - k1) / Math.max(geo.length, 1e-9);

    if (Math.abs(dk) < 1e-12) {
        // Constant curvature — behaves like an arc.
        const k = k1;
        if (Math.abs(k) < 1e-9) {
            return { x: ds, y: 0, theta: 0 };
        }
        return {
            x: Math.sin(k * ds) / k,
            y: (1 - Math.cos(k * ds)) / k,
            theta: k * ds,
        };
    }

    // Numerical integration with fine steps.
    const steps = Math.max(16, Math.ceil(ds / 0.25));
    const step = ds / steps;
    let x = 0;
    let y = 0;
    let theta = 0;
    for (let i = 0; i < steps; i += 1) {
        const sMid = (i + 0.5) * step;
        const curvature = k1 + dk * sMid;
        theta += curvature * step;
        x += Math.cos(theta) * step;
        y += Math.sin(theta) * step;
    }
    return { x, y, theta };
}

export function elevationAt(road, s) {
    const entry = profileEntryAt(road.elevationProfile, s);
    if (!entry) {
        return 0;
    }
    const ds = s - entry.s;
    return evalCubic(entry, ds);
}

function elevationSlopeAt(road, s) {
    const entry = profileEntryAt(road.elevationProfile, s);
    if (!entry) {
        return 0;
    }
    const ds = s - entry.s;
    return entry.b + 2 * entry.c * ds + 3 * entry.d * ds * ds;
}

export function superelevationAt(road, s) {
    const entry = profileEntryAt(road.superelevationProfile, s);
    if (!entry) {
        return 0;
    }
    const ds = s - entry.s;
    return evalCubic(entry, ds);
}

export function laneOffsetAt(road, s) {
    const entry = profileEntryAt(road.laneOffsets, s);
    if (!entry) {
        return 0;
    }
    const ds = s - entry.s;
    return evalCubic(entry, ds);
}

export function laneWidthAt(lane, sIntoSection) {
    if (!lane.widths || lane.widths.length === 0) {
        return 0;
    }
    let entry = lane.widths[0];
    for (const candidate of lane.widths) {
        if (candidate.sOffset <= sIntoSection + 1e-9) {
            entry = candidate;
        } else {
            break;
        }
    }
    return Math.abs(evalCubic(entry, sIntoSection - entry.sOffset));
}

// Total lateral offset from the reference line to the inner edge of `lane`
// (i.e. sum of widths of all lanes between it and the center line).
export function innerEdgeOffset(road, section, lane, s) {
    const lanesBetween = lane.id > 0
        ? section.left.filter((l) => l.id < lane.id && l.id > 0)
        : section.right.filter((l) => l.id > lane.id && l.id < 0);

    const sectionStart = section.s;
    let offset = 0;
    for (const other of lanesBetween) {
        offset += laneWidthAt(other, s - sectionStart);
    }
    offset += laneWidthAt(lane, s - sectionStart);
    return offset;
}

// Sampled points along one lane's center line within its road/section range.
// Returns [{x,y,z}] plus heading per point.
export function sampleLaneCenterLine(road, sectionIndex, laneId, sampleStep = SAMPLE_STEP) {
    const section = road.laneSections[sectionIndex];
    if (!section) {
        return [];
    }
    const sectionEnd = sectionIndex + 1 < road.laneSections.length
        ? road.laneSections[sectionIndex + 1].s
        : road.length;
    const lane = [...section.left, ...section.right].find((l) => l.id === laneId);
    if (!lane) {
        return [];
    }

    const points = [];
    const steps = Math.max(2, Math.ceil((sectionEnd - section.s) / sampleStep));
    for (let i = 0; i <= steps; i += 1) {
        const s = section.s + ((sectionEnd - section.s) * i) / steps;
        const ref = refPointAt(road, s);
        if (!ref) {
            continue;
        }
        const halfWidth = laneWidthAt(lane, s - section.s) * 0.5;
        const sign = laneId > 0 ? 1 : -1;
        const t = laneOffsetAt(road, s)
            + sign * (innerEdgeOffset(road, section, lane, s) - halfWidth);
        points.push(offsetPoint(ref, t));
    }
    return points;
}

// Sampled left/right boundary polylines of a lane across its section extent.
export function sampleLaneBoundaries(road, sectionIndex, laneId, sampleStep = SAMPLE_STEP) {
    const section = road.laneSections[sectionIndex];
    if (!section) {
        return { left: [], right: [] };
    }
    const sectionEnd = sectionIndex + 1 < road.laneSections.length
        ? road.laneSections[sectionIndex + 1].s
        : road.length;
    const lane = [...section.left, ...section.right].find((l) => l.id === laneId);
    if (!lane) {
        return { left: [], right: [] };
    }

    const leftPoints = [];
    const rightPoints = [];
    const steps = Math.max(2, Math.ceil((sectionEnd - section.s) / sampleStep));
    for (let i = 0; i <= steps; i += 1) {
        const s = section.s + ((sectionEnd - section.s) * i) / steps;
        const ref = refPointAt(road, s);
        if (!ref) {
            continue;
        }
        const outer = innerEdgeOffset(road, section, lane, s);
        const inner = outer - laneWidthAt(lane, s - section.s);
        const sign = laneId > 0 ? 1 : -1;
        const laneOff = laneOffsetAt(road, s);
        leftPoints.push(offsetPoint(ref, laneOff + sign * outer));
        rightPoints.push(offsetPoint(ref, laneOff + sign * inner));
    }
    return { left: leftPoints, right: rightPoints };
}

// Sampled reference line of an entire road.
export function sampleReferenceLine(road, sampleStep = SAMPLE_STEP) {
    const points = [];
    const length = roadLength(road);
    const steps = Math.max(2, Math.ceil(length / sampleStep));
    for (let i = 0; i <= steps; i += 1) {
        const s = (length * i) / steps;
        const ref = refPointAt(road, s);
        if (ref) {
            points.push(ref);
        }
    }
    return points;
}

export function roadLength(road) {
    if (road.length > 0) {
        return road.length;
    }
    const last = road.geometries[road.geometries.length - 1];
    return last ? last.s + last.length : 0;
}

// Lateral offset from the reference line. Positive t is to the LEFT of the
// heading direction (OpenDRIVE convention).
export function offsetPoint(ref, t) {
    return {
        x: ref.x - Math.sin(ref.hdg) * t,
        y: ref.y + Math.cos(ref.hdg) * t,
        z: ref.z,
        hdg: ref.hdg,
    };
}

// World position on the CENTER LANE at road end `endName` ("predecessor" =
// s=0, "successor" = s=length), pulled `back` meters INTO the road along its
// own direction. This is where road-link markers sit; issues use the same
// point so list clicks and disc clicks focus the identical spot. The center
// lane (reference line + laneOffset) is used, NOT the raw reference line.
export function roadEndMarkerPosition(road, endName, back = 2.0) {
    const s = endName === "predecessor" ? 0 : roadLength(road);
    const ref = refPointAt(road, s);
    if (!ref) {
        return null;
    }
    const center = offsetPoint(ref, laneOffsetAt(road, s));
    // Inward direction: +s at the start, -s at the end.
    const sign = endName === "predecessor" ? 1 : -1;
    const ux = Math.cos(ref.hdg) * sign;
    const uy = Math.sin(ref.hdg) * sign;
    return {
        x: center.x + ux * back,
        y: center.y + uy * back,
        z: center.z + 0.12,
    };
}
