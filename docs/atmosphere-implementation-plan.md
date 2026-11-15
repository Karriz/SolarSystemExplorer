# Atmosphere and clouds implementation plan

Proposed November 14, 2026. Status: stages 1–3 implemented: shared foundation,
Earth clear air, Mars dust, and Venus dense atmosphere/clouds. A first giant
cloud/haze backend and solar appearance were added November 15; observed Earth
clouds and Titan remain pending. Scope: Earth, Mars, Venus,
Titan, Jupiter, Saturn, Uranus, Neptune, and the Sun. See [current implementation](atmosphere-rendering.md).

## Next priority: giant planets and the Sun

Proposed November 15, 2026 following the request for more realistic Sun and
giant-planet appearance. Prioritize stage 5 ahead of observed Earth clouds;
extend scope to the Sun through the same linear HDR/depth pipeline. This
section now has a first implementation: bounded ellipsoidal cloud/haze transport
for all four giants, internally ordered Saturn rings/shadows, and a modeled
photosphere/corona. Internal cloud volumes, observed weather and hardware timing
remain future work. See the implementation notes for approximations and evidence.

Current code inspection confirms that all four giants use 512 × 256 generated
canvas bands on spherical standard materials, with no giant atmosphere profiles.
The Sun uses a flat basic material and an additive sprite. The final pipeline
currently compiles three fixed atmosphere functions for Earth, Mars and Venus.

### A. Jupiter and the shared giant boundary

- Add a dedicated giant cloud owner and body profiles. Separate opaque cloud
  radiance/depth from upper-atmosphere scattering; use the existing body-relative
  optical coordinates, lazy resources and single display transform.
- Define the reference pressure radius and equatorial/polar radii explicitly.
  Use the same ellipsoid for cloud geometry, atmospheric ray intersections,
  lighting normals, picking and camera clearance. Keep cameras above the
  supported cloud boundary until internal cloud transport exists.
- Start with Jupiter: cream zones, brown belts, coherent swirls and a modeled
  Great Red Spot. Use documented visible-light maps where suitable and clearly
  label generated structure. Do not bake directional illumination into albedo.
- Anchor detail in body coordinates. Add restrained latitude-dependent drift
  derived from simulation time; preserve storm identity and avoid texture
  stretching, longitude seams and polar pinching. Motion is illustrative,
  not a reconstruction of weather on the selected date.
- Retain the established Earth/Mars/Venus LUT paths and register giants as
  bounded visible-body backends. Avoid evaluating seven atmosphere shaders
  across every pixel. Within Saturn's backend, resolve cloud/haze/ring ordering
  by ray intervals rather than relying on object-center sorting.

Gate: inspect Jupiter in daylight, crescent, night, polar and grazing views;
orbit and zoom continuously, cross the longitude seam, change date, resize and
switch bodies. Verify stable detail and silhouettes, opaque cloud occlusion,
camera clearance, allocation bounds and exact-once disposal.

### B. Saturn, Uranus and Neptune

- Saturn: subdued gold bands and upper haze, oblate silhouette, and detailed
  radial ring opacity. Share one ring optical-depth field between visible
  rings and ring shadows on clouds. Include the planet's shadow on rings.
  Composite front/back rings at their actual ray depths relative to haze;
  the current flattened transparent scene color is insufficient for this.
- Uranus: pale cyan, restrained bands and stronger smoothing by haze.
- Neptune: a slightly bluer cyan appearance with more visible cloud structure.
  Use the revised visible-color references rather than the familiar saturated
  Voyager presentation. Bright clouds and storms remain modeled or dated.

Gate: inspect all bodies at matched illumination and exposure. For Saturn,
include both ring faces, edge-on rings, sunlit/unlit sides, ring/planet shadows,
and camera motion through ring/globe overlaps. Repeat phone viewport and body
switch checks. Never expose an artificial rocky surface beneath giant clouds.

### C. Solar photosphere and outer emission

- Add a separate solar renderer sharing HDR color, depth, body transforms,
  resource ownership and final output with the atmosphere pipeline. Planetary
  scattering LUTs do not describe a self-emitting stellar atmosphere.
- Replace the flat yellow disc with a near-white emissive photosphere,
  view-dependent limb darkening, scale-filtered granulation and restrained
  modeled sunspots with penumbrae. Keep structures anchored to the rotating
  Sun; any evolution is illustrative and independent of live solar activity.
- Replace the fixed sprite with depth-aware, bounded outer emission. Keep
  corona brightness subordinate to the disc at ordinary exposure. If extra
  visibility is needed, document the presentation gain; do not treat colored
  extreme-ultraviolet imagery as natural visible-light appearance.
- Keep optical emission separate from scene-light normalization. Preserve
  planetary presentation brightness while tuning the solar disc. Filter small
  detail by projected size to prevent crawling and aliasing during zoom.
- Foreground bodies and atmospheres must occlude or attenuate solar emission;
  test the full disc and halo, including eclipsing silhouettes. Keep one output
  transform and verify reduced-capability rendering.

Gate: inspect full-disc and close views, orbit/zoom/date motion, foreground
occlusion, atmospheric sunset attenuation and resize. Confirm the disc retains
readable structure at the chosen exposure and that outer emission does not
bleed through planets or rings.

### Verification and references for this extension

Capture fixed-date before/after browser images for each delivery step. Run
targeted geometry/optics/lifecycle checks, the existing atmosphere regressions,
tests and production build. Record remaining visual limits and GPU allocations;
software-renderer timings do not establish hardware performance acceptance.

- [NASA Sun facts: photosphere and outer atmosphere](https://science.nasa.gov/sun/facts/)
- [ESA Solar Orbiter visible-light photosphere reference](https://www.esa.int/media/phi-s-view-of-the-sun-in-visible-light)
- [NASA Cassini natural-color rings and shadows](https://science.nasa.gov/resource/colorful-threads-and-shadows/)
- [Oxford revised Uranus/Neptune visible colors](https://www.ox.ac.uk/news/2024-01-05-new-images-reveal-what-neptune-and-uranus-really-look-0)

## Intended result

One atmosphere system supplies orbital limbs, ground-level skies, twilight,
surface illumination, and aerial perspective. A cooperating cloud system
supports observed Earth coverage, opaque Venus/giant cloud decks, and optional
volumetric detail. Each body has its own optical profile and documented sources.
Measured terrain stays authoritative. Generated cloud structure and fitted
optical parameters are identified as modeled appearance.

## Current integration points

- `ExplorerScene.ts` owns a WebGL renderer, AU-scale geometry, selected-body
  origin rebasing, lighting, transparent rings, and the animation loop. Stage 1
  moved direct canvas rendering into the shared HDR/depth pipeline.
- `EarthSurfaceRenderer.ts` and `PlanetSurfaceRenderer.ts` own the existing
  surfaces. Atmosphere ownership will be separate from terrain and hillshade.
- `pilotImageSample()` and the animation loop now share final-frame rendering.
- `ephemeris.ts` and `orientation.ts` have no Titan model. Parent navigation in
  `App.tsx` assumes that the Moon is the only satellite.
- `GiantPlanetRenderer.ts` now owns a bounded ray-integrated cloud/haze/ring
  backend within the atmosphere pipeline. `SolarRenderer.ts` owns solar emission.
  Giant cloud interiors remain unimplemented.

## Architecture and rendering decisions

Proposed modules:

| Module | Responsibility |
| --- | --- |
| `atmosphereProfiles.ts` | Typed optical profiles, altitude layers, lower boundaries, provenance, and quality defaults |
| `AtmosphereRenderer.ts` | Per-body transforms, scattering resources, visibility, update/dispose, and metrics |
| `atmosphereLuts.ts` and shader modules | Transmittance, multiple-scattering approximation, sky radiance, and finite-distance aerial perspective |
| `AtmosphereRenderPipeline.ts` | HDR/depth targets, atmosphere/cloud composition, transparent-object integration, final output |
| `CloudLayer.ts` | Shared cloud geometry/density, illumination, view integration, and shadow queries |
| `EarthCloudSource.ts` | Downloading, validation, refresh, cache, timestamps, and fallback |
| `atmosphericLighting.ts` | Surface sunlight attenuation, diffuse sky contribution, and cloud-shadow material hooks |

Use Hillaire-style lookup tables as the baseline, implemented for the existing
WebGL renderer. First establish a numerical reference integrator for a small
set of rays; compare the accelerated method against it. Do not assume an
Earth-tuned multiple-scattering approximation remains accurate for Venus or
Titan. Dense-profile validation is a release gate; refine the approximation or
use body-specific precomputed tables if it fails.

Profiles store explicit units: radii/altitudes in km and scattering/extinction
coefficients in inverse km. Separate molecular scattering, aerosol scattering,
aerosol absorption, and gas absorption; allow layered/tabulated density and
wavelength-dependent aerosol phase parameters. Optical RGB is an approximation,
not a spectral or meteorological simulation. Record the source and fitting
limitations of every accepted profile.

Convert camera, surface, and light directions into a body-relative frame before
GPU calculations. Avoid subtracting AU-sized float positions in shaders. Use
stable grazing-ray intersections and depth reconstruction with the current
adaptive near/far planes. A ray ends at actual terrain depth, not the reference
sphere; high terrain must not be clipped by a spherical ground assumption.

Render opaque surfaces into linear HDR color plus depth. Integrate medium
transmission and in-scattering to the visible endpoint, then tone-map and
convert to display color once. Background stars and the Sun are attenuated by
foreground atmosphere; labels/orbit guides remain deliberate overlays.
Transparent rings and the Sun glow need explicit depth-aware handling, rather
than placing every transparent object after a completed atmosphere pass.

Clouds return transmission, radiance, and their occupied ray interval. Split
clear-air integration around cloud segments to avoid applying all haze in
front of clouds or counting it twice. Opaque decks may provide the depth
endpoint from above, but cameras inside/below a deck require volume integration.

Feed atmospheric sunlight transmission and approximate sky irradiance into
surface materials, including terrain child meshes. Apply cloud shadows to
direct sunlight; keep their attenuation separate from terrain shadow maps and
cartographic hillshade. Retain the app's normalized interplanetary brightness
as an explicit presentation convention, consistently shared by surfaces and air.
Do not leave the current fixed ambient fill dominating dense-atmosphere views.

Only visible atmospheres receive rendering work. Cull by projected bounds and
screen size, allocate expensive close-view resources to the selected body,
and cache only a bounded set of inactive profiles. Planet occlusion and medium
ordering must remain correct when more than one body is visible.

## Delivery sequence and acceptance gates

### 1. Render pipeline and numerical foundation

Introduce the shared final-frame function and HDR/depth pipeline, initially
with atmosphere disabled. Handle resize, pixel ratio, resource disposal, and
unsupported HDR capabilities with a defined reduced-quality path. Audit existing
custom material output so no intermediate is tone-mapped twice.

Gate: existing planet, terrain, ring, Sun, and screenshot views match the
baseline within documented image tolerances. No resource growth after repeated
resize/body switches. Ray/reference tests cover limb tangency, inside/outside
atmosphere, night-side occlusion, and depth endpoints.

### 2. Earth clear air and surface lighting

Implement transmittance and multiple-scattering tables, sky rendering, finite
distance haze, and surface lighting hooks. Start with fixed weather-independent
optical parameters. Include planet shadowing and a finite solar disc for smooth
sunrise/twilight behavior; full eclipse modeling is a later extension.

Gate: continuous space-to-ground descent, a thin orbital limb, plausible
day/night transitions, distance-dependent terrain contrast, and no haze leaking
through terrain. Verify overhead and grazing views, mountains, horizon motion,
and fixed-camera terrain LOD changes.

### 3. Mars and Venus profiles; dense cloud support

Mars: add wavelength-dependent dust scattering/absorption and fitted phase
behavior; verify dusty daylight and blue light near sunset against references.
Keep dust loading a fixed documented reference state initially.

Venus: introduce a finite-thickness, nearly opaque cloud layer, upper haze,
independent cloud rotation, and strongly diffuse illumination below the deck.
Keep measured Magellan terrain and existing inferred ground material underneath.
Fit visible appearance against visible-light references; do not use radar or
UV-enhanced imagery as natural-color cloud albedo.

Gate: Venus ground is hidden from ordinary orbital views, descent through the
cloud layer has no geometry pop, and dense haze remains stable below it. This
stage validates the multiple-scattering approach before extending it to Titan.

### 4. Observed Earth cloud coverage and shadows

Integrate the Matteason cloud source behind a provider interface. Use a 2048
map by default, with 4096 available when resource budgets allow. Treat coverage
as linear scalar data with validated longitude orientation, seams, and poles.
Derive approximate optical depth using a documented transfer function; the
source is an appearance map, not measured cloud height or extinction.

Use one modeled finite-thickness layer first. Its visible clouds and Sun-ray
shadow queries must sample the same field, including low-Sun displacement.
Reuse the dense-cloud machinery from Venus with Earth-specific coverage.

Refresh no more frequently than the documented three-hour update interval,
only while relevant, with cancellation and retry backoff. Validate a replacement
before an atomic swap/crossfade; retain the previous map during failures. Bound
persistent caching to the last good frame. Include a bundled dated fallback
with provenance. Do not mistake successful download time for observation time:
display retrieval time and mark observation time unknown if unavailable.

Keep observed maps geographically fixed. Crossfades smooth updates but do not
represent measured weather motion. Latest clouds retain their own date when
simulation time changes; historical weather is a separate provider extension.
Source credits must include "Contains modified EUMETSAT data" and identify
mirrored polar fill and possible missing regions.

Gate: aligned clouds/shadows, correct rendering above/inside/below the layer,
no flashes on refresh, and usable offline/stale-data behavior. Inject download,
decode, and storage failures. Never silently interpret missing source coverage
as verified clear sky.

### 5. Gas and ice giant cloud decks (first pass implemented)

Create body-specific opaque cloud boundaries, upper haze, and layered cloud
appearance for Jupiter, Saturn, Uranus, and Neptune. Use a declared reference
pressure level for radius and altitude; camera limits prevent descent into an
unimplemented interior. Allow ellipsoidal boundaries for visibly oblate bodies
and keep atmosphere/cloud geometry consistent with that shape.

Source documented visible-color references or mark generated textures as
illustrative. Add restrained latitude-dependent motion without claiming live
weather; prevent longitude seams and polar singularities. For Saturn, include
planet shadows on rings and ring attenuation onto clouds/upper haze, with the
transparent rings integrated at the correct viewing depth.

Gate: stable cloud silhouettes, no exposed rocky surface, coherent band motion,
and correct front/back ring composition through orbital and close views.

### 6. Titan body integration and atmosphere

Add a documented Saturn-relative orbit, orientation, radius, selection, marker,
focus, and parent-navigation support. Replace the Moon-only satellite filter
and parent assumptions with explicit body relationships so Titan is not
accidentally treated as a heliocentric planet. State the orbital model's accuracy.

Add a layered haze profile, including detached upper haze, strong absorption,
and optional modeled methane clouds. Use a clearly sourced or labeled fallback
lower boundary; do not imply measured Titan terrain where none is integrated.

Gate: Titan follows Saturn correctly across date changes, focusing remains
stable, and its surface is obscured appropriately from space. Verify dense
atmosphere from both above and below against reference appearance.

### 7. Close cloud detail and quality scaling

Add bounded ray-marched internal detail to the existing cloud density field.
Observed Earth coverage remains authoritative at its source resolution;
sub-resolution structure is procedural. Match integrated optical depth between
cheap orbital rendering and close volumetric rendering, with altitude-based
hysteresis and smooth transitions.

Use reduced-resolution volumes with depth-aware upsampling. Add temporal
accumulation only if needed, with rejection/reset on body switches, date jumps,
camera teleports, coverage replacement, and depth discontinuities. All quality
tiers retain the same broad cloud coverage and atmosphere profile.

Gate: no cloud swimming, transition popping, silhouettes leaking over terrain,
or persistent temporal ghosts during orbit, pan, descent, and ascent.

## Resource budgets and verification

Initial engineering targets, to be measured rather than claimed as achieved:
at 1920x1080 internal resolution, clear-air work <= 2 ms and atmosphere plus
cloud work <= 6 ms on the designated hardware test GPU. Aim for <= 96 MiB of
additional atmosphere/cloud GPU allocations at that resolution; scale render
targets, cloud resolution, and cache size on constrained devices. Account for
HDR/depth intermediates, mipmaps, old/new weather frames, LUTs, and noise volumes.
Choose and record the actual test GPU/browser before performance acceptance.

Expose developer metrics for pass timings, allocations, active profiles,
cloud-source age/state, quality tier, and pending requests. CPU timings and
software-renderer timings do not establish GPU performance acceptance.

Run existing tests and production build after integration changes. Add targeted
numerical and lifecycle checks, provider failure tests, and a deterministic
browser scene matrix using frozen weather fixtures. Compare Earth/Mars/Venus
from ground, below/inside/above clouds where applicable, orbit, and deep space;
include Titan and all giants when added. Cover day, twilight, night, moving
cameras, poles, longitude seams, viewport resize, body switching, and terrain LOD.
Retain a no-atmosphere baseline for the Moon and Mercury.

Keep the main UI curated: atmosphere/cloud visibility, concise provenance and
weather status, and an explicitly labeled scientific surface-reveal option
for Venus/Titan. Detailed optical tuning stays in developer tools. After each
stage, record browser evidence and unresolved limitations before proceeding.

## References

- [Hillaire, A Scalable and Production Ready Sky and Atmosphere Rendering Technique](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14050)
- [Bruneton reference implementation and validation](https://ebruneton.github.io/precomputed_atmospheric_scattering/)
- [Matteason Live Cloud Maps: formats, updates, limitations, attribution](https://github.com/matteason/live-cloud-maps)
- [NASA: Venus facts](https://science.nasa.gov/venus/venus-facts/)
- [NASA: Titan facts](https://science.nasa.gov/saturn/moons/titan/facts/)
- [NASA: Mars sunrise and sunset colors](https://science.nasa.gov/solar-system/planets/mars/what-does-a-sunrise-sunset-look-like-on-mars/)
