import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync } from 'node:fs'
import { cp, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'bounded-terrain-pilot',
    configureServer(server) {
      // Generated terrain is intentionally excluded from the watcher. Serve the
      // small pilot directly so preparing it after startup does not require a
      // million-file public-directory rescan or a dev-server restart.
      const root = resolve('public/terrain/pilot')
      server.middlewares.use('/terrain/pilot', async (req, res, next) => {
        try {
          const path = resolve(root, `.${decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)}`)
          if (!path.startsWith(root + sep) || !['GET', 'HEAD'].includes(req.method ?? '')) return next()
          const info = await stat(path)
          if (!info.isFile()) return next()
          res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'application/octet-stream')
          res.setHeader('Content-Length', info.size)
          if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res)
        } catch { next() }
      })
    },
    async closeBundle() {
      if (mode !== 'app') return
      // Explicit lean build: retain static assets and the bounded pilot, with
      // large planetary baseline releases served separately when configured.
      const publicRoot = resolve('public'), terrainRoot = resolve('public/terrain')
      await cp(publicRoot, resolve('dist'), { recursive: true, filter: path => path !== terrainRoot })
      if (existsSync(resolve(terrainRoot, 'pilot'))) await cp(resolve(terrainRoot, 'pilot'), resolve('dist/terrain/pilot'), { recursive: true })
    },
  }],
  build: { copyPublicDir: mode !== 'app' },
  server: { watch: { ignored: ['**/.terrain-cache/**', '**/.terrain-venv/**', '**/public/terrain/**'] } },
}))
