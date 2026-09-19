import path from 'node:path'
import fs from 'node:fs'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { query } from '../db.js'
import { config } from '../config.js'

export function allowHosts() {
  return config.security?.downloadAllowHosts || []
}

export function bareUrl(u) {
  return String(u || '').split('?')[0].trim()
}

export function clean(s) {
  return String(s || '')
    .replace(/@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function cleanDesc(s) {
  return clean(s).replace(/[。.]+$/, '')
}

export function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''
}

export const CJK_DIRTY_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\ufe30-\ufe4f\ufe10-\ufe19\u2e80-\u2eff\u2f00-\u2fdf\u31c0-\u31ef\uff00-\uffef]/

export function pickEnglish(s) {
  const v = clean(s)
  return v && !CJK_DIRTY_RE.test(v) ? v : ''
}

const RESIDUAL_CJK_RE = new RegExp(CJK_DIRTY_RE.source + '+', 'g')

export function stripResidualCjk(s) {
  const v = clean(s)
  if (!v) return ''
  return v
    .replace(RESIDUAL_CJK_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

const ASCII_LETTER_RE = /[A-Za-z]/

export function pickInjectableEnglish(s) {
  const v = stripResidualCjk(s)
  return v && ASCII_LETTER_RE.test(v) ? v : ''
}

export function resolveAssetName(nameEn, nameCn) {
  return pickEnglish(nameEn) || stripResidualCjk(nameEn) || pickEnglish(nameCn)
}

export function resolveDesc(descEn, descCn) {
  return lowerFirst(cleanDesc(pickEnglish(descEn) || pickEnglish(descCn)))
}

export function normalizeTone(t) {
  const v = clean(t)
  if (!v) return ''
  if (/^(in|with|through|at|while)\b/i.test(v)) return v
  if (/ly$/i.test(v)) return v
  return `in a ${v.replace(/\s+tone$/i, '')} tone`
}

const ARTICLE_REPEAT_PAIRS = [
  [/\b(the)\s+the\b/gi, 'the'],
  [/\b(a)\s+a\b/gi, 'a'],
  [/\b(an)\s+an\b/gi, 'an'],
]

export function dedupeArticles(s) {
  let out = String(s || '')
  let prev = ''
  while (prev !== out) {
    prev = out
    for (const [re, rep] of ARTICLE_REPEAT_PAIRS) out = out.replace(re, rep)
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function truncateStyle(s, max = 300) {
  const v = clean(s)
  if (v.length <= max) return v
  const cut = v.slice(0, max)
  const i = cut.lastIndexOf(' ')
  return i >= max * 0.5 ? cut.slice(0, i) : cut
}

export function formatCutTimestamp(sec) {
  const t = Math.max(0, Math.round(Number(sec) * 1000))
  const total = Math.floor(t / 1000)
  const mmm = String(t % 1000).padStart(3, '0')
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}.${mmm}`
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const AUDIO_MIME_MAP = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
  wma: 'audio/x-ms-wma', amr: 'audio/amr', mpeg: 'audio/mpeg',
}

export function mimeFromExt(filename) {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase()
  if (AUDIO_MIME_MAP[ext]) return AUDIO_MIME_MAP[ext]
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

export function netErrMsg(e) {
  const cause = e?.cause?.code || e?.cause?.message
  return cause ? `${e.message} (${cause})` : e?.message
}

export function removeLocalUploads(urls, uploadDir) {
  const root = path.resolve(uploadDir)
  for (const u of urls || []) {
    if (!u || !String(u).startsWith('/uploads/')) continue
    try {
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
      const abs = path.resolve(root, rel)
      if (abs !== root && !abs.startsWith(root + path.sep)) continue
      fs.rmSync(abs, { force: true })
    } catch {  }
  }
}

export function uploadsUrlToAbs(url, uploadDir) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return null
  try {
    const root = path.resolve(uploadDir)
    const rel = decodeURIComponent(String(url).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
    if (!rel) return null
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) return null
    return fs.existsSync(abs) ? abs : null
  } catch {
    return null 
  }
}

const UPLOAD_REF_SQL = [
  'SELECT image_url AS u FROM characters UNION ALL SELECT audio_url AS u FROM characters',
  'SELECT image_url AS u FROM project_characters UNION ALL SELECT audio_url AS u FROM project_characters',
  'SELECT image_url AS u FROM ip_characters UNION ALL SELECT audio_url AS u FROM ip_characters',
  'SELECT image_url AS u FROM props',
  'SELECT image_url AS u FROM scenes',
  `SELECT storyboard_url AS u FROM shots UNION ALL SELECT frame_url AS u FROM shots
   UNION ALL SELECT frame_url2 AS u FROM shots UNION ALL SELECT blocking_url AS u FROM shots
   UNION ALL SELECT video_url AS u FROM shots UNION ALL SELECT continuity_url AS u FROM shots`,
  'SELECT grid_image_url AS u FROM storyboard_scenes',
  'SELECT cover_url AS u FROM library_assets',
]

export function filterUnreferencedUploadUrls(urls) {
  const candidates = [...new Set((urls || []).map(String).filter((u) => u.startsWith('/uploads/')))]
  if (!candidates.length) return []
  const referenced = new Set()
  for (const sql of UPLOAD_REF_SQL) {
    try {
      for (const row of query(sql)) { if (row.u) referenced.add(row.u) }
    } catch {  }
  }
  return candidates.filter((u) => !referenced.has(u))
}


function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0) return true                              
  if (a === 10) return true                             
  if (a === 127) return true                            
  if (a === 169 && b === 254) return true               
  if (a === 172 && b >= 16 && b <= 31) return true      
  if (a === 192 && b === 168) return true               
  if (a === 192 && b === 0 && p[2] === 0) return true   
  if (a === 100 && b >= 64 && b <= 127) return true     
  if (a === 198 && (b === 18 || b === 19)) return true  
  if (a >= 224) return true                             
  return false
}

function hexGroupsToIPv4(rest) {
  const gs = String(rest).split(':').filter(Boolean)
  if (gs.length < 2) return ''
  const hi = parseInt(gs[gs.length - 2], 16)
  const lo = parseInt(gs[gs.length - 1], 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || lo < 0) return ''
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
}

function isPrivateIPv6(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return true            
  if (s.startsWith('fe80')) return true                 
  if (s.startsWith('fec0')) return true                 
  if (/^f[cd]/.test(s)) return true                     
  if (s.startsWith('ff')) return true                   

  const mapped = s.match(/^::ffff:(.+)$/) || s.match(/^::(?!1$|ffff:)(.+)$/)
  if (mapped) {
    const rest = mapped[1]
    const v4 = rest.includes('.') ? rest : hexGroupsToIPv4(rest)
    if (!v4 || isIP(v4) !== 4) return true
    return isPrivateIPv4(v4)
  }
  return false
}

export async function assertSafeDownloadTarget(rawUrl, allowHosts = []) {
  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    throw new Error(`下载地址不是合法 URL：${String(rawUrl).slice(0, 120)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`下载地址协议不受支持（仅允许 http/https）：${u.protocol}`)
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (allowHosts.some((h) => host === h || host.endsWith('.' + h))) return

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/.test(host)) {
    throw new Error(`下载地址指向本机/内网主机名，已拒绝（SSRF 防护）：${host}`)
  }

  const ipVer = isIP(host)
  if (ipVer === 4) {
    if (isPrivateIPv4(host)) throw new Error(`下载地址指向内网/保留 IP，已拒绝（SSRF 防护）：${host}`)
    return
  }
  if (ipVer === 6) {
    if (isPrivateIPv6(host)) throw new Error(`下载地址指向内网/保留 IP，已拒绝（SSRF 防护）：${host}`)
    return
  }

  let addrs = []
  try {
    addrs = await lookup(host, { all: true })
  } catch (e) {
    throw new Error(`下载地址无法解析：${host}（${e?.code || e?.message || 'DNS 失败'}）`)
  }
  if (!addrs.length) throw new Error(`下载地址无法解析：${host}`)
  for (const a of addrs) {
    const bad = a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address)
    if (bad) throw new Error(`下载地址解析到内网/保留 IP，已拒绝（SSRF 防护）：${host} → ${a.address}`)
  }
}

export async function isSafeDownloadTarget(rawUrl, allowHosts = []) {
  try { await assertSafeDownloadTarget(rawUrl, allowHosts); return true } catch { return false }
}
