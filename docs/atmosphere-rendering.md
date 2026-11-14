# Atmosphere rendering

November 14, 2026. Stages 1–3 of the [implementation plan](atmosphere-implementation-plan.md).
Earth clear air, Mars dust, and Venus dense air/clouds are enabled by default.
Observed Earth clouds, Titan and giant-planet profiles remain pending.

## Implemented

`AtmosphereRenderPipeline.ts` renders the existing scene into a linear RGBA16F
target with a sampleable depth texture. Three.js suppresses material tone mapping
for this target; the final `OutputPass` applies the renderer's exposure, ACES
curve, and display conversion once. Transparent canvas output unpremultiplies
linear RGB before this transform and premultiplies display RGB afterwards.

The animation loop and `pilotImageSample()` now share `renderFrame()`, so browser
samples include the same final output as the visible application. Render counters
cover both passes. Targets follow drawing-buffer resolution, including pixel
ratio changes, and are released on resize/disposal. A rendering failure restores
the caller's render-target and diagnostic state.

Compatible color/depth sample counts are queried per attachment format. Up to
4x MSAA is used where supported and within an estimated 80 MiB attachment budget.
Larger buffers drop MSAA first, then scale resolution if needed. The estimate
includes resolved color/depth and multisample storage, not driver overhead or
the existing renderer's allocations. Additional atmosphere/cloud resources will
need their own accounting within the overall plan's budget. Devices without
HDR attachments, or with an incomplete framebuffer, retain direct rendering.

Existing transparent objects retain scene ordering for this stage. Overlapping
transparent materials now blend linear radiance before tone mapping, which
changes Saturn ring/globe overlap slightly. A separate analytic overlap fixture
checks the intended color. Depth-aware ring/atmosphere integration remains a
later stage; this foundation alone does not solve atmospheric transparency.

`atmosphereMath.ts` establishes CPU reference geometry in body-relative km:
stable sphere intersections, forward air intervals clipped to actual terrain
depth, planet occlusion of sunlight, and ordinary perspective-depth reconstruction.
Directions are unit vectors. These helpers are the reference for subsequent
GPU atmosphere code. Numerical/GPU comparisons for individual profiles are
described below.

## Validation

- Foundation regressions cover grazing rays, small surface clearance,
  elevated/depressed terrain endpoints, planetary shadow, and depth reconstruction
  with the app's AU-scale/adaptive clipping conventions.
- `tsc -b` and a production Vite bundle build pass. Repeated bundle checks skip
  recopying the unchanged generated terrain release.
- `npm run atmosphere:check-pipeline`: run against a Vite server on port 5175,
  or set `ATMOSPHERE_PREVIEW_URL`. Browser output and JSON are saved under
  `.terrain-cache/atmosphere-pipeline-browser/`.
- Browser fixtures check HDR values above 1, premultiplied alpha, analytic linear
  overlap, actual GPU depth sampling, resize/pixel ratio, failure-state restoration,
  direct fallback, missing HDR support, and release of target textures on disposal.
- Scene comparisons cover Sun, Earth, Moon, Mars, Venus and Saturn, including
  close Earth/Moon/Mars views, camera motion, and phone/desktop resize. Frozen
  scene pairs compare the original direct render with the new final frame.
  Solid-body comparisons explicitly wait for visible measured terrain meshes.
  Mean channel differences were below 0.013/255 for Earth/Moon/Mars/Venus and
  about 0.69/255 for Saturn with the deliberate linear ring blending change.

## Earth clear air

`atmosphereProfiles.ts` defines a fixed reference Earth atmosphere using the
RGB molecular/aerosol/ozone model in [Hillaire's paper](https://sebh.github.io/publications/egsr2020.pdf).
The reference radius matches the existing 6371 km terrain system. Coefficients
are in inverse km; distances and scale heights are km. This is an RGB appearance
approximation with fixed conditions, not observed atmospheric weather.

`atmosphereOptics.ts` supplies a numerical reference integral and deterministic
lookup-table builder. A worker builds a 256x64 transmittance table with
Bruneton's limb-concentrated parameterization, a 48x24 isotropic higher-order
scattering table, and a matching diffuse sky irradiance table. Higher-order
feedback includes an average Lambertian ground contribution, rather than simply
adding a constant ambient color. The approximation is validated for clear Earth
only; it must not be assumed accurate for dense Venus/Titan conditions.

`AtmosphereRenderer.ts` owns loading, body-relative transforms, fade-in, immutable
tables, failure fallback and disposal. It allocates tables only when Earth air
is visible, uses 149,504 bytes of RGBA16F table storage, and retains one set across
body switches. Table generation took roughly 1.7-1.9 s in the tested software
browser and runs off the UI thread. Duplicate/late worker results are ignored;
failure leaves the existing direct surface lighting available.

The output shader integrates a finite air segment with 48 deterministic steps,
sunlight transmission, Rayleigh/Cornette-Shanks phase functions, multiple
scattering, and finite-disc planet-shadow smoothing. Actual scene depth ends
each viewing segment. The same body-fixed sunlight transmission attenuates the
surface's direct diffuse/specular terms; sky irradiance replaces Earth's fixed
ambient fill. Both the point-light and directional terrain-shadow paths use the
same atmospheric attenuation. Existing normalized solar brightness and warm
light color remain presentation conventions shared by ground and air.

The existing transparent canvas uses a black-space matte for optically dense
sky, fading smoothly to the CSS overview background in extremely thin air. The
RGB transport and display alpha serve separate purposes; that matte is not a
physical optical-depth product. Decorative overview stars are suppressed in
bright low-altitude skies and recover above the air/at night. This is a
presentation exposure approximation; screen labels/orbit guides remain overlays.

The fallback globe writes analytic reference-sphere depth while air is active.
Otherwise its flat triangles appear as kilometer-scale depressions and produce
a visible grid of excess haze. A selected Earth uses a cached 512x256 reference
mesh for a smoother ground horizon; the overview keeps its smaller mesh. The
extra geometry is reported in Earth asset metrics and disposed by the owner.
Measured regional geometry, including negative elevations, keeps its actual
depth and remains authoritative.

## Earth verification and remaining work

- Earth regressions cover independent vertical optical-depth columns,
  phase-function energy conservation, numerical versus lookup transmission,
  high-sample versus accelerated scattering, finite Sun/night shadow, worker
  failure, fade-in, duplicate/late delivery and disposal.
- `npm run atmosphere:check-earth`: compares actual floating-point GPU scattering
  (single scattering) and transmission against CPU reference integrals.
  Higher orders use the stated isotropic closure, checked for finite output and
  increased radiance without altered transmission; this is not an independent
  path-traced validation of multiple scattering. GPU depth probes recover
  the 10 km reference surface to about 0.12 m, a plane 5 km above it to about
  0.03 m, and a plane 2 km below it to about 0.30 m in the tested camera.
- Browser captures cover orbit, terminator, 80 km altitude, ground sky/horizon,
  sunset, twilight/night, and a real measured Alpine terrain tile at its original
  geographic coordinates. The bounded fixture avoids dependence on the live
  terrain CDN. Tilt through the measured horizon produces no GL errors; repeated
  identical frames have zero sample difference. Moon foreground remains airless,
  and table identities remain stable across body switches and phone resize.
- The neutral pipeline regression explicitly disables Earth optics when checking
  the existing six bodies' direct-render parity and compatibility fallback.

Software Chromium checks establish correctness, not hardware timing. This
quality-first implementation integrates viewing rays directly with sunlight
and multiple-scattering LUTs. A sky-view LUT or aerial-perspective volume can
be added after hardware profiling; the plan's 2 ms clear-air target is not yet
verified. Twilight uses the existing fixed exposure; airglow, moonlight, physical
sky reflections, terrain shadows inside the air, full eclipse modeling, dense
profiles beyond Venus, Earth weather clouds, and Titan integration remain pending.

## Mars and Venus

Each body owns a separate immutable profile and lazy worker/table lifecycle.
The final shader namespaces the three optical models and composites visible
atmospheres from far to near in linear HDR, stopping at actual scene depth.
Surface material hooks also cover measured cube-terrain child meshes; measured
elevations and Venus's 800 m datum conversion are unchanged. Combined LUT storage
for Earth, Mars and Venus is 503,808 bytes, independent of terrain residency.

Mars uses a thin molecular component and fitted RGB dust scattering, absorption,
and wavelength-dependent forward phase functions. The result is warm daylight
with a blue forward-scattered sunset region, following the qualitative behavior
described by [NASA](https://science.nasa.gov/photojournal/the-sun-sets-on-mars/).
Coefficients are a fixed illustrative dust state, not retrieved weather or a
calibrated aerosol dataset.

Venus uses a smooth finite cloud layer from 48–70 km, with an unscaled reference
vertical optical depth of 32. These constraints follow published Venus cloud
models; see [Haus et al.](https://doi.org/10.1002/2016JE005087). Other RGB optical
coefficients and cloud microstructure are fitted appearance parameters.

The Earth isotropic feedback approximation is not reused for Venus. Instead,
`denseAtmosphere.ts` solves a plane-parallel diffuse field with 160 layers and
eight Gauss-Legendre directions per hemisphere. Aerosol/cloud forward scattering
uses reduced scattering `beta_s * (1 - g)`, an isotropic transport approximation.
Layer-average intensities, accelerated lambda iteration, a Lambertian ground
boundary, and separate direct/diffuse terms preserve flux in this model.

The solved diffuse field is stored in 48x96 source and irradiance tables.
Activation requires maximum relative energy error below 0.5% and iteration
residual below 2e-6. The reference Venus profile converged within 973 iterations,
with maximum relative flux error about 6.4e-7. Independent tests compare reflected,
transmitted and absorbed fractions against a separate Monte Carlo photon walk,
and check pure absorption and conservative reflecting limits.

This validates the chosen transport solver, not full spectral Venus radiometry
or a 3D cloud simulation. The plane-parallel diffuse closure approximates grazing
illumination; local curved single-scattering/transmission and planet occlusion
remain in the view integral. The direct phase in Venus's transport model is
isotropic. Scene exposure and normalized warm solar lighting remain presentation
conventions; below-cloud surface contrast is muted at the existing fixed exposure.

Cloud structure is a low-amplitude, seam-free Cartesian density modulation that
vanishes at the poles. It drifts approximately westward once per four simulated
Earth days relative to the solid body; inverse coordinates give the correct
advection direction. It is generated and illustrative, not observed cloud data.
Viewing integration splits at the cloud-top sphere to avoid undersampling the
entry gradient at the limb, using up to 144 samples across three nonempty
segments. A solid core 30 km below the reference surface prevents missed-depth
background rays integrating air through the planet; it lies below all measured
Venus relief and does not replace actual terrain endpoints.

An opaque loading/compatibility cloud proxy prevents exposed ground from orbit
before the dense tables are accepted. It disappears when the finite-volume
renderer is ready; no shell remains to pop through during descent. Rejected
tables retain the cloud proxy. In the ready orbital reference probe, transport
transmission to the ground is below 7e-5 in every channel. Below the clouds,
surface illumination is overwhelmingly diffuse and preferentially warm.

The UI's **Reveal surface** is explicitly a scientific view with atmosphere and
clouds hidden; it restores cartographic hillshade. The default view disables
that hillshade and defers hidden ground streaming until below 100 km. Legacy
terrain/color audits now explicitly choose surface inspection mode.

## Planet verification

- `npm test`: 161 passing tests, including independent Monte Carlo/flux limits,
  dense-profile convergence, spectral Mars behavior, cloud continuity/opacity,
  dense-table rejection fallback, and cloud advection direction.
- `npm run atmosphere:check-planets`: floating-point GPU/reference comparisons
  for both planets, orbital/day/sunset views, Venus above/inside/below clouds,
  measured cube terrain, identical repeated frames, scientific reveal/restore,
  generated cloud motion, longitude wrap, and phone layout. Artifacts are in
  `.terrain-cache/mars-venus-atmospheres-browser/`.
- Scene shutdown detaches the cloud proxy before generic scene traversal;
  its geometry/material and all three Venus tables are released exactly once.
- Earth and neutral-pipeline regressions are retained; runtime performance on a
  physical GPU still needs measurement. Procedural cloud variation is disabled
  in numerical probes so the GPU and reference both evaluate the mean column.
