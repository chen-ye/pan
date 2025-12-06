import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const iconsPath = 'node_modules/@shoelace-style/shoelace/dist/assets/icons';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /\/assets\/icons\/(.+)/,
        replacement: `${iconsPath}/$1`,
      },
    ],
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@shoelace-style/shoelace/dist/assets',
          dest: 'shoelace'
        }
      ]
    }),
  ],
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
  },
  server: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://app:8000',
        changeOrigin: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err: any, _req, _res) => {
            if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.message?.includes('AbortError')) return;
            console.log('proxy error', err);
          });
        }
      },
      '/videos': {
        target: 'http://app:8000',
        changeOrigin: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('proxy error', err);
          });
        }
      }
    }
  }
})
