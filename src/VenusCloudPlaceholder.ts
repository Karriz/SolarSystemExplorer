import * as THREE from 'three'
import type { AtmosphereProfile } from './atmosphereProfiles.ts'

/** Opaque loading/compatibility fallback only. The ready renderer integrates
 * finite cloud density; no opaque shell remains during descent through it. */
export class VenusCloudPlaceholder {
  private readonly material = new THREE.MeshStandardMaterial({ color: new THREE.Color(.72, .69, .62), roughness: 1 })
  private readonly geometry: THREE.SphereGeometry
  readonly mesh: THREE.Mesh
  constructor(body: THREE.Object3D, profile: AtmosphereProfile) {
    this.geometry = new THREE.SphereGeometry((profile.radiusKm + profile.clouds!.baseKm) / 149_597_870.7, 128, 96)
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'venus-cloud-loading-fallback'
    this.mesh.visible = false; body.add(this.mesh)
  }
  update(visible: boolean) { this.mesh.visible = visible }
  dispose() { this.mesh.removeFromParent(); this.geometry.dispose(); this.material.dispose() }
}
