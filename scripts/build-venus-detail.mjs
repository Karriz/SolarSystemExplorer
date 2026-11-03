// Illustrative fractured basalt material; no measured Venus microtopography.
// Reuse the shared seamless rock baker at physical 64 m / 256 m repeats.
import { bakeMaterial } from './build-moon-detail.mjs'
bakeMaterial('venus-detail.png', 64, false, true)
bakeMaterial('venus-medium-detail.png', 256, true, true)
