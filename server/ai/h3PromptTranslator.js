
import { chatCompletion } from './doubao.js'
import { CJK_DIRTY_RE, pickInjectableEnglish } from './shared.js'
import { recordAlert } from './alerts.js'

const SHOT_SIZE_MAP = {
  '大远景': 'extreme long establishing shot',
  '远景': 'long establishing shot',
  '大全景': 'extreme wide shot',
  '全景': 'wide shot',
  '中全景': 'medium-wide shot',
  '中景': 'medium shot',
  '中近景': 'medium close-up',
  '近景': 'close-up',
  '特写': 'extreme close-up',
  '大特写': 'extreme close-up',
}

export function translateShotSize(cn) {
  const key = String(cn || '').trim()
  return SHOT_SIZE_MAP[key] || `medium shot`
}

const CAMERA_MAP = {
  '固定': 'holds a static shot with no camera movement throughout',
  '静止': 'holds a static shot with no camera movement throughout',
  '静态': 'holds a static shot with no camera movement throughout',
  '不动': 'holds a static shot with no camera movement throughout',
  '推近': 'pushes in with small amplitude at slow speed',
  '推': 'pushes in with small amplitude at slow speed',
  '推镜头': 'pushes in with small amplitude at slow speed',
  '拉近': 'pushes in with small amplitude at slow speed',
  '拉远': 'pulls out with small amplitude at slow speed',
  '拉': 'pulls out with small amplitude at slow speed',
  '拉镜头': 'pulls out with small amplitude at slow speed',
  '变焦': 'zooms in with small amplitude at slow speed',
  '变焦推近': 'zooms in with small amplitude at slow speed',
  '推焦': 'zooms in with small amplitude at slow speed',
  '变焦拉远': 'zooms out with small amplitude at slow speed',
  '拉焦': 'zooms out with small amplitude at slow speed',
  '横摇': 'pans horizontally with medium amplitude at slow speed',
  '摇镜头': 'pans horizontally with medium amplitude at slow speed',
  '左摇': 'pans left with medium amplitude at slow speed',
  '右摇': 'pans right with medium amplitude at slow speed',
  '摇上': 'tilts up with small amplitude at slow speed',
  '摇下': 'tilts down with small amplitude at slow speed',
  '上摇': 'tilts up with small amplitude at slow speed',
  '下摇': 'tilts down with small amplitude at slow speed',
  '横移': 'trucks sideways with medium amplitude at slow speed',
  '平移': 'trucks sideways with medium amplitude at slow speed',
  '移镜': 'trucks sideways with medium amplitude at slow speed',
  '左移': 'trucks left with medium amplitude at slow speed',
  '右移': 'trucks right with medium amplitude at slow speed',
  '升降': 'pedestals vertically with medium amplitude at slow speed',
  '升降镜头': 'pedestals vertically with medium amplitude at slow speed',
  '升高': 'pedestals up with medium amplitude at slow speed',
  '降低': 'pedestals down with medium amplitude at slow speed',
  '升镜': 'pedestals up with medium amplitude at slow speed',
  '降镜': 'pedestals down with medium amplitude at slow speed',
  '环绕': 'arcs around the subject with medium amplitude at slow speed',
  '环摇': 'arcs around the subject with medium amplitude at slow speed',
  '绕拍': 'arcs around the subject with medium amplitude at slow speed',
  '弧形环绕': 'arcs around the subject with medium amplitude at slow speed',
  '跟拍': 'tracks the subject with medium amplitude at a speed matching the subject motion',
  '跟随': 'tracks the subject with medium amplitude at a speed matching the subject motion',
  '跟镜': 'tracks the subject with medium amplitude at a speed matching the subject motion',
  '跟移': 'tracks the subject with medium amplitude at a speed matching the subject motion',
  '推轨': 'pushes in on a dolly with medium amplitude at slow speed',
  '滑轨': 'slides along a dolly track with medium amplitude at slow speed',
  '轨道': 'pushes in on a dolly with medium amplitude at slow speed',
  '手持': 'shakes slightly with natural handheld camera motion',
  '手持跟拍': 'shakes slightly while tracking the subject with handheld camera motion',
  '肩扛': 'shakes slightly with shoulder-mounted handheld camera motion',
  '轻微晃动': 'shakes slightly',
  '剧烈晃动': 'shakes strongly',
  '强烈晃动': 'shakes strongly',
  'POV': 'holds a POV shot from the subject eyeline',
  '主观镜头': 'holds a POV shot from the subject eyeline',
  '第一人称': 'holds a POV shot from the subject eyeline',
  '旋转': 'rolls clockwise around the lens axis with medium amplitude at slow speed',
  '旋转镜头': 'rolls clockwise around the lens axis with medium amplitude at slow speed',
  '滚转': 'rolls clockwise around the lens axis with medium amplitude at slow speed',
  '俯拍': 'holds a high-angle static shot looking down, with no camera movement',
  '俯视': 'holds a high-angle static shot looking down, with no camera movement',
  '仰拍': 'holds a low-angle static shot looking up, with no camera movement',
  '仰视': 'holds a low-angle static shot looking up, with no camera movement',
}

const CAMERA_ANGLE_MAP = {
  '正面': 'the camera is positioned front-on at eye level, facing the subject directly',
  '侧面': 'the camera is positioned at a 45-degree three-quarter side view of the subject',
  '正侧': 'the camera is positioned in a full side profile view of the subject',
  '背面': 'the camera is positioned behind the subject, framing the back of the character',
  '过肩': 'the camera is positioned in an over-the-shoulder framing behind the subject',
  '俯拍': 'the camera is positioned high above, looking down at the subject',
  '仰拍': 'the camera is positioned low, looking up at the subject',
}

export function translateCameraAngle(cn) {
  const key = String(cn || '').trim()
  return CAMERA_ANGLE_MAP[key] || ''
}

export function translateCameraMovement(cn) {
  const key = String(cn || '').trim()
  return CAMERA_MAP[key] || ''
}


const TONE_MAP = {
  '压低声音': 'in a hushed tone',
  '低声': 'in a hushed tone',
  '小声': 'in a quiet tone',
  '小声嘀咕': 'while muttering quietly',
  '耳语': 'in a whisper',
  '兴奋': 'excitedly',
  '好奇': 'curiously',
  '鼓起腮帮': 'while puffing out cheeks',
  '鼓气逞强': 'while putting on a brave front',
  '逞强': 'while putting on a brave front',
  '壮胆': 'while trying to sound brave',
  '大喊': 'while shouting',
  '大喊道': 'while shouting',
  '喊道': 'while shouting',
  '惊呼': 'in a startled cry',
  '低吼': 'in a low growl',
  '怒吼': 'in a furious roar',
  '咆哮': 'in a roar',
  '喘气': 'while panting',
  '喘息': 'while panting',
  '喘着气': 'while panting for breath',
  '虚弱地呻吟': 'while moaning weakly',
  '呻吟': 'while moaning',
  '虚弱': 'weakly',
  '晃着腿': 'while swinging legs',
  '笑眯眯': 'while smiling gently',
  '微笑': 'while smiling softly',
  '温柔': 'gently',
  '温柔坚定': 'in a gentle but firm tone',
  '胆怯发飘': 'in a timid quavering thin voice',
  '胆怯': 'in a timid quavering tone',
  '发飘': 'in a thin unsteady voice',
  '轻快期待': 'lightly and expectantly',
  '期待': 'expectantly',
  '认真': 'earnestly',
  '坚定': 'determinedly',
  '害怕': 'fearfully',
  '惊恐': 'in terror',
  '紧张': 'nervously',
  '惊讶': 'in surprise',
  '诧异': 'in surprise',
  '开心': 'happily',
  '开心地': 'happily',
  '高兴': 'happily',
  '沮丧': 'dejectedly',
  '愤怒': 'angrily',
  '咬牙': 'through gritted teeth',
  '咬牙切齿': 'through gritted teeth',
  '急切': 'urgently',
  '急促': 'in quick breaths',
  '沉重': 'heavily',
  '颤抖': 'tremblingly',
  '颤声': 'in a trembling voice',
  '平静': 'calmly',
  '沉稳': 'steadily',
}

export function translateTone(cn) {
  const key = String(cn || '').trim()
  if (!key) return ''
  const segs = key.split(/[，,、/｜|]+/).map((s) => s.trim()).filter(Boolean)
  const hits = []
  for (const seg of segs) {
    let hit = TONE_MAP[seg]
    if (!hit) {
      for (const [k, v] of Object.entries(TONE_MAP)) { if (seg.includes(k)) { hit = v; break } }
    }
    if (hit && !hits.includes(hit)) hits.push(hit)
  }
  if (hits.length) return hits.join(', ')
  if (TONE_MAP[key]) return TONE_MAP[key]
  for (const [k, v] of Object.entries(TONE_MAP)) { if (key.includes(k)) return v }
  return ''
}

const translationCache = new Map()

const TRANSLATE_SYSTEM_PROMPT = `你是 AI 视频 prompt 翻译与扩写专家，把中文分镜描述翻译成符合 MiniMax H3 Ref2VA 规范的英文。

【翻译规则】
1. 只翻译并扩写给定字段，**不得添加原文没有的角色、道具、情节、镜头切换或对白**；
   **空间关系是硬约束，必须逐字忠实保留、禁止改写或省略**——谁在哪儿、面向哪个方向
   （背对镜头/侧对镜头/面对镜头）、被什么遮挡（躲在某物后/只露出头部）、露了多少、
   谁在看谁、相对远近与高低。这些是镜头的戏剧核心，即使与扩写词数冲突，也**宁少勿改**。
2. 角色名/场景名直接保留原文（中文名不变，如"一二""布布""大白熊"原样保留）
3. 运镜不要翻译（已在别处处理），只翻译画面与动作
4. 语气词翻译成英文副词短语（如"压低声音"→"in a hushed tone"）
5. 不要翻译台词内容（台词单独处理）
6. **输出必须是纯英文**，除角色名/场景名外不得出现任何中文字符
7. **音色克隆约束**（本次任务若标注「音色克隆角色」，下列角色台词由克隆音色朗读）：
   凡描写这些角色**发声方式**的内容，必须写成平稳克制的说法，**禁止**出现：
   鼓腮/鼓气（puffed cheeks、inflating cheeks、cheeks into spheres）、张大嘴（opening its mouth wide）、
   大口吸气（drawing in a large/deep breath、a large volume of air）、用力投射（projecting a call）、
   喊叫（shouting / screaming / yelling）、提高音量（raising its voice）、怒吼低吼（roar / growl）、
   用力到极限（to its maximum extent）。
   替代写法：站直、挺胸、攥紧拳头、眼神坚定、下巴抬起等**不改变发声方式的肢体语言**；
   递送措辞用 "in a steady low voice"、"firmly but quietly" 这类稳态短语。
   （硬原因：H3 一旦把该镜判定为喊叫场景，会抛弃 <Audio N> 克隆音色改用通用嗓音——实测 F0 543Hz vs 样本 286Hz。）

【扩写要求】官方 ref-en.txt §5.2：detailed_description 正常需要 **350-500 英文词**，且明确反对
「reducing the description to a plot summary / A single shot does not automatically justify a shorter
description」。注意 description_en + action_note_en 会拼成同一段 detailed_description，
所以两者的词数之和必须落进 350-500。按「首帧锚定 → 动作起始 → 连续发展 → 结果或反应」展开：

- description_en：**300-380 英文词**。**首先**逐字忠实保留原文的空间关系与朝向（谁背对/面对/侧对镜头、谁躲在什么后、只露出什么、谁看谁、远近高低）；**然后**在保留这些硬信息的前提下，扩写景别与构图布局、光线的方向/质量/色温、材质与色彩细节、环境元素与空间纵深、角色的姿态变化与面部表情。用可拍摄的视觉化语言，不要复述剧情。**一个镜头也要写满**，信息分部在前景/中景/远景三层铺开。
- action_note_en：**60-100 英文词**。按时间进程分解动作：起始姿态 → 动作过程 → 结束状态，写明动作幅度与节奏。
- soundscape_en：20-50 英文词，写环境音与物理音效的层次（1-4 句，官方区间）。
- music_en：20-50 英文词（1-3 句，官方区间），写观众能听到的背景配乐（角色听不到的）；原文为空则返回空字符串。**禁止抽象情绪词、禁止解释配乐的情绪功能**，只写乐器编制/速度/节奏/动态变化。
- tone_en：英文语气短语；原文为空则返回空字符串。

【输出格式】严格 JSON：
{
  "description_en": "...",
  "action_note_en": "...",
  "soundscape_en": "...",
  "music_en": "...",
  "tone_en": "..."
}

字段为空就返回空字符串。只输出 JSON，不要任何其他文字。`

export function rescueLeakedFields(result = {}, hasLeaked = () => true) {
  const FIELDS = ['description_en', 'action_note_en', 'soundscape_en', 'music_en', 'tone_en']
  const rescued = {}
  for (const k of FIELDS) {
    const v = String(result[k] || '').trim()
    rescued[k] = v && hasLeaked(v) ? pickInjectableEnglish(v) : v
  }
  return FIELDS.some((k) => rescued[k]) ? { ...rescued, failed: false } : null
}

export async function translateShotFields(shot = {}, ctx = {}) {
  const { characterNames = [], sceneNames = [], voiceClone = false, voicedNames = [] } = ctx

  const dlgRaw = shot.dialogue
  const dlgArr = Array.isArray(dlgRaw) ? dlgRaw : (dlgRaw && typeof dlgRaw === 'object' ? [dlgRaw] : [])
  const toneList = dlgArr.map((x) => String(x?.tone || '').trim()).filter(Boolean)

  const cacheKey = JSON.stringify({
    d: shot.description || '',
    a: shot.action_note || shot.actionNote || '',
    s: [shot.overall_soundscape || shot.overallSoundscape, shot.sound_effects || shot.soundEffects].filter(Boolean).join('；'),
    m: shot.non_diegetic_music || shot.nonDiegeticMusic || '',
    t: toneList,
    n: [...characterNames, ...sceneNames],
    vc: voiceClone ? voicedNames : false,
  })

  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey)

  const cn = {
    description: String(shot.description || '').replace(/@/g, '').trim(),
    actionNote: String(shot.action_note || shot.actionNote || '').trim(),
    soundscape: [shot.overall_soundscape || shot.overallSoundscape, shot.sound_effects || shot.soundEffects].filter(Boolean).join('；').trim(),
    music: String(shot.non_diegetic_music || shot.nonDiegeticMusic || '').trim(),
    tone: toneList.join('，'),
  }

  const empty = { description_en: '', action_note_en: '', soundscape_en: '', music_en: '', tone_en: '', failed: false }

  if (!cn.description && !cn.actionNote && !cn.soundscape && !cn.music && !cn.tone) {
    translationCache.set(cacheKey, empty)
    return empty
  }

  const nameList = [...characterNames, ...sceneNames].filter(Boolean).map((n) => `- ${n}`).join('\n')

  const messages = [
    { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `角色/场景名（保留原文不翻译）：
${nameList || '（无）'}
${voiceClone && voicedNames.length ? `\n音色克隆角色（这些角色的台词由克隆音色朗读，必须遵守规则 7）：${voicedNames.join('、')}\n` : ''}
需要翻译并扩写的内容：
画面描述：${cn.description || '（空）'}
动作说明：${cn.actionNote || '（空）'}
环境音与画内音效：${cn.soundscape || '（空）'}
配乐：${cn.music || '（空）'}
语气：${cn.tone || '（空）'}`,
    },
  ]

  const NAME_SAFE = new Set([...characterNames, ...sceneNames].filter(Boolean))

  const hasLeakedChinese = (s) => {
    if (!s) return false
    let probe = s
    for (const n of NAME_SAFE) probe = probe.split(n).join('')
    return CJK_DIRTY_RE.test(probe)
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msgs = attempt === 0
        ? messages
        : [
            messages[0],
            { role: 'assistant', content: '（上一次输出含中文，请重新输出纯英文 JSON）' },
            { ...messages[1], content: messages[1].content + '\n\n【重要】输出必须是纯英文（角色名/场景名除外），不得出现任何中文描述词。' },
          ]
      const text = await chatCompletion(msgs, {
        temperature: 0.4,
        maxTokens: 2600,
        responseFormat: { type: 'json_object' },
        timeoutMs: 90000,
        usageContext: { task: 'h3-prompt-translate' },
      })
      const parsed = JSON.parse(text)
      const result = {
        description_en: String(parsed.description_en || '').trim(),
        action_note_en: String(parsed.action_note_en || '').trim(),
        soundscape_en: String(parsed.soundscape_en || '').trim(),
        music_en: String(parsed.music_en || '').trim(),
        tone_en: String(parsed.tone_en || '').trim(),
        failed: false,
      }
      const leaked = hasLeakedChinese(result.description_en)
        || hasLeakedChinese(result.action_note_en)
        || hasLeakedChinese(result.soundscape_en)
        || hasLeakedChinese(result.music_en)
        || hasLeakedChinese(result.tone_en)
      if (leaked) {
        console.warn(`[h3PromptTranslator] 第 ${attempt + 1} 次翻译输出含中文，${attempt === 0 ? '重试' : '先试删残救济'}`)
        if (attempt === 0) continue
        const rescued = rescueLeakedFields(result, hasLeakedChinese)
        if (rescued) {
          console.warn('[h3PromptTranslator] 两次翻译仍含中文，已删残救济保住英文主体（残留 CJK 已剔除）')
          translationCache.set(cacheKey, rescued)
          return rescued
        }
        console.warn('[h3PromptTranslator] 第 2 次翻译仍含中文且删残后无英文主体，放弃并降级')
        recordAlert({
          episodeId: shot.episode_id ?? null, shotId: shot.id ?? null, shotNumber: shot.shot_number || '',
          source: 'translate', level: 'warn',
          message: `镜 ${shot.shot_number || '?'} 的分镜字段翻译两次仍含中文、删残后无英文主体，已降级为空：本镜出片 prompt 将缺画面/动作/声景描述，请人工核对原文后重试`,
          detail: JSON.stringify({ leakedFields: ['description_en', 'action_note_en', 'soundscape_en', 'music_en', 'tone_en'].filter((k) => hasLeakedChinese(result[k])) }).slice(0, 2000),
        })
        const degraded = { ...empty, failed: true }
        translationCache.set(cacheKey, degraded)
        return degraded
      }
      translationCache.set(cacheKey, result)
      return result
    } catch (e) {
      console.warn(`[h3PromptTranslator] 第 ${attempt + 1} 次翻译失败:`, e.message)
      if (attempt === 0) continue
      const degraded = { ...empty, failed: true }
      translationCache.set(cacheKey, degraded)
      return degraded
    }
  }

  const degraded = { ...empty, failed: true }
  translationCache.set(cacheKey, degraded)
  return degraded
}


const parseDialogueLines = (raw) => {
  if (!raw) return []
  let o = raw
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw) } catch { return [] }
  }
  if (!o) return []
  if (Array.isArray(o)) return o.filter((x) => x && typeof x === 'object')
  return typeof o === 'object' ? [o] : []
}

const cleanSpeakerName = (s) => String(s || '').replace(/@/g, '').replace(/\s+/g, ' ').trim()

export function buildGlobalSpeakerMap(shotsInOrder = []) {
  const map = new Map()
  for (const shot of Array.isArray(shotsInOrder) ? shotsInOrder : []) {
    for (const d of parseDialogueLines(shot?.dialogue)) {
      const who = cleanSpeakerName(d?.character || d?.speaker || d?.name)
      const text = cleanSpeakerName(d?.text || d?.line || d?.content)
      if (!who || !text) continue
      if (!map.has(who)) map.set(who, 'S' + (map.size + 1))
    }
  }
  return map
}
