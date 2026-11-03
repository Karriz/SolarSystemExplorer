import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output = '.terrain-cache/surface-detail-browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], cases: [] }
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__detailScene=this;') })
  })
  await page.goto(`${process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'}/?terrainPilot=1`)
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics()
    const s = __detailScene
    terrainPilot.date('2026-10-26T12:00:00Z')
    s.setTerrainShadows(false); s.setTerrainHillshade(false)
    s.__detailRender = s.renderer.render
    s.renderer.render = () => {}
  })
  for (const [body, lat, lon] of [['mercury', 20, 160], ['moon', 26.13, 3.63], ['mars', -12, -70]]) {
    for (const altitude of [500, 6000, 30000]) {
      console.log('Checking detail:', body, altitude)
      await page.evaluate(({ body, lat, lon, altitude }) => terrainPilot.location(body, lat, lon, altitude), { body, lat, lon, altitude })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.waitForFunction(body => {
        const s = __detailScene, surface = s.planetSurfaces.get(body), layer = surface.terrain
        return surface.state.detailMapReady.value && surface.state.mediumDetailReady.value
          && surface.metrics().color === 'compact' && layer.metrics().ready && !layer.metrics().requests
          && [...layer.wanted].every(key => layer.nodes.get(key)?.mesh)
      }, body, { timeout: 180000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.evaluate(() => { __detailScene.pilotAltitude = null })
      for (const lighting of altitude === 500 ? ['overhead', 'grazing'] : ['overhead']) {
        const result = await page.evaluate(async ({ body, lighting }) => {
          const THREE = await import('/node_modules/three/build/three.module.js')
          const s = __detailScene, surface = s.planetSurfaces.get(body), layer = surface.terrain
          // Fixed camera and controlled lighting isolate material behavior from hillshade.
          const lights = []
          s.scene.traverse(o => { if (o.isLight) { lights.push([o, o.visible]); o.visible = false } })
          const radial = s.camera.position.clone().normalize()
          const tangent = new THREE.Vector3(0, 1, 0).cross(radial).normalize()
          const light = new THREE.DirectionalLight(0xffffff, 3)
          light.position.copy(radial).multiplyScalar(lighting === 'overhead' ? 1 : .2)
          if (lighting === 'grazing') light.position.add(tangent)
          s.scene.add(light)
          s.__detailRender.call(s.renderer, s.scene, s.camera)
          const signature = layer.surfaceSignature(), geometryCount = s.renderer.info.memory.geometries
          const pixels = []
          for (const detail of [0, 1, 0]) {
            surface.state.detail.value = detail
            s.__detailRender.call(s.renderer, s.scene, s.camera)
            const gl = s.renderer.getContext(), data = new Uint8Array(256 * 256 * 4)
            gl.readPixels(Math.floor(gl.drawingBufferWidth / 2) - 128, Math.floor(gl.drawingBufferHeight / 2) - 128, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, data)
            pixels.push(data)
          }
          let difference = 0, repeatDifference = 0, changed = 0
          for (let i = 0; i < pixels[0].length; i++) if (i % 4 !== 3) {
            const delta = Math.abs(pixels[0][i] - pixels[1][i])
            difference += delta; repeatDifference += Math.abs(pixels[0][i] - pixels[2][i])
            if (delta > 1) changed++
          }
          surface.state.detail.value = 1
          s.__detailRender.call(s.renderer, s.scene, s.camera)
          const image = s.renderer.domElement.toDataURL()
          s.scene.remove(light); light.dispose()
          lights.forEach(([o, visible]) => { o.visible = visible })
          return { image, meanDifference: difference / (256 * 256 * 3), changedFraction: changed / (256 * 256 * 3), repeatDifference,
            geometryUnchanged: geometryCount === s.renderer.info.memory.geometries && signature === layer.surfaceSignature() }
        }, { body, lighting })
        await writeFile(`${output}/${body}-${altitude}-${lighting}.png`, Buffer.from(result.image.split(',')[1], 'base64'))
        delete result.image
        console.log(body, altitude, lighting, result)
        if (altitude < 18000) {
          assert.ok(result.meanDifference > .5, 'detail remains visible under direct light')
          assert.ok(result.changedFraction > .1)
        } else assert.equal(result.meanDifference, 0, 'material detail fades out before orbital views')
        assert.equal(result.repeatDifference, 0)
        assert.ok(result.geometryUnchanged)
        report.cases.push({ body, altitude, lighting, ...result })
      }
    }
  }
  assert.deepEqual(report.errors, [])
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
