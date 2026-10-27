# Solar System Explorer

**Project concept and technical specification**  
**Status:** Working design document — 27 October 2026  
**Platform:** Browser-first 3D web application, potentially installable as a PWA

## 1. Vision

Create an interactive, geographically grounded **3D Solar System explorer**. Users can smoothly travel from a view of the entire Solar System to a planet, moon, orbiting spacecraft, landing site, and—where data allows—detailed terrain or surface structures.

The visual identity is a **clean, light-colored, slightly stylized low-poly aesthetic**, consistent with the spirit of Katu Maps, while preserving meaningful real-world positions, proportions, and terrain. This is an exploration and visualization tool, not primarily an arcade game or a conventional flat map.

### Design principles

- **One continuous exploration experience:** Solar System → planet/moon → orbital environment → region → surface.
- **Real data first:** Real orbital elements, spacecraft ephemerides, public elevation/imagery, OpenStreetMap, and curated mission information.
- **True spatial scale:** Preserve physical orbital and geographic relationships. Make distant and tiny objects usable through smart camera controls, progressive zoom speed, labels, and optional visualization aids rather than silently changing the underlying positions.
- **Broad coverage, selective detail:** Every major body should be explorable, but the level of surface detail varies with available data.
- **Static-first architecture:** Prefer a mostly client-side application, preprocessed static files/CDN, and public APIs rather than a continuously running custom backend.
- **Progressive LOD:** Use inexpensive geometry and markers at great distances; stream detail only where the camera needs it.
- **Clear data provenance:** Show source, timestamp/epoch, precision, and whether an object or layer is observed, predicted, interpolated, or illustrative.

## 2. Core exploration experience

### 2.1 Solar System overview

- Sun, eight planets, major moons, dwarf planets and other notable small bodies.
- Interactive orbit paths, selectable objects, search, object information, follow/focus controls, and a simulation date/time control.
- Realistic relative positions computed or loaded from reliable ephemerides; time navigation where supported.
- Scalable camera and rendering units, origin rebasing/camera-relative coordinates for numerical stability.
- Progressive representation: 3D detailed mesh nearby; simplified sphere/shape farther away; icon/label for very small or distant objects.
- Solar illumination, optional shadows/eclipses where practical, atmospheric effects, rings and cloud layers.

### 2.2 Planetary and lunar close-up

- Transition to globe view and streamed terrain on bodies with usable topographic data.
- Surface imagery or curated color layers plus stylized shading and low-poly relief.
- Labels for major landmarks, craters, mountains, valleys, seas, geological features and landing sites.
- Show coordinate systems, elevation when available, and data coverage/resolution.
- Smooth level-of-detail transitions; avoid assuming every world has Earth-like geometry or imagery.

### 2.3 Earth and launch facilities

Earth deserves a deeper close-up experience, borrowing relevant ideas and rendering/data components from **Katu Maps**:

- **OpenFreeMap** vector basemap and **MapTiler/Matterhorn**-style terrain source used in Katu Maps (verify the precise provider and usage terms during implementation).
- **OSM roads, buildings and land use**, shown at appropriate zoom levels.
- Terrain-following roads: create road surfaces from centerlines/polygons, sample local height, and handle intersections and crossings.
- Low-poly building and landscape representation where meaningful.
- Detailed launch-site exploration, especially **launch pads**, with OSM roads/buildings plus **curated rocket and launch-pad 3D models** rather than expecting OSM to provide those models.
- Share reusable geographic logic and visual language with Katu Maps where feasible; do not require the two applications to become one app.

## 3. Objects, missions and layers

| Feature | Core behavior | Data approach |
|---|---|---|
| Planets and major moons | Render, orbit, inspect, land on/zoom in | Ephemerides, planetary metadata, imagery/terrain |
| Earth satellites | Show **current** orbiting objects and basic tracks/metadata | CelesTrak GP/OMM or comparable sources; browser-side SGP4 propagation |
| Interplanetary spacecraft | Show locations, trajectories and mission details | JPL Horizons; curated/processed trajectories; SPICE when higher fidelity is needed |
| Asteroids and comets | Search, display orbital paths, inspect selected bodies, visit where shape models exist | **JPL SBDB**, Horizons, MPC as appropriate; mesh/shape data when available |
| Launch sites | Browse locations, pads and curated rockets | OSM, manually curated site/pad catalog, glTF/GLB models |
| Upcoming launches | Browse planned launches and their launch sites; focus sites on the globe | Public launch schedule API or imported feed; show source and freshness |
| Historical landing sites | Locate historical Moon/Mars/other-world landings | Curated mission and landing-site catalog |
| Rovers and landers | Mark position/mission details on surfaces | Curated mission metadata and position datasets where available |
| Surface features | Browse craters, mountains, valleys and other features | Gazetteers and available planetary datasets |

**Important time distinction:** A satellite's TLE/OMM-derived position is an **estimate**, not live onboard telemetry. Spacecraft ephemerides and launch plans may be predictions or delayed observations. The interface must not present all orbital positions as equally precise or "live."

### Object interaction

Each selectable object should have a compact info panel with its name, type, parent body, known dimensions, relevant orbital/mission information, data source/epoch, and contextual actions such as **Focus**, **Follow**, **Show orbit**, **Go to surface**, or **Open mission details**.

## 4. Surface coverage and uneven bodies

Support several distinct geometry strategies, not just sphere heightmaps:

1. **Sphere/ellipsoid + heightfield terrain:** Earth, Moon and Mars; suitable for quadtree or cube-sphere tiles and local elevation displacement.
2. **Sphere/ellipsoid + imagery but limited height data:** Some moons and planets; display authentic visual texture and only genuine known relief, with clearly identified illustrative styling if used.
3. **Irregular closed meshes:** Phobos, Deimos and many asteroids; load or convert public shape models to mesh LODs (e.g., GLB).
4. **Highly non-convex bodies:** Comets and unusually shaped asteroids; retain real overhangs, lobes and concavities using shape meshes, not a radial heightmap.
5. **Gas giants:** Cloud/atmosphere representations rather than fictional solid ground; possible atmospheric close-up only as a later special feature.

### Candidate worlds for rich surface exploration

- **Earth:** OSM-based detail, terrain, launch facilities.
- **Moon and Mars:** First priority for streamed global and local elevation with imagery, landing sites, and geography.
- **Europa, Io, Titan:** Authentic visual layers where available, with terrain richness adapted to the much patchier public topographic coverage; do not manufacture accuracy.
- **Phobos, Deimos, selected asteroids/comets:** Shape mesh exploration.
- **Other planetary moons:** Expand based on usable imagery/shape/elevation sources.

## 5. Planetary imagery and elevation delivery

### Approach A — use public hosted services first

Try to use public tile services for large imagery layers rather than hosting everything yourself:

- **NASA Moon Trek / Mars Trek**: investigate available WMTS imagery layers, coverage and practical use from a WebGL web viewer.
- **USGS Astrogeology / PDS planetary datasets**: authoritative source material to preprocess when a hosted tile API is missing.
- **PlanetServer / WCPS-type services:** Investigate whether numeric Moon/Mars elevation can be queried or tiled at adequate resolution/performance.

**Open validation item:** Availability of visual WMTS imagery does **not** imply a browser-friendly numeric DEM tile API. Elevation services, resolution, access rules, CORS, rate limits and uptime must be tested with real requests before committing the terrain pipeline.

### Approach B — static self-hosted tiles as fallback

Where public services cannot supply performant, numeric elevation:

1. Obtain suitable public Moon/Mars DEM products.
2. Reproject and preprocess into a consistent planet-specific tile pyramid (possibly quantized elevation or terrain mesh tiles).
3. Encode no-data regions explicitly; preserve elevation datum and source resolution.
4. Upload static tiles to **Cloudflare R2 or an equivalent object store/CDN**.
5. Fetch only tiles required by camera LOD and cache them in the browser.

A prior rough *initial* storage estimate discussed was **5–9 GB for selected DEM tile products**, not a final sizing exercise or full-planet maximum-resolution archive. The actual footprint depends heavily on coverage, resolution, compression and pyramid structure.

A modest cloud-credit budget (around **€10/month**) may be enough for a small prototype in some hosting setups, but costs are **not guaranteed**: CDN/object-store operations, bandwidth/egress, traffic and storage policy matter. Avoid binding the architecture to any one credit program.

### Terrain renderer

- Planet-aware projection, geodetic coordinates and height reference.
- Camera-driven quadtree/cube-sphere LOD and screen-space error thresholds.
- Tile mesh stitching/skirt strategies to avoid gaps.
- Vertex displacement from numeric DEMs; consistent normals and parent/child tile transitions.
- Dynamic visual layers from hosted imagery, preprocessed raster assets, or procedural low-poly palette.
- Separate surface-geology labels and landmarks from the tile mesh.

## 6. Orbital and temporal data

### Planets, moons, spacecraft

- Use **JPL Horizons** for planetary/moon orbital states and selected interplanetary spacecraft trajectories.
- Use **SPICE kernels** or suitably sampled precomputed trajectories where improved mission accuracy or nonstandard reference frames are important.
- Precompute orbital/path samples into small static browser assets when direct per-user API access would be impractical.
- Include reference frame, epoch, coordinate units and time scale in every ephemeris dataset.

### Earth satellites

- Import current CelesTrak OMM/GP elements through a controlled update job or suitable permitted client access.
- Propagate with **SGP4** client-side; provide name, type, orbit and estimated current position.
- Manage dense satellite visualization through zoom-aware filtering, clustering/selection and GPU-efficient markers; don't draw every orbit at once.
- Show age/freshness of orbital elements and distinguish decayed/inactive entries where known.

### Asteroids and comets

- Make asteroids and comets a **core feature**, not an afterthought.
- Use **JPL Small-Body Database (SBDB)** for identities/orbital attributes and **Horizons** for selected accurate ephemerides; MPC can supplement catalog information.
- A large catalog should be indexed, filtered and streamed or downloaded selectively rather than rendered at full complexity.
- For selected objects, offer actual shape-mesh close-up when a reliable model exists.

### Upcoming launches

- Ingest a launch schedule with mission, site, vehicle, projected time and status.
- Focus the pad/site and display the vehicle or a curated generic model where appropriate.
- Label announced dates as tentative and refresh their metadata.
- **Do not** treat full simulated launches or launch-to-orbit path animations as MVP requirements.

## 7. Rendering and application architecture

### Proposed stack

- **TypeScript + React** for application structure, panels, search and navigation.
- **Three.js** as the current leading choice for a custom space/planet 3D renderer, with **Babylon.js** remaining a valid alternative evaluated earlier. Choose one primary 3D engine after prototyping; avoid maintaining both unnecessarily.
- **MapLibre GL JS** can remain responsible for ordinary Earth geographic rendering if that gives better OSM/vector-tile support; determine whether to transition between renderers or implement a shared rendering pipeline.
- **glTF/GLB** for curated rockets, launch pads, spacecraft and irregular body meshes.
- **Static JSON/binary assets + CDN** for catalogs, trajectories, terrain and imagery where permitted.
- **GitHub Actions or similar scheduled builds** for metadata refresh and preprocessing; no continuously running custom application server by default.

### Conceptual modules

```text
React interface
  ├── Search / selection / information panels
  ├── Time controls / layer visibility / bookmarks / share links
  └── Unified navigation and camera controller
          │
          ├── Solar System scene (Three.js or Babylon.js)
          │     ├── Ephemerides + orbital paths
          │     ├── Sun / planets / moons / rings / atmospheres
          │     ├── Satellite / spacecraft / small-body rendering
          │     └── Irregular meshes / 3D object models
          │
          └── Surface scene / Earth map integration
                ├── Planet terrain tile/LOD manager
                ├── Planet imagery and DEM adapters
                ├── Earth OpenFreeMap / OSM layers
                └── Surface points of interest and models

Data pipeline (scheduled / offline)
  ├── Horizons / SBDB / CelesTrak / launch feed → normalized catalogs
  ├── Mission / landing-site records → curated metadata
  ├── PDS / USGS DEM and imagery → static terrain tiles (if needed)
  └── Shape models → optimized GLB/LOD meshes

Delivery: static web hosting + public APIs + CDN/object storage
```

### Key engineering constraints

- Handle Solar System distances and street/terrain-scale geometry without floating-point jitter: camera-relative coordinates, local frames and/or floating origins.
- Keep separate inertial, body-fixed and local surface frames, and transform positions consistently with time.
- Avoid visible jumps between orbit view, globe view and terrain view.
- Separate time evolution, data fetching, coordinate transformations and rendering code.
- Gracefully show lower-resolution terrain while high-detail tiles load.
- Keep loading/bandwidth bounded; prioritize low-end browser GPU and mobile performance.
- Make every data provider replaceable through adapters, avoiding dependence on an undocumented service.

## 8. UX concept

### Main view

A full-screen 3D scene with subtle floating controls:

- **Search:** planets, moons, missions, satellites, comets, launch facilities, landmarks.
- **Explorer layers:** planets/moons, satellites, spacecraft, small bodies, launches, landing sites, surface features.
- **Object panel:** facts, source, focus/follow actions, related missions and links.
- **Time control:** now / pause / speed and date selection where data supports it.
- **Camera/navigation:** focus, orbit, follow, zoom-to-surface, back to parent body/Solar System.
- **Shareable links:** object, viewpoint and selected layers/time when feasible.

### Navigation details

- Progressive zoom controls with acceleration across many orders of magnitude.
- Camera can lock onto a selected planet, spacecraft or orbital body.
- Smooth contextual transitions and clear parent-body breadcrumbs.
- Object labels and selectable visual markers stay usable even when physical object size is subpixel.
- Maintain an optional distinction between strictly physical visibility and enhanced markers/orbit line widths.

## 9. Phased implementation

### Phase 1 — viable exploration prototype

- Basic Solar System with real planetary positions, Sun/planets/major moons, orbit paths and time navigation.
- Search, select, focus/follow, object info, smooth scale-aware camera.
- Initial Moon/Mars globe imagery and a proof-of-concept numeric terrain pipeline.
- Earth globe/map integration proof of concept with OpenFreeMap and terrain.
- Static landing-site and launch-site markers.

### Phase 2 — core catalog and surface experience

- Current Earth satellites with refreshed elements and browser SGP4.
- Selected interplanetary spacecraft and trajectory visualization.
- Searchable asteroid/comet catalog; selected close-up shape models.
- Launch schedule and associated sites; curated launch-pad/rocket models.
- Richer Moon/Mars surface terrain, craters/features and lander/rover metadata.
- Irregular body renderer and additional moon imagery.

### Phase 3 — polish and breadth

- More planetary worlds and improved terrain/data coverage.
- Better lighting, eclipse/shadow treatment, atmosphere/clouds, rings and color styling.
- Earth road/building detail near launch sites; performance and mobile optimization.
- More complete spacecraft metadata, labels, filters and sharing.
- Robust coverage/source/uncertainty UI, automated catalog refresh.

### Later / stretch — explicitly not core MVP

- **Historical Earth-satellite timeline and full past orbit replay.** Current satellites are core; reconstructing historical populations is later.
- **Simulated launch trajectories** and animated launch-to-orbit missions.
- High-fidelity spacecraft operations, rendezvous simulation and free-flight gameplay.
- Jupiter/Saturn atmospheric dives, aerostats or other speculative special modes.
- Full worldwide high-resolution planetary terrain hosting, if costs and demand justify it.

## 10. Decisions still open

1. **3D engine:** Choose Three.js versus Babylon.js after tests of planetary terrain LOD, precision and Earth interoperability. Current technical discussion leans toward Three.js.
2. **Earth transition:** Decide when the space renderer hands over to MapLibre or shares data/geometry directly.
3. **Moon/Mars elevation:** Validate a real, legal, reliable public numerical DEM endpoint. Otherwise generate static tiles.
4. **Terrain format:** Compare encoded DEM raster versus premeshed/quantized geometry for network, seams and rendering complexity.
5. **Data refresh schedules:** Tune satellite-element, launch schedule and small-body-catalog update frequencies to provider restrictions.
6. **Orbital visual accuracy:** Decide which objects need Horizons/SPICE accuracy and which can use lighter-weight approximations.
7. **Hosting costs:** Benchmark actual tile bandwidth and CDN requests before committing to Cloudflare R2 or a cloud-credit-funded approach.
8. **Licenses and attribution:** Check each data source, basemap, model, hosted tile API and cache policy individually.

## 11. First concrete technical milestones

- [ ] Build a minimal Solar System scene and camera-relative coordinate system.
- [ ] Implement a central coordinate/time service supporting inertial and body-fixed frames.
- [ ] Render one planet with orbit, axial rotation and click-to-focus interaction.
- [ ] Test Solar System → Moon → crater close-up without precision artifacts.
- [ ] Test hosted Moon/Mars imagery and numeric DEM requests in a browser (including CORS/licensing).
- [ ] Generate a tiny locally hosted lunar DEM tile pyramid as fallback proof of concept.
- [ ] Load a real asteroid/comet irregular shape mesh and orbit data.
- [ ] Propagate a small current satellite subset with SGP4 and display orbits.
- [ ] Show one historical landing site and one Earth launch pad with curated metadata.
- [ ] Prototype Earth OSM rendering and the handoff to planetary close-up.
- [ ] Measure memory, FPS and streaming bandwidth on desktop and mobile.

---

## 12. Summary of established scope

**Core:** Solar System navigation; real planetary positions and terrain; Earth OSM detail and launch pads; Moon/Mars surface imagery/elevation; present-day Earth satellites; interplanetary spacecraft; asteroid/comet orbits and selected shape models; upcoming launch schedules; historic landing sites; rovers and landers; support for irregular bodies.

**Later:** Full historical satellite replay, simulation of launch trajectories, and more speculative or highly detailed special exploration modes.

This is a **planning specification**, not a guarantee that every referenced third-party endpoint, licensing condition, or dataset has been verified. Confirm those during implementation.
