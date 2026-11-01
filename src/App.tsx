import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ChevronDown, Clock3, Compass, Focus, Info, Layers3, Pause, Play, RotateCcw, Search, X } from 'lucide-react'
import { ExplorerScene, type ScreenMarker } from './ExplorerScene'
import { bodyInfo, bodyOrder, positionAt, type BodyId } from './ephemeris'
import { textureSources } from './textureSources'
import { surfaceTileSources, type TileBody } from './surfaceTiles'
import type { TerrainStatus } from './GlobeTerrainLayer'
import { isTerrainBody, type TerrainBody } from './terrain'
import type { RegionalMetrics } from './RegionalTerrainLayer'
import { earthColorSource } from './earthImagery'
import { pilotLocations } from './terrainPilot'

const AU_KM = 149_597_870.7
const DAY_MS = 86_400_000
const speedOptions = [0.1, 1, 10, 100]

function distanceLabel(id: BodyId, date: Date): string {
  if (id === 'sun') return 'CENTER OF THE SOLAR SYSTEM'
  const p = positionAt(id, date)
  const earth = positionAt('earth', date)
  const d = id === 'moon'
    ? Math.hypot(p.x - earth.x, p.y - earth.y, p.z - earth.z) * AU_KM
    : Math.hypot(p.x, p.y, p.z)
  return id === 'moon' ? `${Math.round(d).toLocaleString()} km FROM EARTH` : `${d.toFixed(3)} AU FROM SUN`
}

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const markerLayerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<ExplorerScene | null>(null)
  const markerRefs = useRef({} as Record<BodyId, HTMLButtonElement | null>)
  const dateRef = useRef(new Date())
  const [date, setDate] = useState(dateRef.current)
  const [selected, setSelected] = useState<BodyId>('sun')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [terrainShadows, setTerrainShadows] = useState(true)
  const [showOrbits, setShowOrbits] = useState(true)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [regionalStatuses, setRegionalStatuses] = useState<Partial<Record<'earth' | 'moon', RegionalMetrics>>>({})
  const regionalStatus = regionalStatuses[selected as 'earth' | 'moon']
  const [surfaceDetail, setSurfaceDetail] = useState(true)
  const [terrainEnabled, setTerrainEnabled] = useState(true)
  const [terrainExaggeration, setTerrainExaggeration] = useState(1)
  const [terrainStatuses, setTerrainStatuses] = useState<Partial<Record<TerrainBody, TerrainStatus>>>({})
  const terrainStatus: TerrainStatus = terrainStatuses[selected as TerrainBody] ?? { body: isTerrainBody(selected) ? selected : 'moon', state: 'loading', loadedTiles: 0, failedTiles: 0 }
  const selectedInfo = bodyInfo[selected]
  const results = useMemo(() => bodyOrder.filter(id => bodyInfo[id].name.toLowerCase().includes(query.toLowerCase())), [query])

  useEffect(() => {
    if (!canvasRef.current) return
    const explorer = new ExplorerScene(canvasRef.current, (markers: ScreenMarker[]) => {
      for (const marker of markers) {
        const element = markerRefs.current[marker.id]
        if (!element) continue
        element.style.visibility = marker.visible ? 'visible' : 'hidden'
        if (marker.visible) element.style.transform = `translate3d(${marker.x - 12}px, ${marker.y - 12}px, 0)`
      }
    }, status => setTerrainStatuses(previous => ({ ...previous, [status.body]: status })),
      (id, metrics) => setRegionalStatuses(previous => ({ ...previous, [id]: metrics })))
    explorer.setDate(dateRef.current)
    sceneRef.current = explorer
    // Explicitly opt-in diagnostic bridge for repeatable pilot browser tests.
    if (new URLSearchParams(location.search).has('terrainPilot')) {
      Object.assign(window, { terrainPilot: { location: (body: 'earth' | 'moon', lat: number, lon: number, altitude?: number) => { explorer.surfaceLocation(body, lat, lon, altitude); setSelected(body) }, point: (lat: number, lon: number, altitude?: number) => { explorer.surfaceLocation('earth', lat, lon, altitude); setSelected('earth') }, visit: (id: string, altitude?: number) => { explorer.pilot(id, altitude); const p = pilotLocations.find(p => p.id === id); if (p) setSelected(p.body) },
        sample: () => explorer.pilotImageSample(), metrics: () => explorer.pilotMetrics(), date: (iso: string) => { const next = new Date(iso); if (!Number.isNaN(next.getTime())) { explorer.setDate(next); dateRef.current = next; setDate(next) } }, detail: (enabled: boolean) => { explorer.setSurfaceDetail(enabled); setSurfaceDetail(enabled) } } })
    }
    const markerLayer = markerLayerRef.current
    const forwardWheel = (event: WheelEvent) => {
      event.preventDefault()
      explorer.renderer.domElement.dispatchEvent(new WheelEvent('wheel', {
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        cancelable: true,
      }))
    }
    markerLayer?.addEventListener('wheel', forwardWheel, { passive: false })
    return () => { markerLayer?.removeEventListener('wheel', forwardWheel); explorer.dispose(); sceneRef.current = null; if ('terrainPilot' in window) delete (window as unknown as Record<string, unknown>).terrainPilot }
  }, [])

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      const elapsed = Math.min((now - last) / 1000, 1)
      last = now
      const next = new Date(dateRef.current.getTime() + elapsed * speed * DAY_MS)
      if (next.getUTCFullYear() > 2049) { setPlaying(false); return }
      dateRef.current = next
      setDate(next)
      sceneRef.current?.setDate(next)
    }, 100)
    return () => window.clearInterval(timer)
  }, [playing, speed])

  function choose(id: BodyId) {
    setSelected(id)
    setInfoOpen(true)
    setSearchOpen(false)
    setQuery('')
    setSidebarOpen(false)
    sceneRef.current?.focus(id)
  }

  function updateDate(next: Date) {
    if (Number.isNaN(next.getTime())) return
    dateRef.current = next
    setDate(next)
    sceneRef.current?.setDate(next)
  }

  function resetNow() { setPlaying(false); updateDate(new Date()) }

  return (
    <main className="app">
      <div className="scene" ref={canvasRef} />
      <div className="scene-vignette" />

      <header className="topbar">
        <div className="brand" onClick={() => { sceneRef.current?.overview(); setSelected('sun') }} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') { sceneRef.current?.overview(); setSelected('sun') } }}>
          <span className="brand-mark"><span /></span>
          <span><strong>ORRERY</strong><small>SOLAR SYSTEM EXPLORER</small></span>
        </div>
        <div className="topbar-actions">
          <span className="prototype-pill"><span /> INTERACTIVE PROTOTYPE</span>
          <button className="icon-button mobile-menu" aria-label="Open explorer" onClick={() => setSidebarOpen(!sidebarOpen)}><Layers3 size={19} /></button>
        </div>
      </header>

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-heading"><span>EXPLORE</span><button className="icon-button mobile-close" aria-label="Close explorer" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <div className="search-wrap">
          <Search size={18} />
          <input aria-label="Search celestial bodies" placeholder="Search celestial bodies..." value={query} onFocus={() => setSearchOpen(true)} onChange={e => { setQuery(e.target.value); setSearchOpen(true) }} onKeyDown={e => { if (e.key === 'Enter' && results[0]) choose(results[0]); if (e.key === 'Escape') setSearchOpen(false) }} />
          {query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={15} /></button>}
        </div>
        {searchOpen && query && <div className="search-results">{results.length ? results.map(id => <button key={id} onClick={() => choose(id)}><span className="body-dot" style={{ background: bodyInfo[id].color }} />{bodyInfo[id].name}<small>{bodyInfo[id].kind}</small></button>) : <div className="no-results">No matching body</div>}</div>}
        <div className="nav-section-title">OUR SOLAR SYSTEM <span>10 OBJECTS</span></div>
        <div className="body-list">
          {bodyOrder.map(id => <button key={id} className={`body-row ${selected === id ? 'active' : ''} ${id === 'moon' ? 'moon-row' : ''}`} onClick={() => choose(id)}>
            <span className={`body-icon icon-${id}`} style={{ '--body-color': bodyInfo[id].color } as React.CSSProperties} />
            <span>{bodyInfo[id].name}<small>{id === 'sun' ? 'STAR' : id === 'moon' ? 'EARTH’S MOON' : bodyInfo[id].kind}</small></span>
            {selected === id && <span className="row-active-mark" />}
          </button>)}
        </div>
        <div className="sidebar-bottom"><span className="tiny-orbit" /> <span>Left drag to orbit <b>·</b> Right drag to turn / tilt nearby <b>·</b> Scroll to zoom</span></div>
      </aside>

      <div className="marker-layer" ref={markerLayerRef}>
        {bodyOrder.map(id => <button key={id} ref={element => { markerRefs.current[id] = element }} className={`marker ${selected === id ? 'selected' : ''} marker-${id}`} onClick={() => choose(id)} aria-label={`Focus ${bodyInfo[id].name}`}>
          <span className="marker-point" style={{ '--body-color': bodyInfo[id].color } as CSSProperties} />
          <span className="marker-label">{bodyInfo[id].name}</span>
        </button>)}
      </div>

      {selected === 'sun' && <div className="scene-caption"><span className="eyebrow">THE COSMOS, AT YOUR FINGERTIPS</span><h1>Explore our<br /><em>Solar System.</em></h1><p>Travel through space and time. Discover the worlds that orbit our Sun.</p></div>}

      <div className="view-controls">
        <button title="Solar System overview" onClick={() => { sceneRef.current?.overview(); setSelected('sun'); setInfoOpen(true) }}><Compass size={18} /> <span>Overview</span></button>
        <button title="Toggle orbit paths" className={showOrbits ? 'control-on' : ''} onClick={() => { sceneRef.current?.setOrbits(!showOrbits); setShowOrbits(!showOrbits) }}><Layers3 size={18} /> <span>Orbits</span></button>
      </div>

      {infoOpen && <section className="info-card">
        <div className="info-top"><span className="eyebrow">CURRENTLY EXPLORING</span><button className="icon-button" aria-label="Close information panel" onClick={() => setInfoOpen(false)}><X size={17} /></button></div>
        <div className="info-title"><span className={`info-planet icon-${selected}`} style={{ '--body-color': selectedInfo.color } as React.CSSProperties} /><div><h2>{selectedInfo.name}</h2><span>{selectedInfo.kind}</span></div></div>
        <p>{selectedInfo.description}</p>
        <div className="info-stat"><span>MEAN RADIUS</span><strong>{Math.round(selectedInfo.radiusKm).toLocaleString()} km</strong></div>
        <div className="info-stat"><span>POSITION</span><strong>{distanceLabel(selected, date)}</strong></div>
        {selected !== 'sun' && <div className="surface-source">Rotation: <a href={selected === 'earth' ? 'https://aa.usno.navy.mil/faq/GAST' : 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc'} target="_blank" rel="noreferrer">{selected === 'earth' ? 'USNO sidereal time' : 'JPL NAIF planetary constants'}</a> · approximate</div>}
        {textureSources[selected] && <div className="surface-source">Surface: <a href={textureSources[selected]!.page} target="_blank" rel="noreferrer">{textureSources[selected]!.label}</a> · {textureSources[selected]!.credit}</div>}
        {selected !== 'earth' && selected !== 'moon' && selected in surfaceTileSources && <div className="surface-source">Detail: <a href={surfaceTileSources[selected as TileBody].page} target="_blank" rel="noreferrer">{surfaceTileSources[selected as TileBody].label}</a> · {surfaceTileSources[selected as TileBody].credit}</div>}
        {(selected === 'earth' || selected === 'moon') && <div className="terrain-controls">
          <div className="surface-source">Explore measured terrain</div>
          <div role="status" className="surface-source">{!terrainEnabled ? 'Terrain off' : regionalStatus?.ready ? 'Measured terrain' : regionalStatus?.failed ? 'Regional detail unavailable · showing fallback' : regionalStatus?.requests ? 'Loading regional relief…' : selected === 'earth' ? 'Terrain loads as you explore' : terrainStatus.state === 'ready' ? 'Global LOLA terrain' : terrainStatus.state === 'unavailable' ? 'Lunar terrain unavailable · showing globe' : 'Loading global lunar terrain…'}</div>
          <div className="terrain-options pilot-places">{pilotLocations.filter(p => p.body === selected).map(p => <button key={p.id} onClick={() => sceneRef.current?.pilot(p.id)}>{p.name}</button>)}</div>
          {selected === 'moon' && <div className="terrain-options"><button aria-pressed={surfaceDetail} onClick={() => { sceneRef.current?.setSurfaceDetail(!surfaceDetail); setSurfaceDetail(!surfaceDetail) }}>Surface detail {surfaceDetail ? 'on' : 'off'}</button></div>}
          {selected === 'moon' && surfaceDetail && <div className="surface-source">Fine surface detail uses generated normal and roughness textures.</div>}
          {selected === 'moon' && <div className="surface-source">The lunar surface uses smooth-shaded measured terrain.</div>}
          {selected === 'earth' && <div className="surface-source">Color: <a href={earthColorSource.page} target="_blank" rel="noreferrer">{earthColorSource.label}</a> · {regionalStatus?.imagery?.ready ? 'streamed imagery' : 'globe fallback'} · © ESA WorldCover / modified Copernicus Sentinel data 2021</div>}
          {selected === 'earth' && <div className="surface-source">Elevation: <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">© Mapterhorn</a> · streamed terrain</div>}
        </div>}
        {(isTerrainBody(selected) || selected === 'earth') && <div className="terrain-controls">
          <div className="terrain-options">
            <button aria-pressed={terrainEnabled} onClick={() => { sceneRef.current?.setTerrain(!terrainEnabled); setTerrainEnabled(!terrainEnabled) }}>Terrain {terrainEnabled ? 'on' : 'off'}</button>
            {(selected === 'earth' || selected === 'moon') && <button aria-pressed={terrainShadows} disabled={!terrainEnabled} onClick={() => { sceneRef.current?.setTerrainShadows(!terrainShadows); setTerrainShadows(!terrainShadows) }}>Shadows {terrainShadows ? 'on' : 'off'}</button>}
            <label>Relief <select aria-label="Terrain relief" value={terrainExaggeration} disabled={!terrainEnabled} onChange={e => { const value = Number(e.target.value); sceneRef.current?.setTerrainExaggeration(value); setTerrainExaggeration(value) }}><option value={1}>True scale</option><option value={4}>4× exaggerated</option></select></label>
          </div>
          {selected !== 'earth' && !regionalStatus?.ready && <div role="status" className="surface-source">{terrainStatus.state === 'ready' ? (terrainStatus.failedTiles ? 'Terrain on · some detail unavailable' : `Measured relief · ${terrainStatus.source && terrainStatus.source.resolution < 1000 ? `${Math.round(terrainStatus.source.resolution)} m` : `${((terrainStatus.source?.resolution ?? 0) / 1000).toFixed(1)} km`} source grid`) : terrainStatus.state === 'unavailable' ? 'Terrain unavailable · showing imagery' : terrainStatus.state === 'off' ? 'Terrain off · showing imagery' : terrainStatus.failedTiles ? 'Terrain unavailable · retrying' : 'Loading terrain…'}</div>}
          {terrainStatus.source && !regionalStatus?.ready && <div className="surface-source">Elevation: <a href={terrainStatus.source.url} target="_blank" rel="noreferrer">{terrainStatus.source.credit}</a></div>}
          {terrainStatus.source?.gaps && <div className="surface-source">Gray terrain marks gaps in elevation coverage.</div>}
          {terrainStatus.source?.approximate && <div className="surface-source">Heights above the Martian areoid, shown on a mean-radius sphere.</div>}
        </div>}
        <div className="info-actions"><button onClick={() => sceneRef.current?.focus(selected)}><Focus size={16} /> Focus view</button>{selected !== 'sun' && <button className="quiet" onClick={() => { const parent: BodyId = selected === 'moon' ? 'earth' : 'sun'; choose(parent) }}><ArrowLeft size={16} /> {selected === 'moon' ? 'Earth' : 'Sun'}</button>}</div>
      </section>}
      {!infoOpen && <button className="reopen-info" onClick={() => setInfoOpen(true)}><Info size={17} /> Show details</button>}

      <footer className="timeline">
        <div className="timeline-label"><Clock3 size={17} /><span>TIME TRAVEL</span><span className="approx-note">POSITIONS ARE APPROXIMATE</span></div>
        <div className="timeline-main">
          <button className="play-button" aria-label={playing ? 'Pause time' : 'Play time'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
          <div className="date-readout"><strong>{new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)}</strong><small>{date.toISOString().slice(11, 16)} UTC</small></div>
          <input className="date-input" aria-label="Set simulation date" type="date" min="1900-01-01" max="2049-12-31" value={date.toISOString().slice(0, 10)} onChange={e => updateDate(new Date(`${e.target.value}T12:00:00Z`))} />
          <div className="timeline-divider" />
          <label className="speed-select">SPEED <select aria-label="Simulation speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{speedOptions.map(value => <option key={value} value={value}>{value} day{value === 1 ? '' : 's'}/sec</option>)}</select><ChevronDown size={14} /></label>
          <button className="now-button" onClick={resetNow}><RotateCcw size={15} /> Now</button>
        </div>
        <div className="timeline-source">Planet positions: <a href="https://ssd.jpl.nasa.gov/planets/approx_pos.html" target="_blank" rel="noreferrer">JPL approximate elements</a> (1800–2050) · Moon: simplified orbit model · Sizes and distances use physical scale</div>
      </footer>
    </main>
  )
}
