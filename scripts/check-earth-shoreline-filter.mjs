import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { filterEarthMaterials, MASK_GUTTER } from '../src/earthSurfaceData.ts'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/earth-shorelines'
await mkdir(output, { recursive: true })
const size = 64, width = size + 2 * MASK_GUTTER, aa = 4, slope = .37, intercept = 42.3
const fine = new Uint8Array((width * aa) ** 2), legacy = new Uint8Array(width ** 2)
for (let y = 0; y < width * aa; y++) for (let x = 0; x < width * aa; x++) {
  if ((x + .5) / aa - MASK_GUTTER + slope * ((y + .5) / aa - MASK_GUTTER) < intercept) fine[y * width * aa + x] = 9
}
for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
  if (x + .5 - MASK_GUTTER + slope * (y + .5 - MASK_GUTTER) < intercept) legacy[y * width + x] = 255
}
const masks = filterEarthMaterials(fine, width, aa)
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  page.on('console', m => { if (m.type() === 'error') console.log(m.text()) })
  page.on('pageerror', e => console.log(e.message))
  await page.route('**/__shore-test', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Shoreline GPU check</title>' }))
  await page.goto(`${url}/__shore-test`)
  const results = await page.evaluate(async ({ size, width, color, surface, legacy, gutter }) => {
    const T = await import('/node_modules/.vite/deps/three.js')
    const { configureEarthSurfaceMaterial, earthMaskBinding } = await import('/src/earthSurfaceMaterial.ts')
    const { surfaceState } = await import('/src/surfaceMaterial.ts')
    const renderer = new T.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true })
    renderer.outputColorSpace = T.LinearSRGBColorSpace
    const scene = new T.Scene(), camera = new T.OrthographicCamera(-1, 1, 1, -1, .1, 10)
    camera.position.set(5, 0, 0); camera.lookAt(1, 0, 0)
    const geometry = new T.PlaneGeometry(2, 2)
    geometry.setAttribute('earthColorUv', geometry.getAttribute('uv').clone())
    geometry.rotateY(Math.PI / 2); geometry.translate(1, 0, 0)
    const texture = (bytes, format = T.RGBAFormat, mips = true) => {
      const t = new T.DataTexture(new Uint8Array(bytes), width, width, format)
      t.magFilter = T.LinearFilter; t.minFilter = mips ? T.LinearMipmapLinearFilter : T.LinearFilter
      t.generateMipmaps = mips; t.unpackAlignment = 1; t.needsUpdate = true
      return t
    }
    const palette = texture(color); palette.colorSpace = T.SRGBColorSpace
    const response = texture(surface), old = texture(legacy, T.RedFormat, false)
    const binding = earthMaskBinding()
    binding.map.value = palette; binding.surface.value = response; binding.active.value = 1; binding.width.value = width
    binding.transform.value.set(size / width, -size / width, gutter / width, (gutter + size) / width)
    const state = surfaceState(); state.detail.value = 0
    const empty = new T.DataTexture(new Uint8Array([0]), 1, 1, T.RedFormat); empty.needsUpdate = true
    const material = new T.MeshStandardMaterial()
    const global = { value: empty }, globalReady = { value: 0 }
    configureEarthSurfaceMaterial(material, state, { global, globalReady, time: { value: 0 } }, 1, false, undefined, undefined, binding)
    const mode = { value: 0 }, compile = material.onBeforeCompile
    material.onBeforeCompile = (shader, r) => {
      compile.call(material, shader, r)
      shader.uniforms.legacyWater = { value: old }; shader.uniforms.legacyMode = mode
      shader.fragmentShader = 'uniform sampler2D legacyWater; uniform float legacyMode;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'gl_FragColor=vec4(vec3(legacyMode>0.5?texture2D(legacyWater,vEarthMaskUv).r:earthSample.a),1.0);')
    }
    scene.add(new T.Mesh(geometry, material))
    const images = []
    for (const resolution of [512, 32]) for (const enabled of [0, 1]) {
      renderer.setSize(resolution, resolution)
      mode.value = enabled
      renderer.render(scene, camera)
      const gl = renderer.getContext(), pixels = new Uint8Array(resolution * resolution * 4)
      gl.readPixels(0, 0, resolution, resolution, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      const rows = []
      for (let y = resolution - 1; y >= 0; y--) rows.push(Array.from({ length: resolution }, (_, x) => pixels[(y * resolution + x) * 4] / 255))
      images.push({ resolution, legacy: !!enabled, rows })
    }
    // The globe's wrapped longitude must not select a coarse mip strip at
    // the dateline. Odd viewport width deliberately puts it inside a GPU quad.
    const globeBytes = new Uint8Array(256 * 128)
    for (let y=0;y<128;y++) for(let x=0;x<256;x++) if(x<16||x>=240) globeBytes[y*256+x]=255
    const globe = new T.DataTexture(globeBytes,256,128,T.RedFormat)
    globe.wrapS=T.RepeatWrapping;globe.minFilter=T.LinearMipmapLinearFilter;globe.magFilter=T.LinearFilter;globe.generateMipmaps=true;globe.needsUpdate=true
    global.value=globe;globalReady.value=1;binding.active.value=0;mode.value=0
    geometry.translate(-2,0,0);material.side=T.DoubleSide;material.needsUpdate=true
    camera.position.set(-5,0,0);camera.lookAt(-1,0,0);renderer.setSize(257,257);renderer.render(scene,camera)
    const datelinePixels=new Uint8Array(257*257*4), gl=renderer.getContext()
    gl.readPixels(0,0,257,257,gl.RGBA,gl.UNSIGNED_BYTE,datelinePixels)
    let minimumDatelineWater=1
    for(let y=8;y<249;y++)for(let x=126;x<=130;x++)minimumDatelineWater=Math.min(minimumDatelineWater,datelinePixels[(y*257+x)*4]/255)
    images.push({ dateline: true, minimumDatelineWater, glError: gl.getError() })
    globe.dispose()
    for (const t of [palette, response, old, empty]) t.dispose()
    geometry.dispose(); material.dispose(); renderer.dispose()
    return images
  }, { size, width, color: Array.from(masks.color), surface: Array.from(masks.surface), legacy: Array.from(legacy), gutter: MASK_GUTTER })
  const report = []
  const dateline = results.find(image => image.dateline)
  assert.ok(dateline.minimumDatelineWater > .99, 'global coverage must remain continuous across the dateline mip seam')
  assert.equal(dateline.glError, 0)
  for (const image of results.filter(image => !image.dateline)) {
    let sum = 0, max = 0, n = 0, areaError = 0
    for (let y = 3; y < image.resolution - 3; y++) {
      const row = image.rows[y], expected = (intercept - slope * ((y + .5) / image.resolution * size)) / size * image.resolution - .5
      const i = row.findIndex(v => v < .5)
      if (i <= 0) continue
      const crossing = i - 1 + (row[i - 1] - .5) / Math.max(1e-8, row[i - 1] - row[i])
      const error = Math.abs(crossing - expected)
      sum += error * error; max = Math.max(max, error); n++
      for (let x = Math.max(0, Math.floor(expected) - 2); x < Math.min(image.resolution, Math.ceil(expected) + 3); x++) {
        let truth = 0
        for (let sy = 0; sy < 16; sy++) for (let sx = 0; sx < 16; sx++) {
          if ((x + (sx + .5) / 16) / image.resolution * size + slope * ((y + (sy + .5) / 16) / image.resolution * size) < intercept) truth++
        }
        areaError += Math.abs(row[x] - truth / 256)
      }
    }
    report.push({ resolution: image.resolution, legacy: image.legacy, rmsEdgePixels: Math.sqrt(sum / n), maximumEdgePixels: max, areaError })
  }
  console.log(JSON.stringify({ edges: report, dateline }, null, 2))
  await writeFile(`${output}/filter-results.json`, JSON.stringify({ edges: report, dateline }, null, 2))
  const near = report.filter(r => r.resolution === 512), far = report.filter(r => r.resolution === 32)
  assert.ok(near[0].rmsEdgePixels < near[1].rmsEdgePixels * .7, 'magnified shoreline must reduce raster stair-stepping')
  assert.ok(far[0].areaError < far[1].areaError, 'minified shoreline must preserve fractional water coverage')
} finally { await browser.close() }
