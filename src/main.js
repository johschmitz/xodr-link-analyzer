import { parseXodr } from "./xodr/parser.js";
import { setWorldOffset } from "./xodr/geometry.js";
import { analyze } from "./analysis/analyzer.js";
import {
    createViewer,
    buildRoadMeshes,
    buildIssueMarkers,
    buildJointMarkers,
    buildLaneLinkMarkers,
    buildIdMarkers,
    buildJunctionIdMarkers,
    setReferenceLinesVisible,
    setMarkersVisible,
} from "./viewer.js";
import { createErrorPanel, showToast } from "./ui/errorPanel.js";

const ui = {
    viewport: document.getElementById("viewport"),
    fileInput: document.getElementById("fileInput"),
    fileStatus: document.getElementById("fileStatus"),
    roadCountStat: document.getElementById("roadCountStat"),
    junctionCountStat: document.getElementById("junctionCountStat"),
    okCountStat: document.getElementById("okCountStat"),
    errorCountStat: document.getElementById("errorCountStat"),
    warnCountStat: document.getElementById("warnCountStat"),
    refLineToggle: document.getElementById("refLineToggle"),
    markersToggle: document.getElementById("markersToggle"),
    tolGap: document.getElementById("tolGap"),
    tolHeading: document.getElementById("tolHeading"),
    tolZ: document.getElementById("tolZ"),
    reanalyzeButton: document.getElementById("reanalyzeButton"),
    fitViewButton: document.getElementById("fitViewButton"),
    issueList: document.getElementById("issueList"),
    filterToggle: document.getElementById("filterToggle"),
    copyAllButton: document.getElementById("copyAllButton"),
    filterPanel: document.getElementById("filterPanel"),
    filterCheckboxes: document.getElementById("filterCheckboxes"),
    filterAllButton: document.getElementById("filterAllButton"),
    filterNoneButton: document.getElementById("filterNoneButton"),
    helpButton: document.getElementById("helpButton"),
    infoPanel: document.getElementById("infoPanel"),
    closeInfoButton: document.getElementById("closeInfoButton"),
};

const viewer = createViewer(ui.viewport);
let currentModel = null;
let currentIssues = [];

function tolerances() {
    return {
        gap: Number(ui.tolGap.value) || 0.01,
        heading: Number(ui.tolHeading.value) || 0.5,
        z: Number(ui.tolZ.value) || 0.01,
    };
}

// Single place where the camera gets positioned for issue focus, used by
// both the issue list and clicks on discs in the 3D view.
function focusCameraOn(position) {
    viewer.focusOn(position, 40);
}

const errorPanel = createErrorPanel({
    listElement: ui.issueList,
    filterCheckboxes: ui.filterCheckboxes,
    onSelect(issue) {
        const position = issue.location?.position;
        focusCameraOn(position);
    },
});

errorPanel.setIssues([]); // populate filter list with all classes at startup

ui.filterToggle.addEventListener("click", () => {
    const expanded = ui.filterToggle.getAttribute("aria-expanded") === "true";
    ui.filterToggle.setAttribute("aria-expanded", String(!expanded));
    ui.filterToggle.textContent = expanded ? "Filter ▾" : "Filter ▴";
    ui.filterPanel.hidden = expanded;
    ui.filterPanel.classList.toggle("open", !expanded);
});

ui.filterAllButton.addEventListener("click", () => {
    setAllFilters(true);
});

ui.copyAllButton.addEventListener("click", () => {
    errorPanel.copyAllIssues(ui.copyAllButton);
});
ui.filterNoneButton.addEventListener("click", () => {
    setAllFilters(false);
});

function setAllFilters(visible) {
    for (const checkbox of ui.filterCheckboxes.querySelectorAll("input[type=checkbox]")) {
        checkbox.checked = visible;
        checkbox.dispatchEvent(new Event("change"));
    }
}

async function loadFile(file) {
    console.log(`[xodr] Loading file: ${file.name} (${(file.size / 1024).toFixed(1)} kB)`);
    ui.fileStatus.textContent = file.name;
    try {
        const text = await file.text();
        console.log(`[xodr] Read ${text.length} characters.`);
        const model = parseXodr(text);
        console.log(`[xodr] Parsed OK: ${model.roads.length} roads, ${model.junctions.length} junctions.`, model);
        setWorldOffset(model.offset);
        currentModel = model;
        buildRoadMeshes(viewer, model);
        console.log("[xodr] Road meshes built.");
        runAnalysis();
        console.log(`[xodr] Analysis done: ${currentIssues.length} issues.`, currentIssues);
        ui.roadCountStat.textContent = String(model.roads.length);
        ui.junctionCountStat.textContent = String(model.junctions.length);
        showToast(`Loaded ${file.name}`);
    } catch (error) {
        console.error("[xodr] Load failed:", error);
        ui.fileStatus.textContent = error.message;
    }
}

function runAnalysis() {
    if (!currentModel) {
        return;
    }

    console.log(`[xodr] Analyzing with tolerances:`, tolerances());
    const { issues, lookups } = analyze(currentModel, tolerances());
    currentIssues = issues;

    buildIssueMarkers(viewer, issues.filter((i) => i.severity !== "info"));
    buildJointMarkers(viewer, currentModel, lookups, issues);
    buildLaneLinkMarkers(viewer, currentModel, lookups, issues);
    buildIdMarkers(viewer, currentModel);
    buildJunctionIdMarkers(viewer, currentModel);

    errorPanel.setIssues(issues);
    ui.copyAllButton.disabled = issues.length === 0;

    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warning").length;
    ui.errorCountStat.textContent = String(errors);
    ui.warnCountStat.textContent = String(warnings);
    ui.okCountStat.textContent = String(Math.max(countJoints() - errors, 0));
}

function countJoints() {
    if (!currentModel) {
        return 0;
    }
    let count = 0;
    for (const road of currentModel.roads) {
        if (road.predecessor?.elementId) count += 1;
        if (road.successor?.elementId) count += 1;
    }
    return count;
}

ui.fileInput.addEventListener("change", () => {
    console.log("[xodr] File input change event, files:", ui.fileInput.files.length);
    if (ui.fileInput.files.length > 0) {
        loadFile(ui.fileInput.files[0]);
    }
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    console.log("[xodr] Drop event, file:", file?.name);
    if (file && /\.xodr$/i.test(file.name)) {
        loadFile(file);
    }
});

ui.refLineToggle.addEventListener("change", () => setReferenceLinesVisible(viewer, ui.refLineToggle.checked));
ui.markersToggle.addEventListener("change", () => setMarkersVisible(viewer, ui.markersToggle.checked));
ui.reanalyzeButton.addEventListener("click", runAnalysis);
[ui.tolGap, ui.tolHeading, ui.tolZ].forEach((input) => input.addEventListener("change", runAnalysis));
ui.fitViewButton.addEventListener("click", () => viewer.fitView());

ui.helpButton.addEventListener("click", () => {
    ui.infoPanel.hidden = !ui.infoPanel.hidden;
});
ui.closeInfoButton.addEventListener("click", () => {
    ui.infoPanel.hidden = true;
});

// Clicking a disc in the 3D view selects the linked issue (highlight in the
// list) but centers the camera on the clicked disc's own position, so each
// side of a link pair zooms to where you actually clicked.
viewer.onMarkerClick(({ issueId, position }) => {
    if (issueId != null) {
        errorPanel.selectIssueSilently(issueId);
    } else {
        errorPanel.deselect();
    }
    focusCameraOn(position);
});

function animate() {
    viewer.render();
    requestAnimationFrame(animate);
}

console.log("[xodr] main.js loaded — wiring UI events.");

// Auto-load the default sample for faster iteration.
fetch("./samples/sample-broken.xodr")
    .then((response) => {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.text();
    })
    .then((text) => {
        const file = new File([text], "sample-broken.xodr");
        loadFile(file);
    })
    .catch((error) => console.warn("[xodr] Auto-load of sample skipped:", error.message));

fetch("./version.json")
    .then((response) => response.json())
    .then((data) => {
        if (data.version) {
            document.getElementById("versionLabel").textContent = `v${data.version}`;
        }
    })
    .catch(() => { /* version label is cosmetic */ });

animate();
