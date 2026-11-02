import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const output = resolve('.terrain-cache/moon-vectors/soft-boundaries')
const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5173'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__softScene=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.date('2026-10-26T12:00:00Z')
    terrainPilot.location('moon',26.13,3.63,12000)
    terrainPilot.metrics()
  })
  await page.getByRole('button', { name: 'Surface detail on', exact: true }).click()
  await page.getByRole('button', { name: 'Shadows on', exact: true }).click()
  await page.getByLabel('Moon color', { exact: true }).selectOption('10-smooth')
  await page.waitForFunction(() => __softScene.moonColorMode === '10-smooth', null, { timeout: 60000 })
  const point = await page.evaluate(() => __softScene.moonVectorColor.previewPoint())
  const visit = async altitude => {
    await page.evaluate(({point,altitude}) => terrainPilot.location('moon',point.lat,point.lon,altitude), {point,altitude})
    await page.waitForFunction(() => __softScene.surfaces.moon.vectorColorSoftReady.value === 1, null, { timeout: 60000 })
    await page.waitForTimeout(1600)
  }
  const compare = () => page.evaluate(() => {
    const s = __softScene, state = s.surfaces.moon, gl = s.renderer.getContext()
    const read = () => {
      s.renderer.render(s.scene,s.camera)
      const p = new Uint8Array(512*512*4)
      gl.readPixels(Math.floor(gl.drawingBufferWidth/2)-256,Math.floor(gl.drawingBufferHeight/2)-256,512,512,gl.RGBA,gl.UNSIGNED_BYTE,p)
      return p
    }
    state.vectorColorSoftReady.value = 0; const sharp = read()
    state.vectorColorSoftReady.value = 1; const soft = read()
    const gradient = pixels => {
      let max = 0
      for (let y=1;y<511;y++) for (let x=1;x<511;x++) {
        const i=(y*512+x)*4
        for (const neighbor of [i+4,i+512*4]) {
          const difference = Math.abs(pixels[i]-pixels[neighbor])+Math.abs(pixels[i+1]-pixels[neighbor+1])+Math.abs(pixels[i+2]-pixels[neighbor+2])
          max=Math.max(max,difference/3)
        }
      }
      return max
    }
    return { difference: sharp.reduce((sum,v,i)=>sum+Math.abs(v-soft[i]),0)/sharp.length,
      sharpGradient: gradient(sharp), softGradient: gradient(soft), metrics: s.moonVectorColor.metrics() }
  })
  await visit(1000)
  report.near = await compare()
  assert.ok(report.near.difference > .05, 'Near softening did not affect GPU pixels')
  assert.ok(report.near.softGradient < report.near.sharpGradient, 'Near boundary remains sharp')
  assert.ok(report.near.metrics.patchBytes < 12*1048576)
  await page.screenshot({ path: resolve(output,'ground-soft.png') })
  await page.evaluate(() => { __softScene.surfaces.moon.vectorColorSoftReady.value=0 })
  await page.screenshot({ path: resolve(output,'ground-sharp.png') })
  await page.evaluate(() => { __softScene.surfaces.moon.vectorColorSoftReady.value=1; __softScene.pilotAltitude=null })
  const builds = await page.evaluate(() => __softScene.moonVectorColor.metrics().builds)
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => __softScene.moonVectorColor.metrics().builds), builds)
  await visit(60000)
  report.orbit = await compare()
  assert.equal(report.orbit.difference,0,'Distant view must retain its crisp colors')
  await page.screenshot({ path: resolve(output,'orbit.png') })
  await visit(1000)
  await page.evaluate(() => {
    window.__softDisposed=false
    __softScene.moonVectorColor.softPatch.addEventListener('dispose',()=>{ window.__softDisposed=true })
  })
  await page.getByLabel('Moon color', { exact: true }).selectOption('10-diagonal')
  await page.waitForFunction(() => __softScene.moonColorMode==='10-diagonal', null, { timeout: 60000 })
  assert.equal(await page.evaluate(() => window.__softDisposed && __softScene.surfaces.moon.vectorColorSoftMap.value===null),true)
  await page.setViewportSize({width:390,height:844})
  await page.getByLabel('Moon color', { exact: true }).selectOption('10-smooth')
  await page.waitForFunction(() => __softScene.moonColorMode==='10-smooth',null,{timeout:60000})
  await visit(1000)
  await page.screenshot({path:resolve(output,'phone.png')})

  // Independent straight boundary in known colors: measure the physical
  // 10–90% transition at several zooms, then compare the same ground samples
  // after moving the window. The unused black palette entry catches bad halos.
  await page.route('**/moon-vectors/10-smooth/manifest.json',route=>route.fulfill({json:{
    schema:1,variant:'10-smooth',width:16,height:8,tileSize:16,
    palette:['#000000','#b4b4b4','#dcdcdc',...Array(7).fill('#000000')],
    tiles:[{x:0,y:0,file:'fixture.json'}],
  }}))
  await page.route('**/moon-vectors/10-smooth/fixture.json',route=>route.fulfill({json:{
    paths:['','M0,0L8,0L8,8L0,8Z','M8,0L16,0L16,8L8,8Z',...Array(7).fill('')],
  }}))
  report.physical = await page.evaluate(async () => {
    const {MoonVectorColor}=await import('/src/MoonVectorColor.ts')
    const {surfaceState}=await import('/src/surfaceMaterial.ts')
    const source=new MoonVectorColor(), state=surfaceState(), R=1737400
    source.replace(await source.load('10-smooth'))
    const body=__softScene.bodies.get('moon').clone(false)
    body.position.set(0,0,0);body.quaternion.identity();body.updateMatrixWorld(true)
    const radius=body.geometry.parameters.radius, camera=__softScene.camera.clone()
    camera.aspect=1;camera.updateProjectionMatrix()
    let time=performance.now()
    const view=(altitude,shift=0,longitude=0)=>{
      const lon=longitude*Math.PI/180+shift/R, distance=radius*(1+altitude/R)
      camera.position.set(distance*Math.cos(lon),0,-distance*Math.sin(lon))
      camera.lookAt(0,0,0);camera.updateMatrixWorld(true)
      source.updateView(camera,body,state,true,()=>null,time+=1000)
      const canvas=state.vectorColorSoftMap.value.image, b=state.vectorColorBounds.value
      const row=canvas.getContext('2d').getImageData(0,Math.floor(canvas.height/2),canvas.width,1).data
      const values=Array.from({length:canvas.width},(_,i)=>row[i*4])
      const meters=(b.z-b.x)*Math.PI/180*R
      const crossing=target=>{
        for(let i=1;i<values.length;i++)if(values[i]>=target&&values[i-1]<target)
          return (i-1+(target-values[i-1])/(values[i]-values[i-1]))*meters/canvas.width
        return null
      }
      const color=groundMeters=>{
        const lon=groundMeters/R*180/Math.PI
        const x=(lon-b.x)/(b.z-b.x)*canvas.width-.5
        const lo=Math.max(0,Math.min(canvas.width-2,Math.floor(x))), t=x-lo
        return values[lo]*(1-t)+values[lo+1]*t
      }
      const a=crossing(184), c=crossing(216)
      return {width:a===null||c===null?null:c-a, samples:[-100,0,100].map(color),
        min:Math.min(...values),max:Math.max(...values),center:values[Math.floor(values.length/2)]}
    }
    const zooms=[500,1000,2000].map(altitude=>({altitude,...view(altitude)}))
    const centered=view(1000),panned=view(1000,650),dateline=view(1000,0,180)
    source.dispose()
    return {zooms,centered,panned,dateline,clean:state.vectorColorMap.value===null&&state.vectorColorSoftMap.value===null}
  })
  for (const zoom of report.physical.zooms) {
    assert.ok(zoom.width>280&&zoom.width<340,`Wrong physical transition width: ${JSON.stringify(zoom)}`)
    assert.ok(zoom.min>=179&&zoom.max<=221,'Blur introduced a dark/bright fringe')
  }
  report.physical.centered.samples.forEach((v,i)=>assert.ok(Math.abs(v-report.physical.panned.samples[i])<1.5,'Mixture moved with the window'))
  assert.ok(report.physical.dateline.center>=198&&report.physical.dateline.center<=202,'Dateline halo did not wrap neighboring colors')
  assert.equal(report.physical.clean,true)
  assert.deepEqual(report.errors,[])
  report.completed=true
  console.log('Ground softness, crisp distant rendering, fixed metric width, moving-window halo, dateline, cleanup, and phone passed')
} finally {
  await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2))
  await browser.close()
}
