import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Ports follow CLAUDE.md: web 5175, API 8082. strictPort: fail rather than drift onto a port
// another project on this machine owns.
const API = 'http://127.0.0.1:8082';

/**
 * The page's Content-Security-Policy, as a <meta> tag in the production build only (the dev
 * server needs inline scripts for hot reload). Everything is same-origin except avatars, which
 * come from the sign-in provider over https. A meta CSP can't carry frame-ancestors; the server
 * in front (Caddy) adds that, with the same policy, as a header (Phase 7).
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: only for previews of the user's own files before they are sent.
  "img-src 'self' https: data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'chitthi-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: WEB_CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cspMeta()],
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
