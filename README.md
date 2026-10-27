# Solar System Explorer prototype

A browser prototype for exploring the Sun, eight planets, and the Moon. It uses React, TypeScript, Three.js, and Vite.

## Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Run `npm run build` to type-check and create a production build in `dist/`.

Left drag pans across the scene, right drag tilts/orbits the camera, and the mouse wheel zooms toward the pointer. Pan distance scales with the current camera zoom.

## What this prototype includes

- Solar System overview and scale-aware camera focus
- Search, body selection, orbit paths, and an information panel
- Date selection and adjustable time playback
- Planet positions calculated from [JPL's approximate orbital elements](https://ssd.jpl.nasa.gov/planets/approx_pos.html), valid from 1800 to 2050
- A deliberately simplified lunar orbit, identified as approximate in the interface
- Physical body radii and orbital distances, with screen labels to make small bodies selectable

Earth, Moon, and Mars use local NASA image maps in `public/textures/`. Their source pages, credits, and details are recorded in `src/textureSources.ts` and linked from each body's information panel. Earth's October 2004 Blue Marble composite includes shaded ocean bathymetry. The Earth shader lifts only blue ocean pixels so deep water stays visible; lighting remains much brighter on the solar side. The Moon and Mars maps are also fixed imagery, so changing the simulation date does not change their surface appearance. The scene keeps a procedural map visible while each image loads, and if loading fails. Other bodies still use procedural illustrations.

Body pole and prime meridian angles follow [JPL NAIF's generic planetary constants](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc); Earth uses the [USNO approximate sidereal time formula](https://aa.usno.navy.mil/faq/GAST). The Moon includes the NAIF periodic terms. Mars uses the largest of its periodic terms; remaining small terms and polar motion are omitted. UTC stands in for UT1/TDB, so surface orientations are approximate rather than suitable for precise geolocation. Rotation follows the chosen simulation date, including time playback. Sunlight comes from the Sun's scene position, with brightness normalized across distances to make the day/night boundary readable at every planet.

The scene uses right-handed axes (+X toward the J2000 equinox, +Y ecliptic north, -Z toward positive ecliptic longitude). The NASA equirectangular maps are applied without horizontal mirroring, so western longitudes remain on the left of each source map.

This prototype has no terrain, imagery tiles, satellites, spacecraft, or live data feeds yet.
