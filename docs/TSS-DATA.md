# Traffic separation scheme data (`passages/<id>.tss.json`)

A traffic separation scheme is described once, declaratively, in a JSON file next to the passage that uses it.
`tools/build_chart.py` turns it into the polygons of the `tss` block of `site/passages/<id>/chart-data.js`; the app draws them,
runs its point-in-polygon zone alerts against them and (soon) reads the alert text and flow direction from them
instead of hard-coding them. The schema is `schema/tss.schema.json`; `tools/validate_passage.py` checks the file
(schema plus the rules below) and the builder refuses to run on an invalid one.

The passage file points at it: `"tss": "strait-of-gibraltar.tss.json"` (relative to the passage file). A passage
without `"tss"` gets an empty `tss` block: no lanes, no alerts.

**Safety first.** The scheme in force is the one promulgated by IMO and printed on the official charts. Transcribe
the positions from the current COLREG.2 circular (or the IMO Ships' Routeing publication), never from a map
database, and record who checked them in `checkedBy`. Positions are facts and may be copied; the circular's prose
is IMO copyright and must not be (see `docs/LICENSING.md`).

## Top level

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Scheme id, normally the passage id (`strait-of-gibraltar`). |
| `name` | yes | Name as in the circular: `"In the Strait of Gibraltar"`. |
| `source` | yes | Circular or resolution, session, reference chart, datum. |
| `sourceDate` | yes | Date of the circular, `YYYY-MM-DD`. |
| `inForce` | | Date the scheme came into force. |
| `datum`, `referenceChart` | | Informational; the app assumes WGS 84. |
| `checkedBy` | yes | Who checked the transcription against the circular and the chart. Be honest: the bundled file says it has not been checked by a navigator yet. |
| `checkedOn` | | Date of that check. |
| `notes` | | Free text: construction decisions, notes of the circular paraphrased in your own words. |
| `rules.crossing` | | `{"rule": "rightAngles", "colreg": "10(c)", "text": ...}`: how lanes are crossed. `rightAngles` means the app steers to `flowDeg ± 90`, whichever is closer to the leg course, and tells the helmsman not to slow down. |
| `points` | yes | Named positions, see below. |
| `separationZones`, `lanes`, `precautionary`, `inshoreZones`, `freeAreas`, `anchorages` | | The elements, see below. Each list is written to the chart in the order given; that is also the order the app checks and draws them in. |

## Points

Every position is written once, in `points`, and referred to by id everywhere else, so a corrected position
changes every polygon that uses it.

```json
{"id": "1", "lat": "35 59.01 N", "lon": "5 25.68 W"}
{"id": "itz_n_nw", "role": "construction", "lat": 36.12, "lonOf": "11", "note": "..."}
```

- `id`: for IMO points use the position number of the circular (`"1"` … `"25"`), so a reviewer can put the file and
  the circular side by side.
- `lat` / `lon`: either decimal degrees (north and east positive) or degrees and decimal minutes with hemisphere,
  exactly as printed in the circular (`"36 02.80 N"`, `"5 19.68 W"`). The builder computes `degrees + minutes / 60`,
  the same arithmetic the previous Python table used, so the transcription and the generated chart are unchanged.
- `latOf` / `lonOf`: take the parallel or the meridian of another point. Used for construction points such as
  "the meridian of point 11 at 36.12 N".
- `role`: `imo` (default) points are written to `chart-data.js` as `tss.points`; `construction` points are only
  used to close polygons and never leave the builder.

Construction points exist because inshore traffic zones are bounded by the coast: the circular gives the seaward
limits and the meridians, and the coast closes the polygon. The file carries the meridians inland to a latitude
well over the land and the builder cuts the polygon at the OpenStreetMap coastline (`clipToLand`).

## Separation zones

```json
{"id": "zone_b", "name": "Separation zone (west)", "paragraph": "b",
 "centreline": ["3", "4", "5"], "halfWidthNm": 0.25, "region": ["9", "10", "11", "12", "13", "14"],
 "level": "warn", "enter": "In the separation zone. Keep crossing, do not linger.", "leave": null}
```

The circular says "a separation zone, half a mile wide, is centred upon the following positions": that is the
`centreline` and `halfWidthNm` 0.25. The builder buffers the centreline (extended 3 nm beyond both ends, square
caps and mitred joins, in a local nautical-mile plane) and clips the strip to `region`, the outer limit of the whole
scheme part the zone sits in (both lanes' outer lines joined into one polygon).

## Lanes

```json
{"id": "west_wb", "name": "Westbound lane (west)", "paragraph": "d", "flowDeg": 270,
 "region": ["9", "10", "11", "12", "13", "14"], "separationZone": "zone_b", "side": "north",
 "crossing": "rightAngles", "arrows": {"along": ["3", "4", "5"], "offsetNorthNm": 1.2, "perSegment": 4},
 "level": "danger", "enter": "Entering the WESTBOUND traffic lane. ...", "leave": "Clear of the westbound lane."}
```

- `region` + `separationZone` + `side`: the lane polygon is `region` minus the separation-zone strip, and `side`
  (`north`, `south`, `east`, `west`) says which of the two remaining parts it is. The builder asserts there are
  exactly two parts. A lane without a separation zone (a scheme with a separation *line*) omits both keys and
  gives the lane polygon itself as `region`.
- `flowDeg`: general direction of traffic flow, degrees true, 0–360. The app derives the side ships come from and
  the crossing heading from it; the chart's `flow` letter (`W` / `E` / `N` / `S`) is the nearest cardinal.
- `trueAxisDeg` (informational) records the lane axis when `flowDeg` is a rounded cardinal value.
- `crossing`: `rightAngles` (default; see `rules.crossing`).
- `arrows`: flow arrows on the chart, along the line through `along` in the order of the flow, shifted north by
  `offsetNorthNm` (negative for south), `perSegment` arrows per segment, clipped to the lane polygon.

**The flowDeg choice for Gibraltar.** The western pair (points 3-4-5) runs 270/090 true in the part the
recommended route crosses (5°42'W). The eastern pair (points 1-2) actually runs 252/072 true. The file keeps
`flowDeg` 270/090 for all four lanes because that is what the app computed before this file existed (`flow: 'W'`
→ 270), so the spoken crossing headings (180/000) do not change with this data move. Switching the eastern pair to
252/072 is a one-line data change; do it only after running `node tools/replay.js` on the east route and reviewing
the new crossing headings it speaks.

## Precautionary areas, inshore traffic zones, free areas

```json
{"id": "prec_tm", "name": "Precautionary area Tanger-Med", "paragraph": "h", "region": ["8", "9", "14", "15"],
 "level": "warn", "enter": "Entering the Tanger-Med precautionary area. ...", "leave": "Leaving the precautionary area."}
{"id": "itz_sw", "name": "South-western inshore traffic zone (Morocco)",
 "region": ["12", "13", "14", "20", "21", "22", "23", "24", "coast_24", "coast_12", "25"], "clipToLand": true,
 "level": "info", "enter": "In the Moroccan inshore traffic zone. Follow the coast to Tangier.", "leave": "Leaving the Moroccan inshore zone."}
```

`region` is the polygon (vertices in ring order, do not repeat the first point). `inshoreZones` and `freeAreas`
accept `clipToLand: true` to subtract the OpenStreetMap land polygons. Only the outer ring of the result is kept:
an island inside a clipped zone does not make a hole.

## Anchorages

```json
{"id": "anch_alpha", "name": "Anchorage Alpha (Tanger-Med ships)", "lat": "35 51.05 N", "lon": "5 40.34 W", "radiusNm": 0.4}
```

Circular anchorage areas of the scheme. They are written to `chart-data.js` as `tss.anchorages` (id, name, lat,
lon, radiusNm); alerting on them is the passage file's job (Gibraltar lists Anchorage Alpha as hazard
`anch_alpha`).

## Alert text (every element except anchorages)

| Key | Meaning |
|---|---|
| `level` | `danger` (beeps, interrupts speech), `warn` (beeps), `info` (spoken only). |
| `enter` | Spoken when the boat enters. Required, a full sentence a helmsman can act on: `"Ships come from your LEFT"`. |
| `leave` | Spoken when the boat leaves; `null` for a silent exit (the transition is still logged and replayed). |

For lanes the app composes the spoken text itself from `flowDeg`, the leg course and the boat's heading (side of
traffic, crossing heading); `enter` is the static fallback and the text of the briefing.

The Gibraltar texts were copied verbatim from the app's former `ZONE_TEXT` table, so the data move changed no
spoken word. They are emitted to the chart as `tss.<list>[].level / enter / leave` and `tss.lanes[].flowDeg /
crossing` so the app can drop its table.

## Ids and the LEG report

Element ids must be unique across the whole file (lanes, zones, precautionary areas, inshore zones, free areas,
anchorages): the app keys its zone state by id. `paragraph` (a letter) names the paragraph of the circular that
describes the element; the builder labels the element `<kind>_<letter>` in its LEG report (`zone_a`, `lane_d`,
`prec_g`, the names `docs/TESTING.md` uses), falling back to the id.

## Checks

`python3 tools/validate_passage.py` (run automatically by the builder and in CI) validates against
`schema/tss.schema.json` and then checks: point ids unique, every reference resolves (no cycles), latitude and
longitude in range after parsing, every region and centreline point exists, regions have at least three distinct
points and (with shapely) are valid polygons, element ids unique across the file, `side` and `separationZone`
come together, `separationZone` exists, every element has `enter` text, alert text ends with a full stop
(warning), IMO points inside the passage bbox (warning), paragraph letters unique per kind (warning).

## Gibraltar file

`passages/strait-of-gibraltar.tss.json`: the 25 positions of COLREG.2/Circ.66 Annex 1, two separation zones
(a: points 1-2, b: points 3-4-5), four lanes (c, d westbound; e, f eastbound), two precautionary areas (g east,
h Tanger-Med), the northern, south-eastern and south-western inshore traffic zones, the free navigation area off
Tanger-Med, and Anchorage Alpha. It reproduces the previous hard-coded chart byte for byte; regenerate with
`python3 tools/build_chart.py <scratch>` and diff.
