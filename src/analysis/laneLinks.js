// Lane-level logical linkage checks (L1–L5).

import { refPointAt, roadLength, laneWidthAt, innerEdgeOffset, roadEndMarkerPosition } from "../xodr/geometry.js";

function endpointLocation(road, endName) {
    return roadEndMarkerPosition(road, endName);
}

const LANE_TYPE_GROUPS = {
    driving: ["driving", "stop", "exit", "onRamp", "offRamp", "connectingRamp"],
    soft: ["shoulder", "parking", "biking", "sidewalk", "border", "restricted"],
};

function typeGroup(type) {
    const t = String(type).toLowerCase();
    for (const [group, members] of Object.entries(LANE_TYPE_GROUPS)) {
        if (members.includes(t)) {
            return group;
        }
    }
    return "other";
}

// Returns the lane section that is active at the given contact point of a road.
function sectionAtContact(road, contactPoint) {
    if (contactPoint === "end") {
        return road.laneSections[road.laneSections.length - 1];
    }
    return road.laneSections[0];
}

// World position at the start of lane section `sectionIndex` — the boundary
// where a section-transition problem occurs.
function sectionBoundaryPosition(road, sectionIndex) {
    const s = road.laneSections[sectionIndex]?.s ?? 0;
    const ref = refPointAt(road, Math.min(s, roadLength(road)));
    return ref ? { x: ref.x, y: ref.y, z: ref.z } : null;
}

export function checkLaneLinks(model, lookups, issues) {
    const { roadById } = lookups;
    const checkedPairs = new Set();

    for (const road of model.roads) {
        checkSectionTransitions(road, issues);

        for (const [endName, link] of [["predecessor", road.predecessor], ["successor", road.successor]]) {
            if (!link || !link.elementId) {
                continue;
            }
            const target = roadById.get(String(link.elementId));
            if (!target) {
                continue; // road-level check already reported this
            }

            const thisContact = endName === "predecessor" ? "start" : "end";
            const backEnd = endName === "predecessor" ? "successor" : "predecessor";
            // contactPoint names the end of the TARGET that touches us.
            const backContact = link.contactPoint === "end" ? "end" : "start";
            const thisSection = sectionAtContact(road, thisContact);
            const otherSection = sectionAtContact(target, backContact);

            // Dedup per joint (both contacts), not per road pair — two roads
            // may legally touch at more than one pair of ends.
            const pairKey = [`${road.id}:${thisContact}`, `${target.id}:${backContact}`].sort().join("|");
            if (checkedPairs.has(pairKey)) {
                continue;
            }
            checkedPairs.add(pairKey);

            checkLanePair(road, thisSection, target, otherSection, endName, backEnd, issues);
        }
    }
}

// Collects lane-link descriptors for visualization between directly linked
// road ends: { from: {roadId, laneId, contact}, to: {...}, status }
// status: "ok" | "unidirectional"
// L5: consecutive lane sections within a road must have matching lane links.
function checkSectionTransitions(road, issues) {
    for (let i = 0; i < road.laneSections.length - 1; i += 1) {
        const from = road.laneSections[i];
        const to = road.laneSections[i + 1];
        const fromLanes = [...from.left, ...from.right];
        const toLanes = [...to.left, ...to.right];

        for (const lane of fromLanes) {
            const links = lane.links.successor;
            if (links.length === 0) {
                continue; // lane ends at section boundary — legal only if lane disappears; flagged softly
            }
            for (const link of links) {
                if (!toLanes.some((l) => l.id === link.id)) {
                    issues.push({
                        severity: "error",
                        category: "lane",
                        title: "Missing lane link target at section transition",
                        detail: `Road ${road.id}: lane ${lane.id} in section ${i} links successor to lane ${link.id}, which does not exist in section ${i + 1}.`,
                        location: { roadIds: [road.id], position: sectionBoundaryPosition(road, i + 1) },
                    });
                }
            }
        }

        for (const lane of toLanes) {
            const links = lane.links.predecessor;
            if (links.length === 0) {
                continue;
            }
            for (const link of links) {
                if (!fromLanes.some((l) => l.id === link.id)) {
                    issues.push({
                        severity: "error",
                        category: "lane",
                        title: "Missing lane link target at section transition",
                        detail: `Road ${road.id}: lane ${lane.id} in section ${i + 1} links predecessor to lane ${link.id}, which does not exist in section ${i}.`,
                        location: { roadIds: [road.id], position: sectionBoundaryPosition(road, i + 1) },
                    });
                }
            }
        }
    }
}

// L1–L4 for a pair of directly linked road ends.
function checkLanePair(roadA, sectionA, roadB, sectionB, endA, endB, issues) {
    const forwardDir = endA === "successor" ? "successor" : "predecessor";
    const backwardDir = endA === "successor" ? "predecessor" : "successor";
    const lanesA = [...sectionA.left, ...sectionA.right];
    const lanesB = [...sectionB.left, ...sectionB.right];

    for (const laneA of lanesA) {
        for (const link of laneA.links[forwardDir]) {
            const laneB = lanesB.find((l) => l.id === link.id);

            if (!laneB) {
                issues.push({
                    severity: "error",
                    category: "lane",
                    title: "Missing lane link target",
                    detail: `Road ${roadA.id} lane ${laneA.id} links ${forwardDir} to lane ${link.id} on road ${roadB.id} (${endB}), but that lane does not exist there (available: ${laneIdsSummary(lanesB)}).`,
                    location: { roadIds: [roadA.id, roadB.id], laneIds: [laneA.id, link.id], position: endpointLocation(roadA, endA) },
                });
                continue;
            }

            // L2: reciprocity
            const backLinks = laneB.links[backwardDir];
            if (!backLinks.some((l) => l.id === laneA.id)) {
                const backState = backLinks.length === 0
                    ? `has no ${backwardDir} links at all`
                    : `'s ${backwardDir} links point elsewhere (${backLinks.map((l) => l.id).join(", ")}) instead of back to lane ${laneA.id}`;
                issues.push({
                    severity: "error",
                    category: "lane",
                    title: "Unidirectional lane link",
                    detail: `Road ${roadA.id} lane ${laneA.id} → road ${roadB.id} lane ${laneB.id}, but lane ${laneB.id} ${backState}.`,
                    location: { roadIds: [roadA.id, roadB.id], laneIds: [laneA.id, laneB.id], position: endpointLocation(roadA, endA) },
                });
            }

            // L3: type compatibility
            if (typeGroup(laneA.type) !== typeGroup(laneB.type)) {
                issues.push({
                    severity: "warning",
                    category: "lane",
                    title: "Lane type mismatch",
                    detail: `Road ${roadA.id} lane ${laneA.id} (${laneA.type}) links to road ${roadB.id} lane ${laneB.id} (${laneB.type}).`,
                    location: { roadIds: [roadA.id, roadB.id], laneIds: [laneA.id, laneB.id], position: endpointLocation(roadA, endA) },
                });
            }

            // L6: geometric lane jump — the connected lanes must overlap laterally.
            // Compute each lane's lateral extent at the joint; if neither contains
            // the other, traffic would jump sideways across the connection.
            const extentA = laneExtentAtEnd(roadA, sectionA, laneA, endA);
            const extentB = laneExtentAtEnd(roadB, sectionB, laneB, endB);
            if (extentA && extentB) {
                const overlap = Math.min(extentA.outer, extentB.outer) - Math.max(extentA.inner, extentB.inner);
                const smallerWidth = Math.min(extentA.width, extentB.width);
                if (overlap < smallerWidth * 0.5 - 0.05) {
                    issues.push({
                        severity: "warning",
                        category: "lane",
                        title: "Lane link lateral jump",
                        detail: `Road ${roadA.id} lane ${laneA.id} → road ${roadB.id} lane ${laneB.id}: lanes only overlap by ${Math.max(overlap, 0).toFixed(2)} m of ${smallerWidth.toFixed(2)} m width at the joint — traffic shifts sideways.`,
                        location: { roadIds: [roadA.id, roadB.id], laneIds: [laneA.id, laneB.id], position: endpointLocation(roadA, endA) },
                    });
                }
            }
        }
    }

    // L4: center lane (id 0) must not have lane links across roads.
    if (sectionA.center && sectionA.center.links[forwardDir]?.length > 0) {
        issues.push({
            severity: "error",
            category: "lane",
            title: "Center lane link across roads",
            detail: `Road ${roadA.id} center lane (id 0) has a ${forwardDir} link; center lanes should not link across roads.`,
            location: { roadIds: [roadA.id], position: endpointLocation(roadA, endA) },
        });
    }
}

// Lateral extent [inner, outer] of a lane at a road end, measured from the
// reference line (signed: positive left). inner/outer are the lane's two edges.
function laneExtentAtEnd(road, section, lane, endName) {
    const s = endName === "predecessor" ? section.s : roadLength(road);
    const width = laneWidthAt(lane, Math.max(s - section.s, 0));
    if (width <= 0) {
        return null;
    }
    const outerAbs = innerEdgeOffset(road, section, lane, Math.min(s, roadLength(road)));
    const sign = lane.id > 0 ? 1 : -1;
    const outer = sign * outerAbs;
    const inner = outer - sign * width;
    return { inner: Math.min(inner, outer), outer: Math.max(inner, outer), width };
}

// Collects lane-link descriptors for visualization between directly linked
// road ends: { from: {roadId, laneId, contact}, to: {...}, status }
// status: "ok" | "unidirectional". One entry per declared lane link (both
// directions are merged into a single connector per lane pair).
export function collectLaneLinks(model, lookups) {
    const links = [];
    const { roadById } = lookups;
    const seenLanePairs = new Set();

    for (const road of model.roads) {
        for (const [endName, link] of [["predecessor", road.predecessor], ["successor", road.successor]]) {
            if (!link || !link.elementId) {
                continue;
            }
            const target = roadById.get(String(link.elementId));
            if (!target) {
                continue;
            }

            const thisContact = endName === "predecessor" ? "start" : "end";
            const backContact = link.contactPoint === "end" ? "end" : "start";
            const thisSection = sectionAtContact(road, thisContact);
            const otherSection = sectionAtContact(target, backContact);
            const forwardDir = endName === "successor" ? "successor" : "predecessor";
            const backwardDir = endName === "successor" ? "predecessor" : "successor";
            const lanesA = [...thisSection.left, ...thisSection.right];
            const lanesB = [...otherSection.left, ...otherSection.right];

            for (const laneA of lanesA) {
                for (const laneLink of laneA.links[forwardDir]) {
                    // Deduplicate per undirected lane pair at this joint so a
                    // reciprocal declaration (A→B and B→A) draws one connector.
                    const lanePairKey = [`${road.id}:${thisContact}:${laneA.id}`, `${target.id}:${backContact}:${laneLink.id}`].sort().join("|");
                    if (seenLanePairs.has(lanePairKey)) {
                        continue;
                    }
                    seenLanePairs.add(lanePairKey);

                    const laneB = lanesB.find((l) => l.id === laneLink.id);
                    if (!laneB) {
                        // Broken/missing target — draw a red stub from the source lane.
                        links.push({
                            from: { roadId: road.id, laneId: laneA.id, contact: thisContact },
                            to: null,
                            status: "broken",
                        });
                        continue;
                    }
                    const reciprocal = laneB.links[backwardDir].some((l) => l.id === laneA.id);
                    links.push({
                        from: { roadId: road.id, laneId: laneA.id, contact: thisContact },
                        to: { roadId: target.id, laneId: laneB.id, contact: backContact },
                        status: reciprocal ? "ok" : "unidirectional",
                    });
                }
            }
        }
    }

    return links;
}

function laneIdsSummary(lanes) {
    return lanes.map((l) => l.id).join(", ") || "none";
}
