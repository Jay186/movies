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

  gradualMarkers: [
    'step by step', 'one by one', 'little by little', 'bit by bit', 'layer by layer',
    'more and more', 'closer and closer', 'farther and farther', 'gradually', 'slowly',
    'turn into', 'turns into', 'give way to', 'gives way to', 'reveal', 'reveals',
    'come into view', 'comes into view', 'grow closer', 'grows closer',
    'draws nearer', 'draw nearer', 'looms larger', 'loom larger',
    'more clearly', 'comes into focus', 'come into focus',
  ],

  structure: {
    sceneHeader: /^(scene|sc)\s*\d+/i,
    settingHead: /^(setting|location|space|environment|time)\s*[:：]/i,
  },

  placeNoise: [
    'medium shot', 'wide shot', 'close-up', 'extreme wide', 'full shot', 'medium close',
    'dawn', 'morning', 'noon', 'afternoon', 'dusk', 'evening', 'night',
    'int', 'ext', 'interior', 'exterior',
  ],

  placeBadHead: /^(the|a|an|and|or|but|of|in|on|at|to|for|with|from|by|is|are|was|were)$/,

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
