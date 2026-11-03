# Nearby solid-body material detail

Moon, Mars and Mercury use generated fine and medium material detail alongside
measured terrain and geographic color. These repeating textures suggest surface
materials; they do not represent mapped rocks, craters or mineral abundances.
Mercury uses an airless regolith/fractured-fragment pattern with its own fragment
distribution. Mars retains dust, sand ripples and partly buried fragments.

The material modulates the measured color's brightness without changing its hue.
Unlike a normal-only effect, this variation remains visible under frontal light.
Fine detail fades between 300 and 3,000 m camera distance; medium detail fades
between 2,500 and 18,000 m. Both use body-fixed triplanar sampling and hardware
mipmaps. Detail never displaces measured terrain or changes terrain selection.

Each 512 × 512 linear RGBA texture packs normal XY in RG, generated reflectance
variation in B, and roughness in A. Positive normal Z is reconstructed in the
shader. Brightness and roughness vary independently without extra texture reads.
Fine repeats are 64 m for Moon/Mercury and 128 m for Mars; medium repeats are
256 m and 512 m respectively. Missing textures leave the measured surface usable.

Rebuild with `npm run moon:build-detail`, `npm run mars:build-detail`, and
`npm run mercury:build-detail`. All six textures must use this packing together
with the shared shader. `npm run surfaces:check-detail` exercises the real terrain
renderer under controlled overhead/grazing lighting, records captures under
`.terrain-cache/surface-detail-browser`, checks medium-distance visibility and
distant fade, and verifies reversible toggles without geometry changes or shader
errors. `npm run surfaces:check-planets` checks the shared default/lifecycle path.
