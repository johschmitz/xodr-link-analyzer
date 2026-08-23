// Parses an OpenDRIVE XML document into a plain JS model used by the
// geometry evaluator and the linkage analyzer.

export function parseXodr(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const parserError = doc.querySelector("parsererror");
    if (parserError) {
        throw new Error(`Invalid XML: ${parserError.textContent.trim()}`);
    }

    const root = doc.documentElement;
    if (root.tagName !== "OpenDRIVE") {
        throw new Error(`Unexpected root element <${root.tagName}>, expected <OpenDRIVE>.`);
    }

    const header = root.querySelector("header");
    const roads = [];
    const junctions = [];

    for (const roadNode of root.querySelectorAll(":scope > road")) {
        roads.push(parseRoad(roadNode));
    }
    for (const junctionNode of root.querySelectorAll(":scope > junction")) {
        junctions.push(parseJunction(junctionNode));
    }

    return {
        revMajor: header?.getAttribute("revMajor") || "",
        revMinor: header?.getAttribute("revMinor") || "",
        name: header?.querySelector("geoReference") ? "georeferenced" : "",
        offset: {
            x: num(header?.querySelector(":scope > offset")?.getAttribute("x"), 0),
            y: num(header?.querySelector(":scope > offset")?.getAttribute("y"), 0),
            z: num(header?.querySelector(":scope > offset")?.getAttribute("z"), 0),
            hdg: num(header?.querySelector(":scope > offset")?.getAttribute("hdg"), 0),
        },
        roads,
        junctions,
    };
}

function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRoad(roadNode) {
    const road = {
        id: roadNode.getAttribute("id"),
        name: roadNode.getAttribute("name") || "",
        length: num(roadNode.getAttribute("length")),
        rule: roadNode.getAttribute("rule") || "RHT",
        junction: roadNode.getAttribute("junction") || "-1",
        predecessor: parseContactLink(roadNode.querySelector(":scope > link > predecessor")),
        successor: parseContactLink(roadNode.querySelector(":scope > link > successor")),
        geometries: [],
        elevationProfile: [],
        superelevationProfile: [],
        laneOffsets: [],
        laneSections: [],
    };

    const planView = roadNode.querySelector(":scope > planView");
    if (planView) {
        for (const geoNode of planView.querySelectorAll(":scope > geometry")) {
            road.geometries.push(parseGeometry(geoNode));
        }
    }

    const elevationProfile = roadNode.querySelector(":scope > elevationProfile");
    if (elevationProfile) {
        for (const node of elevationProfile.querySelectorAll(":scope > elevation")) {
            road.elevationProfile.push({
                s: num(node.getAttribute("s")),
                a: num(node.getAttribute("a")),
                b: num(node.getAttribute("b")),
                c: num(node.getAttribute("c")),
                d: num(node.getAttribute("d")),
            });
        }
    }

    const lateralProfile = roadNode.querySelector(":scope > lateralProfile");
    if (lateralProfile) {
        for (const node of lateralProfile.querySelectorAll(":scope > superelevation")) {
            road.superelevationProfile.push({
                s: num(node.getAttribute("s")),
                a: num(node.getAttribute("a")),
                b: num(node.getAttribute("b")),
                c: num(node.getAttribute("c")),
                d: num(node.getAttribute("d")),
            });
        }
    }

    const lanesNode = roadNode.querySelector(":scope > lanes");
    if (lanesNode) {
        for (const node of lanesNode.querySelectorAll(":scope > laneOffset")) {
            road.laneOffsets.push({
                s: num(node.getAttribute("s")),
                a: num(node.getAttribute("a")),
                b: num(node.getAttribute("b")),
                c: num(node.getAttribute("c")),
                d: num(node.getAttribute("d")),
            });
        }
        for (const sectionNode of lanesNode.querySelectorAll(":scope > laneSection")) {
            road.laneSections.push(parseLaneSection(sectionNode));
        }
    }

    return road;
}

function parseContactLink(node) {
    if (!node) {
        return null;
    }
    return {
        elementType: node.getAttribute("elementType") || "road",
        elementId: node.getAttribute("elementId"),
        contactPoint: node.getAttribute("contactPoint") || "",
    };
}

function parseGeometry(geoNode) {
    const geometry = {
        s: num(geoNode.getAttribute("s")),
        x: num(geoNode.getAttribute("x")),
        y: num(geoNode.getAttribute("y")),
        hdg: num(geoNode.getAttribute("hdg")),
        length: num(geoNode.getAttribute("length")),
        type: null,
    };

    const line = geoNode.querySelector("line");
    const arc = geoNode.querySelector("arc");
    const spiral = geoNode.querySelector("spiral");
    const poly3 = geoNode.querySelector("poly3");
    const paramPoly3 = geoNode.querySelector("paramPoly3");

    if (line) {
        geometry.type = "line";
    } else if (arc) {
        geometry.type = "arc";
        geometry.curvature = num(arc.getAttribute("curvature"));
    } else if (spiral) {
        geometry.type = "spiral";
        geometry.curvStart = num(spiral.getAttribute("curvStart"));
        geometry.curvEnd = num(spiral.getAttribute("curvEnd"));
    } else if (poly3) {
        geometry.type = "poly3";
        geometry.a = num(poly3.getAttribute("a"));
        geometry.b = num(poly3.getAttribute("b"));
        geometry.c = num(poly3.getAttribute("c"));
        geometry.d = num(poly3.getAttribute("d"));
    } else if (paramPoly3) {
        geometry.type = "paramPoly3";
        geometry.pRange = paramPoly3.getAttribute("pRange") === "arclength" ? "arclength" : "normalized";
        geometry.aU = num(paramPoly3.getAttribute("aU"));
        geometry.bU = num(paramPoly3.getAttribute("bU"));
        geometry.cU = num(paramPoly3.getAttribute("cU"));
        geometry.dU = num(paramPoly3.getAttribute("dU"));
        geometry.aV = num(paramPoly3.getAttribute("aV"));
        geometry.bV = num(paramPoly3.getAttribute("bV"));
        geometry.cV = num(paramPoly3.getAttribute("cV"));
        geometry.dV = num(paramPoly3.getAttribute("dV"));
    } else {
        geometry.type = "unknown";
    }

    return geometry;
}

function parseLaneSection(sectionNode) {
    const section = {
        s: num(sectionNode.getAttribute("s"), 0),
        singleSide: sectionNode.getAttribute("singleSide") === "true",
        left: [],
        center: null,
        right: [],
    };

    const leftNode = sectionNode.querySelector(":scope > left");
    const centerNode = sectionNode.querySelector(":scope > center");
    const rightNode = sectionNode.querySelector(":scope > right");

    if (leftNode) {
        for (const laneNode of leftNode.querySelectorAll(":scope > lane")) {
            section.left.push(parseLane(laneNode));
        }
    }
    if (centerNode) {
        const centerLanes = centerNode.querySelectorAll(":scope > lane");
        section.center = centerLanes.length > 0
            ? parseLane(centerLanes[0])
            : { id: 0, type: "driving", level: false, links: { successor: [], predecessor: [], direct: [] }, widths: [], borders: [] };
    }
    if (rightNode) {
        for (const laneNode of rightNode.querySelectorAll(":scope > lane")) {
            section.right.push(parseLane(laneNode));
        }
    }

    return section;
}

function parseLane(laneNode) {
    const lane = {
        id: Number(laneNode.getAttribute("id")),
        type: laneNode.getAttribute("type") || "none",
        level: laneNode.getAttribute("level") === "true",
        links: { successor: [], predecessor: [] },
        widths: [],
        borders: [],
    };

    const linkNode = laneNode.querySelector(":scope > link");
    if (linkNode) {
        for (const link of linkNode.querySelectorAll(":scope > successor, :scope > predecessor")) {
            lane.links[link.tagName].push({ id: Number(link.getAttribute("id")) });
        }
    }

    for (const widthNode of laneNode.querySelectorAll(":scope > width")) {
        lane.widths.push({
            sOffset: num(widthNode.getAttribute("sOffset")),
            a: num(widthNode.getAttribute("a"), 1),
            b: num(widthNode.getAttribute("b")),
            c: num(widthNode.getAttribute("c")),
            d: num(widthNode.getAttribute("d")),
        });
    }
    for (const borderNode of laneNode.querySelectorAll(":scope > border")) {
        lane.borders.push({
            sOffset: num(borderNode.getAttribute("sOffset")),
            a: num(borderNode.getAttribute("a")),
            b: num(borderNode.getAttribute("b")),
            c: num(borderNode.getAttribute("c")),
            d: num(borderNode.getAttribute("d")),
        });
    }

    return lane;
}

function parseJunction(junctionNode) {
    const junction = {
        id: junctionNode.getAttribute("id"),
        name: junctionNode.getAttribute("name") || "",
        type: junctionNode.getAttribute("type") || "default",
        connections: [],
    };

    for (const connNode of junctionNode.querySelectorAll(":scope > connection")) {
        const connection = {
            id: connNode.getAttribute("id"),
            incomingRoad: connNode.getAttribute("incomingRoad"),
            connectingRoad: connNode.getAttribute("connectingRoad"),
            contactPoint: connNode.getAttribute("contactPoint") || "start",
            laneLinks: [],
        };
        for (const laneLinkNode of connNode.querySelectorAll(":scope > laneLink")) {
            connection.laneLinks.push({
                from: Number(laneLinkNode.getAttribute("from")),
                to: Number(laneLinkNode.getAttribute("to")),
            });
        }
        junction.connections.push(connection);
    }

    return junction;
}
