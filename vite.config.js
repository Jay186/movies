import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// [R7 2026-09-18] 读取后端 server/.env 的 API_TOKEN，代理转发 /api 时自动附带。
// 目的：本地零配置——用户打开即用，令牌只在 Node 侧流转、不进浏览器；
// 后端鉴权对外部直连（局域网设备、恶意网页直打 :3000）依然生效。
// 将来改登录模式（每用户独立令牌）时，此配置随开发环境一起退场即可，不产生迁移债。
function readServerApiToken() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'server', '.env'), 'utf8')
    // 只匹配未注释的 API_TOKEN=xxx 行（# 开头的注释行不会被 ^\s* 放行）
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
    // 强制 IPv4 loopback：Node 18+ 解析 localhost 时优先 ::1，导致 vite 只监听 IPv6、
    // 浏览器（IPv4）连不上而表现为"项目没启动"。固定 127.0.0.1 后双栈可访问。
    host: '127.0.0.1',
    proxy: {
      // 后端 API 代理
      // 注意：后端 app.listen 只绑定 127.0.0.1，这里必须写 127.0.0.1——
      // 写 localhost 时 Node 会优先解析成 IPv6 ::1，代理连接被拒导致 /api、/uploads 全部 500
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        // [R7] 鉴权零配置：代理层自动盖上 x-api-token。setHeader 为覆盖语义，
        // 浏览器没带/带错都会被修正为 server/.env 的正确值（自愈）；
        // 后端换令牌后重启前端（start.bat 重开）即生效。
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
      // 上传的图片静态资源
      '/uploads': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      // RunningHub API 代理，解决浏览器 CORS
      '/rh-api': {
        target: 'https://www.runninghub.cn',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rh-api/, ''),
      },
    },
  },
})
