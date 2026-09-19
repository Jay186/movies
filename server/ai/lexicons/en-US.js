// 英文语言包（en-US）—— 验证算法与语言解耦的示例
//
// 本文件的存在本身就是通用性证明：同一套算法，换一个语言包即可服务英文剧本。
// 注意：本包是**结构示例**，词表为最小可用集（英文分词与中文差异大，
// 实战需按项目语料扩充——这正是词表该在数据层而非算法层的原因）。
export default {
  id: 'en-US',
  label: 'English',

  separators: /[·\-—/|,;\s]+/,

  env: {
    fog: ['fog', 'mist', 'haze', 'smog', 'foggy', 'misty'],
    light: [
      'dawn', 'morning', 'noon', 'midday', 'afternoon', 'dusk', 'sunset', 'twilight',
      'evening', 'night', 'midnight', 'moonlight', 'starlight', 'daylight', 'sunlight',
    ],
    weather: ['snow', 'rain', 'wind', 'storm', 'ice', 'frost', 'humid', 'dry', 'dust', 'sand', 'steam'],
  },

  verticalTerrain: [
    'cliff', 'cliff top', 'precipice', 'canyon', 'ravine', 'valley floor', 'gorge',
    'slope', 'hillside', 'staircase', 'stairs', 'ladder', 'rooftop', 'balcony',
    'basement', 'cellar', 'summit', 'hilltop', 'high ground', 'upper floor', 'lower floor',
  ],

  moveVerbs: [
    'descend', 'descended', 'climb', 'climbed', 'ascend', 'drop down', 'jump down',
    'walk down', 'went down', 'went up', 'cross', 'crossed', 'pass through', 'passed through',
    'wade', 'waded', 'swim', 'swam', 'arrive', 'arrived', 'reach', 'reached',
    'enter', 'entered', 'exit', 'exited', 'step by step', 'one by one', 'approach', 'approached',
  ],

  transition: [
    'fade', 'faded', 'clear', 'cleared', 'lift', 'lifted', 'settle', 'settled',
    'dissipate', 'dissipated', 'linger', 'lingered', 'gradually', 'slowly', 'subside', 'subsided',
    'drift away', 'drifted away', 'thin out', 'thinned out', 'roll back', 'rolled back',
    'pull back', 'pulled back', 'hang there', 'stay above', 'stay behind',
    'step out of', 'steps out of', 'walk out of', 'walks out of',
    'emerge from', 'emerges from', 'break through', 'breaks through', 'pierce through',
  ],

  // 渐变锚点：证明"移动过程被展开写了"（与 zh-CN 的 gradualMarkers 同义）
  // ⚠️ 同样不收 "first / then / next / finally" 这类通用递进连词——
  // 它们在任何叙事里都会出现，会让"过程未展开"被误豁免。
  gradualMarkers: [
    'step by step', 'one by one', 'little by little', 'bit by bit', 'layer by layer',
    'more and more', 'closer and closer', 'farther and farther', 'gradually', 'slowly',
    'turn into', 'turns into', 'give way to', 'gives way to', 'reveal', 'reveals',
    'come into view', 'comes into view', 'grow closer', 'grows closer',
    'draws nearer', 'draw nearer', 'looms larger', 'loom larger',
    'more clearly', 'comes into focus', 'come into focus',
  ],

  // 剧本结构识别（与 zh-CN 的 structure 同义，按英文剧本书写约定）
  structure: {
    sceneHeader: /^(scene|sc)\s*\d+/i,
    settingHead: /^(setting|location|space|environment|time)\s*[:：]/i,
  },

  placeNoise: [
    'medium shot', 'wide shot', 'close-up', 'extreme wide', 'full shot', 'medium close',
    'dawn', 'morning', 'noon', 'afternoon', 'dusk', 'evening', 'night',
    'int', 'ext', 'interior', 'exterior',
  ],

  // 英文用空格分词，故"bad head"按整词判断（此处给空正则，由实现按词匹配）
  placeBadHead: /^(the|a|an|and|or|but|of|in|on|at|to|for|with|from|by|is|are|was|were)$/,

  // 英文地点后缀多用整词，此处简化为常见地形/场所词尾
  placeTail: /(cliff|canyon|valley|forest|river|lake|sea|city|street|hall|room|yard|garden|field|mountain|island|bridge|shore|bank|road|path|gate|tower)$/,

  messages: {
    envJump: (ctx) =>
      `Scene ${ctx.curNo}: the following environment elements present in the previous scene ` +
      `(scene ${ctx.prevNo}) disappear entirely here with no transition — ` +
      ctx.jumped.map((j) => `${ctx.familyLabel[j.family] || j.family} (${j.prevHits.join(', ')})`).join('; ') +
      `. Viewers will feel a spatial break, which is the typical cause of ` +
      `"adjacent scenes look like two different places". Describe when and how these change.`,

    handoffMissing: (ctx) =>
      `Scene ${ctx.prevNo} -> scene ${ctx.curNo}: the previous scene has vertical terrain ` +
      `(${ctx.prevVHits.join(', ')}) but this scene describes no movement process ` +
      `(a static place name does not count). The storyboard artist has no transition basis, ` +
      `so the two scenes will look unrelated. Add the movement, e.g. "descends the mountain path", ` +
      `"rounds three bends".`,

    handoffThin: (ctx) =>
      `Scene ${ctx.prevNo} -> scene ${ctx.curNo}: the previous scene has vertical terrain ` +
      `(${ctx.prevVHits.join(', ')}) but this scene compresses the movement into isolated ` +
      `verb(s) (${ctx.moveHits.join(', ')}) with no process laid out — the storyboard artist ` +
      `cannot derive transition shots and must hard-cut from the previous scene's last shot ` +
      `to this scene's first shot. Expand it into cuttable beats: graded progression ` +
      `("step by step"), continuous change (snow -> wet stone -> gravel), or a target ` +
      `growing closer ("the bridge comes into view").`,

    objectForm: (ctx) =>
      `"${ctx.object}" is described with inconsistent forms across scenes: ` +
      ctx.seen.map((s) => `${s.label} uses "${s.hits.join(', ')}"`).join('; ') +
      `. The same object must keep one form (material / structure / break position / orientation) ` +
      `across scenes, otherwise it will be rendered as two different things.`,

    summaryDrift: (ctx) =>
      `Scene ${ctx.sceneNo}: script text and scene-asset summary describe different environments. ` +
      (ctx.onlySummary.length ? `summary-only: ${ctx.onlySummary.join(', ')}; ` : '') +
      (ctx.onlyScript.length ? `script-only: ${ctx.onlyScript.join(', ')}; ` : '') +
      `Downstream storyboard consumes the summary, so visuals will drift from the script. ` +
      `Reconcile the summary against the script.`,

    sceneLabel: (n) => `scene #${n}`,
    sceneLabelWithNo: (no) => `scene ${no}`,
    listSep: ', ',
    unknownScene: '?',
    logSummary: (ctx) =>
      `[continuityGuard] ${ctx.sceneCount} scenes, ${ctx.warnCount} warnings.` +
      ctx.items.map((w) => ` [${w.code}]scene${w.scene}`).join(''),
  },

  familyLabel: { fog: 'fog/visibility', light: 'light/time-of-day', weather: 'weather/moisture' },
}
