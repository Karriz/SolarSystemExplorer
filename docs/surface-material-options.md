# Surface material options

Research/review date: 2026-10-29. This remains the design study; the initial Earth/Moon material path is now implemented in the [bounded pilot](terrain-pilot-results.md), with quality and hardware acceptance still open. [Terrain upgrade plan](terrain-upgrade-plan.md) controls the shared milestones, acquisition gates, and resource measurements.

## Recommendation

Use a hybrid of measured regional color, measured surface classification, and procedural material detail. Keep elevation and lighting independent of color. A classification should select how an area behaves—dust, exposed rock, vegetation, snow, water—not replace all its geographic color variation with one flat tint.

This gives us recognizable planets from orbit and detailed, dynamically illuminated surfaces nearby. Pure procedural generation remains useful for filling unresolved detail, but should not relocate known landforms or imply that generated rocks, dunes, trees, or buildings were observed at those positions.

## Review outcome: preserve measured appearance across distance

Medium-distance accuracy takes priority over generating convincing close-up noise. Elevation, regional color, material controls, and procedural detail each need their own source resolution, streaming LOD, and cost budget. They need not share pixel sizes or force each other to refine.

| View regime | Appearance that must remain accurate | Detail we may introduce | Cost rule |
| --- | --- | --- | --- |
| Orbit and broad regional view | Known regional color/albedo patterns, limb, large relief, and appropriately registered illumination | Filtered aggregate material response | Small global fallback and view-dependent measured data; no close-detail masks or geometric scattering |
| Medium distance, where individual landforms are recognizable | Measured crater rims, mountain/valley shape, coastlines where supported, ejecta/albedo patterns, and color/terrain registration | Class-dependent roughness and restrained mesoscopic normals | Upgrade only if projected error or visible material boundaries justify the data; keep measured imagery as the geographic reference |
| Close view down to 100 m | The same known geography and regional mean color, with source limits retained | Stable grain, fine normals, small color/roughness variation; optional bounded geometry later | Reuse shared materials and generate appearance locally; do not require uniformly meter-scale observed terrain |

Procedural detail must converge back to the measured appearance when filtered or viewed farther away. It is an additive visual capability, not a replacement for missing regional geography. Conversely, do not low-pass every observed color feature to the elevation spacing: a legitimate ejecta ray or surface marking can be recorded in imagery even when its relief is unresolved.

The first release needs observed regional color and a small shared material library. A complete global geology/biome classification is not a prerequisite. Geology, albedo, optical roughness, grain size, and vegetation structure are different quantities; avoid pretending that a class or spectral proxy directly measures all shader parameters.

## The three practical approaches

| Approach | Advantages | Limitations | Role here |
| --- | --- | --- | --- |
| Normalized imagery plus detail materials | Preserves recognizable regional patterns and ejecta rays; shortest route from the current renderer | Normalization can leave shadows, seams, and viewing effects; imagery becomes blurry close up | Good first step, particularly on the Moon |
| Surface-class maps plus procedural materials | No directional lighting baked into generated base color; compact classifications; coherent close detail | Classes do not specify exact color, geometry, or material parameters; flat palettes lose geographic character | Useful control layer, insufficient as the only global color source |
| Regional reflectance/color plus class-driven procedural detail | Retains geography while allowing material-specific roughness, normals, and close detail | Requires data preparation, material authoring, and careful transitions | Recommended destination |

Trying to recover perfect albedo from the current shaded mosaics is a fourth possibility, but not a good foundation. Where source pixels are in shadow, the missing surface signal cannot be recovered uniquely. We can reduce low-frequency illumination when source geometry and elevation are available, but should prefer better source products.

## Data candidates

### Earth

**Preferred classification candidate: ESA WorldCover 2021 v200, introduced regionally.** It provides 11 land-cover classes at approximately 10 m resolution, including trees, shrubland, grassland, cropland, built-up land, bare/sparse ground, snow/ice, water, wetlands, mangroves, and moss/lichen. The categorical map is delivered in geographic COG tiles. Its global map is approximately 117 GB, so the first task is extracting one region and deriving only the controls needed for that comparison, not converting the globe. The 10 m scale is a possible boundary-detail tier, not a mandatory global download. Its CC BY 4.0 license requires attribution. Reported overall classification accuracy is 76.7%; classifications are useful evidence, not exact truth. [ESA data access and license](https://esa-worldcover.org/en/data-access), [product manual](https://worldcover2021.esa.int/data/docs/WorldCover_PUM_V2.0.pdf).

Land cover is different from biome: a “trees” pixel does not tell us whether to render tropical broadleaf forest or northern conifers. A second regional vegetation/climate layer would be needed for that distinction. Likewise, bare ground does not distinguish sand, exposed rock, and mud. Start with broad materials and add such subdivisions where supporting data exists.

**Alternatives:** Dynamic World supplies nine classes and per-class probabilities at 10 m, with observations from 2015 onward. It is attractive for temporal composites and confidence-aware classification, but requires compositing and cloud-gap handling. Its probabilities express classification confidence; they are not measured material coverage fractions. [Dynamic World catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1).

Copernicus Global Land Cover 100 m Collection 3 provides fractional cover layers and forest-type information, useful for evaluating smoother regional mixtures. Mixing unrelated classifications at different LODs can change a location's apparent material during zoom, so the initial implementation should derive all coarse levels from the same fine classification. [Copernicus documentation](https://documentation.v1.dataspace.copernicus.eu/APIs/SentinelHub/Data/clms/land-cover-and-land-use-mapping/global-dynamic-land-cover/lc_global_100m_yearly_v3.html), [band definitions](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_Landcover_100m_Proba-V-C3_Global).

**Regional color:** use Blue Marble without added relief as a quick improvement, and evaluate MODIS MCD43A4 NBAR for a more controlled 500 m reflectance composite. NBAR removes view-angle effects and provides quality flags; it is not automatically a terrain-shadow-free, ready-made RGB albedo texture. Snow, clouds, data gaps, remaining illumination effects, color conversion, and water need separate handling. [NASA Blue Marble variants](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/), [NASA MCD43 products](https://modis.gsfc.nasa.gov/data/dataprod/mod43.php), [MCD43A4 product metadata](https://catalog.data.gov/dataset/modis-terraaqua-brdf-albedo-nadir-brdf-adjusted-ref-daily-l3-global-500m-v061).

**Materials:** vegetation canopy, dry vegetation/soil, sand, exposed rock, snow/ice, built-up ground, and water. Forests viewed from 100 m need canopy-scale appearance; applying a grass or soil material to forest terrain would look wrong. Real roads, buildings, coastlines, and tree geometry require additional geographic data, not just class noise.

At review time Earth had imagery but no elevation adapter in `terrainBodies`; the pilot now uses a separate bounded regional adapter. The agreed elevation candidate is Mapterhorn, which publishes preprocessed 512×512 Terrarium WebP tiles via XYZ and PMTiles, with approximately 30 m advertised global source coverage and finer regional sources. Validate delivered local sampling, mixed surface/ground-model characteristics, height datum, Mercator coverage, channel-preserving decoding, and outage fallback before adoption. Use its existing distribution rather than creating a second full-world elevation archive. Copernicus GLO-30 remains an upstream/alternative source; as a surface model, it must not be assumed to be bare-earth terrain. [Mapterhorn data access](https://mapterhorn.com/data-access/), [Mapterhorn source coverage](https://mapterhorn.com/), [Copernicus distribution](https://registry.opendata.aws/copernicus-dem/).

Do not combine a canopy/building-inclusive surface model with separately generated trees/buildings without accounting for their heights. Water masks, shorelines, elevation, and imagery also need a consistent treatment: mismatched sources can create flooded coasts or land/water steps even when each raster appears plausible by itself.

### Moon

**Regional color/reflectance:** keep the CGI Moon Kit color map as a practical starting point, or preprocess the source normalized WAC bands. The kit is intended for 3D rendering, while normalized source data offers more control. Photometric normalization puts observations into a common lighting/viewing geometry; it does not guarantee removal of every shadow or provide a complete physical material model. [NASA CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/), [LROC normalized products](https://www.lroc.im-ldi.com/images/downloads).

**Optional classification refinement:** rasterize the USGS Unified Geologic Map's unit polygons into a small set of rendering families such as mare plains, highlands, crater/ejecta terrain, and mixed terrain. The GIS product is globally available at 1:5 million scale, with CC0 use terms and a citation request. Use polygon attributes rather than the illustrated shaded map. These are broad geological controls, not meter-accurate texture boundaries or direct grain-size/roughness measurements. A provisional two-family mask can validate the renderer first, but must remain identified as inferred. [USGS GIS data](https://astrogeology.usgs.gov/search/map/Moon/Geology/Unified_Geologic_Map_of_the_Moon_GIS_v2/).

**Close detail:** subtle regolith grains, dust, exposed-rock patches, and sparse small rocks. Preserve observed broad albedo patterns and ejecta rays. Slope can influence exposed-rock/dust mixtures as an artistic rule, but should not be presented as a measured rock-distribution map.

For a later fidelity step, LROC provides resolved Hapke photometric parameters, including single-scattering albedo and phase-response parameters. These support more appropriate lunar reflectance than treating every surface as generic terrestrial PBR. Coverage is near-global rather than complete, and implementation would need careful matching between the normalized color and the chosen reflectance model. [LROC parameter maps](https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_HAPKEPARAMMAP), [Sato et al. research](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2013JE004580).

For the first material trial, compare a manageable CGI Moon Kit color variant with the current fallback; do not make ingestion of the approximately 943 MB full EXR or multi-gigabyte TIFF a prerequisite. Preprocess chosen source data into the required geographic tiles/mips, preserving color space. This is an appearance-oriented rendering product, not a guarantee of scientifically calibrated RGB albedo. [NASA product downloads](https://svs.gsfc.nasa.gov/4720/).

### Mars

Mars offers unusually relevant material-control data:

- TES bolometric albedo: regional brightness, not RGB surface color; the documented global product is 8 pixels/degree.
- TES dust-cover index: a quantitative dust proxy, available as numeric data. Avoid its shaded-relief preview variants.
- THEMIS-derived thermal inertia: a useful constraint on fine particulate versus rockier/consolidated surfaces, but not a unique material classifier. Dust, sand, rock, cementation, and mixtures can produce overlapping responses.
- USGS global geology: broad geological context at 1:20 million scale, not a close-range texture mask.

[TES albedo products](https://tes.mars.asu.edu/products/), [TES dust-cover data](https://tes.asu.edu/~ruff/DCI/dci.html), [USGS thermal-inertia metadata](https://astrogeology.usgs.gov/search/map/mars-themis-derived-global-thermal-inertia-mosaic), [Mars geologic map](https://pubs.usgs.gov/sim/3292/).

Use these as inputs to a proposed mixture of dusty soil, darker sand, exposed rock, and polar material. Modulate a calibrated regional palette with measured brightness; do not colorize the scientific data's display legend and call that albedo. Thermal inertia is a physical property of heat storage/transfer, not the renderer's optical roughness parameter, so translating between them requires a visual model and validation. Seasonal polar cover would need an additional dated dataset or an explicitly illustrative model.

### Mercury

Evaluate the photometrically corrected MDIS reflectance bands instead of using the current enhanced-color display mosaic as natural color. The documented three-band product includes infrared, so even corrected RGB channel assignment is not necessarily human-visible color. A restrained calibrated palette plus regional reflectance is preferable to directly adopting enhanced colors. [USGS MDIS color mosaic metadata](https://astrogeology.usgs.gov/search/map/mercury_messenger_mdis_global_color_mosaic_665m).

Proposed material families are regolith, smooth plains, and crater/ejecta terrain. A reliable classification mask and color conversion still need a focused data-selection pass; this study has not established a ready-to-use global Mercury material-class tile service.

### Venus and the giant planets

For Venus, separate an observational radar display from a plausible visible-surface rendering. Geological mapping can constrain broad morphology: a global study identifies 13 units at 1:10 million scale, but this does not supply measured global RGB albedo or meter-scale material maps. Mapping these units to rock materials and using diffuse atmospheric illumination would be a reconstruction. Machine-readable distribution and reuse terms for a chosen geology source still need verification. [Ivanov and Head, global geological map](https://www.sciencedirect.com/science/article/pii/S0032063311002297).

The giant planets should retain a separate cloud/atmosphere material system. A terrain biome pipeline should not imply solid ground there.

## Proposed renderer

```text
Measured elevation ──────────────> terrain shape, slope, geometric normals
Regional reflectance/color ──────> broad geographic appearance
Surface classes / property maps ─> material selection and mixture weights
Body-fixed coordinates + seed ───> repeatable close detail
                                     │
                                     v
                         base color + roughness + normals
                                     │
                                     v
                         dynamic Sun, atmosphere, shadows
```

1. Keep the existing terrain tile/worker/cache architecture. Add a separately versioned surface-material pyramid with regional color, class IDs/weights, source resolution, confidence/coverage, epoch, and attribution. Reproject sources into each body's existing coordinate contract before publishing.
2. At far range, sample regional color and measured terrain. At middle range, introduce class-driven mixtures and mesoscopic normals. At close range, add filtered material textures/noise and, selectively, small geometry. Base transitions on projected feature size and source resolution, not a single altitude threshold.
3. Preserve the regional mean color as detail appears. Detail maps should modulate around that mean rather than multiply a second unrelated full-color surface onto it. Otherwise zooming will visibly change regional brightness.
4. Derive mixture coverage for coarse mip levels offline. Do not linearly interpolate categorical class numbers: averaging “rock=2” and “snow=4” must not produce “forest=3.” Coastlines and known contacts need deliberate boundary handling.
5. Use a small reusable set of unlit base-color, normal, and roughness assets. Start with two dominant materials per surface patch, evaluating up to four on desktop if profiling permits. Local triplanar mapping can reduce stretching on steep slopes; it adds sampling cost and needs correctly blended normals.
6. Anchor detail to body-fixed physical coordinates and deterministic seeds. Tile-local precision with stable origins is needed for small features; camera-relative coordinates alone would make the ground slide. Preserve positions and material identity across tile LOD changes, poles, the date line, and body rotation. Filter high frequencies to avoid shimmer.
7. Start with normal/roughness detail. Add displacement or scattered rock geometry only where silhouettes or shadows justify it, with bounded amplitude and compatible camera clearance. Color and normal textures alone cannot change silhouette, cast geometric shadows, or provide collision geometry. [Three.js material behavior](https://threejs.org/docs/pages/MeshStandardMaterial.html).
8. Remove terrain's general texture-as-emission contribution for the physical-lighting path. Treat atmospheric fill, sky illumination, and exposure separately. Add terrain cast shadows around the close view using a focused shadow region aligned to the Sun; avoid spending the entire shadow budget on a Solar-System-scale point-light cube map. The initial pilot now prototypes this focused-shadow strategy on Earth/Moon; broader validation remains open.

True measured albedo and normalized reflectance should also remain distinct in the data contract. Feeding reflectance already normalized to a particular geometry into an unrelated lighting model without calibration can still bias brightness, even when obvious shadows are absent.

## Processing, storage, and availability constraints

Reuse the acquisition gates and baseline measurements in the [terrain plan](terrain-upgrade-plan.md#availability-and-acquisition-gates). The existence of a scientific product or a colorized web preview does not establish a ready numerical tile service. Use source data, confirmed coverage, exact versions, and appropriate terms; keep observed color/terrain available if a classification request fails.

- Begin with one source region and the minimum channels that affect the proposed shader. Fetch source granules or COG windows where possible; confirm range access instead of assuming all upstream formats support cheap crops. Record any whole-file fetch and normalized/staging footprint separately from published output.
- Keep classification controls independent from color and height LOD. Prefer a compact class encoding or a few selected mixture weights; do not stream all scientific property bands to every device. Preserve uncertainty separately from physical mixture weights.
- Derive coarse controls consistently from the same source. Store fine boundaries only where they improve the visible result. Use gutters and consistent sampling across tile borders; missing class data must not silently change observed regional color.
- Evaluate a shared atlas/texture-array or small material library before generating unique detailed textures for every geographic tile. The first close-detail pass has two material families, no mandatory full triplanar path, and no runtime generation of large raster assets.
- Decode/preprocess scientific/control data without color transformations. Mark actual color textures with the correct color space; normals, weights, roughness, and height are numerical data. Lossy/compressed formats for control or normal data require error checks before adoption.
- Measure shader variants independently: baseline regional color, two-family detail, optional triplanar projection, and shadows. Avoid enabling costly multi-material sampling over the whole planet simply because the shader supports it. Restrict fine detail to the relevant view footprint and fade/filter it using pixel derivatives/projected scale.
- Budget source files, processed color/control tiles, shared materials, and runtime allocations separately. Image wire size is not decoded texture size. Include mip levels, parent/child overlap, worker buffers, geometry, shadow maps, and cached imagery in the combined peak measurement.
- Use source-conditioned material parameters with deterministic body-fixed seeds. Keep detailed coordinates numerically stable at planetary scale. Do not add a second layer of geometry at scales already represented by measured elevation; optional geometry needs an explicit amplitude/frequency limit and matching shadows/clearance.
- Preserve dated observations and reconstruction flags. Earth seasons, Martian frost, Venus visible appearance, and inferred rock placement must not be presented as measured just because the simulation date or shader can vary them.

Procedural close detail is not computationally free. The acceptance test is that it materially improves the near view while maintaining frame time and converging to the same measured medium-distance image. A large library of high-resolution material assets or expensive noise can be worse than one additional measured raster, so the pilot must compare actual bytes, decode cost, and GPU time.

## What 100-meter viewing means

At the current 48° vertical field of view, a camera looking straight down from 100 m sees roughly 89 m vertically on locally flat ground. Our configured source elevation spacing is approximately 474 m for the Moon, 463 m for Mars, 665 m for Mercury, and 4.6 km for Venus. These figures were checked in `scripts/terrain-sources.json`; Earth has no current terrain adapter.

Consequently, procedural materials can solve close-range blur and flat shading, but cannot restore accurate missing gullies, crater rims, cliffs, or rock positions. More mesh subdivisions only interpolate the same coarse evidence. Higher-resolution DEMs or local site datasets are needed where geographic accuracy matters. Keep procedural detail explicitly distinct from measured features in source metadata and documentation.

Likewise, a 2021 land-cover map does not become historical truth because the simulation date changes. Seasonal appearance may be an optional model; observed epochs should remain recorded.

## Shared prototype and rollout

Follow the implementation order in the [terrain plan](terrain-upgrade-plan.md). The first milestone is a sound medium-distance baseline plus bounded Earth/lunar tests; neither meter-scale measured sites nor a full global material classification is mandatory.

**Medium-distance baseline:** first correct observable registration and baked-lighting problems using manageable regional/color products. Preserve recognizable observed patterns and evaluate geometry under neutral color. Establish source and artifact limitations before adding noise that could obscure them.

**Earth pilot and Moon reference region:** use Mapterhorn to establish streaming costs across three bounded Earth test areas. Add a WorldCover material test in one area with coast, vegetation, bare ground, and built-up land. On the Moon, retain measured regional color and add two restrained regolith/rock families; a clearly identified slope-based mask can test the shader before an optional geology-derived mask. Compare measured-only, class-only, and hybrid appearance before expanding source coverage.

**Later planetary expansion:** prototype a Mars dust/rock mixture from numerical regional properties, retaining uncertainty and observed color identity. Add Mercury's selected measured terrain/color improvements and conservative regolith detail. Treat Venus as a radar display or explicitly reconstructed visible appearance; additional numerical geology/stereo sources remain availability-gated. Meter-scale destinations and geometric surface scattering are separate later experiments.

Validation should include fixed-location zoom sequences from orbit to 100 m; at least two Sun azimuths and a low Sun angle; tilted/grazing views; material/LOD boundaries; body rotation; and desktop/mobile GPU timings. Geographic features should remain stable, procedural frequency should fade without popping, and reversing the Sun should reverse lighting without leaving a painted directional shadow in the color map. A neutral-color material override can distinguish terrain/lighting problems from texture problems.

At medium range, compare landmark positions, regional color, limb/silhouette, source seams, and legitimate high-contrast surface features against the selected observed references. At close range, toggle procedural detail without changing camera or Sun: mean color and known landforms must remain stable. Filter the detail back out and confirm that it returns to the same measured medium-distance appearance. Normal detail must be tested separately from geometric shadows because normals do not create cast shadows or collision surfaces.

## Verification limits

Provider documentation, published metadata, current source files, and existing local terrain release metadata were inspected. Candidate scientific archives have not been downloaded or converted, and live tile CORS, hosting cost, shader performance, and visual quality have not been validated in this study. Some providers expose attractive preview maps containing legends or hillshade; adoption must use underlying numerical/classification data instead. Documentation lookup failures are not proof that a source is unavailable, but successful lookup alone is not proof of usable delivery. This review updates planning documents only; it makes no renderer changes or large data downloads.
