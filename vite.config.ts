import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standard build — this is what you deploy and export.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // razvoj: vite (5173) → lokalni strežnik (8090)
      '/api': 'http://localhost:8090',
    },
  },
})
