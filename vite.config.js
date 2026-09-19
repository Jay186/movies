import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function readServerApiToken() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'server', '.env'), 'utf8')
    const m = txt.match(/^\s*API_TOKEN\s*=\s*(\S+)\s*$/m)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}
const API_TOKEN = readServerApiToken()

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        ...(API_TOKEN
          ? {
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => {
                  proxyReq.setHeader('x-api-token', API_TOKEN)
                })
              },
            }
          : {}),
      },
      '/uploads': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/rh-api': {
        target: 'https://www.runninghub.cn',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rh-api/, ''),
      },
    },
  },
})
