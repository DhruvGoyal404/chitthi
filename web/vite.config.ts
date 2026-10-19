import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Ports follow CLAUDE.md: web 5175, API 8082. strictPort: fail rather than drift onto a port
// another project on this machine owns.
const API = 'http://127.0.0.1:8082';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: 'localhost',
    port: 5175,
    strictPort: true,
    // The browser's Origin (http://localhost:5175) passes through unchanged, so the API's
    // Origin allow-list applies to proxied requests and WebSocket upgrades alike.
    proxy: { '/api': { target: API, ws: true } },
  },
  preview: { host: 'localhost', port: 5175, strictPort: true, proxy: { '/api': { target: API, ws: true } } },
});
