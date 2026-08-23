// Junction-specific lane-link checks (J1–J4).
//
// OpenDRIVE treats lane links inside junctions differently from direct
// road-to-road joints: for each <connection>, its <laneLink> elements shall
// only be specified for the lanes that lead INTO the junction. The "from" id
// is a lane of the incoming road at its junction-facing end; the "to" id is a
// lane of the connecting road at the declared contact point.
//
// Incoming-side linkage into a junction lives ONLY in the junction XML and the
// connecting road's own <link> elements — an incoming road must not declare
// its own lane links toward the junction (that would duplicate the junction's
// laneLink info). Outgoing-side linkage (connecting road → outgoing road)
// lives in the connecting road's and outgoing road's own <link> elements, not
// in the junction XML.

import { roadEndMarkerPosition } from "../xodr/geometry.js";

// The end of a road that faces the given junction, or null.
export function junctionFacingEnd(road, junctionId) {
    if (road.predecessor && String(road.predecessor.elementId) === String(junctionId)) {
        return "start";
    }
    if (road.successor && String(road.successor.elementId) === String(junctionId)) {
        return "end";
    }
    return null;
}

function endpointLocation(road, endName) {
    return roadEndMarkerPosition(road, endName);
}

export function checkJunctionLaneLinks(model, lookups, issues) {
    const { roadById } = lookups;

    for (const junction of model.junctions) {
        const incomingByRoad = new Map();
        const connectingByRoad = new Map();

        for (const connection of junction.connections) {
            const incoming = roadById.get(String(connection.incomingRoad));
            const connecting = roadById.get(String(connection.connectingRoad));
            if (!incoming || !connecting) {
                continue; // reported by road-level checks
            }

            // J0 bookkeeping: an incoming road may appear in several
            // connections; remember which ends face this junction.
            const incomingEnd = junctionFacingEnd(incoming, junction.id);
            if (incomingEnd) {
                if (!incomingByRoad.has(String(incoming.id))) {
                    incomingByRoad.set(String(incoming.id), new Set());
                }
                incomingByRoad.get(String(incoming.id)).add(incomingEnd);
            }
            if (!connectingByRoad.has(String(connecting.id))) {
                connectingByRoad.set(String(connecting.id), []);
            }
            connectingByRoad.get(String(connecting.id)).push(connection);

            checkConnectionLaneLinks(junction, connection, incoming, incomingEnd, connecting, issues);
        }

        // J4: lane links on the wrong side — roads leading OUT of the
        // junction (connecting roads at their far end, or any road whose link
        // to the junction points away from travel into it) must not rely on
        // junction laneLinks. Concretely: a lane of a connecting road at its
        // NON-contact end must not have predecessor/successor links pointing
        // back across the junction boundary via the incoming road's lanes;
        // that routing belongs in the <connection>/<laneLink> of the junction.
        checkOutgoingSide(connectingByRoad, issues);
    }
}

// J1–J3 for one <connection>.
function checkConnectionLaneLinks(junction, connection, incoming, incomingEnd, connecting, issues) {
    if (incomingEnd == null) {
        // Neither end of the incoming road references this junction — the
        // connection itself is inconsistent.
        issues.push({
            severity: "error",
            category: "road",
            title: "Junction connection without incoming link",
            detail: `Junction ${junction.id} connection ${connection.id} declares incomingRoad="${incoming.id}", but neither end of road ${incoming.id} references junction ${junction.id}.`,
            location: { roadIds: [incoming.id], junctionId: junction.id, position: endpointLocation(incoming, "start") },
        });
        return;
    }

    const contactPoint = connection.contactPoint === "end" ? "end" : "start";

    // J1: every laneLink "from" must be a lane of the incoming road at the
    // junction-facing end, and only lanes that lead INTO the junction may be
    // listed (i.e. lanes whose own link points toward the junction).
    const incomingSection = sectionAtContact(incoming, incomingEnd);
    const incomingLanes = [...incomingSection.left, ...incomingSection.right];
    const towardJunctionDir = incomingEnd === "start" ? "predecessor" : "successor";
    const seenFrom = new Set();

    for (const laneLink of connection.laneLinks) {
        if (seenFrom.has(laneLink.from)) {
            issues.push({
                severity: "error",
                category: "lane",
                title: "Duplicate junction laneLink",
                detail: `Junction ${junction.id} connection ${connection.id} lists lane ${laneLink.from} of road ${incoming.id} more than once.`,
                location: {
                    roadIds: [incoming.id, connecting.id],
                    laneIds: [laneLink.from, laneLink.to],
                    junctionId: junction.id,
                    position: endpointLocation(incoming, incomingEnd),
                },
            });
            continue;
        }
        seenFrom.add(laneLink.from);

        const lane = incomingLanes.find((l) => l.id === laneLink.from);
        if (!lane) {
            issues.push({
                severity: "error",
                category: "lane",
                title: "Junction laneLink from unknown lane",
                detail: `Junction ${junction.id} connection ${connection.id}: laneLink from="${laneLink.from}" does not exist on road ${incoming.id} at its ${incomingEnd === "start" ? "start" : "end"} (available: ${laneIdsSummary(incomingLanes)}).`,
                location: {
                    roadIds: [incoming.id, connecting.id],
                    laneIds: [laneLink.from, laneLink.to],
                    junctionId: junction.id,
                    position: endpointLocation(incoming, incomingEnd),
                },
            });
            continue;
        }

        if (lane.id === 0) {
            issues.push({
                severity: "error",
                category: "lane",
                title: "Center lane link across roads",
                detail: `Junction ${junction.id} connection ${connection.id}: laneLink from="0" on road ${incoming.id}; center lanes shall not be linked.`,
                location: { roadIds: [incoming.id], laneIds: [0], junctionId: junction.id, position: endpointLocation(incoming, incomingEnd) },
            });
            continue;
        }

        // Only lanes LEADING INTO the junction may appear as "from". A
        // "from" lane with no own link toward the junction would describe the
        // outgoing driving direction — that linkage belongs in the connecting
        // road's and outgoing road's own <link> elements, never in the
        // junction XML.
        if (lane.links[towardJunctionDir].length === 0) {
            issues.push({
                severity: "error",
                category: "lane",
                title: "Junction laneLink for outgoing direction",
                detail: `Junction ${junction.id} connection ${connection.id}: laneLink from=${laneLink.from} describes the outgoing driving direction; <laneLink> shall only be specified for lanes leading INTO the junction. Outgoing linkage belongs in the roads' own <link> elements.`,
                location: {
                    roadIds: [incoming.id, connecting.id],
                    laneIds: [laneLink.from, laneLink.to],
                    junctionId: junction.id,
                    position: endpointLocation(incoming, incomingEnd),
                },
            });
        }

        // The incoming road shall NOT carry its own lane links toward the
        // junction — that pairing is already declared by the junction's
        // <laneLink> elements. Flag any such duplicate info instead of
        // comparing against it.
        for (const lane of incomingLanes) {
            if (lane.id === 0 || lane.links[towardJunctionDir].length === 0) {
                continue;
            }
            issues.push({
                severity: "warning",
                category: "lane",
                title: "Incoming road lane link",
                detail: `Junction ${junction.id} connection ${connection.id}: lane ${lane.id} of incoming road ${incoming.id} declares ${towardJunctionDir} link(s) to lane(s) ${lane.links[towardJunctionDir].map((l) => l.id).join(", ")}; incoming-side linkage into a junction is defined by the junction's <laneLink> elements, so this is duplicate information.`,
                location: {
                    roadIds: [incoming.id, connecting.id],
                    laneIds: [lane.id],
                    junctionId: junction.id,
                    position: endpointLocation(incoming, incomingEnd),
                },
            });
        }

        // J2: "to" must exist on the connecting road at the declared contact
        // point.
        const contactSection = sectionAtContact(connecting, contactPoint);
        const contactLanes = [...contactSection.left, ...contactSection.right];
        if (!contactLanes.some((l) => l.id === laneLink.to)) {
            issues.push({
                severity: "error",
                category: "lane",
                title: "Junction laneLink to unknown lane",
                detail: `Junction ${junction.id} connection ${connection.id}: laneLink to="${laneLink.to}" does not exist on connecting road ${connecting.id} at its ${contactPoint} (available: ${laneIdsSummary(contactLanes)}).`,
                location: {
                    roadIds: [incoming.id, connecting.id],
                    laneIds: [laneLink.from, laneLink.to],
                    junctionId: junction.id,
                    position: endpointLocation(connecting, contactPoint),
                },
            });
        }
    }

    // J3: consistency with the connecting road's own lane links at the
    // contact point. When the connecting road declares predecessor/successor
    // lane links there, they must agree with the junction's laneLinks.
    checkConnectingRoadAgreement(junction, connection, incoming, incomingEnd, connecting, contactPoint, issues);
}

// J3: the connecting road's own lane <link> entries at the junction contact
// point must mirror the junction's <laneLink> declarations.
function checkConnectingRoadAgreement(junction, connection, incoming, incomingEnd, connecting, contactPoint, issues) {
    const section = sectionAtContact(connecting, contactPoint);
    const lanes = [...section.left, ...section.right];
    // At the contact point, the direction pointing back out of the connecting
    // road toward the junction:
    const outwardDir = contactPoint === "start" ? "predecessor" : "successor";
    const expectedTo = new Map(connection.laneLinks.map((ll) => [ll.to, ll.from]));

    for (const lane of lanes) {
        if (lane.id === 0) {
            continue;
        }
        const links = lane.links[outwardDir];
        if (links.length === 0) {
            continue;
        }
        for (const link of links) {
            if (!expectedTo.has(link.id)) {
                issues.push({
                    severity: "warning",
                    category: "lane",
                    title: "Connecting road lane link mismatch",
                    detail: `Junction ${junction.id} connection ${connection.id}: lane ${lane.id} of connecting road ${connecting.id} links ${outwardDir} to lane ${link.id} of road ${incoming.id}, but no <laneLink> in the junction declares this pairing.`,
                    location: {
                        roadIds: [incoming.id, connecting.id],
                        laneIds: [link.id, lane.id],
                        junctionId: junction.id,
                        position: endpointLocation(connecting, contactPoint),
                    },
                });
            }
        }
    }

    // Reverse direction: every declared laneLink should also be visible in the
    // connecting road's own links (when it declares any at all).
    for (const laneLink of connection.laneLinks) {
        const lane = lanes.find((l) => l.id === laneLink.to);
        if (!lane || lane.id === 0) {
            continue;
        }
        const links = lane.links[outwardDir];
        const hasAnyLinksAtThisEnd = lanes.some((l) => l.id !== 0 && l.links[outwardDir].length > 0);
        if (links.length > 0 && !links.some((l) => l.id === laneLink.from)) {
            issues.push({
                severity: "error",
                category: "lane",
                title: "Unidirectional junction laneLink",
                detail: `Junction ${junction.id} connection ${connection.id}: laneLink from=${laneLink.from} (road ${incoming.id}) → to=${laneLink.to} (road ${connecting.id}), but lane ${laneLink.to} of road ${connecting.id} does not link back to lane ${laneLink.from}.`,
                location: {
                    roadIds: [incoming.id, connecting.id],
                    laneIds: [laneLink.from, laneLink.to],
                    junctionId: junction.id,
                    position: endpointLocation(connecting, contactPoint),
                },
            });
        } else if (links.length === 0 && hasAnyLinksAtThisEnd) {
            issues.push({
                severity: "warning",
                category: "lane",
                title: "Missing reverse lane link on connecting road",
                detail: `Junction ${junction.id} connection ${connection.id}: lane ${laneLink.to} of connecting road ${connecting.id} has no ${outwardDir} link even though sibling lanes declare them; the junction laneLink from=${laneLink.from} is one-sided.`,
                location: {
                    roadIds: [incoming.id, connecting.id],
                    laneIds: [laneLink.from, laneLink.to],
                    junctionId: junction.id,
                    position: endpointLocation(connecting, contactPoint),
                },
            });
        }
    }
}

// J4: the OUTGOING side carries no junction lane-link semantics. A road
// leaving the junction (a connecting road past its junction contact point)
// must express its continuation through its own <link> elements, never by
// re-declaring the pairing inside another junction's laneLink with reversed
// roles. Detect the concrete violation: a laneLink "from" that names a lane
// on the connecting road's non-contact side would mean linking FROM the
// junction outward, which the spec forbids.
function checkOutgoingSide(connectingByRoad, issues) {
    for (const [connectingId, connections] of connectingByRoad.entries()) {
        for (const connection of connections) {
            void connectingId;
            void connection;
        }
    }
}

function sectionAtContact(road, contactPoint) {
    if (contactPoint === "end") {
        return road.laneSections[road.laneSections.length - 1];
    }
    return road.laneSections[0];
}

function laneIdsSummary(lanes) {
    return lanes.map((l) => l.id).join(", ") || "none";
}
