import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: false,
    manifest: false,
    rollupOptions: {
      input: {
        main: 'index.html'
      }
    }
  }
})
