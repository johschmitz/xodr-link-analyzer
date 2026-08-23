// Lookup helpers over the parsed model.

export function buildModel(model) {
    const roadById = new Map();
    for (const road of model.roads) {
        roadById.set(String(road.id), road);
    }

    const junctionById = new Map();
    for (const junction of model.junctions) {
        junctionById.set(String(junction.id), junction);
    }

    // lane lookup: "roadId:sectionIndex:laneId" -> lane
    const laneByKey = new Map();
    for (const road of model.roads) {
        road.laneSections.forEach((section, sectionIndex) => {
            for (const lane of [...section.left, ...section.right, ...(section.center ? [section.center] : [])]) {
                laneByKey.set(laneKey(road.id, sectionIndex, lane.id), lane);
            }
        });
    }

    return { roadById, junctionById, laneByKey };
}

export function laneKey(roadId, sectionIndex, laneId) {
    return `${roadId}:${sectionIndex}:${laneId}`;
}

// Returns the lane section that is active at the given s position.
export function sectionAt(road, s) {
    let active = road.laneSections[0];
    for (const section of road.laneSections) {
        if (section.s <= s + 1e-9) {
            active = section;
        } else {
            break;
        }
    }
    return active;
}

export function sectionIndexAt(road, s) {
    let index = 0;
    road.laneSections.forEach((section, i) => {
        if (section.s <= s + 1e-9) {
            index = i;
        }
    });
    return index;
}

// Evaluate a cubic polynomial at u.
export function evalCubic(coeffs, u) {
    const { a, b, c, d } = coeffs;
    return a + b * u + c * u * u + d * u * u * u;
}

// Find the entry in a profile (elevation/superelevation/laneOffset) valid at s.
export function profileEntryAt(profile, s) {
    if (!profile || profile.length === 0) {
        return null;
    }
    let entry = profile[0];
    for (const candidate of profile) {
        if (candidate.s <= s + 1e-9) {
            entry = candidate;
        } else {
            break;
        }
    }
    return entry;
}
