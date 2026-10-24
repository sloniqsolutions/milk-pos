import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POS_SRC = path.resolve(__dirname, '../frontend/src');
const SHIMS = path.resolve(__dirname, 'src/pos-shims');

/**
 * Reuse the POS screens, unmodified.
 *
 * The dashboard renders `frontend/src/pages/*` directly rather than
 * reimplementing them. That keeps one Reports screen instead of two that drift
 * apart, and it is what the owner already knows how to use.
 *
 * Three of the POS's modules mean something different up here, and only those
 * are replaced:
 *
 *   @/api/index          -> the cloud client (same-origin, session cookie)
 *   @/context/AuthContext -> the owner's session, no PIN and no idle lock
 *   @/lib/POSContext      -> a menu holder with no sale screen behind it
 *
 * `@/lib/SettingsContext` is reused as-is: it already falls back to its
 * defaults when the settings request fails, which is exactly right here.
 */

/**
 * Redirect the API client wherever it is imported from.
 *
 * An alias on `@/api/index` alone is not enough — several POS files import it
 * *relatively* (`../api/index`), which resolves straight to the till's own
 * client with its hardcoded `localhost:3001`. Those would quietly talk to a
 * backend that is not there. Matching on the resolved importer catches both
 * spellings, and any file added later without anyone remembering this.
 */
function cloudApiForPosScreens() {
  return {
    name: 'cloud-api-for-pos-screens',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.startsWith(POS_SRC.replace(/\\/g, '/')) &&
          !importer.startsWith(POS_SRC)) return null;
      if (!/(?:^|\/)api\/index$/.test(source) && source !== '@/api/index') return null;
      return path.join(SHIMS, 'api.js');
    },
  };
}

/**
 * Resolve npm packages imported by the POS screens from the dashboard's own
 * node_modules.
 *
 * The POS keeps its UI libraries (lucide-react, recharts, ...) in
 * devDependencies, so a production install of ../frontend leaves them out and
 * the build fails with "failed to resolve import". The dashboard already lists
 * every one it needs, so a single install here is enough and ../frontend never
 * has to be installed.
 */
function packagesFromDashboard() {
  const inPosSource = (file) => {
    const f = String(file || '').replace(/\\/g, '/');
    return f.startsWith(POS_SRC.replace(/\\/g, '/'));
  };
  return {
    name: 'packages-from-dashboard',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!inPosSource(importer)) return null;
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('@/') || source.startsWith('\0')) return null;
      return this.resolve(source, path.join(__dirname, 'src/main.jsx'), { ...options, skipSelf: true });
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [cloudApiForPosScreens(), packagesFromDashboard(), react()],
  build: { outDir: 'dist', emptyOutDir: true },
  resolve: {
    // Order matters: the specific overrides must be tried before the general
    // `@` fallback, or every import would resolve into the POS source.
    alias: [
      { find: '@/context/AuthContext', replacement: path.join(SHIMS, 'AuthContext.jsx') },
      { find: '@/lib/POSContext', replacement: path.join(SHIMS, 'POSContext.jsx') },
      { find: '@/api/index', replacement: path.join(SHIMS, 'api.js') },
      { find: '@', replacement: POS_SRC },
    ],
  },
  server: {
    port: 5174,
    // In development the two run apart, so proxy the API across.
    proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true } },
  },
});
