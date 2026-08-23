// three.js scene setup, road mesh building, and issue marker rendering.

import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { roadLength, sampleReferenceLine, sampleLaneBoundaries, refPointAt, laneWidthAt, laneOffsetAt, offsetPoint, roadEndMarkerPosition } from "./xodr/geometry.js";
import { collectLaneLinks } from "./analysis/laneLinks.js";
import { buildModel as buildLookups } from "./xodr/model.js";

const SKY_COLOR = "#cadcee";
const FOG_COLOR = "#d4e1ef";

const LANE_TYPE_COLORS = {
    driving: "#3c4248",
    stop: "#3c4248",
    border: "#4a5058",
    shoulder: "#707780",
    parking: "#707780",
    sidewalk: "#8a8f87",
    biking: "#8a8f87",
    median: "#6d6d58",
    none: "#59616a",
};

const COLOR_OK = 0x2ce67d;
const COLOR_ERROR = 0xff3b30;
const COLOR_WARN = 0xf0c54c;
const COLOR_REF = 0x9b59f6;
const COLOR_OPEN = 0x8a8f87;

// Issues of the current analysis, used to map clicked markers to issue IDs.
const currentIssuesRef = { issues: [] };

export function createViewer(container) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY_COLOR);
    scene.fog = new THREE.Fog(FOG_COLOR, 8000, 20000);

    const camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.1, 30000);
    camera.up.set(0, 0, 1);
    camera.position.set(-40, -40, 30);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Pan moves the orbit target with the camera, so the pivot follows the view.
    controls.screenSpacePanning = true;

    scene.add(new THREE.HemisphereLight(0xe7f1ff, 0x8a846f, 1.35));
    const keyLight = new THREE.DirectionalLight(0xfff4da, 1.6);
    keyLight.position.set(120, -80, 150);
    scene.add(keyLight);

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(40000, 40000),
        new THREE.MeshStandardMaterial({ color: "#c8c0aa", roughness: 1.0, metalness: 0.0 })
    );
    ground.position.z = -0.05;
    scene.add(ground);

    const roadGroup = new THREE.Group();
    const refLineGroup = new THREE.Group();
    const markerGroup = new THREE.Group();
    scene.add(roadGroup, refLineGroup, markerGroup);

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const viewer = {
        renderer,
        scene,
        camera,
        controls,
        roadGroup,
        refLineGroup,
        markerGroup,
        markers: [],
        fitView() {
            const box = new THREE.Box3().setFromObject(roadGroup);
            if (box.isEmpty()) {
                return;
            }
            const center = new THREE.Vector3();
            const size = new THREE.Vector3();
            box.getCenter(center);
            box.getSize(size);
            const radius = Math.max(size.x, size.y, 10) * 0.7;
            camera.position.set(center.x - radius, center.y - radius, radius * 0.8);
            controls.target.copy(center);
            controls.update();
        },
        focusOn(position, span = 30) {
            // No position → do nothing; zooming out to the full map would
            // lose the user's context entirely.
            if (!position) {
                return;
            }
            const target = new THREE.Vector3(position.x, position.y, position.z);
            // Look straight down from above so surface markers are readable.
            camera.position.set(target.x, target.y - span * 0.25, target.z + span);
            controls.target.copy(target);
            controls.update();
        },
        render() {
            controls.update();
            renderer.render(scene, camera);
        },
        onMarkerClick(handler) {
            clickHandler = handler;
        },
    };

    // Click-to-focus: raycast into the marker group; if a disc carries an
    // issue ID, invoke the handler (wired in main.js to selectIssue).
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos = null;
    let clickHandler = null;

    renderer.domElement.addEventListener("pointerdown", (event) => {
        downPos = { x: event.clientX, y: event.clientY };
    });

    renderer.domElement.addEventListener("pointerup", (event) => {
        if (!clickHandler || !downPos) {
            return;
        }
        // Ignore drags (orbit/pan) — only treat near-stationary clicks.
        if (Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y) > 5) {
            return;
        }
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(markerGroup.children, false)
            .filter((hit) => hit.object.visible);
        // Markers without their own issue (green/gray status discs) deselect
        // the currently selected issue instead of selecting one.
        if (hits.length > 0) {
            // Raycast returns raw geometric distance, but markers are drawn
            // stacked by renderOrder with depthTest off — so the visually
            // topmost marker is not necessarily the nearest one. Pick by
            // renderOrder first, distance second, or clicking a joint square
            // through an overlapping ID label would focus the wrong marker.
            const topHit = hits.reduce((best, hit) => {
                const ro = hit.object.renderOrder || 0;
                const bestRo = best.object.renderOrder || 0;
                if (ro !== bestRo) {
                    return ro > bestRo ? hit : best;
                }
                return hit.distance < best.distance ? hit : best;
            });
            const { issueId = null, focusPosition } = topHit.object.userData;
            clickHandler({ issueId, position: focusPosition });
        }
    });

    // Double-click: recenter the orbit pivot on whatever mesh is under the
    // cursor, without moving the camera (no zoom/dolly).
    renderer.domElement.addEventListener("dblclick", (event) => {
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(scene.children, true)
            .filter((hit) => hit.object.visible);
        if (hits.length > 0) {
            // Shift both pivot and camera by the same delta so the view
            // angle/distance relative to the pivot is unchanged.
            const delta = hits[0].point.clone().sub(controls.target);
            controls.target.add(delta);
            camera.position.add(delta);
            controls.update();
        }
    });

    return viewer;
}

export function clearGroup(group) {
    const disposed = new Set();
    while (group.children.length > 0) {
        const child = group.children[0];
        group.remove(child);
        child.traverse((node) => {
            if (node.geometry && !disposed.has(node.geometry)) {
                disposed.add(node.geometry);
                node.geometry.dispose();
            }
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            for (const material of materials) {
                if (material && !disposed.has(material)) {
                    disposed.add(material);
                    material.dispose();
                }
            }
        });
    }
}

function appendPolyline(target, points) {
    // Emit each boundary as LineSegments pairs (p0,p1, p1,p2, …) so that
    // separate boundaries never get connected by a diagonal line.
    for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        target.push(a.x, a.y, a.z + 0.06, b.x, b.y, b.z + 0.06);
    }
}

// Draws the lane boundary outline and marks the start/end contact
// points with direction arrows.
function addRoadOutline(viewer, model, road, extraPositions) {
    const length = roadLength(road);
    if (length <= 0 || road.laneSections.length === 0) {
        return;
    }

    // Lane boundary polylines are already collected in extraPositions as
    // line segment pairs.
    const positions = [...extraPositions];

    // End caps: cross-section lines at s=0 and s=length.
    for (const s of [0, length]) {
        const ref = refPointAt(road, s);
        if (!ref) {
            continue;
        }
        const section = sectionAtS(road, s);
        let halfWidth = 0;
        for (const lane of section.left) {
            halfWidth += laneWidthAt(lane, Math.max(s - section.s, 0));
        }
        let rightWidth = 0;
        for (const lane of section.right) {
            rightWidth += laneWidthAt(lane, Math.max(s - section.s, 0));
        }
        const laneOff = laneOffsetAt(road, s);
        const a = offsetPoint(ref, halfWidth + laneOff);
        const b = offsetPoint(ref, -rightWidth + laneOff);
        positions.push(a.x, a.y, a.z + 0.06, b.x, b.y, b.z + 0.06);
    }

    if (positions.length >= 6) {
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        const outline = new LineSegments2(geometry, new LineMaterial({
            color: 0x1fb6ff,
            transparent: true,
            opacity: 0.55,
            toneMapped: false,
            linewidth: 1.2, // pixels
        }));
        viewer.roadGroup.add(outline);
    }
}

// Blue outline around a junction area: take the outer corners (left/right
// edge) of every incoming road's junction-facing end and connect them with
// straight lines in angular order around the junction.
function buildJunctionOutlines(viewer, model) {
    const positions = [];

    for (const junction of model.junctions || []) {
        const corners = [];
        const seenRoads = new Set();
        for (const connection of junction.connections) {
            const roadId = String(connection.incomingRoad);
            if (seenRoads.has(roadId)) {
                continue;
            }
            seenRoads.add(roadId);
            const road = model.roads.find((r) => String(r.id) === roadId);
            if (!road || road.laneSections.length === 0) {
                continue;
            }
            // Which end of this road faces the junction?
            let contact = null;
            if (road.predecessor?.elementType === "junction" && String(road.predecessor.elementId) === String(junction.id)) {
                contact = "start";
            } else if (road.successor?.elementType === "junction" && String(road.successor.elementId) === String(junction.id)) {
                contact = "end";
            } else {
                continue;
            }
            const s = contact === "start" ? 0 : roadLength(road);
            const ref = refPointAt(road, s);
            if (!ref) {
                continue;
            }
            const section = sectionAtS(road, s);
            let leftWidth = 0;
            for (const lane of section.left) {
                leftWidth += laneWidthAt(lane, Math.max(s - section.s, 0));
            }
            let rightWidth = 0;
            for (const lane of section.right) {
                rightWidth += laneWidthAt(lane, Math.max(s - section.s, 0));
            }
            const laneOff = laneOffsetAt(road, s);
            const left = offsetPoint(ref, leftWidth + laneOff);
            const right = offsetPoint(ref, -rightWidth + laneOff);
            corners.push({ x: left.x, y: left.y, z: left.z });
            corners.push({ x: right.x, y: right.y, z: right.z });
        }

        if (corners.length < 2) {
            continue;
        }

        // Order corners by angle around their centroid so consecutive points
        // form the junction hull instead of criss-crossing lines.
        const cx = corners.reduce((sum, p) => sum + p.x, 0) / corners.length;
        const cy = corners.reduce((sum, p) => sum + p.y, 0) / corners.length;
        corners.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

        for (let i = 0; i < corners.length; i += 1) {
            const a = corners[i];
            const b = corners[(i + 1) % corners.length];
            positions.push(a.x, a.y, a.z + 0.06, b.x, b.y, b.z + 0.06);
        }
    }

    if (positions.length >= 6) {
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        const outline = new LineSegments2(geometry, new LineMaterial({
            color: 0x1fb6ff,
            transparent: true,
            opacity: 0.55,
            toneMapped: false,
            linewidth: 1.2, // pixels
        }));
        viewer.roadGroup.add(outline);
    }
}

// Convert concatenated polylines into LineSegments pairs. Each boundary is a
// continuous strip; emit segment pairs so no connecting diagonal is drawn
// between separate boundaries.
function extraPositionsToSegments(flat) {
    return flat;
}

function sectionAtS(road, s) {
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

const LANE_LINK_COLORS = {
    ok: 0x2ce67d,
    unidirectional: 0xf0c54c,
    broken: 0xff3b30,
};

// World position of a lane's center line at a road end (start/end contact).
function laneCenterEndpoint(road, laneId, contact) {
    const section = contact === "start" ? road.laneSections[0] : road.laneSections[road.laneSections.length - 1];
    if (!section) {
        return null;
    }
    const lane = [...section.left, ...section.right].find((l) => l.id === laneId);
    if (!lane) {
        return null;
    }
    const s = contact === "start" ? section.s : roadLength(road);
    const ref = refPointAt(road, s);
    if (!ref) {
        return null;
    }
    const halfWidth = laneWidthAt(lane, Math.max(s - section.s, 0)) * 0.5;
    const sign = laneId > 0 ? 1 : -1;
    const t = sign * (laneOffsetAt(road, s))
        + sign * (innerEdgeOffsetTotal(road, section, lane, s) - halfWidth);
    const p = offsetPoint(ref, t);
    return { x: p.x, y: p.y, z: p.z + 0.15 };
}

// Sum of widths of all lanes between the center line and `lane` (outer edge offset).
function innerEdgeOffsetTotal(road, section, lane, s) {
    const between = lane.id > 0
        ? section.left.filter((l) => l.id < lane.id && l.id > 0)
        : section.right.filter((l) => l.id > lane.id && l.id < 0);
    let total = laneWidthAt(lane, Math.max(s - section.s, 0));
    for (const other of between) {
        total += laneWidthAt(other, Math.max(s - section.s, 0));
    }
    return total;
}

// For broken links (no target lane), draw a short stub in the road's outward
// direction from the source lane endpoint.
function stubEndpoint(road, laneId, contact, pa) {
    const s = contact === "start" ? 0 : roadLength(road);
    const ref = refPointAt(road, s);
    if (!ref) {
        return pa;
    }
    const dirSign = contact === "start" ? -1 : 1;
    return {
        x: pa.x + Math.cos(ref.hdg) * dirSign * 2,
        y: pa.y + Math.sin(ref.hdg) * dirSign * 2,
        z: pa.z,
    };
}

// Draws flat labeled discs (lane ID, "!" when missing) on each connected
// lane near the joint, plus a connecting line between them.
// Green = ok, yellow = unidirectional, red = broken/missing.
export function buildLaneLinkMarkers(viewer, model, lookups, issues = []) {
    currentIssuesRef.issues = issues;
    const links = collectLaneLinks(model, lookups);

    for (const link of links) {
        const roadA = lookups.roadById.get(String(link.from.roadId));
        if (!roadA) {
            continue;
        }
        const pa = laneCenterEndpoint(roadA, link.from.laneId, link.from.contact);
        let pb = null;
        let labelB = "!";
        let labelA = String(link.from.laneId);
        if (link.to) {
            const roadB = lookups.roadById.get(String(link.to.roadId));
            if (roadB) {
                pb = laneCenterEndpoint(roadB, link.to.laneId, link.to.contact);
                labelB = String(link.to.laneId);
            }
        }
        if (!pa) {
            continue;
        }

        const color = LANE_LINK_COLORS[link.status] || LANE_LINK_COLORS.broken;
        // Unidirectional: the "!" sits on the side that DECLARED the link
        // (its outgoing link has no counterpart) and is red — a missing back
        // link is an error. The issue itself belongs to the OTHER road — the
        // one missing the link — so only that side's disc selects the issue.
        const unidirectional = link.status === "unidirectional";
        let colorA = color;
        if (unidirectional && pb) {
            labelA = "!";
            colorA = LANE_LINK_COLORS.broken;
        }

        // Pull each disc back into its own road/lane so both sides are apart.
        const posA = pullIntoRoad(roadA, link.from.contact, pa);
        const headingA = roadHeadingAt(roadA, link.from.contact === "start" ? 0 : roadLength(roadA));
        const meshA = addSurfaceLabel(viewer.markerGroup, labelA, colorA, posA.x, posA.y, posA.z + 0.02, 1.3, "circle", headingRotation(headingA));
        if (meshA) {
            meshA.userData.issueId = unidirectional && pb
                ? null
                : nearestIssueId(currentIssuesRef.issues, pa, link.from.roadId, "lane", [link.from.laneId, link.to?.laneId]);
            meshA.userData.focusPosition = posA;
        }

        if (!pb) {
            // Broken link: short red stub pointing outward from the source lane.
            pb = stubEndpoint(roadA, link.from.laneId, link.from.contact, pa);
        } else {
            const roadB = lookups.roadById.get(String(link.to.roadId));
            pb = pullIntoRoad(roadB, link.to.contact, pb);
            const headingB = roadHeadingAt(roadB, link.to.contact === "start" ? 0 : roadLength(roadB));
            const meshB = addSurfaceLabel(viewer.markerGroup, labelB, color, pb.x, pb.y, pb.z + 0.02, 1.3, "circle", headingRotation(headingB));
            if (meshB) {
                meshB.userData.issueId = nearestIssueId(currentIssuesRef.issues, pb, link.to.roadId, "lane", [link.to.laneId, link.from.laneId]);
                meshB.userData.focusPosition = pb;
            }
        }

        // Connect the line between the disc centers so line and markers join up.
        const positions = new Float32Array([posA.x, posA.y, posA.z, pb.x, pb.y, pb.z]);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
            color,
            depthTest: false,
            transparent: true,
            opacity: 0.95,
            toneMapped: false,
        }));
        line.renderOrder = 4;
        viewer.markerGroup.add(line);
    }
}

// Move a lane-end point slightly back into its own road along -/+s and lift
// it just above the surface for the flat label.
function pullIntoRoad(road, contact, p) {
    const dir = inwardDirectionAt(road, contact);
    if (!dir) {
        return { x: p.x, y: p.y, z: p.z };
    }
    return {
        x: p.x + dir.ux * 1.2,
        y: p.y + dir.uy * 1.2,
        z: p.z,
    };
}

function stripGeometry(leftBoundary, rightBoundary) {
    const count = Math.min(leftBoundary.length, rightBoundary.length);
    if (count < 2) {
        return null;
    }
    const positions = new Float32Array(count * 2 * 3);
    const indices = [];
    for (let i = 0; i < count; i += 1) {
        const left = leftBoundary[i];
        const right = rightBoundary[i];
        const base = i * 6;
        positions[base + 0] = left.x;
        positions[base + 1] = left.y;
        positions[base + 2] = left.z;
        positions[base + 3] = right.x;
        positions[base + 4] = right.y;
        positions[base + 5] = right.z;
        if (i < count - 1) {
            const start = i * 2;
            indices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

export function buildRoadMeshes(viewer, model) {
    clearGroup(viewer.roadGroup);
    clearGroup(viewer.refLineGroup);

    for (const road of model.roads) {
        const outlinePositions = [];

        for (let sectionIndex = 0; sectionIndex < road.laneSections.length; sectionIndex += 1) {
            const section = road.laneSections[sectionIndex];
            for (const lane of [...section.left, ...section.right]) {
                const { left, right } = sampleLaneBoundaries(road, sectionIndex, lane.id);
                const geometry = stripGeometry(left, right);
                if (!geometry) {
                    continue;
                }
                const color = LANE_TYPE_COLORS[String(lane.type).toLowerCase()] || LANE_TYPE_COLORS.none;
                viewer.roadGroup.add(new THREE.Mesh(
                    geometry,
                    new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide })
                ));

                // Collect lane boundary polylines for the outline.
                appendPolyline(outlinePositions, left);
                appendPolyline(outlinePositions, right);
            }
        }

        // Lane boundary outline + cross-section ticks at both ends.
        addRoadOutline(viewer, model, road, outlinePositions);

        const refPoints = sampleReferenceLine(road);
        if (refPoints.length >= 2) {
            const positions = new Float32Array(refPoints.length * 3);
            refPoints.forEach((p, i) => {
                positions[i * 3 + 0] = p.x;
                positions[i * 3 + 1] = p.y;
                positions[i * 3 + 2] = p.z + 0.2;
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
            const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
                color: COLOR_REF,
                toneMapped: false,
                depthTest: false,
                transparent: true,
                opacity: 0.9,
            }));
            line.renderOrder = 3;
            line.visible = true;
            viewer.refLineGroup.add(line);

            // Arrow tip at the road's end (s = length): the reference line ends
            // with an arrowhead pointing in +s direction.
            const tipLength = Math.max(length * 0.04, 1.5);
            const lastP = refPoints[refPoints.length - 1];
            const prevP = refPoints[refPoints.length - 2] || lastP;
            const dirX = lastP.x - prevP.x;
            const dirY = lastP.y - prevP.y;
            const dirLen = Math.hypot(dirX, dirY) || 1;
            const ux = dirX / dirLen, uy = dirY / dirLen; // +s direction at end
            const px = -uy, py = ux;
            const arrowPositions = new Float32Array([
                lastP.x, lastP.y, lastP.z + 0.2,
                lastP.x - ux * tipLength + px * tipLength * 0.5, lastP.y - uy * tipLength + py * tipLength * 0.5, lastP.z + 0.2,
                lastP.x, lastP.y, lastP.z + 0.2,
                lastP.x - ux * tipLength - px * tipLength * 0.5, lastP.y - uy * tipLength - py * tipLength * 0.5, lastP.z + 0.2,
            ]);
            const arrowGeometry = new THREE.BufferGeometry();
            arrowGeometry.setAttribute("position", new THREE.BufferAttribute(arrowPositions, 3));
            const tip = new THREE.LineSegments(arrowGeometry, new THREE.LineBasicMaterial({
                color: COLOR_REF,
                toneMapped: false,
                depthTest: false,
                transparent: true,
                opacity: 0.9,
            }));
            tip.renderOrder = 3;
            tip.visible = true;
            viewer.refLineGroup.add(tip);

            // Start marker: a short horizontal tick across the line at s = 0.
            const firstP = refPoints[0];
            const nextP = refPoints[1] || firstP;
            const sdx = nextP.x - firstP.x;
            const sdy = nextP.y - firstP.y;
            const sdLen = Math.hypot(sdx, sdy) || 1;
            const sux = sdx / sdLen, suy = sdy / sdLen; // +s direction at start
            const tickLength = Math.max(length * 0.04, 1.5) * 0.5;
            const spx = -suy, spy = sux;
            const tickPositions = new Float32Array([
                firstP.x - spx * tickLength, firstP.y - spy * tickLength, firstP.z + 0.2,
                firstP.x + spx * tickLength, firstP.y + spy * tickLength, firstP.z + 0.2,
            ]);
            const tickGeometry = new THREE.BufferGeometry();
            tickGeometry.setAttribute("position", new THREE.BufferAttribute(tickPositions, 3));
            const tick = new THREE.LineSegments(tickGeometry, new THREE.LineBasicMaterial({
                color: COLOR_REF,
                toneMapped: false,
                depthTest: false,
                transparent: true,
                opacity: 0.9,
            }));
            tick.renderOrder = 3;
            tick.visible = true;
            viewer.refLineGroup.add(tick);
        }
    }

    buildJunctionOutlines(viewer, model);

    viewer.fitView();
}

export function setReferenceLinesVisible(viewer, visible) {
    viewer.refLineGroup.visible = visible;
}

// Draws the red segment spanning an actual gap for gap issues.
export function buildIssueMarkers(viewer, issues) {
    clearGroup(viewer.markerGroup);

    for (const issue of issues) {
        const gap = issue.location?.gap;
        if (!gap || !gap.a || !gap.b) {
            continue;
        }
        const positions = new Float32Array([
            gap.a.x, gap.a.y, gap.a.z + 0.15,
            gap.b.x, gap.b.y, gap.b.z + 0.15,
        ]);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: COLOR_ERROR, depthTest: false, toneMapped: false }));
        line.renderOrder = 5;
        viewer.markerGroup.add(line);
    }
}

// --- Flat 2D labels drawn on the road surface ---------------------------

// Canvas texture with a colored disc/square and a centered text label.
function makeLabelTexture(text, colorHex, shape) {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const color = "#" + colorHex.toString(16).padStart(6, "0");

    ctx.fillStyle = color;
    ctx.beginPath();
    if (shape === "square") {
        // Manual rounded rect (roundRect() is missing in older browsers).
        const x0 = 16, y0 = 16, w = size - 32, h = size - 32, r = 28;
        ctx.moveTo(x0 + r, y0);
        ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
        ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
        ctx.arcTo(x0, y0 + h, x0, y0, r);
        ctx.arcTo(x0, y0, x0 + w, y0, r);
        ctx.closePath();
    } else if (shape === "triangle") {
        // Equilateral triangle pointing up (+s direction of the road).
        const cx = size / 2, cy = size / 2 + 14, r = size / 2 - 20;
        for (let i = 0; i < 3; i += 1) {
            const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
            const px = cx + r * Math.cos(angle);
            const py = cy + r * Math.sin(angle);
            if (i === 0) {
                ctx.moveTo(px, py);
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.closePath();
    } else {
        ctx.arc(size / 2, size / 2, size / 2 - 14, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let fontSize = 130;
    ctx.font = `bold ${fontSize}px sans-serif`;
    while (ctx.measureText(text).width > size * 0.72 && fontSize > 30) {
        fontSize -= 8;
        ctx.font = `bold ${fontSize}px sans-serif`;
    }
    ctx.fillText(text, size / 2, size / 2 + fontSize * 0.05);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// Flat disc/square mesh lying on the road surface at (x, y, z).
function addSurfaceLabel(group, text, colorHex, x, y, z, sizeMeters, shape, rotationZ = 0) {
    try {
        const geometry = shape === "square"
            ? new THREE.PlaneGeometry(sizeMeters, sizeMeters)
            : new THREE.CircleGeometry(sizeMeters / 2, 24);
        const material = new THREE.MeshBasicMaterial({
            map: makeLabelTexture(text, colorHex, shape || "circle"),
            transparent: true,
            depthTest: false,
            toneMapped: false,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        // The scene is Z-up (camera.up = 0,0,1), so the plane's default
        // normal +Z already lies flat on the ground — no rotation needed.
        // Rotate 180° about Z so the text reads correctly from above; an
        // extra rotationZ spins directional shapes (triangles) afterwards.
        mesh.rotation.z = Math.PI + rotationZ;
        mesh.renderOrder = 6;
        mesh.position.set(x, y, z);
        // Every clickable marker carries its own focus position so clicking
        // it can center the camera — independent of any attached issue.
        mesh.userData.focusPosition = { x, y, z };
        group.add(mesh);
        return mesh;
    } catch (error) {
        console.error("[xodr] Failed to create surface label:", text, error);
        return null;
    }
}

// Unit vector at a road end pointing back INTO the road (+s at start,
// -s at end). Evaluated analytically from the reference line so the
// direction is exact even when the end falls between coarse samples.
// Returns {ux, uy} or null.
function inwardDirectionAt(road, contact) {
    const s = contact === "start" ? 0 : roadLength(road);
    const a = refPointAt(road, s);
    if (!a) {
        return null;
    }
    // Tangent from a small step along s, clamped to stay inside the road.
    const ds = Math.min(0.5, Math.max(roadLength(road) / 100, 0.01));
    const p1 = refPointAt(road, Math.min(s, contact === "start" ? s + ds : s - ds));
    const p2 = refPointAt(road, Math.max(s, contact === "start" ? s + ds : s - ds));
    let tx = Math.cos(a.hdg);
    let ty = Math.sin(a.hdg);
    if (p1 && p2 && !(p1.x === p2.x && p1.y === p2.y)) {
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        tx = (p2.x - p1.x) / len; // +s direction (p2 is at larger s)
        ty = (p2.y - p1.y) / len;
    }
    const sign = contact === "start" ? 1 : -1;
    return { ux: tx * sign, uy: ty * sign };
}

// +s tangent at the road's END (successor), pointing out of the road.
// Returns {ux, uy} or null.
function outwardDirectionAt(road) {
    const d = inwardDirectionAt(road, "end");
    if (!d) {
        return null;
    }
    return { ux: -d.ux, uy: -d.uy }; // inward at end is -s; outward is +s
}

// World-space +s heading (radians) at position `s` along the road.
function roadHeadingAt(road, s) {
    const ref = refPointAt(road, Math.min(Math.max(s, 0), roadLength(road)));
    return ref ? ref.hdg : null;
}

// Extra mesh Z-rotation that aligns a marker's texture-up direction with
// the given world heading. The 180° text flip in addSurfaceLabel mirrors
// screen y, so the sign is negative and shifted by 90°.
function headingRotation(heading) {
    // -π/2 on top of the heading alignment spins every marker 90° clockwise
    // so the text reads sideways along the road instead of across it.
    return heading == null ? -Math.PI / 2 : heading - Math.PI;
}

// Position of a road-end marker: on the CENTER LANE of its own road (not
// the raw reference line — they differ when <laneOffset> is used), pulled
// back into the road. Shared with the analyzers via roadEndMarkerPosition,
// so issues and discs sit at identical world positions.
function roadMarkerPosition(road, contact, s) {
    return roadEndMarkerPosition(road, contact === "predecessor" ? "predecessor" : "successor");
}

// Road-level link markers: flat squares on the road surface near each joint,
// labeled with the road ID the end's link declares (or "!" when the end has
// no link info).
// Green = verified, red = error at this end, yellow = warning, gray = open.
// ONE MARKER PER ROAD END (not per joint): both sides of a joint get their
// own disc on their own road, so e.g. road 2's start side shows its
// predecessor marker even though road 1's successor marker is present too —
// previously the disc was merged per joint and anchored on the first road,
// leaving the far side of the joint without any road-link marker.
// A single "CP" square per physical joint marks the contact point itself.
// Squares distinguish road-joint markers from the circular lane-link discs.
export function buildJointMarkers(viewer, model, lookups, issues) {
    buildJointMarkers._lookups = lookups;

    const ends = [];
    for (const road of model.roads) {
        for (const [endName, link] of [["predecessor", road.predecessor], ["successor", road.successor]]) {
            const s = endName === "predecessor" ? 0 : roadLength(road);
            const point = endpointOf(road, s);
            if (!point) {
                continue;
            }
            const pos = roadMarkerPosition(road, endName, s);
            if (!pos) {
                continue;
            }
            ends.push({ road, endName, link, point, pos, s });
        }
    }

    // Per-end disc: this end's own declared target id (or "!"), colored by
    // this end's own worst road-level issue. For a unidirectional road link
    // the DECLARING end shows a yellow "!" (its outgoing link has no
    // counterpart) and carries no issue; the OTHER end — the road missing
    // the back link — owns the issue and shows it in red.
    for (const end of ends) {
        const hasLink = Boolean(end.link && end.link.elementId);
        let issue = issueForEnd(issues, end.road, end.endName, end.point, "road");
        // This end declared a link whose counterpart is missing?
        const declaresUnidirectional = issue != null
            && issue.location?.declaredByEnd
            && String(issue.location.declaredByEnd.roadId) === String(end.road.id)
            && issue.location.declaredByEnd.endName === end.endName;
        const label = hasLink ? String(end.link.elementId) : "!";
        let color;
        if (declaresUnidirectional) {
            color = COLOR_WARN;
            issue = null; // the other side of the joint owns this issue
        } else {
            color = issue
                ? (issue.severity === "error" ? COLOR_ERROR : COLOR_WARN)
                : (hasLink ? COLOR_OK : COLOR_OPEN);
        }
        const endHeading = roadHeadingAt(end.road, end.s);
        const mesh = addSurfaceLabel(viewer.markerGroup, label, color, end.pos.x, end.pos.y, end.pos.z, 1.3, "square", headingRotation(endHeading));
        if (mesh) {
            // Only attach this end's OWN issue — no nearest-issue fallback,
            // otherwise an open-end "!" marker would select an issue that
            // actually lives at the road's other end.
            mesh.userData.issueId = issue ? issue.id : null;
            mesh.userData.focusPosition = end.pos;
        }
    }

    // One contact-point square per PHYSICAL joint (ends sharing a world
    // position), including open ends with no declared link — every road end
    // is a contact point, so it always gets its CP marker; tied to geometry
    // issues (gap/heading/elevation).
    const groups = [];
    for (const end of ends) {
        const group = groups.find((g) => Math.hypot(g.point.x - end.point.x, g.point.y - end.point.y) < 0.5);
        if (group) {
            group.ends.push(end);
        } else {
            groups.push({ point: end.point, ends: [end] });
        }
    }

    for (const group of groups) {
        const { point, ends: groupEnds } = group;
        const linkedEnds = groupEnds.filter((e) => e.link && e.link.elementId);
        const first = linkedEnds[0] || groupEnds[0];
        const cpIssue = issueForEnd(issues, first.road, first.endName, point, "geometry")
            || groupEnds.map((e) => issueForEnd(issues, e.road, e.endName, point, "geometry")).find(Boolean)
            || null;
        // Shape encodes which end of the road this contact point is:
        // triangle = successor (end), square = predecessor (start). Rotated
        // so the tip points along the road's +s direction — WITHOUT the 90°
        // clockwise text spin other markers get, since the tip must stay
        // aligned with the road.
        const refEnd = groupEnds.find((e) => e.endName === "successor") || groupEnds[0];
        const isEnd = refEnd.endName === "successor";
        const cpShape = isEnd ? "triangle" : "square";
        const cpHeading = roadHeadingAt(refEnd.road, isEnd ? roadLength(refEnd.road) : 0);
        const cpRotation = cpHeading == null ? 0 : cpHeading + Math.PI / 2;
        const cp = addSurfaceLabel(viewer.markerGroup, "CP", 0x9aa0a6, point.x, point.y, point.z + 0.1, 0.9, cpShape, cpRotation);
        if (cp) {
            cp.userData.issueId = cpIssue ? cpIssue.id : nearestIssueId(issues, point, first.road.id, "geometry");
            cp.userData.focusPosition = { x: point.x, y: point.y, z: point.z + 0.1 };
        }
    }
}

// Find the issue belonging to a specific road END. An issue belongs to this
// end when it mentions this road and its stored position is nearer this
// endpoint than the road's other endpoint (issues without a position count
// for both ends). When `preferredCategory` is given, ONLY issues of that
// category are returned — the joint disc picks logical link problems
// (category "road"), the CP square geometric ones (category "geometry") —
// so a gap error never attaches to a road-id/link disc.
function issueForEnd(issues, road, endName, point, preferredCategory) {
    const otherPoint = endpointOf(road, endName === "predecessor" ? roadLength(road) : 0);
    const candidates = issues.filter((i) =>
        i.category !== "lane"
        && Array.isArray(i.location?.roadIds)
        && i.location.roadIds.some((id) => String(id) === String(road.id)));

    const belongs = (issue) => {
        const p = issue.location?.position;
        if (!p || !otherPoint) {
            return true;
        }
        return Math.hypot(p.x - point.x, p.y - point.y) <= Math.hypot(p.x - otherPoint.x, p.y - otherPoint.y);
    };

    const pickNearest = (list) => {
        let best = null;
        let bestDist = Infinity;
        for (const issue of list) {
            const p = issue.location?.position;
            const d = p ? Math.hypot(p.x - point.x, p.y - point.y) : Infinity;
            if (d < bestDist) {
                bestDist = d;
                best = issue;
            }
        }
        return best;
    };

    if (!preferredCategory) {
        return pickNearest(candidates.filter(belongs));
    }
    return pickNearest(candidates.filter((i) => i.category === preferredCategory && belongs(i)));
}

// ID of the issue matching a marker position. Issues carry the road IDs
// they belong to, so we match by road membership first (a disc on road X
// should select an issue about road X even when the issue's stored position
// — often a joint midpoint — is far away). `category` keeps the two marker
// layers separate: lane-link discs only select "lane" issues, road-joint
// discs only select non-lane (geometry/road) issues. `laneIds`, when given,
// pins the match to issues mentioning that exact lane pair — several lane
// issues at one joint share the same position, so distance alone cannot
// tell them apart. Distance is only a fallback for issues without road IDs
// (e.g. section-transition issues).
function nearestIssueId(issues, point, roadId = null, category = null, laneIds = null) {
    let candidates = issues;
    if (category === "lane") {
        const byCategory = candidates.filter((i) => i.category === "lane");
        if (byCategory.length > 0) {
            candidates = byCategory;
        }
    } else if (category) {
        // Road-joint discs: any non-lane issue (geometry, road, …).
        const byCategory = candidates.filter((i) => i.category !== "lane");
        if (byCategory.length > 0) {
            candidates = byCategory;
        }
    }
    if (roadId != null) {
        let byRoad = candidates.filter((i) =>
            Array.isArray(i.location?.roadIds)
            && i.location.roadIds.some((id) => String(id) === String(roadId)));
        if (laneIds && byRoad.length > 1) {
            const byLanePair = byRoad.filter((i) =>
                Array.isArray(i.location?.laneIds)
                && i.location.laneIds.some((id) => String(id) === String(laneIds[0]))
                && i.location.laneIds.some((id) => String(id) === String(laneIds[1])));
            if (byLanePair.length > 0) {
                byRoad = byLanePair;
            }
        }
        if (byRoad.length > 0) {
            // Prefer the issue whose stored position is closest to the disc.
            let best = byRoad[0];
            let bestDist = Infinity;
            for (const issue of byRoad) {
                const p = issue.location.position;
                const d = p ? Math.hypot(p.x - point.x, p.y - point.y) : Infinity;
                if (d < bestDist) {
                    bestDist = d;
                    best = issue;
                }
            }
            return best.id;
        }
    }
    let best = null;
    let bestDist = 2.0;
    for (const issue of candidates) {
        const p = issue.location?.position;
        if (!p) {
            continue;
        }
        const d = Math.hypot(p.x - point.x, p.y - point.y);
        if (d < bestDist) {
            bestDist = d;
            best = issue.id;
        }
    }
    return best;
}

// Exact world-space reference-line endpoint (no coarse sampling).
function endpointOf(road, s) {
    return refPointAt(road, Math.min(Math.max(s, 0), roadLength(road)));
}

// Static ID labels placed a bit inside each road end, so it is always clear
// which road/lane is being looked at:
// - Road ID: one gray square on the center lane, a few meters in from each
//   end (between the two joint squares).
// - Lane ID: gray circle on each lane's centerline at BOTH ends of every
//   lane section, pushed further into the road than the lane-link discs so
//   the two layers don't overlap near the joint.
// Shape matches the link markers (square = road level, circle = lane level);
// neutral gray keeps them apart from the green/red status markers.
const ID_MARKER_COLOR = 0x6b7280;

export function buildIdMarkers(viewer, model) {
    for (const road of model.roads) {
        const len = roadLength(road);
        const inset = Math.min(4, len * 0.2);
        if (inset <= 0.1) {
            continue;
        }

        // One road ID square per end, on the center lane.
        for (const s of [inset, len - inset]) {
            const ref = refPointAt(road, Math.min(Math.max(s, 0), len));
            if (!ref) {
                continue;
            }
            const c = offsetPoint(ref, laneOffsetAt(road, s));
            addSurfaceLabel(viewer.markerGroup, String(road.id), ID_MARKER_COLOR, c.x, c.y, c.z + 0.05, 1.1, "square", headingRotation(ref.hdg));
        }

        // Lane ID circles at BOTH ends of every lane section. The contact
        // ends are pulled further inside the road than the lane-link discs
        // (which sit ~1.2 m from the joint) to keep the layers apart.
        const laneInset = 3.0;
        for (const section of road.laneSections) {
            const sectionEnd = road.laneSections[road.laneSections.indexOf(section) + 1]?.s ?? len;
            for (const s of [section.s, sectionEnd]) {
                const contact = s === 0 ? "start" : (Math.abs(s - len) < 1e-9 ? "end" : null);
                let sLabel = Math.min(Math.max(s, 0), len);
                if (contact) {
                    const sign = contact === "start" ? 1 : -1;
                    sLabel = Math.min(Math.max(s + sign * laneInset, 0), len);
                    if (Math.abs(sLabel - s) < 0.5) {
                        continue; // road too short — skip to avoid overlap with discs
                    }
                }
                const ref = refPointAt(road, sLabel);
                if (!ref) {
                    continue;
                }
                for (const lane of [...section.left, ...section.right]) {
                    if (lane.id === 0) {
                        continue;
                    }
                    const halfWidth = laneWidthAt(lane, Math.max(sLabel - section.s, 0)) * 0.5;
                    if (halfWidth <= 0) {
                        continue;
                    }
                    const laneSign = lane.id > 0 ? 1 : -1;
                    const t = laneSign * (laneOffsetAt(road, sLabel)
                        + innerEdgeOffsetTotal(road, section, lane, sLabel) - halfWidth);
                    const p = offsetPoint(ref, t);
                    addSurfaceLabel(viewer.markerGroup, String(lane.id), ID_MARKER_COLOR, p.x, p.y, p.z + 0.04, 0.9, "circle", headingRotation(ref.hdg));
                }
            }
        }
    }
}

// Junction ID labels placed at the center of each junction. The center is
// simply the average of the junction's contact points: the road end of every
// incoming/outgoing road whose link declares elementType="junction" with this
// junction's id (the elementType check matters — a plain road link whose id
// numerically equals the junction id must not be counted).
// Purple matches the "junction" accent used elsewhere in the UI.
const JUNCTION_ID_MARKER_COLOR = 0x9b59f6;

export function buildJunctionIdMarkers(viewer, model) {
    for (const junction of model.junctions) {
        const points = [];
        for (const road of model.roads) {
            for (const link of [road.predecessor, road.successor]) {
                if (!link?.elementId || link.elementType !== "junction" || String(link.elementId) !== String(junction.id)) {
                    continue;
                }
                const p = endpointOf(road, link === road.predecessor ? 0 : roadLength(road));
                if (p) {
                    points.push(p);
                }
            }
        }
        if (points.length === 0) {
            continue;
        }
        let cx = 0, cy = 0, cz = 0;
        for (const p of points) {
            cx += p.x;
            cy += p.y;
            cz += p.z;
        }
        cx /= points.length;
        cy /= points.length;
        cz /= points.length;
        addSurfaceLabel(viewer.markerGroup, String(junction.id), JUNCTION_ID_MARKER_COLOR, cx, cy, cz + 0.06, 1.4, "square", 0);
    }
}

export function setMarkersVisible(viewer, visible) {
    viewer.markerGroup.visible = visible;
}
