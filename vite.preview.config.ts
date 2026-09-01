import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Preview-only build: inlines JS + CSS into a single self-contained
// preview-dist/index.html publishable as one clickable artifact.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'preview-dist',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 100000000,
  },
})
