import { bakeMaterial } from './build-moon-detail.mjs'
// Shared packed-data format and triplanar sampler; Earth's class shader adds
// mapped palettes/water response. These textures are generated, not observed.
bakeMaterial('earth-detail.png', 64)
bakeMaterial('earth-medium-detail.png', 256, true)
