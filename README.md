# Solar System Explorer prototype

A browser prototype for exploring the Sun, eight planets, and the Moon. It uses React, TypeScript, Three.js, and Vite.

## Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Run `npm run build` to type-check and create a production build in `dist/`.

Left drag moves around the selected body in both horizontal and vertical directions. At close range (below half a body radius in altitude), left drag grips the surface under the cursor instead. Right drag tilts the camera's viewing direction toward the horizon, without moving its position. Scrolling moves closer to or farther from the selected body while preserving that viewing direction. One-finger touch orbits or grabs the surface; two-finger touch adds pinch zoom. Close views follow the body's rotation, and zooming back out retains heading and tilt. Focus view resets the view toward the selected body's center; Overview returns to the Sun.

Close zoom reaches an altitude of 5% of each body's radius (about 319 km above Earth). Camera movement stays outside globe surfaces, and the near clipping distance adapts on approach. Visible globe regions load progressively sharper imagery tiles. The Moon can also load locally generated elevation tiles (see below).

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

Local terrain is currently available for the Moon. Other bodies have no terrain geometry yet; satellites, spacecraft, and live data feeds are not included.


## Local lunar terrain

Build the static terrain backend and run the explorer:

```bash
npm run terrain:build
npm run terrain:validate
npm run dev
```

Requires Python 3, with no additional Python packages. The first build downloads NASA/MIT's [LOLA LDEM_16 raster and PDS label](https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/) into `.terrain-cache/` (33.2 MB raster). Later builds reuse the cache; `npm run terrain:build -- --offline` prevents downloading. The source checksum is pinned; an upstream change requires reviewing the product and updating the adapter.

Select **Moon**, zoom in, and use **Terrain on/off** in its information panel to compare measured relief with the imagery globe. **Relief → 4× exaggerated** makes the geometry easier to inspect; **True scale** is the default. Local terrain uses the existing CGI Moon Kit global color texture. NASA Trek detail imagery resumes when terrain is off or unavailable. At present, terrain and streamed detail imagery are alternative render paths rather than a combined high-resolution material.

The default release has 2,730 tiles across levels 0–5, totaling approximately 20 MB of compressed elevation payloads, plus a 0.4 MB manifest. Only needed tiles are fetched. Each tile has a 65×65 grid with shared edge samples; the finest equatorial spacing is about 2.7 km, resampled from a 1.9 km source. The source's original vertical sampling is preserved at 0.5 m increments. Use `--max-zoom 3` for a smaller experiment. The coarse two-root fallback is part of the same tile pyramid.

`public/terrain/catalog.json` points to a versioned Moon manifest and relative tile URLs. Vite serves these files locally and includes them in production builds. Generated data and cached sources are Git-ignored; regenerate before deploying. Dataset releases include source hashes, the original label, frame, radius, coverage, elevation bounds, per-tile hashes, estimated geometric errors, and credits. The Moon adapter converts the source's 0–360° east-positive pixel-centered grid into a geographic 2×1-root quadtree covering both poles. Heights reference the source's 1,737,400 m sphere, matching the renderer's lunar radius; this adapter does not assume Earth coordinate systems or vertical datums.

Tile `.bin` files contain gzip-compressed little-endian signed 16-bit samples. The suffix is intentional: static servers must deliver the opaque bytes without `Content-Encoding: gzip`, because a web worker verifies and decompresses the payload. Each signed sample multiplied by 0.5 gives height in meters above the reference sphere. Rows run north to south. There is no missing-data mask in this first adapter because the selected gridded product provides a filled global surface.

The renderer limits terrain to four concurrent requests, 48 selected leaf patches, and an estimated 48 MiB combined geometry/sample CPU+GPU budget. It retains parent terrain until replacement children load, uses boundary skirts, aborts obsolete fetches, rejects stale worker results, and restores the imagery globe on disable or root failure. Geometry construction currently runs on the main thread; checksum verification and decompression run in a worker. Level selection uses an estimated midpoint-plus-spherical-chord error, not a certified maximum error bound. Camera picking still uses the reference sphere, and the existing minimum altitude keeps the camera above terrain even at 4× relief.

The local backend is static: no database, API server, or cloud account is required. Its output can later move to object storage and a CDN without changing the tile contract. Mars, Mercury, and Venus require additional explicit source adapters and corresponding renderer support.
