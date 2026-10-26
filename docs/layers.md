# Layers

What each OSM-derived layer looks like, what tilegen emits for it and which
module draws it. The short version of the tile contract is in
[architecture.md](architecture.md); [AGENTS.md](../AGENTS.md) has the
module-by-module map.

## Buildings

Clicking a building inspects it: the popup shows its name and address, height,
wall color, roof shape and roof color (with a swatch), marks the values tilegen
had to impute, and links to the feature's OSM page when the tile carries an id.
The popup also has a **G** button that downloads the building as a `.glb`.
The layers menu (the gear at the top left) turns the **windows**, **balconies**,
**roof shapes**, **water**, **church crosses**, **parked cars**, **lamp posts**
and **imputed colors** on and off, with a question mark beside the last one
explaining what imputation means.

### Building parts

`building:part=*` footprints are emitted as ordinary buildings. A part's bottom
comes from `min_height`, or `min_level` × 3 m when that is missing; its top from
`height`, else `max_level` × 3 m, else the level count added to the base. The
walls therefore start on the podium and the roof sits at the part's real top
(the Bicocca University example is a 10–15 m volume). Facade windows and
balconies are offset by the same base and a part starting above the street gets
no ground door.

## Light and atmosphere

The scene opens on the real sun over Milan (`src/daynight.ts`): the current sun
position over Milan is used, you need to change the code for other coordinates.

The directional light casts soft shadows over a 2 km cascade following the view;
Sky/fog colors, ambient warmth and a whole-canvas warm multiply (`#grade`)
follow the same model, so golden hour is warm with long shadows.

The **basemap** checkbox swaps the MapTiler style for an empty one, leaving the
3D scene on its own; unchecking it is useful for screenshots and for checking
the generated city against the real map. At night the basemap swaps to the dark
style (with a short fade through black),
the scene lights and parked cars dim, and the street lamps and traffic signals
glow: `tilegen/lamps.py` puts a lamp every 55 m on both sides of every
parking-eligible road, and the signal heads blink red/green on the same global
8 s light the vehicles react to. Both are additive sprites on a thin instanced
post (`src/night_lights.ts`), visible at night above zoom 15. The **lamp posts**
checkbox switches the street lamps and their posts off; the signal heads stay.

## Churches

A church is an ordinary `building=*` polygon in OSM, so tilegen reports the
`building` value (and `religion` for an `amenity=place_of_worship`), and the
frontend does the classifying (`isChurch` in `src/elements3d/church.ts`):
`church`, `cathedral`, `chapel`, `basilica`, `abbey`, `monastery`, or a place of
worship with a `christian`/`christian:*` religion.

A church gets a different look from the apartment blocks around it: when OSM has
no `building:colour` for it, its walls take a seeded warm stone/ochre tone (a real
tagged color still wins), when OSM has no `roof:colour` the roof is slate, and the
roof is forced gabled and pitched 1.3× steeper than the default — a footprint too
complex for a pitched roof (a courtyard, a concave outline) stays flat, as it does
for any building. A **gold cross** (3 m, up to 6 m on a cathedral-sized footprint)
stands on the ridge, or just above the cap of a flat roof; its arms follow the
ridge, so it reads as a cross from the side of the church. The cross is its own
per-tile mesh (kind `church`), so the **church crosses** checkbox hides the
ornament and leaves the church walls as buildings.

## Water

Water is drawn at ground level by an animated shader (`src/elements3d/water.ts`):
lakes, ponds and reservoirs as flat polygons, and rivers, canals and streams as
flat ribbons whose width depends on the class (`WATERWAY_WIDTH`). tilegen clips
each water body to the tile, so a lake or a long canal only stores the piece
that belongs to the tile instead of its whole outline in every tile it touches.

The shader is a `ShaderMaterial` (no lights or normals): a drifting field of two
crossing swells plus some noise, with narrow bright bands that travel across it,
tinted by a per-kind base color baked into the vertex colors. `uTime` is
advanced every frame from wall-clock time, so the surface keeps moving while the
map is still. Water is its own per-tile mesh, so the **water** checkbox in the
layers menu is a plain visibility switch.

Clicking water inspects it, like a building: a popup shows its name (when OSM
has one), its kind (Lake, Canal, ...) and a link to the feature's OSM page when
the tile carries an id. Picking is a point-in-polygon test for areas and a
distance-to-centerline test for waterways.

A water body below ground is drawn at 10% opacity (`UNDERWATER_OPACITY`): OSM
marks this with a negative **`layer`** (the tunnel/bridge ordering — Seveso is
`layer=-2`; `level` is the fallback). The fade is baked into a per-vertex
`aFade` attribute, so a tile's merged water mesh can mix surface and underwater
features. tilegen emits the effective vertical position as the feature's `layer`
and reports the positions it finds: water below 0 (the ones that fade) and roads
above 0 (bridges; see *Bridges and tunnels* below; the road network itself is not
emitted).

## Cemeteries

Cemeteries are OSM areas (`landuse=cemetery` or `amenity=grave_yard`), clipped
to the tile like a park and emitted as `cmtype: "cemetery"`. The frontend leaves
the basemap's cemetery ground and path network visible and fills the area with
rows of simple tombstones (`src/elements3d/cemetery.ts`, layout in
`tombstone_rows.ts`).

The graves themselves are almost never mapped, so the rows are procedural: the
grid is aligned to the cemetery's longest wall, inset from the boundary, given a
seeded gap pattern so it does not read as a checkerboard, and capped at
`MAX_TOMBSTONES_PER_TILE` (6,000). A very large cemetery widens the row and
stone spacing rather than leaving holes in the rows. Most stones are slabs with
a seeded height and pale stone; about one in ten is a simple cross. The stones
are one geometry and one Lambert material per tile (kind `cemetery`), so a tile
is one draw call and the stones darken at night with the rest of the scene. They
are small enough not to cast shadows. Parking and street lamps skip ways whose
midpoint is inside a cemetery, so the grave paths do not fill with parked cars.

## Street furniture

Bollards, bins, bike racks, post boxes, drinking fountains, info boards and
hydrants are emitted as point features (`cmtype: "furniture"`, with a
`furniture` kind) and drawn as simple low-poly boxes by
`src/elements3d/furniture.ts`. Areas (a bike-parking lot) collapse to their
centroid; a line (a rack mapped as a way) keeps its bearing so the rack lines up
with the kerb. A whole tile merges into one Lambert mesh (kind `furniture`), so
the density costs one draw call per tile, not one per object. The props do not
cast shadows and darken at night with the benches and buildings.

Benches remain their own layer (they carry a facing and have a checkbox); the
street-furniture layer is always visible like trees and water.

## Fountains

`amenity=fountain` becomes a point with a `size` (the equivalent diameter of a
mapped area, clamped to 1.5–12 m; a node keeps 2.4 m). The frontend
(`src/elements3d/fountain.ts`) builds a stone basin with a blue water surface
and, for the larger ones, a central pedestal, bowl and jet. The stone is one
Lambert mesh (`fountain`); the water is its own mesh (`fountain_water`) with a
small shader that ripples the basin, adds concentric rings and runs moving bands
up the jet, dimmed at night. Clicking either rings the basin and opens a popup
with its name (when OSM has one) and the OSM link.

## Transit stops

Metro entrances, tram stops and bus stops are point features
(`cmtype: "transit_stop"`, with `stop: metro|tram|bus`, `name` and `shelter`).
The frontend (`src/elements3d/transit.ts`) gives them the Milan look: a metro
entrance has a dark stair opening and an "M" totem — a red panel with a white
M on a single double-sided plane, drawn on a small canvas texture and kept as
its own per-tile mesh; a bus or tram stop has the yellow palina, with a
shelter (posts, roof, glass back and a bench) when OSM says it is covered. The
poles and shelters merge into one Lambert mesh per tile; the sign planes are the
only textured part. Clicking one rings the stop and opens a popup with the stop
name, its kind and the OSM link.

## Outdoor terraces

Food and drink places tagged with `outdoor_seating` become a point feature
(`cmtype: "terrace"`, with the amenity and name). tilegen moves the point from
the cafe to the nearest road point outside the building footprint, so the
umbrellas sit at the kerb. The frontend (`src/elements3d/terrace.ts`) lays out
one or two umbrellas with tables and three chairs each, merged into one Lambert
mesh per tile. The umbrellas are seeded cream/red/green/blue; the terrace is
clickable and shows the place name, the terrace kind and the OSM link. No
shadows.

## Playgrounds and monuments

`leisure=playground` becomes a point with an equivalent diameter (6–18 m). The
frontend (`src/elements3d/playground.ts`) draws a sand/rubber patch with a swing,
a slide, a spring rider and, for wider patches, a climbing frame, merged into one
Lambert mesh per tile and clickable.

`historic=monument`, `historic=memorial` and `man_made=obelisk` become
`cmtype: "monument"` points carrying the `kind` and `memorial` sub-kind. The
frontend (`src/elements3d/monument.ts`) picks a pedestal/statue, bust, obelisk,
war memorial, stele, plaque or Stolperstein from those tags, merges the pieces
per tile and makes each one clickable with its name and OSM link.

## Construction sites

`landuse=construction` areas are clipped to the tile like a park. The frontend
(`src/elements3d/construction.ts`) draws the dirt/gravel ground, containers and a
material stack, plus one to three tower cranes on the tile that holds the site
centroid (so a site spanning tiles does not sprout a crane in every one). Cranes
are simplified solid masts and jibs; at map zoom the silhouette is the point.
Clicking a site rings it and shows its name, kind and OSM link. `building=construction`
footprints still go through the ordinary building layer.

## Crosswalks

Marked `highway=crossing` nodes become `cmtype: "crosswalk"` points. tilegen
matches each node to its road way and carries the local `bearing` and the full
road `width` (from `width`, then `lanes`, then the highway class); unmarked and
informal crossings, tunnel/bridge decks and nodes with no matching road are
skipped. The frontend (`src/elements3d/crosswalk.ts`) lays white bars along the
carriageway, repeated across it, turns them with the road and merges them into
one mesh per tile. They sit a few centimeters above the ground so they do not
z-fight the basemap, and are clickable with a "Zebra crossing" popup and OSM
link. The plain `crossing` point still drives the cosmetic vehicle slowdown; the
two features share an id.

## Stop lines and lane arrows

`highway=stop`, `highway=give_way` and `highway=traffic_signals` nodes become
`cmtype: "road_marking"` points carrying the road's approach `directions`, width,
lane count and `turn:lanes`. tilegen uses `direction=forward/backward` on stop
and give-way nodes (relative to the matched way), `oneway` and, for signals
without a direction, both approaches. The frontend
(`src/elements3d/road_marking.ts`) draws a solid white stop line 3.2 m before
the node on the approach half of a two-way road (the full width when one-way),
or a dashed give-way line, plus one white lane arrow per approach lane where
there are at least two lanes; `turn:lanes` turns the arrow. One merged mesh per
tile (kind `road_marking`), with a thin dark edge for contrast. These are
painted markings, so there is no popup and no toggle.

## Platforms and rails

Rail and tram platforms are clipped to the tile; a platform mapped as an edge
line is buffered to a 4 m ribbon. The frontend (`src/elements3d/platform.ts`)
raises them into a concrete slab with a white edge and makes them clickable.
Above-ground `railway=rail`/`tram` ways become `cmtype: "rail"` features; the
frontend (`src/elements3d/rail.ts`) lays a ballast ribbon, two rails and sleepers
for heavy rail, two embedded rails for trams, and catenary poles and a wire for
both. Tunnels, covered sections and bridge decks are skipped. The **transit &
rails** checkbox hides platforms, rails, stops and metro signs together. One
merged mesh per tile each; no shadows.

## Sidewalks and curbs

Sidewalks are authored in `tilegen/sidewalks.py` from car-road center lines and
mapped `footway=sidewalk` ways. A car road defaults to a sidewalk on both sides;
`sidewalk:left/right`, then `sidewalk`, override that (`no`/`none` removes a
side, `separate` leaves the separately mapped footway alone, `left`/`right`
limits the side). Width comes from `sidewalk:side:width`, then `sidewalk:width`,
defaulting to 2 m (1.5 m on service roads). Mapped footway sidewalks use their
own `width`/`sidewalk:width`, default 2 m.

tilegen buffers the center lines, unions them per tile, subtracts the
car-road surfaces with extra clearance, and closes hairline corner gaps. The
frontend (`src/elements3d/sidewalk.ts`) extrudes the resulting polygons into a
0.14 m slab with a darker kerb face, one mesh per tile. The
`#sidewalks-toggle` checkbox hides the layer; it is gated at zoom 16.

## Walls and gates

`barrier=wall`, `retaining_wall`, `city_wall`, `hoarding` and `wall=*` ways
become low solid walls (`src/elements3d/wall.ts`): one box per segment, 1.5 m
high and 0.3 m thick by default, colored by the `wall` material tag. Gates
(`barrier=gate|lift_gate|swing_gate|wicket_gate|sliding_gate`) become two posts
and a closed leaf oriented by the nearest wall. The **walls & gates** checkbox
(`#walls-toggle`) hides both; no shadows.

## Rooftop accessories

Mapped `man_made=water_tower|chimney|antenna|mast` features and
`generator:source=solar` generators become rooftop props. tilegen finds the
containing building and carries its roof height as `base`; the frontend builds
a water tank on legs, a brick chimney, an antenna mast with crossbars or a solar
panel surface. A mapped solar polygon keeps its own footprint; a solar point
gets a small panel array. Buildings carrying solar panels keep a flat top so
the panels are not buried under a pitched roof. All of them are clickable, with
the OSM link. One merged Lambert mesh per tile (kind `rooftop`), no shadows;
`#rooftop-toggle` hides the layer.

## Park paths

Footways and cycleways that pass through a park or green area are clipped to the
park's footprint and to the tile, then drawn as narrow ground ribbons. A mapped
`surface` picks the color (`asphalt`, `gravel`, `paving_stones`, `dirt`, ...);
otherwise walkways are light brown and cycleways brick red. `#park-paths-toggle`
hides the layer. Mapped `footway=sidewalk` ways stay in the sidewalk layer.

## Power lines and pylons

`power=tower` nodes become low-poly pylons, and `power=line` / `power=minor_line`
ways are clipped per tile and drawn as sagging catenary spans. The wire height
comes from the line voltage; the towers use a 30 m default because the extract
does not carry their height. One merged Lambert mesh per tile for the towers and
one `LineSegments` per tile for the wires, both behind `#power-lines-toggle`.
Underground and cable-tunnel sections are skipped.

## Pitches and tracks

A `leisure=pitch` area carrying a `sport` is a green like any other — same
polygon, same parks checkbox — plus a court painted over it
(`src/elements3d/pitch.ts`, layout in the unit-tested `pitch_layout.ts`). The
markings and the goals, hoops and nets are their own per-tile kinds
(`pitch` and `pitch_paint`), so `#pitches-toggle` hides the court and leaves the
lawn. A `leisure=track` mapped for athletics is the same pass with the tartan
ring as its polygon. A pitch big enough to be floodlit also hands the night
layer four mast positions.

## Bridges and tunnels

The road and rail network is not emitted (the vehicle routes are precomputed
separately), so a bridge would otherwise be invisible: the road it carries does
not exist as geometry. tilegen therefore emits the bridge ways themselves
(`bridge` set and not `no`, on a highway or railway) and the `man_made=bridge` /
`building=bridge` deck footprints as `cmtype: "bridge"`, clipped to the tile like
water. The frontend raises them into a slab (`src/elements3d/bridge.ts`): a deck
at `h = max(4, 4.5 * layer)` m with a parapet on each edge and both ends ramped
back to the ground over ~15 m, so the deck meets the basemap road instead of
ending in mid-air. The deck width comes from the `highway`/`railway` class.

A tunnel is underground and invisible, so the only honest, visible thing is its
**portal**: tilegen emits a Point (`cmtype: "tunnel"`) at each true end of a
tunnel way that falls in the tile, and the frontend draws a dark frame (two
pillars and a lintel) around the opening there. The ends are the true ones, not
the tile-clipped ones, so no portal appears on an arbitrary tile boundary. Only
roads and railways get one — the extract's thousands of `tunnel=yes` footway and
step underpasses, and culverts/building passages, are left out — and a buried
waterway is still drawn as water. **The underground part is deliberately not
drawn.** Both kinds are per-tile meshes, so the **bridges & tunnels** checkbox is
a plain visibility switch.
