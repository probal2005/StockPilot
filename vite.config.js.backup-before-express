import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Worker API runs separately under `wrangler dev` on 8787; the Vite dev
// server proxies /api so the preview origin serves the whole app.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    // An explicit list keeps the dev server locked to named hosts. The preview
    // hostname for this workspace is appended from
    // __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS when the server is started, so no
    // machine-specific host is ever written into the repo.
    allowedHosts: [],
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
})
