# Issue Types — OpenDRIVE Link Analyzer

This document lists the linkage checks the analyzer performs and the issues they
can produce. It is the living reference for what "correct" means in this tool —
update it whenever a check is added, changed, or removed.

Each issue has a **category** (`road`, `lane`, `geometry`), a **severity**
(`error` = broken linkage, `warning` = suspicious but possibly intentional), a
short title, and a detail message naming the involved roads/lanes. Issues are
listed in the right-hand panel, rendered as markers in the 3D view, and
deduplicated when the same problem is found from both sides of a joint.

## Road-level logical linkage (`src/analysis/roadLinks.js`)

Checks each road's `<predecessor>` / `<successor>` elements.

| Title | Severity | Description |
|---|---|---|
| Missing road link target | error | The linked element id does not exist as a road or junction. |
| Road `<end>` declared as junction but is a road | error | `elementType="junction"` is declared, but the referenced id is a road. |
| Unidirectional road link | error | A links to B, but B has no matching link back to A (either no link at that end, or a link to a different element). |
| Road contact point mismatch | error | The reverse link exists but declares the wrong contact point (`start` vs `end`). |
| No road entry in junction connections | error | The road references a junction, but the junction has no `<connection>` with this road as `incomingRoad`. |

## Lane-level logical linkage (`src/analysis/laneLinks.js`)

Checks lane `<link>` entries between connected roads and between consecutive
lane sections of the same road.

| Title | Severity | Description |
|---|---|---|
| Missing lane link target | error | A lane links to a lane id that does not exist on the neighbor road at that end. |
| Missing lane link target at section transition | error | A lane links across a section boundary to an id that does not exist in the adjacent section (OpenDRIVE requires explicit links between consecutive sections). |
| Unidirectional lane link | error | A's lane links to B's lane, but B's lane does not link back (either no reverse links at all, or links to a different lane). |
| Lane type mismatch | warning | Linked lanes have incompatible types (e.g. driving → sidewalk). |
| Lane link lateral jump | warning | Linked lanes barely overlap laterally at the joint — traffic would shift sideways. |
| Center lane link across roads | error | Center lane (id 0) has a link across a road boundary, which OpenDRIVE forbids. |

## Junction lane links (`src/analysis/junctionLaneLinks.js`)

OpenDRIVE rule: for each `<connection>`, its `<laneLink>` elements shall only
be specified for the lanes that lead INTO the junction — `from` is a lane of
the incoming road at its junction-facing end, `to` a lane of the connecting
road at the declared contact point. The outgoing side carries no junction
lane-link information; continuation out of the connecting road is expressed by
that road's own `<link>` elements.

| Title | Severity | Description |
|---|---|---|
| Junction connection without incoming link | error | The connection's `incomingRoad` has no end that references the junction. |
| Duplicate junction laneLink | error | The same incoming lane is listed twice in one connection's `<laneLink>`s. |
| Junction laneLink from unknown lane | error | `from` does not exist on the incoming road at its junction-facing end (wrong side / wrong section). |
| Incoming road lane link | warning | The incoming road declares its own lane links toward the junction; that pairing is already defined by the junction's `<laneLink>` elements, so this is duplicate information. |
| Junction laneLink for outgoing direction | error | A `<laneLink>`'s `from` lane does not lead into the junction — the laneLink describes the outgoing driving direction, which belongs in the roads' own `<link>` elements, not the junction XML. |
| Junction laneLink to unknown lane | error | `to` does not exist on the connecting road at the declared contact point. |
| Unidirectional junction laneLink | error | The connecting road's lane does not link back to the incoming lane at the contact point, although it declares links there. |
| Missing reverse lane link on connecting road | warning | A declared `laneLink` target lane has no reverse link while sibling lanes do — likely an oversight rather than intent. |
| Connecting road lane link mismatch | warning | The connecting road declares a lane link back to the incoming road at the junction contact point that no junction `<laneLink>` covers. |

## Geometrical linkage (`src/analysis/geometryLinks.js`)

For every connected pair of endpoints (direct road-to-road, and via junction
connections), compares world positions and orientations. Tolerances are
configurable in the sidebar.

| Title | Severity | Description |
|---|---|---|
| Contact point gap at connection | error | Distance between the two endpoint world positions exceeds the position tolerance. |
| Road heading discontinuity | error | Yaw difference at the joint exceeds the heading tolerance — twisted/misaligned connection. |
| Road elevation step | error | \|Δz\| at the joint exceeds the elevation tolerance. |
| Road width mismatch | warning | Total lane-group width differs significantly across the joint — roads connect but lanes don't line up physically. |

## Overlapping roads (`src/analysis/overlappingRoads.js`)

| Title | Severity | Description |
|---|---|---|
| Overlapping roads | error | Two roads overlap over a significant length without belonging to (or connecting to) a junction — usually duplicated geometry. |

## Maintenance notes

- When adding a new check: add it to the matching table above (or create a new
  section), including severity and a one-line description.
- When changing severity or semantics of an existing issue, update its row.
- Removing a check should remove its row here too; this file intentionally
  contains only what the code actually implements.
