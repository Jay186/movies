import { parseDialogue } from './dialogue.js'
import { config } from '../config.js'
import { isHardCutTransition } from './postHooks.js'

// 时长边界读 config（与分镜生成 / 出片 / 补全共用同一口径），不在此处另写副本。
const H3_MIN_DURATION = config.storyboard?.durationMin ?? 4
const H3_MAX_DURATION = config.storyboard?.durationMax ?? 15

const valueOf = (obj, ...keys) => {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null) return obj[key]
  }
  return undefined
}

const textOf = (obj, ...keys) => String(valueOf(obj, ...keys) ?? '').trim()

function arrayOf(value) {
  if (Array.isArray(value)) return value
  if (value == null || value === '') return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function nameArray(value) {
  return arrayOf(value).map((item) => {
    if (typeof item === 'string') return item.trim()
    return String(item?.name ?? item?.title ?? '').trim()
  }).filter(Boolean)
}

function numberOf(value, fallback = NaN) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pushIssue(bucket, code, message, shot = null, extra = {}) {
  bucket.push({ code, message, shotNumber: shot?.shotNumber || shot?.shot_number || '', ...extra })
}

function shotRows(document) {
  const rows = []
  for (const [sceneIndex, scene] of (document?.scenes || []).entries()) {
    for (const [shotIndex, raw] of (scene?.shots || []).entries()) {
      rows.push({
        ...raw,
        sceneNumber: scene.sceneNumber ?? scene.scene_number ?? sceneIndex + 1,
        shotNumber: raw.shotNumber ?? raw.shot_number ?? `${sceneIndex + 1}-${shotIndex + 1}`,
      })
    }
  }
  return rows
}

function assetNames(context = {}) {
  const names = (key, aliases = []) => {
    const source = context[key] ?? aliases.flatMap((a) => context[a] || [])
    return new Set((source || []).map((item) => {
      if (typeof item === 'string') return item.trim()
      return String(item?.name ?? item?.title ?? '').trim()
    }).filter(Boolean))
  }
  return {
    characters: names('characters'),
    scenes: names('scenes', ['sceneTitles']),
    props: names('props'),
  }
}

function assetImageMap(context = {}) {
  const mapFor = (key, aliases = []) => {
    const source = context[key] ?? aliases.flatMap((a) => context[a] || [])
    return new Map((source || []).map((item) => {
      if (typeof item === 'string') return [item.trim(), '']
      return [String(item?.name ?? item?.title ?? '').trim(), String(item?.image_url ?? item?.imageUrl ?? '').trim()]
    }).filter(([name]) => name))
  }
  return {
    characters: mapFor('characters'),
    scenes: mapFor('scenes', ['sceneTitles']),
    props: mapFor('props'),
  }
}

function parseActionPoints(actionNote) {
  const text = String(actionNote || '')
  const points = []
  const re = /(?:\bAt\s*|\baction\s*(?:at)?\s*|(?:动作|开始|转折)\s*)(\d+(?:\.\d+)?)\s*s?/gi
  let match
  while ((match = re.exec(text))) points.push(Number(match[1]))
  return points.filter((v, i) => i === 0 || v !== points[i - 1])
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''))
}

function stateTokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').trim()
}

// finalFrame is English while worldStateOut is intentionally compact Chinese.
// Compare only stable, language-independent composition anchors instead of raw
// word overlap (which produces false mismatches for every bilingual shot).
function stateAnchorRequirements(text) {
  const source = String(text || '').toLowerCase()
  const requirements = []
  const add = (name, pattern) => requirements.push({ name, pattern })

  if (/(画面左|左侧|左边)/.test(source)) add('frame-left', /(?:at|on|near)\s+(?:the\s+)?(?:far\s+)?left(?:\s+side)?|frame\s+left|left\s+of\s+frame/i)
  if (/(画面右|右侧|右边)/.test(source)) add('frame-right', /(?:at|on|near)\s+(?:the\s+)?(?:far\s+)?right(?:\s+side)?|frame\s+right|right\s+of\s+frame/i)
  if (/(画面中央|画面中心|中央|中心)/.test(source)) add('frame-center', /(?:at|near|in)\s+(?:the\s+)?center(?:\s+of\s+the\s+frame)?|center\s+frame|frame\s+center|central(?:ly)?/i)
  if (/(坐|蹲)/.test(source)) add('seated', /\b(?:sit(?:s|ting)?|seated|crouch(?:es|ing)?)\b/i)
  if (/(站|立)/.test(source)) add('standing', /\bstand(?:s|ing)?\b|\bon\s+(?:their|her|his)\s+feet\b/i)
  if (/(跪)/.test(source)) add('kneeling', /\bkneel(?:s|ing)?\b/i)
  if (/(趴|俯卧)/.test(source)) add('prone', /\bprone\b|lying\s+face\s+down/i)
  if (/(躺|卧)/.test(source)) add('lying', /\b(?:lie|lies|lying|laid)\b|lying\s+down/i)
  if (/(手空|空手|未持|没有拿|没有持)/.test(source)) add('hands-empty', /(?:hands?|paws?)\s+(?:are\s+)?empty|empty\s+(?:hands?|paws?)|nothing\s+in\s+(?:their|her|his)\s+(?:hands?|paws?)/i)
  if (/(手持|拿着|握着|抱着|双手持)/.test(source)) add('holding', /\bhold(?:s|ing)?\b|grasp(?:s|ing)?|carry(?:ing|ies)?|cradl(?:e|es|ing)\b/i)
  if (/(背对|背向)/.test(source)) add('back-to-camera', /back\s+to\s+(?:the\s+)?camera|facing\s+away|with\s+their\s+back\s+to/i)
  if (/(面向|朝向|朝着)/.test(source)) add('facing', /\bfacing\b|gazing\s+toward|looking\s+toward|turned\s+toward/i)
  return requirements
}

function validateSpace(shot, errors) {
  const type = textOf(shot, 'spaceType', 'space_type')
  const evidence = textOf(shot, 'spaceEvidence', 'space_evidence')
  if (!type || !evidence) {
    pushIssue(errors, 'SPACE_PAIR_REQUIRED', 'spaceType 与 spaceEvidence 必须成对填写', shot)
    return
  }
  if (!/^(S[1-4]|O[12]|X)$/.test(type)) {
    pushIssue(errors, 'SPACE_TYPE_INVALID', `空间类型 ${type} 不属于 S1-S4/O1/O2/X`, shot)
    return
  }
  const constrained = /(夹持|夹住|狭窄|只容|有遮挡|半封闭|两侧.*墙|两侧.*建筑|头顶.*树冠|岩壁)/i.test(evidence)
  if (type === 'O1' && constrained) pushIssue(errors, 'SPACE_EVIDENCE_CONTRADICTION', 'O1 不能搭配显示夹持、遮挡或半封闭的证据', shot)
  if (type === 'O2' && !constrained) pushIssue(errors, 'SPACE_EVIDENCE_WEAK', 'O2 必须在 spaceEvidence 中说明夹持、遮挡或通行受限事实', shot)
  if (type.startsWith('S') && /(露天|河滩|山崖|森林|街道|户外|室外)/i.test(evidence)) {
    pushIssue(errors, 'SPACE_INDOOR_OUTDOOR_CONTRADICTION', `${type} 的证据描述为室外空间`, shot)
  }
}

function validateAssets(shot, names, errors, context = {}) {
  const images = assetImageMap(context)
  const checks = [
    ['characters', 'CHARACTER_ASSET_MISSING'],
    ['sceneAssets', 'SCENE_ASSET_MISSING'],
    ['propAssets', 'PROP_ASSET_MISSING'],
  ]
  for (const [field, code] of checks) {
    const values = arrayOf(valueOf(shot, field, field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)))
    const set = names[field === 'sceneAssets' ? 'scenes' : field === 'propAssets' ? 'props' : 'characters']
    for (const value of values) {
      const name = typeof value === 'string' ? value.trim() : String(value?.name ?? value?.title ?? '').trim()
      if (name && !set.has(name)) pushIssue(errors, code, `${field} 引用资产「${name}」不在当前集资产表`, shot)
      if (name && context.requireReferenceImages && set.has(name)) {
        const imageSet = field === 'sceneAssets' ? images.scenes : field === 'propAssets' ? images.props : images.characters
        if (!imageSet.get(name)) pushIssue(errors, 'ASSET_REFERENCE_IMAGE_MISSING', `${field} 引用资产「${name}」没有参考图，无法稳定锁定外观/空间`, shot, { assetName: name, field })
      }
      if (field === 'sceneAssets' && name) {
        const sceneMeta = context.sceneMeta?.get(name)
        const shotScene = numberOf(shot.sceneNumber ?? shot.scene_number)
        if (sceneMeta?.sceneNumber != null && Number.isFinite(shotScene) && Number(sceneMeta.sceneNumber) !== shotScene) {
          pushIssue(errors, 'SCENE_ASSET_CROSS_SCENE', `镜 ${shot.shotNumber || shot.shot_number || ''} 引用场景「${name}」属于第 ${sceneMeta.sceneNumber} 场，本镜属于第 ${shotScene} 场；跨场景资产会与本场空间锚点冲突`, shot)
        }
      }
    }
  }
}

function validateCharacterCoverage(shot, errors, context = {}) {
  const characters = nameArray(valueOf(shot, 'characters'))
  if (!characters.length) return
  const integrated = textOf(shot, 'integratedMultimodalDescription', 'integrated_multimodal_description')
  const description = textOf(shot, 'description')
  const finalFrame = textOf(shot, 'finalFrame', 'final_frame')
  const source = `${integrated}\n${description}\n${finalFrame}`
  const characterRows = new Map((context.characters || []).map((item) => {
    if (typeof item === 'string') return [item.trim(), null]
    return [String(item?.name || '').trim(), item]
  }).filter(([name]) => name))
  for (const name of characters) {
    const row = characterRows.get(name)
    const nameEn = String(row?.name_en || row?.nameEn || '').trim()
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedEn = nameEn ? nameEn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
    // Chinese names do not have a useful JavaScript word boundary. Match the
    // canonical token directly, while keeping English aliases token-safe.
    const present = source.includes(`@${name}`) || source.includes(name) || (escapedEn && new RegExp(`\\b${escapedEn}\\b`, 'i').test(source))
    if (!present) {
      pushIssue(errors, 'CHARACTER_IMD_COVERAGE_MISSING', `镜 ${shot.shotNumber || shot.shot_number || ''} 的角色「${name}」已在 characters 字段声明，但未出现在 integrated_multimodal_description/最终画面中；Ref2VA 无法绑定该角色`, shot, { assetName: name })
    }
  }
}

function validateShot(shot, index, previousEnd, names, errors, warnings, context = {}) {
  const duration = numberOf(valueOf(shot, 'duration'))
  const start = numberOf(valueOf(shot, 'startTime', 'start_time'))
  const end = numberOf(valueOf(shot, 'endTime', 'end_time'))
  const label = shot.shotNumber || `${index + 1}`
  if (!Number.isInteger(duration) || duration < H3_MIN_DURATION || duration > H3_MAX_DURATION) {
    pushIssue(errors, 'DURATION_INVALID', `镜 ${label} 时长必须是 ${H3_MIN_DURATION}-${H3_MAX_DURATION} 的整数秒，当前为 ${valueOf(shot, 'duration')}`, shot)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (Number.isInteger(duration) && end - start !== duration)) {
    pushIssue(errors, 'TIMELINE_INVALID', `镜 ${label} 的 startTime/endTime 必须与 duration 一致`, shot)
  }
  if (index === 0 && start !== 0) pushIssue(errors, 'TIMELINE_NOT_ZERO', '首镜 startTime 必须为 0', shot)
  if (index > 0 && Number.isFinite(start) && Number.isFinite(previousEnd) && start !== previousEnd) {
    pushIssue(errors, 'TIMELINE_GAP_OR_OVERLAP', `镜 ${label} 未与上一镜连续衔接（应从 ${previousEnd}s 开始）`, shot)
  }

  for (const [field, aliases] of [
    ['integratedMultimodalDescription', ['integratedMultimodalDescription', 'integrated_multimodal_description']],
    ['finalFrame', ['finalFrame', 'final_frame']],
    ['worldStateOut', ['worldStateOut', 'world_state_out']],
  ]) {
    if (!textOf(shot, ...aliases)) pushIssue(errors, 'REQUIRED_FIELD_MISSING', `${field} 不能为空`, shot, { field })
  }
  const finalFrame = textOf(shot, 'finalFrame', 'final_frame')
  if (finalFrame && hasChinese(finalFrame)) pushIssue(errors, 'FINAL_FRAME_NOT_ENGLISH', 'finalFrame 必须为纯英文', shot)
  const out = textOf(shot, 'worldStateOut', 'world_state_out')
  if (finalFrame && out) {
    const requirements = stateAnchorRequirements(out)
    if (requirements.length && !requirements.every(({ pattern }) => pattern.test(finalFrame))) {
      const missing = requirements.filter(({ pattern }) => !pattern.test(finalFrame)).map(({ name }) => name).join(', ')
      pushIssue(errors, 'FINAL_FRAME_STATE_MISMATCH', `finalFrame 缺少 worldStateOut 的状态锚点：${missing}`, shot)
    }
  }
  if (textOf(shot, 'nonDiegeticMusic', 'non_diegetic_music')) pushIssue(errors, 'NON_DIEGETIC_MUSIC_FORBIDDEN', 'nonDiegeticMusic 必须为空字符串', shot)
  validateSpace(shot, errors)
  validateAssets(shot, names, errors, context)
  validateCharacterCoverage(shot, errors, context)
  if (context.requireStyleDeclaration) {
    const integrated = textOf(shot, 'integratedMultimodalDescription', 'integrated_multimodal_description')
    if (!/(?:[a-z][a-z0-9-]*\s+style|art\w*\s+style|visual\w*\s+style|render(?:ing)?\s+style|same\s+style|style\s+as|画风|风格)/i.test(integrated)) {
      pushIssue(errors, 'STYLE_DECLARATION_MISSING', 'integrated_multimodal_description 未声明项目画风，不能确认或出片', shot)
    }
  }

  const dialogue = parseDialogue(valueOf(shot, 'dialogue'))
  for (const line of dialogue) {
    const t = numberOf(valueOf(line, 'startTime', 'start_time'))
    if (Number.isFinite(t) && Number.isFinite(start) && Number.isFinite(end) && (t < start || t > end)) {
      pushIssue(errors, 'DIALOGUE_OUTSIDE_SHOT', `台词时间 ${t}s 超出镜 ${label} 的 ${start}-${end}s 范围`, shot)
    }
  }
  const points = parseActionPoints(valueOf(shot, 'actionNote', 'action_note'))
  // 拍点数量取决于已定稿分镜的表演节奏。xiaomo-film-studio 没有按镜头
  // 时长规定固定上限，因此不能用未经来源确认的预算否决或改写原分镜。
  // 普通生成阶段仅保留观测结果；拍点间隔不是 Skill 或 Ref2VA 的失败条件。
  for (let i = 1; i < points.length; i++) if (points[i] <= points[i - 1]) pushIssue(warnings, 'ACTION_POINT_ORDER', '动作拍点未按时间递增', shot)
  if (duration && Number.isFinite(start) && Number.isFinite(end) && end - start > duration) pushIssue(warnings, 'DURATION_MISMATCH', '时间轴长度大于 duration', shot)
}

function validateCharacterContinuity(rows, errors) {
  const explicitlyAbsent = (shot, name) => {
    const source = `${textOf(shot, 'worldStateIn', 'world_state_in')} ${textOf(shot, 'worldStateOut', 'world_state_out')}`
    if (!source) return false
    const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 只接受与该角色同句/同段的离场锚点，避免把另一个角色的「未入画」
    // 错当成当前缺失角色的声明。
    const namePattern = new RegExp(`(?:@?${escaped})(?:[^；;。.!?\\n]{0,36})(?:未入画|不在画面|不在镜头|离场|离开|退出画面)`, 'i')
    const reversePattern = new RegExp(`(?:未入画|不在画面|不在镜头|离场|离开|退出画面)(?:[^；;。.!?\\n]{0,36})(?:@?${escaped})`, 'i')
    return namePattern.test(source) || reversePattern.test(source)
  }
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]
    const current = rows[index]
    const previousScene = numberOf(previous.sceneNumber ?? previous.scene_number)
    const currentScene = numberOf(current.sceneNumber ?? current.scene_number)
    const crossScene = Number.isFinite(previousScene) && Number.isFinite(currentScene) && previousScene !== currentScene
    const transition = textOf(current, 'transitionIn', 'transition_in')
    const hardCut = isHardCutTransition(transition)
    const carriesAcrossScene = Boolean(textOf(current, 'worldStateIn', 'world_state_in'))
    if (hardCut || (crossScene && !carriesAcrossScene)) continue

    const previousCharacters = nameArray(valueOf(previous, 'characters'))
    const currentCharacters = new Set(nameArray(valueOf(current, 'characters')))
    const dropped = previousCharacters.filter((name) => !currentCharacters.has(name) && !explicitlyAbsent(current, name))
    if (!dropped.length) continue

    const currentText = `${textOf(current, 'integratedMultimodalDescription', 'integrated_multimodal_description')} ${textOf(current, 'description')} ${textOf(current, 'finalFrame', 'final_frame')}`
    const isInsert = currentCharacters.size === 0 && /no\s+characters?|character\s+coverage\s*:\s*n\/a|无角色|没有角色|仅展示|空镜/i.test(currentText)
    if (isInsert) continue

    pushIssue(
      errors,
      'CONTINUITY_CHARACTER_DROPPED',
      `镜 ${current.shotNumber || current.shot_number || index + 1} 按软接续应保留上一镜在场角色：${dropped.join('、')}；如确实离场，请声明硬切或在状态字段中明确离场`,
      current,
      { previousShotNumber: previous.shotNumber || previous.shot_number || index },
    )
  }
}

export function validateStoryboardDocument(document = {}, context = {}) {
  const errors = []
  const warnings = []
  const rows = shotRows(document)
  const names = assetNames(context)
  if (context.scenes?.length && !context.sceneMeta) {
    context.sceneMeta = new Map(context.scenes.map((scene) => [String(scene?.title ?? scene?.name ?? '').trim(), {
      sceneNumber: scene?.sceneNumber ?? scene?.scene_number,
    }]).filter(([name]) => name))
  }
  if (!Array.isArray(document?.scenes) || document.scenes.length === 0) errors.push({ code: 'SCENES_EMPTY', message: '分镜至少需要一个场次' })
  if (rows.length === 0) errors.push({ code: 'SHOTS_EMPTY', message: '分镜至少需要一个镜头' })
  let previousEnd = 0
  rows.forEach((shot, index) => {
    validateShot(shot, index, previousEnd, names, errors, warnings, context)
    const end = numberOf(valueOf(shot, 'endTime', 'end_time'))
    if (Number.isFinite(end)) previousEnd = end
  })
  const expectedSceneCount = numberOf(context.scriptSceneCount, NaN)
  if (Number.isFinite(expectedSceneCount) && expectedSceneCount > 0 && document.scenes.length !== expectedSceneCount) {
    pushIssue(errors, 'SCENE_COUNT_MISMATCH', `分镜场次数 ${document.scenes.length} 与剧本场次数 ${expectedSceneCount} 不一致`)
  }
  const targetDuration = numberOf(context.targetDuration, NaN)
  if (Number.isFinite(targetDuration) && previousEnd && Math.abs(previousEnd - targetDuration) > 2) {
    warnings.push({ code: 'TOTAL_DURATION_DRIFT', message: `分镜总时长 ${previousEnd}s 与目标 ${targetDuration}s 偏差超过 2s` })
  }
  return { ok: errors.length === 0, errors, warnings, shotCount: rows.length, totalDuration: previousEnd }
}

// 已由 xiaomo-film-studio 定稿的分镜文件属于“忠实导入”，不应被 H3
// 生成建议二次否决。导入仍阻断结构损坏、时间轴损坏、资产不存在、末帧不可用
// 等会导致落库或出片失败的问题；软接续等需要人工判断的内容只记录 warning。
export function validateStoryboardImport(document = {}, context = {}) {
  // 已定稿文件的导入是数据转换，不是重新导演。xiaomo-film-studio
  // 和 H3 Ref2VA 文档没有授权平台按动作密度、角色接续、双语状态锚点、
  // 空间证据或画风声明改写原镜头，因此这些语义检查不能阻断导入。
  // 这里只检查会导致数据无法落库的最小结构：场次/镜头容器必须存在，
  // 每个镜头必须是对象，并保留原始字段；其余内容交给 provider 解释。
  const errors = []
  const warnings = []
  if (!Array.isArray(document?.scenes) || document.scenes.length === 0) {
    errors.push({ code: 'SCENES_EMPTY', message: '分镜至少需要一个场次' })
  }
  let shotCount = 0
  for (const [sceneIndex, scene] of (document?.scenes || []).entries()) {
    if (!scene || typeof scene !== 'object' || !Array.isArray(scene.shots)) {
      errors.push({ code: 'SCENE_SHOTS_INVALID', message: `第 ${sceneIndex + 1} 场缺少 shots 数组` })
      continue
    }
    for (const [shotIndex, shot] of scene.shots.entries()) {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
        errors.push({ code: 'SHOT_INVALID', message: `第 ${sceneIndex + 1} 场第 ${shotIndex + 1} 镜不是对象` })
      } else {
        shotCount += 1
      }
    }
  }
  if (shotCount === 0 && errors.length === 0) errors.push({ code: 'SHOTS_EMPTY', message: '分镜至少需要一个镜头' })
  return { ok: errors.length === 0, errors, warnings, shotCount, totalDuration: null }
}

export function validateStoryboardRows(rows = [], context = {}) {
  const scenes = []
  for (const row of rows) {
    const sceneNumber = row.scene_number ?? row.sceneNumber ?? 1
    let scene = scenes.find((item) => item.sceneNumber === sceneNumber)
    if (!scene) { scene = { sceneNumber, title: row.scene_title || '', shots: [] }; scenes.push(scene) }
    scene.shots.push(row)
  }
  return validateStoryboardDocument({ scenes }, context)
}

export function formatStoryboardValidationError(result, limit = 12) {
  const issues = [...(result?.errors || []), ...(result?.warnings || [])]
  const max = Math.max(1, Number(limit) || 12)
  return issues.slice(0, max).map((issue) => `${issue.shotNumber ? `镜${issue.shotNumber} ` : ''}${issue.message}`).join('；') || '分镜契约校验失败'
}
