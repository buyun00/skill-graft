import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 18766,
    proxy: {
      '/api': 'http://127.0.0.1:18765'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
