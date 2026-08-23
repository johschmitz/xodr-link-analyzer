// Geometrical continuity checks (G1–G5) plus junction path checks.

import { refPointAt, roadLength, laneWidthAt } from "../xodr/geometry.js";

const DEG = 180 / Math.PI;

export function checkGeometryLinks(model, lookups, tolerances, issues) {
    const { roadById, junctionById } = lookups;
    const checkedPairs = new Set();

    for (const road of model.roads) {
        for (const [endName, link] of [["predecessor", road.predecessor], ["successor", road.successor]]) {
            if (!link || !link.elementId) {
                continue;
            }
            const target = roadById.get(String(link.elementId));
            if (!target) {
                continue;
            }

            const pairKey = [`${road.id}:${endName}`, `${link.elementId}`].sort().join("|");
            if (checkedPairs.has(pairKey)) {
                continue;
            }
            checkedPairs.add(pairKey);

            const thisContact = endName === "predecessor" ? "start" : "end";
            const backContact = link.contactPoint === "end" ? "end" : "start";

            compareEndpoints(road, thisContact, target, backContact, tolerances, issues);
        }
    }

    // Junction connections: incoming road end must meet the connecting road's
    // declared contact point.
    for (const junction of model.junctions) {
        for (const connection of junction.connections) {
            const incoming = roadById.get(String(connection.incomingRoad));
            const connecting = roadById.get(String(connection.connectingRoad));
            if (!incoming || !connecting) {
                continue; // reported by road-level checks
            }

            const incomingEnd = findIncomingEnd(incoming, junction.id);
            if (!incomingEnd) {
                continue; // reported by road-level checks
            }

            compareEndpoints(
                incoming,
                incomingEnd,
                connecting,
                connection.contactPoint === "end" ? "end" : "start",
                tolerances,
                issues,
                { junctionId: junction.id, connectionId: connection.id }
            );
        }
    }
}

function findIncomingEnd(road, junctionId) {
    if (road.predecessor && String(road.predecessor.elementId) === String(junctionId)) {
        return "start";
    }
    if (road.successor && String(road.successor.elementId) === String(junctionId)) {
        return "end";
    }
    return null;
}

// G1–G4: compare the world-space endpoint of two connected road ends.
function compareEndpoints(roadA, contactA, roadB, contactB, tolerances, issues, context = {}) {
    const pointA = endpointPoint(roadA, contactA);
    const pointB = endpointPoint(roadB, contactB);
    if (!pointA || !pointB) {
        return;
    }

    const where = context.junctionId
        ? `junction ${context.junctionId} (connection ${context.connectionId})`
        : `${contactA} of road ${roadA.id} ↔ ${contactB} of road ${roadB.id}`;
    const location = {
        roadIds: [roadA.id, roadB.id],
        position: { x: (pointA.x + pointB.x) / 2, y: (pointA.y + pointB.y) / 2, z: (pointA.z + pointB.z) / 2 },
        gap: context.junctionId ? null : { a: pointA, b: pointB },
    };

    // G1: positional gap
    const dist = Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
    if (dist > tolerances.gap) {
        issues.push({
            severity: "error",
            category: "geometry",
            title: "Contact point gap at connection",
            detail: `Gap of ${dist.toFixed(3)} m between ${where}.`,
            location,
        });
    }

    // G2: heading discontinuity
    let hdgDiff = Math.abs(normalizeAngle(pointA.hdg - pointB.hdg)) * DEG;
    // Roads meeting head-to-head connect in opposite directions.
    const opposite = contactA !== contactB;
    if (opposite) {
        hdgDiff = Math.abs(normalizeAngle(pointA.hdg - pointB.hdg + Math.PI)) * DEG;
    }
    if (hdgDiff > 90) {
        hdgDiff = Math.abs(hdgDiff - 180);
    }
    if (hdgDiff > tolerances.heading) {
        issues.push({
            severity: "error",
            category: "geometry",
            title: "Road heading discontinuity",
            detail: `Heading differs by ${hdgDiff.toFixed(2)}° between ${where}.`,
            location,
        });
    }

    // G3: elevation step
    const dz = Math.abs(pointA.z - pointB.z);
    if (dz > tolerances.z) {
        issues.push({
            severity: "error",
            category: "geometry",
            title: "Road elevation step",
            detail: `Elevation differs by ${dz.toFixed(3)} m between ${where}.`,
            location,
        });
    }

    // G5: total width mismatch across the joint (direct road-road only).
    if (!context.junctionId) {
        const widthA = totalWidthAtEnd(roadA, contactA);
        const widthB = totalWidthAtEnd(roadB, contactB);
        if (widthA > 0 && widthB > 0 && Math.abs(widthA - widthB) > 0.05 + 0.02 * Math.max(widthA, widthB)) {
            issues.push({
                severity: "warning",
                category: "geometry",
                title: "Road width mismatch",
                detail: `Total lane-group width is ${widthA.toFixed(2)} m on road ${roadA.id} vs ${widthB.toFixed(2)} m on road ${roadB.id} at ${where.replace(" ↔ ", " ↔ ")}.`,
                location,
            });
        }
    }
}

function endpointPoint(road, contact) {
    const s = contact === "start" ? 0 : roadLength(road);
    return refPointAt(road, s);
}

function totalWidthAtEnd(road, contact) {
    const section = contact === "start" ? road.laneSections[0] : road.laneSections[road.laneSections.length - 1];
    if (!section) {
        return 0;
    }
    let total = 0;
    for (const lane of [...section.left, ...section.right]) {
        total += laneWidthAt(lane, contact === "start" ? 0 : Math.max(0, roadLength(road) - section.s));
    }
    return total;
}

function normalizeAngle(a) {
    while (a > Math.PI) {
        a -= 2 * Math.PI;
    }
    while (a < -Math.PI) {
        a += 2 * Math.PI;
    }
    return a;
}
