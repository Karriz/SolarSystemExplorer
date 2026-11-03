# Shared Moon/Mars rendering

Implemented November 3, 2026 as the first stage of the
[generic planet rendering plan](generic-planet-rendering-plan.md).

Moon and Mars now use `PlanetSurfaceRenderer`. Each instance owns its base
material configuration, cube terrain, continuous color loader, global hillshade,
generated detail assets, fallback handling and disposal. `ExplorerScene` keeps
scene-wide camera, lighting and terrain queries; it no longer owns separate
Moon/Mars color implementations or vector comparison loaders.

`planetRenderProfiles.ts` describes each body's physical detail scales,
accepted color-sampling behavior, original image dimensions and source credits.
`planetSurfaceMaterial.ts` contains the shared material implementation.
`moonSurfaceMaterial.ts` is a compatibility export for regional terrain and
existing material checks. The accepted Moon and Mars sampling behavior is
preserved explicitly instead of silently changing sharpening during refactoring.

## Fixed appearance

- Measured terrain on, true-scale geometry, continuous compact 4K color,
  global DEM-derived hillshade on, generated normal/roughness detail on.
- No Moon/Mars terrain, shadow, hillshade, detail or relief controls; no color
  selectors, vector boundary preview or location shortcuts in the product UI.
- Keep body navigation, focus, orbit display, simulation controls, source
  attribution and loading/failure status.
- Color and generated detail load on first visit to a body. Fine hillshade and
  terrain retain their existing release-on-departure behavior. Visited bodies'
  small detail maps and 4K color stay resident until scene disposal; this change
  does not introduce a device-wide cache manager.
- If compact color fails, try the original image once. If both fail, retain
  the placeholder and report it accurately. Superseded/disposed work cannot
  attach late textures. Missing detail does not remove measured terrain.
- Existing Earth/Mercury/Venus controls affect only the selected body and keep
  their own UI state; they cannot change Moon/Mars defaults.

Scientific geographic terrain releases, height sampling, mesh selection,
stitching, source frames and published asset formats are unchanged. There is
no terrain rebuild or conversion into cube-face source data.

The current lunar shadow-light path is preserved, but terrain meshes still
do not cast shadows. Restoring stable terrain self-shadowing remains separate;
this consolidation does not claim to fix moving-shadow artifacts.

## Validation

Run Vite on port 5175 and use:

```sh
npm test
npm run build:app
npm run surfaces:check-planets
npm run surfaces:check-global
```

This pass passed all 116 existing tests and the lean app build. The global
hillshade run selected Hadley, lunar north pole/dateline, Valles, Martian south
pole and cube corner, plus the common motion/failure checks. Fixed-ground
hillshade samples remained identical (152, 152, 152), with no page/shader errors.
Desktop and phone screenshots were inspected against the pre-refactor captures;
streaming settlement differs between captures, so this is not a pixel-identical
image claim. Real-device performance and lunar self-shadowing remain open.

The shared-surface browser check covers both owners and fixed defaults, absence
of rendering/location controls, no eager color/detail loads, correct 4K images,
original/placeholder fallbacks, delayed completion after disposal, isolation
from Earth settings, dateline visits and phone layout. Screenshots/results are
under `.terrain-cache/planet-surfaces-browser/`.

The existing global hillshade browser check has been migrated to the generic
owner and fixed-options UI. It retains GPU comparisons, stable selection,
camera panning, bounded pool reuse, release on body switch, fixed-ground samples,
bundled fallback/recovery and corrupt-page rejection. It supports
`GLOBAL_SURFACE_CASES` for selecting geographic views.

Older color/vector comparison scripts that operate the removed selectors are
historical diagnostic tools, not current product acceptance checks. Original
and reference assets/builders remain available for offline source review.
Software WebGL validates rendering behavior, not real-device performance.

## Next extension

Mercury is now implemented through a new profile and validated color/hillshade
assets; see [Mercury data and validation](mercury-surface.md). Keep terrain manifest validation strict and label enhanced color
accurately. Venus still needs explicit radar/cloud semantics; Earth retains its
regional provider, and giant planets need a cloud/atmosphere implementation.
