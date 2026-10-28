# Solar System Explorer prototype

A browser prototype for exploring the Sun, eight planets, and the Moon. It uses React, TypeScript, Three.js, and Vite.

## Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Run `npm run build` to type-check and create a production build in `dist/`.

Left drag moves around the selected body in both horizontal and vertical directions. At close range (below half a body radius in altitude), left drag grips the surface under the cursor instead. Right drag tilts the camera's viewing direction toward the horizon, without moving its position. Scrolling moves closer to or farther from the selected body while preserving that viewing direction. One-finger touch orbits or grabs the surface; two-finger touch adds pinch zoom. Close views follow the body's rotation, and zooming back out retains heading and tilt. Focus view resets the view toward the selected body's center; Overview returns to the Sun.

Close zoom reaches an altitude of 5% of each body's radius (about 319 km above Earth). Camera movement stays outside globe surfaces, and the near clipping distance adapts on approach. Visible globe regions load progressively sharper imagery tiles; there is no terrain geometry.

Run `npm test` with Node.js 22.6 or newer to check camera safety, tile mapping, request lifecycle, and cache limits.

## What this prototype includes

- Solar System overview and scale-aware camera focus
- Search, body selection, orbit paths, and an information panel
- Date selection and adjustable time playback
- Planet positions calculated from [JPL's approximate orbital elements](https://ssd.jpl.nasa.gov/planets/approx_pos.html), valid from 1800 to 2050
- A deliberately simplified lunar orbit, identified as approximate in the interface
- Physical body radii and orbital distances, with screen labels to make small bodies selectable

Earth, Moon, and Mars use local NASA image maps in `public/textures/`. Their source pages, credits, and details are recorded in `src/textureSources.ts` and linked from each body's information panel. Earth's October 2004 Blue Marble composite includes shaded ocean bathymetry. The Earth shader lifts only blue ocean pixels so deep water stays visible; lighting remains much brighter on the solar side. The Moon and Mars maps are also fixed imagery, so changing the simulation date does not change their surface appearance. The scene keeps a procedural map visible while each image loads, and if loading fails. Other bodies still use procedural illustrations.

At closer range, geographic WMTS tiles stream directly from NASA (no API key):

- Earth: [GIBS Blue Marble with shaded relief and bathymetry](https://nasa-gibs.github.io/gibs-api-docs/), 500 m imagery, zooms 0–7, 512-pixel tiles on the CRS84 grid.
- Moon: [NASA Trek LRO WAC global mosaic](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon), approximately 100 m source imagery, zooms 0–8, 256-pixel tiles.
- Mars: [NASA Trek Viking MDIM 2.1 color mosaic](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars), 232 m source imagery (finest served grid approximately 326 m at the equator), zooms 0–7, 256-pixel tiles.

Provider grids, endpoints, and credits are in `src/surfaceTiles.ts`. These are fixed composites, independent of the simulation date. The Moon WAC detail layer is monochrome and contains illumination from its source observations. Earth's bathymetric composite retains the readable oceans of the local fallback and includes baked relief shading. Tiles follow the body's rotation and use the scene's sunlight. The renderer retains parent imagery and local maps while detail loads or requests fail, caps concurrent requests at six, and budgets approximately 96 MiB for tile textures including mipmaps. Unused cached tiles are evicted as needed; obsolete requests are aborted. No service uptime guarantee is assumed.

Body pole and prime meridian angles follow [JPL NAIF's generic planetary constants](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc); Earth uses the [USNO approximate sidereal time formula](https://aa.usno.navy.mil/faq/GAST). The Moon includes the NAIF periodic terms. Mars uses the largest of its periodic terms; remaining small terms and polar motion are omitted. UTC stands in for UT1/TDB, so surface orientations are approximate rather than suitable for precise geolocation. Rotation follows the chosen simulation date, including time playback. Sunlight comes from the Sun's scene position, with brightness normalized across distances to make the day/night boundary readable at every planet.

The scene uses right-handed axes (+X toward the J2000 equinox, +Y ecliptic north, -Z toward positive ecliptic longitude). The NASA equirectangular maps are applied without horizontal mirroring, so western longitudes remain on the left of each source map.

This prototype has no terrain, satellites, spacecraft, or live data feeds yet.
