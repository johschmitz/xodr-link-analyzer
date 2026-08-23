// Road-level logical linkage checks (R1–R5).

import { roadEndMarkerPosition } from "../xodr/geometry.js";

function endpointLocation(road, endName) {
    return roadEndMarkerPosition(road, endName);
}

export function checkRoadLinks(model, lookups, issues) {
    const { roadById, junctionById } = lookups;

    for (const road of model.roads) {
        for (const [endName, link] of [["predecessor", road.predecessor], ["successor", road.successor]]) {
            if (!link || !link.elementId) {
                continue;
            }

            const targetRoad = roadById.get(String(link.elementId));
            const targetJunction = junctionById.get(String(link.elementId));

            if (!targetRoad && !targetJunction) {
                issues.push({
                    severity: "error",
                    category: "road",
                    title: `Missing road link target`,
                    detail: `${describeEnd(road.id, endName)} links to element "${link.elementId}" which does not exist.`,
                    location: { roadIds: [road.id], position: endpointLocation(road, endName) },
                });
                continue;
            }

            if (link.elementType === "junction" && !targetJunction) {
                issues.push({
                    severity: "error",
                    category: "road",
                    title: `Road ${endName} declared as junction but is a road`,
                    detail: `${describeEnd(road.id, endName)} declares elementType="junction" for id "${link.elementId}", which is a road.`,
                    location: { roadIds: [road.id], position: endpointLocation(road, endName) },
                });
                continue;
            }

            if (targetJunction) {
                checkJunctionConnection(road, endName, targetJunction, issues);
                continue;
            }

            // Direct road-to-road link: verify reciprocity and contact points.
            const backLink = endName === "predecessor" ? targetRoad.successor : targetRoad.predecessor;
            if (!backLink || !backLink.elementId || String(backLink.elementId) !== String(road.id)) {
                const backState = !backLink || !backLink.elementId
                    ? `has no link at its ${endName === "predecessor" ? "successor" : "predecessor"} end`
                    : `links to element "${backLink.elementId}" instead of back to ${road.id}`;
                issues.push({
                    severity: "error",
                    category: "road",
                    title: "Unidirectional road link",
                    detail: `${describeEnd(road.id, endName)} → road ${link.elementId} (${link.contactPoint}), but road ${link.elementId} ${backState}.`,
                    // Which end DECLARED the link — the other side of the joint
                    // is the one missing the back link, so it owns this issue.
                    location: { roadIds: [road.id, link.elementId], declaredByEnd: { roadId: road.id, endName }, position: endpointLocation(road, endName) },
                });
                continue;
            }

            // Contact point consistency: A's predecessor must be B's successor end.
            const expectedBackContact = endName === "predecessor"
                ? (link.contactPoint === "start" ? "end" : "start")
                : (link.contactPoint === "start" ? "end" : "start");
            if (backLink.contactPoint && backLink.contactPoint !== expectedBackContact && backLink.contactPoint !== expectedBackContact.toLowerCase()) {
                issues.push({
                    severity: "error",
                    category: "road",
                    title: "Road contact point mismatch",
                    detail: `${describeEnd(road.id, endName)} → road ${link.elementId} (${link.contactPoint}), but the reverse link on road ${link.elementId} declares contactPoint="${backLink.contactPoint}" (expected "${expectedBackContact}").`,
                    location: { roadIds: [road.id, link.elementId], position: endpointLocation(road, endName) },
                });
            }
        }
    }
}

function checkJunctionConnection(road, endName, junction, issues) {
    const connection = junction.connections.find((c) => String(c.incomingRoad) === String(road.id));
    if (!connection) {
        issues.push({
            severity: "error",
            category: "road",
            title: "No road entry in junction connections",
            detail: `${describeEnd(road.id, endName)} references junction ${junction.id}, but the junction has no <connection> with incomingRoad="${road.id}".`,
            location: { roadIds: [road.id], junctionId: junction.id, position: endpointLocation(road, endName) },
        });
    }
}

export function describeEnd(roadId, endName) {
    return `road ${roadId} ${endName}`;
}
