// Orchestrates all linkage checks and produces the issue list.

import { buildModel } from "../xodr/model.js";
import { checkRoadLinks } from "./roadLinks.js";
import { checkLaneLinks } from "./laneLinks.js";
import { checkGeometryLinks } from "./geometryLinks.js";
import { checkOverlappingRoads } from "./overlappingRoads.js";
import { checkJunctionLaneLinks } from "./junctionLaneLinks.js";

export function analyze(model, tolerances) {
    const lookups = buildModel(model);
    const issues = [];

    checkRoadLinks(model, lookups, issues);
    checkLaneLinks(model, lookups, issues);
    checkJunctionLaneLinks(model, lookups, issues);
    checkGeometryLinks(model, lookups, tolerances, issues);
    checkOverlappingRoads(model, lookups, issues);

    // Deduplicate identical issues (e.g. same pair reported from both sides).
    const seen = new Set();
    const unique = [];
    for (const issue of issues) {
        const key = `${issue.category}|${issue.title}|${issue.detail}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        unique.push(issue);
    }
    unique.forEach((issue, index) => {
        issue.id = index;
    });

    return { issues: unique, lookups };
}
