
import zhCN from './lexicons/zh-CN.js'
import enUS from './lexicons/en-US.js'
import objectFormsZh from './lexicons/object-forms.zh.js'

const LANGUAGE_PACKS = { 'zh-CN': zhCN, 'en-US': enUS }
const DEFAULT_LANG = 'zh-CN'

const OBJECT_FORM_PACKS = { zh: objectFormsZh }

function getLanguagePack(lang) {
  if (lang && typeof lang === 'object') return lang
  return LANGUAGE_PACKS[lang || DEFAULT_LANG] || LANGUAGE_PACKS[DEFAULT_LANG]
}

function getObjectFormPack(pack) {
  if (pack && typeof pack === 'object') return pack
  return OBJECT_FORM_PACKS[pack || 'zh'] || OBJECT_FORM_PACKS.zh
}


function autoExtractPlaceNouns(scenes = [], opts = {}) {
  const pack = opts.pack || getLanguagePack()
  const NOISE = new Set(pack.placeNoise || [])
  const BAD_HEAD = pack.placeBadHead
  const PLACE_TAIL = pack.placeTail
  const SEP = pack.separators || /[·\-—/｜|,，、\s]+/

  const counter = new Map()
  const add = (w, weight) => {
    const t = String(w || '').trim()
    if (t.length < 2 || t.length > 8) return
    if (NOISE.has(t)) return
    if (BAD_HEAD && BAD_HEAD.test(t)) return
    const base = weight + (PLACE_TAIL && PLACE_TAIL.test(t) ? 2 : 0)
    counter.set(t, (counter.get(t) || 0) + base)
  }

  for (const h of (opts.hint || [])) add(h, 10)

  for (const sc of scenes) {
    const t = String(sc?.title || '')
    for (const seg of t.split(SEP)) {
      const s = String(seg || '').trim()
      if (s.length >= 2 && s.length <= 8) add(s, 1)
      if (s.length > 4) {
        for (let len = 2; len <= 4; len++) {
          for (let i = 0; i + len <= s.length; i++) add(s.slice(i, i + len), 1)
        }
      }
    }
  }

  return [...counter.entries()].filter(([, n]) => n >= 3).map(([w]) => w)
}

function buildLexicon(opts = {}) {
  const L = opts.lexicon || {}
  const pack = getLanguagePack(opts.languagePack)
  const formPack = getObjectFormPack(opts.objectFormPack)
  const uniq = (...arrs) => [...new Set(arrs.flat().filter(Boolean))]

  const env = {
    fog: uniq(L.env?.fog || [], pack.env?.fog || []),
    light: uniq(L.env?.light || [], pack.env?.light || []),
    weather: uniq(L.env?.weather || [], pack.env?.weather || []),
  }
  const verticalTerrain = uniq(L.verticalTerrain || L.vertical || [], pack.verticalTerrain || [])
  const moveVerbs = uniq(L.moveVerbs || [], pack.moveVerbs || [])
  const transition = uniq(L.transition || [], pack.transition || [])
  const gradualMarkers = uniq(L.gradualMarkers || [], pack.gradualMarkers || [])

  let placeNouns = L.placeNouns || []
  if (!placeNouns.length && opts.autoExtract !== false && Array.isArray(opts.scenes)) {
    placeNouns = autoExtractPlaceNouns(opts.scenes, { hint: opts.placeHint, pack })
  }

  const objects = { ...(formPack || {}) }
  if (L.objects && typeof L.objects === 'object') {
    for (const [k, v] of Object.entries(L.objects)) {
      if (Array.isArray(v) && v.length) objects[k] = v
    }
  }

  const stateAliases = {}
  const mergeAliases = (src) => {
    if (!src || typeof src !== 'object') return
    for (const [k, v] of Object.entries(src)) {
      const key = String(k || '').trim().toLowerCase()
      if (!key) continue
      const list = Array.isArray(v) ? v : [v]
      const clean = list.map((a) => String(a || '').trim()).filter(Boolean)
      if (!clean.length) continue
      stateAliases[key] = [...new Set([...(stateAliases[key] || []), ...clean])]
    }
  }
  mergeAliases(pack.stateAliases)
  mergeAliases(L.stateAliases)

  const separators = pack.separators || /[·\-—/｜|,，、\s]+/

  return {
    env, verticalTerrain, moveVerbs, transition, gradualMarkers, placeNouns, objects, separators,
    lang: pack.id || DEFAULT_LANG,
    messages: pack.messages || {},
    familyLabel: pack.familyLabel || {},
    stateAliases,
    structure: L.structure || pack.structure || {},
  }
}


function extractEnvState(text = '', lexicon) {
  const t = String(text || '')
  const env = lexicon?.env || {}
  const hit = (words) => [...new Set((words || []).filter((w) => t.includes(w)))]
  return {
    fog: hit(env.fog),
    light: hit(env.light),
    weather: hit(env.weather),
  }
}

function checkEnvTransition(scenes = [], lexicon) {
  const out = []
  const transition = lexicon?.transition || []
  const placeNouns = lexicon?.placeNouns || []
  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]
    const cur = scenes[i]
    if (!prev || !cur) continue
    const a = extractEnvState(prev.text, lexicon)
    const b = extractEnvState(cur.text, lexicon)
    const curText = String(cur.text || '')
    const prevText = String(prev.text || '')

    const jumped = []
    for (const family of ['fog', 'light', 'weather']) {
      const hadBefore = a[family].length > 0
      const hasNow = b[family].length > 0
      if (hadBefore && !hasNow) jumped.push({ family, prevHits: a[family] })
    }
    if (!jumped.length) continue
    if (transition.some((w) => curText.includes(w))) continue

    if (placeNouns.some((w) => prevText.includes(w) && curText.includes(w))) continue

    const M = lexicon?.messages || {}
    out.push({
      code: 'ENV_STATE_JUMP',
      scene: cur.sceneNumber,
      message: M.envJump
        ? M.envJump({
            curNo: cur.sceneNumber, prevNo: prev.sceneNumber, jumped,
            familyLabel: lexicon?.familyLabel || {},
          })
        : `[ENV_STATE_JUMP] scene ${prev.sceneNumber}->${cur.sceneNumber}: ` +
          jumped.map((j) => `${j.family}(${j.prevHits.join(',')})`).join('; ') +
          ` — environment state disappeared without transition description.`,
      detail: { jumped, prevScene: prev.sceneNumber },
    })
  }
  return out
}

function checkHandoffAnchor(scenes = [], lexicon) {
  const vertical = lexicon?.verticalTerrain || []
  const moveVerbs = lexicon?.moveVerbs || []
  const placeNouns = lexicon?.placeNouns || []
  const gradual = lexicon?.gradualMarkers || []
  const out = []

  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]
    const cur = scenes[i]
    if (!prev || !cur) continue
    const prevText = String(prev.text || prev.finalFrame || '')
    const curText = String(cur.text || '')

    const prevVHits = vertical.filter((w) => prevText.includes(w))
    if (!prevVHits.length) continue
    const curVHits = vertical.filter((w) => curText.includes(w))

    const sharedPlace = placeNouns.some((w) => prevText.includes(w) && curText.includes(w))
    const bothVertical = prevVHits.length > 0 && curVHits.length > 0
    if (sharedPlace && !bothVertical) continue

    const windowText = handoffWindow(curText, lexicon?.structure)
    const moveHits = moveVerbs.filter((w) => windowText.includes(w))
    const gradualHits = gradual.filter((w) => windowText.includes(w))
    const M = lexicon?.messages || {}

    if (!moveHits.length && !gradualHits.length) {
      out.push({
        code: 'HANDOFF_ANCHOR_MISSING',
        scene: cur.sceneNumber,
        message: M.handoffMissing
          ? M.handoffMissing({
              curNo: cur.sceneNumber, prevNo: prev.sceneNumber, prevVHits,
            })
          : `[HANDOFF_ANCHOR_MISSING] scene ${prev.sceneNumber}->${cur.sceneNumber}: ` +
            `previous scene has vertical terrain (${prevVHits.join(',')}) but this scene ` +
            `describes no movement process — storyboard has no transition basis.`,
        detail: { prevScene: prev.sceneNumber, prevVerticalHits: prevVHits, window: windowText.length },
      })
    } else if (!gradualHits.length) {
      out.push({
        code: 'HANDOFF_ANCHOR_THIN',
        scene: cur.sceneNumber,
        message: M.handoffThin
          ? M.handoffThin({
              curNo: cur.sceneNumber, prevNo: prev.sceneNumber,
              prevVHits, moveHits,
            })
          : `[HANDOFF_ANCHOR_THIN] scene ${prev.sceneNumber}->${cur.sceneNumber}: ` +
            `previous scene has vertical terrain (${prevVHits.join(',')}) but this scene ` +
            `compresses the movement into isolated verb(s) (${moveHits.join(',')}) ` +
            `with no gradual markers — storyboard cannot derive transition shots.`,
        detail: { prevScene: prev.sceneNumber, prevVerticalHits: prevVHits, moveHits, window: windowText.length },
      })
    }
  }
  return out
}

function handoffWindow(text, structure = {}) {
  const WINDOW = 400
  const sceneHeader = structure.sceneHeader
  const settingHead = structure.settingHead
  const lines = String(text || '').split('\n')
  const body = []
  let skippedHeader = false
  let skippedSetting = false
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (!skippedHeader) {
      skippedHeader = true
      if (sceneHeader ? sceneHeader.test(t) : true) continue
    }
    if (!skippedSetting && settingHead && settingHead.test(t)) {
      skippedSetting = true
      continue
    }
    body.push(t)
    if (body.join('\n').length >= WINDOW) break
  }
  const joined = body.join('\n')
  return (joined || String(text || '')).slice(0, WINDOW)
}

function checkObjectFormConsistency(scenes = [], lexicon) {
  const objects = lexicon?.objects || {}
  const out = []

  for (const [obj, formGroups] of Object.entries(objects)) {
    const seen = []
    for (const sc of scenes) {
      const t = String(sc?.text || '')
      if (!t.includes(obj)) continue
      for (let fi = 0; fi < formGroups.length; fi++) {
        const hits = (formGroups[fi] || []).filter((w) => t.includes(w))
        if (hits.length) {
          const sceneNo = sc?.sceneNumber ?? sc?.scene_number ?? null
          const M = lexicon?.messages || {}
          seen.push({
            scene: sceneNo == null ? (M.unknownScene || '?') : sceneNo,
            label: sceneNo == null
              ? (M.sceneLabel ? M.sceneLabel(seen.length + 1) : `#${seen.length + 1}`)
              : (M.sceneLabelWithNo ? M.sceneLabelWithNo(sceneNo) : `scene ${sceneNo}`),
            formIdx: fi,
            hits,
          })
          break
        }
      }
    }
    if (seen.length >= 2) {
      const forms = [...new Set(seen.map((s) => s.formIdx))]
      if (forms.length > 1) {
        const M = lexicon?.messages || {}
        out.push({
          code: 'OBJECT_FORM_INCONSISTENT',
          scene: seen.map((s) => s.scene).join('/'),
          message: M.objectForm
            ? M.objectForm({ object: obj, seen })
            : `[OBJECT_FORM_INCONSISTENT] "${obj}" has inconsistent form across scenes: ` +
              seen.map((s) => `${s.label}=${s.hits.join(',')}`).join('; ') +
              ` — same object must keep one form across scenes.`,
          detail: { object: obj, seen },
        })
      }
    }
  }
  return out
}

function checkSummaryDrift(rows = [], lexicon) {
  const out = []
  for (const r of rows) {
    if (!r) continue
    const a = extractEnvState(r.scriptText, lexicon)
    const b = extractEnvState(r.summaryText, lexicon)
    const diffs = []
    for (const family of ['fog', 'light', 'weather']) {
      const A = new Set(a[family])
      const B = new Set(b[family])
      const onlyScript = [...A].filter((x) => !B.has(x))
      const onlySummary = [...B].filter((x) => !A.has(x))
      if (onlyScript.length || onlySummary.length) diffs.push({ family, onlyScript, onlySummary })
    }
    if (diffs.length) {
      const onlyS = diffs.flatMap((d) => d.onlySummary)
      const onlyC = diffs.flatMap((d) => d.onlyScript)
      const M = lexicon?.messages || {}
      out.push({
        code: 'SUMMARY_SCRIPT_DRIFT',
        scene: r.sceneNumber,
        message: M.summaryDrift
          ? M.summaryDrift({ sceneNo: r.sceneNumber, onlySummary: onlyS, onlyScript: onlyC })
          : `[SUMMARY_SCRIPT_DRIFT] scene ${r.sceneNumber}: script and scene summary ` +
            `describe different environments` +
            (onlyS.length ? `; summary-only: ${onlyS.join(',')}` : '') +
            (onlyC.length ? `; script-only: ${onlyC.join(',')}` : '') +
            ` — downstream storyboard consumes summary and will drift from the script.`,
        detail: { diffs },
      })
    }
  }
  return out
}



export function checkContinuity(input = {}, opts = {}) {
  const scenes = Array.isArray(input.scenes) ? input.scenes : []
  const lexicon = buildLexicon({
    lexicon: opts.lexicon,
    languagePack: opts.languagePack,
    objectFormPack: opts.objectFormPack,
    scenes,
    placeHint: opts.placeHint,
    autoExtract: opts.autoExtract,
  })
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null
  const run = (key) => !only || only.has(key)

  const warnings = []
  if (run('env')) warnings.push(...checkEnvTransition(scenes, lexicon))
  if (run('handoff')) warnings.push(...checkHandoffAnchor(scenes, lexicon))
  if (run('form')) warnings.push(...checkObjectFormConsistency(scenes, lexicon))
  if (run('drift')) {
    const rows = scenes
      .filter((s) => s && (s.summaryText != null || s.scriptText != null))
      .map((s) => ({
        sceneNumber: s.sceneNumber,
        scriptText: s.scriptText ?? s.text,
        summaryText: s.summaryText ?? '',
      }))
    warnings.push(...checkSummaryDrift(rows, lexicon))
  }

  if (warnings.length) {
    const M = lexicon.messages || {}
    const log = M.logSummary
      ? M.logSummary({
          sceneCount: scenes.length,
          warnCount: warnings.length,
          items: warnings,
        })
      : `[continuityGuard] ${scenes.length} scenes, ${warnings.length} warnings.` +
        warnings.map((w) => ` [${w.code}]scene${w.scene}`).join('')
    console.warn(log)
  }
  return {
    warnings,
    summary: { sceneCount: scenes.length, warningCount: warnings.length },
    lexicon,
  }
}
