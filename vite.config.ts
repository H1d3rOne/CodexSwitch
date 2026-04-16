import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, rmSync } from 'fs'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-assets',
      closeBundle() {
        const distDir = resolve(__dirname, 'dist')
        mkdirSync(distDir, { recursive: true })
        copyFileSync(
          resolve(__dirname, 'public/manifest.json'),
          resolve(distDir, 'manifest.json')
        )
        copyFileSync(
          resolve(__dirname, 'public/icon.png'),
          resolve(distDir, 'icon.png')
        )
        rmSync(resolve(distDir, 'public'), { recursive: true, force: true })
      },
    },
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
