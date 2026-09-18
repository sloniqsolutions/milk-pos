
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from "path"
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  base: './',

  build: {
  outDir: 'dist',
  emptyOutDir: true,
  // A desktop app's bundle is read off local disk on every launch, never
  // fetched over a network — the 500kB default warning is sized for a
  // website's download cost, which doesn't apply here. jspdf is already
  // its own dynamically-imported chunk (see Settings.jsx's handleSendReport);
  // the rest is React + Radix + the app itself, which V8 parses in well
  // under a second regardless. Raised rather than chased with further
  // code-splitting, which would be real risk for no real gain here.
  chunkSizeWarningLimit: 1500,
},

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
  plugins: [
    react(),
  ]
});
