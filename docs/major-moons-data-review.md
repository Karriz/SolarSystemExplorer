# Major moons: data and renderer fit

Reviewed November 15, 2026. Scope: Io, Europa, Ganymede, Callisto, Titan and
Enceladus. This document records the source review and implementation direction.
Enceladus, Io and Europa have since been implemented; see their [Enceladus](enceladus-surface.md) [Io](io-surface.md) and [Europa](europa-surface.md) source, rendering and validation notes.

## Recommendation

Updated requirement: **every moon must ship with complete global terrain and
natural-looking visible color**. The user explicitly permits procedural
variation in missing areas, including actual terrain geometry. Imagery-only
spheres and grayscale maps are preparation fallbacks, not completed bodies.

Use the existing geographic-source / cube-terrain / compact-color approach to
deliver globally complete reconstructed surfaces. Preserve measurements where
available; fill missing coverage using constrained interpolation and body-specific
procedural terrain. Color should approximate visible reflectance, using observed
visible color where available and explicit reconstruction elsewhere. Complete
coverage does not mean globally measured RGB or elevation: those source products
do not exist uniformly for these moons.

The strongest first terrain destination remains **Enceladus**, followed by the
Galilean moons and Titan. Independent imagery, terrain, reference-shape and
atmosphere capabilities are still useful internally, but all completed moons
must expose a seamless global surface.

## Global reconstruction contract

Build complete geographic products offline and serve them through the existing
versioned releases. Keep source measurements, inferred broad shape and generated
gap fill as separate preparation layers with coverage/confidence metadata.

- **Terrain:** register measured regional DEMs to a documented reference figure
  and vertical placement. Complete missing broad relief conservatively, then
  add seeded, body-specific landforms only in unmeasured regions. Fit their
  scale, slope and amplitude to observed examples rather than using the same
  crater/noise field on every moon. Use continuity constraints at coverage
  boundaries without changing the authoritative measured interior. Imagery
  feature masks may constrain reconstruction, but image brightness alone is
  not an elevation measurement.
- **Geometry:** generated gap-fill relief is authorized to affect silhouettes,
  normals and collision clearance. Bake it into the same height tiles used for
  drawing and camera safety; keep seed and body coordinates fixed. Separate
  finer normal/roughness detail remains shading-only. Version generated heights
  so camera movement, LOD changes and cache residency never regenerate a
  different surface.
- **Color:** reconstruct a visible-reflectance-like RGB map from usable visible
  bands, documented spectral/color references and geographic imagery. Retain
  real spatial variation, remove baked lighting where supportable, and use
  restrained inferred color in gaps. Desaturating an infrared composite alone
  is not a validated visible-color conversion. Keep atmosphere color in the
  atmosphere, rather than baking Titan's orange illumination into its albedo.
- **Provenance:** retain measured / interpolated / procedurally reconstructed
  masks and record source bands, transformations and source epochs. A concise
  body credit can state "Observed imagery and terrain; reconstructed gaps."
  Detailed provenance belongs in the source information, with no extra tuning
  controls required in the main exploration flow.

| Moon | Global completion strategy |
| --- | --- |
| Enceladus | Measured global DEM/reference figure plus bounded fill where needed; reconstruct restrained visible ice color from Cassini visible-band evidence. |
| Io | Published stereo terrain where obtainable; constrained volcanic plains and mountain/patera fill elsewhere; visible-band color reconstruction rather than unmodified false color. |
| Europa | Controlled regional relief plus reconstructed ice plains, ridges and chaos constrained by mapped geography; spacecraft-based visible color with explicit gap fill. |
| Ganymede | Available regional relief plus reconstructed grooved/dark terrains and craters; visible-color reconstruction preserving mapped terrain boundaries. |
| Callisto | Available regional relief plus reconstructed cratered plains and basin structures; visible-color reconstruction preserving observed geographic variation. |
| Titan | Observed/interpolated broad topography plus conservative dune/plain/icy upland fill; inferred visible material colors constrained by Huygens and spectral/geologic evidence, under separate haze. |

Additional leads checked after the requirement update:

- [Schenk's 2024 Galilean terrain review](https://www.hou.usra.edu/meetings/lpsc2024/pdf/2687.pdf)
  reports partial stereo/photoclinometric coverage and body-specific relief
  constraints, including Ganymede and Callisto. These are useful calibration
  evidence, not ready complete global height products.
- [Callisto crater morphometry](https://doi.org/10.3847/PSJ/ad61dd) describes
  regional stereo/photoclinometric DEMs using an updated control network.
- [MExLab's Ganymede maps](https://mexlab-ru.ru/ganymede-en/) identify updated
  mosaics and regional DEM work. Downloadable wall-map PDFs are not substitutes
  for numeric elevation; underlying raster access and terms remain to verify.
- [Bjorn Jonsson's spacecraft-based maps](https://bjj.mmedia.is/data/planetary_maps.html)
  include Io, Europa, Ganymede and Callisto, making them candidates for color
  evaluation. His site requests attribution and restricts web mirroring;
  deployment rights need resolution before bundling. Its Io DEM is explicitly
  described as largely fictional and must not be mistaken for measured data.
- [Cassini's Enceladus global color map](https://science.nasa.gov/photojournal/color-maps-of-enceladus-2014/)
  supplies useful geographic color evidence, but spans UV/IR and is enhanced.
  It cannot be installed unchanged and called natural color.
- [Titan DISR color research](https://www.sciencedirect.com/science/article/abs/pii/S0019103515002547)
  is a local visible/spectral constraint, not global measured surface RGB.
  Use original instrument products and verified spectral processing in
  preparation; global color remains a reconstruction.

## Sources by body

### Enceladus

Select the paired Schenk/McKinnon products: [Cassini global DEM, 200 m grid](https://astrogeology.usgs.gov/search/map/enceladus-cassini-global-dem-200m-schenk)
and [global monochrome mosaic, 100 m grid](https://astrogeology.usgs.gov/search/map/enceladus-cassini-global-mosaic-100m-schenk).
The DEM's effective horizontal sampling is about 400 m and vertical precision
roughly 25–100 m, varying by location. Elevations are in **kilometers**, relative
to a triaxial reference figure with axes 256.2 / 251.4 / 248.6 km. The catalog
requests author citations and lists no access constraint.

Fit: measured terrain, source-derived normals and optional cartographic
hillshade. Use the monochrome mosaic as the morphology/luminance input for a
separate visible-color reconstruction. Inspect retained image shadows before
combining it with strong relief lighting. Generated fine ice detail remains
shading-only; missing terrain can use the global completion contract above.

The source's projection radius and elevation datum are different concepts.
Preserve the reference figure in geometry, picking and camera clearance. One
compatible preparation route is converting datum-relative elevations into
radial heights above the renderer's chosen sphere. Confirm the source's height
direction convention first; never simply add these residuals to a mean sphere.

### Io

[USGS Galileo color-merge mosaic, nominal 1 km](https://astrogeology.usgs.gov/search/map/io_galileo_ssi_global_color_merge_mosaic_1km)
is a convenient global appearance source. Its chromatic inputs include violet,
green and 756 nm near-infrared; native color sampling varies from about
1.3–21 km. It is false color, with stronger coloration than visual appearance.
The [grayscale mosaic](https://astrogeology.usgs.gov/search/map/io_galileo_ssi_grayscale_global_mosaic_1km)
retains illumination from different directions and is not a clean albedo map.

[White et al. (2014)](https://doi.org/10.1002/2013JE004591) provide an ISIS cube
DEM in supporting information, covering approximately 75% of the globe from
Voyager/Galileo stereo. The paper and archive location were identified; the
supplementary binary was not retrieved in this review.

Fit: compact reconstructed visible geographic color plus measured terrain after
validating the cube, datum, gaps and redistribution terms, completed globally
with procedural fill. Reconstructed coverage must remain explicit in provenance.
Static mosaics must retain their mission epoch; they are not
Io's appearance on the selected simulation date. Plumes and glowing lava would
be separate modeled effects, not height inferred from image brightness.

### Europa

[Voyager/Galileo global mosaic, 500 m grid](https://astrogeology.usgs.gov/search/map/europa_voyager_galileo_ssi_global_mosaic_500m)
is available as a single-band raster. Global output spacing does not imply
uniform source detail; the [USGS geologic-map documentation](https://pubs.usgs.gov/sim/3513/sim3513_pamphlet.pdf)
describes downsampling and upsampling of heterogeneous imagery.

More valuable for terrain are the [USGS controlled regional DTMs](https://stac.astrogeology.usgs.gov/docs/data/jupiter/europa/europa_controlled_usgs_dtms/):
Cilix, Pwyll, Agenor Linea, Rhadamanthys chaos/pits and Yelland ridged plains.
They include figure-of-merit and confidence assets. Typical effective horizontal
resolution is about 1–2 km despite finer grid spacing. The [STAC collection](https://stac.astrogeology.usgs.gov/api/collections/galileo_usgs_photogrammetrically_controlled_dtms)
declares CC0-1.0 and warns that heights are relative, not tied to a global
elevation reference.

Fit: five measured terrain destinations within a completed reconstructed global
surface. Establish a documented vertical placement for each regional DTM;
do not claim global measured terrain. Keep its confidence mask through
preparation. Prefer the corresponding updated controlled imagery when aligning
these sites; do not assume exact alignment with the older global mosaic.

For color, a monochrome baseline is supportable immediately. A global visible
RGB product was not validated here. NASA's [approximately natural-color views](https://www.lpi.usra.edu/science/schenk/moons/euro.html)
provide appearance references, not automatically a complete georeferenced RGB
texture. Avoid coloring geological units as though they were measured RGB.

### Ganymede

[USGS Voyager/Galileo color mosaic, nominal 1.4 km](https://astrogeology.usgs.gov/search/map/ganymede_voyager_galileo_ssi_color_global_mosaic_1_4km)
is available, but uses 991 nm near-infrared for red, 559 nm green and 413 nm
violet. It merges coarser color with a sharper monochrome base, includes
synthesized red in a coverage gap, monochrome polar fill and enhanced color.
Underlying imagery ranges from approximately 400 m to 20 km.

Fit: complete reconstructed global terrain and visible color, using enhanced
color only as a preparation reference or explicit comparison. A validated,
readily downloadable global DEM was not established in this
review; this is a sourcing gap, not evidence that no terrain research exists.
Do not derive displacement from bright crater rays or dark terrain boundaries.
The monochrome companion mosaic can provide morphology/luminance for a
separately justified visible-color reconstruction.

### Callisto

[USGS Galileo/Voyager global mosaic, 1 km grid](https://astrogeology.usgs.gov/search/map/callisto_galileo_voyager_global_mosaic_1km)
provides a straightforward single-band baseline. Original image scales range
from approximately 400 m to 60 km. The map uses a 2,409.3 km sphere, which must
be recorded separately from whichever body radius the app adopts.

Fit: reconstructed global terrain and visible color, using this mosaic as a
geographic input. A global measured DEM and global visible RGB were not
validated here. Keep baked image relief separate from dynamic lighting and
label procedural crater fill as reconstructed. The listing describes the mosaic
as public domain with no use constraints.

### Titan

Use the [Cassini ISS 4 km global mosaic](https://astrogeology.usgs.gov/search/map/titan_cassini_iss_global_mosaic_4005m)
for a small geographic fallback, retaining its documented imaging gap. It is
938 nm near-infrared brightness, not visible RGB. The [450 m controlled mosaic](https://astrogeology.usgs.gov/search/map/titan_cassini_iss_near_global_mosaic_450m)
covers only 65°S–45°N and is also a single-band methane-window product. Radar
mosaics should remain a scientific viewing layer, not visible-color albedo.

For elevation, prefer [Corlies et al. (2017)](https://doi.org/10.1002/2017GL075518)
and the author's [27.5 MB data archive](https://hayesresearchgroup.com/data-products/)
over the older 2013 global map. Measurements cover only about 9% of Titan;
global coverage is interpolated. Preserve measured/interpolated provenance.

For atmosphere, [Huygens HASI](https://pdsatmospheres.nmsu.edu/data_and_services/atmospheres_data/Huygens/HASI.html)
supplies atmospheric structure and [DISR](https://pdsatmospheres.nmsu.edu/data_and_services/atmospheres_data/Huygens/DISR.html)
supplies descent radiometry and imagery. These constrain a modeled profile;
they do not provide a global, time-varying atmosphere.

Fit: reuse the shared atmosphere transport with a Titan-specific layered haze
profile, rather than copying Venus cloud parameters. Default orbital appearance
should obscure the ground appropriately. The completed ground uses reconstructed
visible color and terrain; infrared geography can be a scientific comparison.
Any visible ground palette
must be marked inferred and must not generalize the Huygens landing site into
measured global color.

## Download checks

Small HTTP range requests were made on November 15, 2026. All eight URLs below
returned **206 Partial Content** and TIFF signatures. Sizes are exact upstream
byte counts from Content-Range, not runtime asset sizes. These are accessibility
checks, not whole-file checksum or scientific-data validation.

The Enceladus prefix is
`https://asc-astropedia.s3.us-west-2.amazonaws.com/Enceladus/Cassini/`.
All other rows use the USGS mirror prefix
`https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/`.
The corresponding `planetarymaps.usgs.gov/mosaic/` URLs returned 403 here.

| Product filename | Bytes |
| --- | ---: |
| `Enceladus_Cassini_DEM_global_200m_schenk2024.tif` | 129,613,723 |
| `Enceladus_Cassini_mosaic_global_100m_schenk2024.tif` | 518,340,175 |
| `Io_Galileo_SSI_Global_Mosaic_ClrMerge_1km.tif` | 196,637,696 |
| `Europa_Voyager_GalileoSSI_global_mosaic_500m.tif` | 192,777,263 |
| `Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif` | 199,204,541 |
| `Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif` | 114,640,717 |
| `Titan_ISS_P19658_Mosaic_Global_4km.tif` | 8,169,529 |
| `Titan_ISS_Globe_65Sto45N_450M_AvgMos.tif` | 1,580,151,015 |

Bounded header inspection confirmed:

- Enceladus DEM: 8049 × 4025 Float32; 200 m projected pixels; projection sphere
  256,200 m; NoData approximately -3.402823e38. Raster scale is **1**, although
  the documented height values are kilometers. A source adapter must explicitly
  convert to meters. Mask NoData before scaling.
- Europa: 19631 × 9816 UInt8, one band, NoData 0; no embedded CRS/transform was
  exposed. Obtain and validate the companion labels before geographic use.
- Callisto: 15138 × 7569 UInt8, one band, equirectangular, central meridian 180°,
  NoData 0; projection sphere approximately 2,409,300 m.
- Titan global: 4040 × 2020 UInt8, one band, equirectangular, NoData 0.
- Titan regional: 35953 × 10987 Float32, one band; no embedded CRS/transform or
  NoData was exposed. The catalog gives west-positive longitude and
  planetographic latitude: verify the actual companion labels and transform.
- Io and Ganymede: TIFF access confirmed, but bounded in-memory header opening
  could not resolve all directory references. Full metadata inspection remains
  an ingestion gate; they have not been declared corrupt.

The [Europa STAC items endpoint](https://stac.astrogeology.usgs.gov/api/collections/galileo_usgs_photogrammetrically_controlled_dtms/items?limit=5)
returned all five sites and their DTM/confidence/provenance links. Binary DTM
payloads were not checked. The [Corlies ZIP](https://data.astro.cornell.edu/titan_topo_corlies/titan_topo_corlies.zip)
returned a ZIP signature and range response, total 27,504,153 bytes; contents
were not downloaded or validated. Io's supplementary cube remains unverified.

## Orbit, orientation and parent systems

[JPL NAIF generic kernels](https://naif.jpl.nasa.gov/naif/data_generic.html)
provide ephemerides (SPK) and body constants/orientations (PCK). Two inspected
kernel comments identify suitable coverage:

- [JUP365](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup365.cmt):
  Io 501, Europa 502, Ganymede 503, Callisto 504; approximately 1600–2200.
- [SAT441](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat441.cmt):
  Enceladus 602 and Titan 606, among other Saturn moons; approximately 1750–2250.

These are verified candidates, not a claim that they are the newest solutions.
Select a pinned coherent kernel set and inspect its coverage during preparation.
For the browser, offline extraction into bounded, date-chunked interpolants is
preferable to shipping the entire kernel collection or relying on live queries.
Validate interpolation error and time conversion against SPICE. Use geometric
states in one frame/time convention for the scene, and full relevant PCK
periodic terms for orientation.

Add parent-relative satellite offsets to the same parent center used by the
scene. The current approximate heliocentric parent positions remain an accuracy
limit. Distinguish a planet center from its system barycenter; accurate moon
offsets alone do not make the entire scene suitable for precise event prediction.

## Changes needed in the existing approach

Current code supports much of the rendering, but is not yet arbitrary-body data
driven. `BodyId`, `TerrainBody`, orientation tables, texture loaders and atmosphere
dispatch contain fixed body sets. `planetOrder` and UI back navigation special-case
only Earth's Moon. `PlanetSurfaceRenderer` constructs terrain and hillshade
unconditionally. Regional terrain is also currently specialized to Earth/Moon.

1. Introduce explicit parent IDs, NAIF IDs, shape/frame metadata and optional
   imagery, elevation, hillshade and atmosphere capabilities. Make planet lists,
   focus, distance labels and parent navigation derive from those relationships.
2. Allow image-covered reference shapes as loading/preparation fallbacks, but
   require a complete reconstructed height release and color asset for every
   finished moon. Never present generated coverage as measured terrain.
3. Extend offline preparation for source units, triaxial datum conversion,
   missing georeferencing, longitude direction, latitude convention, regional
   footprints and relative height datums. The current builder assumes a
   tightly specified full-global raster; simply adding JSON entries is insufficient.
4. Reuse numeric height decoding, geographic sampling, cube meshes, parent
   retention, source normals, budgets and compact color. Derive hillshade from
   the completed height product, retaining its measured/generated provenance.
   Imagery brightness must never become an unqualified elevation measurement.
5. Make view limits reflect supported data quality. Fine normal/roughness detail
   can enrich appearance, but cannot justify claiming meter-scale measured terrain.
6. Load textures and terrain lazily with a shared bound across inactive moons.
   Keep existing measured source data authoritative and record every inferred
   color, interpolated height, synthesized band and generated detail layer.

## Suggested delivery sequence

1. Parent/body registry and coherent moon ephemerides, selection and focus.
2. Enceladus end-to-end: paired imagery/DEM, datum conversion, cube terrain,
   source normals, optional hillshade and terrain-relative camera checks.
3. Produce and validate complete visible-color reconstructions and global height
   releases for the four Galilean moons. Incorporate Europa's regional DTMs and
   Io's stereo DEM, and obtainable Ganymede/Callisto regional DEMs, before
   procedural completion. Release only when all geographic coverage is filled.
4. Titan haze, reconstructed visible ground color and globally completed
   terrain, retaining measured/interpolated/generated masks. Infrared/radar
   views can be scientific comparison layers; they do not replace default RGB.
5. Validate every completed moon under changing Sun direction and orbital,
   ground and grazing views, including generated/measured boundaries. Check
   color under neutral reference illumination separately from atmospheric light.

Acceptance should include known-feature longitude checks, parent-facing
hemisphere/orientation over time, datum sample comparisons, gaps/poles/seams,
orbital-to-ground transitions, moving-camera LOD, image-shadow interactions,
body switching/disposal and phone layout. Browser checks are required when
rendering is implemented; no renderer changes were made for this review.
