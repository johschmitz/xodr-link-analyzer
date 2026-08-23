# OpenDRIVE Link Analyzer

Web-based tool that loads an OpenDRIVE (`.xodr`) file, renders it in 3D with
three.js, and analyzes **road-level**, **lane-level**, and **geometrical**
linkage. Correct joints are marked green, broken links red (warnings yellow).
Click an issue in the right-hand list or in the 3D viewport to zoom the view
onto it.

Background: I had this idea for a good visualization of the OpenDRIVE road and
lane linkage in the back of my mind for a long time and finally found some time
and free tokens via the OpenRouter Ox Alpha promotion. No simple and good tool
exist to help with this task to the best of my knowledge. I think what comes
closest is the official ASAM OpenX Quality checker tooling.

Warning: this tool has been vibecoded over the course of a single weekend and
although I did many manual testing and improvement iterations it still contains
a potentially large number of bugs and OpenDRIVE support is very basic.

## Run locally

This app is structured into multiple files using ECMAScript (ES) modules. ES
modules require a web server (opening `index.html` via `file://` will not work):

```sh
python3 -m http.server 8080
```

## Usage

1. Click **Load .xodr file** (or drag & drop a `.xodr` anywhere on the page).
2. Browse issues in the **Issues** panel; click one to fly the camera there.
3. Toggle reference lines / markers in the sidebar; adjust gap/heading/z
   tolerances and hit **Re-analyze** to re-run checks.
4. Click a marker in the 3D view to select it in the panel.
5. Double-click any mesh in the 3D view to make that point the new orbit
   pivot — the camera keeps its viewing angle and distance, only the center
   of rotation moves.

Sample files are in `samples/`:
- `sample-valid.xodr` — two correctly linked roads, no errors expected.
- `sample-broken.xodr` — includes a missing successor target, a positional gap,
  heading discontinuity, elevation step, and broken lane links.

See `ISSUE_TYPES.md` for the list of supported issue types.

## Dependencies

The three.js dependency has been added to this repository (no build step, no CDN
at runtime):

- [three.js](https://github.com/mrdoob/three.js) r185 — 3D rendering
  (`libs/three/`, MIT License, Copyright © 2010-2026 Three.js authors),
  including the `OrbitControls` and `lines` (fat lines) addons from
  `examples/jsm/`.

The machine-readable SPDX bill of materials lives in [`SPDX.sbom`](SPDX.sbom).
