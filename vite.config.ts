import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync } from 'node:fs'
import { cp, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'static-terrain-releases',
    configureServer(server) {
      // Generated terrain is excluded from the watcher. Serve completed files
      // directly so new immutable releases are available after publication,
      // without rescanning the public tree or restarting the dev server.
      for (const directory of ['terrain', 'hillshade']) {
        const root = resolve('public', directory)
        server.middlewares.use(`/${directory}`, async (req, res, next) => {
          try {
            const path = resolve(root, `.${decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)}`)
            if (!path.startsWith(root + sep) || !['GET', 'HEAD'].includes(req.method ?? '')) return next()
            const info = await stat(path)
            if (!info.isFile()) return next()
            res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'application/octet-stream')
            res.setHeader('Content-Length', info.size)
            if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res)
          } catch { next() }
        })
      }
    },
    async closeBundle() {
      if (mode !== 'app') return
      // Explicit lean build: retain static assets and the bounded pilot, with
      // large planetary baseline releases served separately when configured.
      const publicRoot = resolve('public'), terrainRoot = resolve('public/terrain'), hillshadeRoot = resolve('public/hillshade')
      await cp(publicRoot, resolve('dist'), { recursive: true, filter: path => path !== terrainRoot && path !== hillshadeRoot })
      if (existsSync(resolve(terrainRoot, 'pilot'))) await cp(resolve(terrainRoot, 'pilot'), resolve('dist/terrain/pilot'), { recursive: true })
    },
  }],
  build: { copyPublicDir: mode !== 'app' },
  server: { watch: { ignored: ['**/.terrain-cache/**', '**/.terrain-venv/**', '**/public/terrain/**', '**/public/hillshade/**'] } },
}))
