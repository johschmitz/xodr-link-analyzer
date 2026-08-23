// Unique-id check (R7): road ids and junction ids share one namespace in
// OpenDRIVE — every <road> and <junction> shall have an id that is unique
// across both element types.

import { refPointAt, roadLength } from "../xodr/geometry.js";

export function checkUniqueIds(model, lookups, issues) {
    const seen = new Map(); // id -> { kind, element }

    const claim = (id, kind, element) => {
        const key = String(id);
        const first = seen.get(key);
        if (!first) {
            seen.set(key, { kind, element });
            return;
        }
        issues.push({
            severity: "error",
            category: "road",
            title: "Duplicate element id",
            detail: `${first.kind} ${first.element.id} and ${kind} ${element.id} share the same id "${key}". Road and junction ids must be unique across the whole file.`,
            location: {
                roadIds: first.kind === "road" ? [first.element.id] : [],
                junctionId: first.kind === "junction" ? first.element.id : undefined,
                position: markerPosition(first),
            },
        });
    };

    for (const road of model.roads) {
        claim(road.id, "road", road);
    }
    for (const junction of model.junctions) {
        claim(junction.id, "junction", junction);
    }
}

// Marker at the start of a road, or at the centroid of a junction's incoming
// road endpoints — same anchor the viewer uses for junction id labels.
function markerPosition(entry) {
    if (entry.kind === "road") {
        const ref = refPointAt(entry.element, 0);
        return ref ? { x: ref.x, y: ref.y, z: ref.z } : null;
    }
    let count = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const connection of entry.element.connections) {
        const road = lookupsRoad(connection.incomingRoad);
        if (!road) {
            continue;
        }
        const ref = refPointAt(road, 0);
        if (!ref) {
            continue;
        }
        count += 1;
        x += ref.x;
        y += ref.y;
        z += ref.z;
    }
    return count > 0 ? { x: x / count, y: y / count, z: z / count } : null;
}
