import path from 'node:path'
import dotenv from 'dotenv'
import { serverDir } from './paths.js'

dotenv.config({ path: path.join(serverDir, '.env') })

const LOCAL_PROXY_URL = process.env.ZIKL_PROXY || 'http://127.0.0.1:7897'

export const config = {
  port: process.env.PORT || 3000,

  host: process.env.SERVER_HOST || '127.0.0.1',

  defaultArtStyle: process.env.DEFAULT_ART_STYLE || '吉卜力风格',

  llm: {
    apiKey: process.env.ZHIPU_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    baseURL: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: process.env.LLM_MODEL || 'glm-5.2', 
    lightModel: process.env.LLM_LIGHT_MODEL ?? 'qwen3.8-flash',
    vlmModel: process.env.LLM_VLM_MODEL ?? 'qwen3.8-flash',
    maxConcurrent: Math.max(1, Number(process.env.LLM_MAX_CONCURRENT) || 6),
  },

  storyboard: {
    parallel: process.env.STORYBOARD_PARALLEL !== '0',
    fixAxis: process.env.STORYBOARD_FIX_AXIS !== '0',
    enrichConcurrency: Math.max(1, Number(process.env.ENRICH_CONCURRENCY) || 4),
    frameReview: process.env.FRAME_REVIEW !== '0',
    frameReviewRetry: Math.max(0, Number(process.env.FRAME_REVIEW_RETRY ?? 1)),
    sceneReview: process.env.SCENE_REVIEW === '1',
    sceneReviewRetry: Math.max(0, Number(process.env.SCENE_REVIEW_RETRY ?? 1)),
    lightTasks: (process.env.LLM_LIGHT_TASKS ?? 'h3-prompt-translate,style-prompt-en,lighting-check,storyboard-airlock,storyboard-axis,storyboard-geography')
      .split(',').map((s) => s.trim()).filter(Boolean),
    durationMin: Math.max(1, Number(process.env.SHOT_DURATION_MIN) || 4),
    durationMax: Math.max(1, Number(process.env.SHOT_DURATION_MAX) || 15),
    speechRateMaxCharsPerSec: Math.max(1, Number(process.env.DIALOGUE_SPEECH_RATE_MAX) || 5),
    speechRateMinChars: Math.max(1, Number(process.env.DIALOGUE_SPEECH_RATE_MIN_CHARS) || 3),
    longShotMinSec: Math.max(1, Number(process.env.LONG_SHOT_MIN_SEC) || 8),
    thinPromptChars: Math.max(1, Number(process.env.THIN_PROMPT_CHARS) || 80),
    qcPanelLimit: Math.max(50, Number(process.env.QC_PANEL_LIMIT) || 2000),
    qcFixBatchLimit: Math.max(1, Number(process.env.QC_FIX_BATCH_LIMIT) || 20),
    axisVerify: process.env.STORYBOARD_AXIS_VERIFY !== '0',

    multiBeatActionThreshold: Math.max(1, Number(process.env.MULTI_BEAT_ACTION_THRESHOLD) || 4),
    multiBeatActionWithConnector: Math.max(1, Number(process.env.MULTI_BEAT_ACTION_WITH_CONNECTOR) || 3),
    multiBeatConnectorThreshold: Math.max(1, Number(process.env.MULTI_BEAT_CONNECTOR_THRESHOLD) || 3),
    cutGainJaccardThreshold: Number(process.env.CUT_GAIN_JACCARD_THRESHOLD) || 0.4,
    cutGainLlmVerify: process.env.CUT_GAIN_LLM_VERIFY === '1',
    cutGainStructuralCheck: process.env.CUT_GAIN_STRUCTURAL_CHECK !== '0',
    reactionShotEnabled: process.env.REACTION_SHOT_CHECK !== '0',
    endingRushedRatio: Number(process.env.ENDING_RUSHED_RATIO) || 1.3,
    lightFlipEnabled: process.env.LIGHT_FLIP_CHECK !== '0',
    cameraMoveCheckEnabled: process.env.CAMERA_MOVE_CHECK !== '0',
    soundArcEnabled: process.env.SOUND_ARC_CHECK !== '0',
    silenceGapEnabled: process.env.SILENCE_GAP_CHECK !== '0',
    chainReactionCheckEnabled: process.env.CHAIN_REACTION_CHECK !== '0',
    emptyLongShotEnabled: process.env.EMPTY_LONG_SHOT_CHECK !== '0',
    emptyLongShotMinSec: Number(process.env.EMPTY_LONG_SHOT_MIN_SEC) || 8,
    musicLangCheckEnabled: process.env.MUSIC_LANG_CHECK !== '0',
    openingHookCheckEnabled: process.env.OPENING_HOOK_CHECK !== '0',
    openingHookMaxSec: Number(process.env.OPENING_HOOK_MAX_SEC) || 10,
    cutActionOverlapCheckEnabled: process.env.CUT_ACTION_OVERLAP_CHECK !== '0',
    actionDensityCheckEnabled: process.env.ACTION_DENSITY_CHECK !== '0',
    actionDensityMax: Number(process.env.ACTION_DENSITY_MAX) || 0.6,
    attrMonotoneCheckEnabled: process.env.ATTR_MONOTONE_CHECK !== '0',
    attrMonotoneAngleMax: Number(process.env.ATTR_MONOTONE_ANGLE_MAX) || 0.45,
    attrMonotoneShotTypeMax: Number(process.env.ATTR_MONOTONE_SHOTTYPE_MAX) || 0.4,
    attrMonotoneMoveMax: Number(process.env.ATTR_MONOTONE_MOVE_MAX) || 0.3,
  },

  assetState: {
    enabled: process.env.ASSET_STATE !== '0',
  },

  progress: {
    ttlAfterDoneMs: Math.max(1000, Number(process.env.PROGRESS_TTL_AFTER_DONE_MS) || 30_000),
    staleActiveMs: Math.max(60_000, Number(process.env.PROGRESS_STALE_ACTIVE_MS) || 30 * 60 * 1000),
    maxEntries: Math.max(10, Number(process.env.PROGRESS_MAX_ENTRIES) || 200),
  },

  runninghub: {
    apiKey: process.env.RUNNINGHUB_API_KEY || '',
    baseURL: 'https://www.runninghub.cn',
    workflows: {
      imageGenerator: '2092078813630001153', 
      storyboardGenerator: '2092895275319910402', 
      frameGridGenerator: process.env.RH_FRAME_GRID_WORKFLOW_ID || '',
      shotGridApp: process.env.RH_SHOT_GRID_APP_ID || '2048139846660657154',
      h3Combat: process.env.RH_H3_COMBAT_WORKFLOW_ID || '2094872667374571522',
      h3V4: process.env.RH_H3_V4_WORKFLOW_ID || '2097709786870673409',
      h3V4mc: process.env.RH_H3_V4_MC_WORKFLOW_ID || '',
    },
    motionContext: {
      enabled: process.env.RH_MOTION_CONTEXT_ENABLED === 'true',
    },
    h3CombatTimeoutMs: Number(process.env.RH_H3_COMBAT_TIMEOUT_MS) || 60 * 60 * 1000,
    shotGrid: {
      aspectRatio: process.env.RH_SHOT_GRID_ASPECT_RATIO || '9:16',
      resolution: process.env.RH_SHOT_GRID_RESOLUTION || '1k',
    },
    nodeMap: {
      imageGenerator: {
        prompt: { nodeId: '17', fieldName: 'prompt' },
      },
      storyboardGenerator: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        prompt: { nodeId: '1', fieldName: 'prompt' },
        negativePrompt: { nodeId: '13', fieldName: 'prompt' },
        image1: { nodeId: '22', fieldName: 'image' },
        image2: { nodeId: '30', fieldName: 'image' },
        llmApiBaseUrl: { nodeId: '27', fieldName: 'api_baseurl' },
        llmApiKey: { nodeId: '27', fieldName: 'api_key' },
        llmModel: { nodeId: '27', fieldName: 'model' },
      },
      frameGridGenerator: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        image1: { nodeId: '22', fieldName: 'image' },          
        image2: { nodeId: '30', fieldName: 'image' },          
        image3: { nodeId: '31', fieldName: 'image' },          
        userPrompt: { nodeId: '24', fieldName: 'text' },       
        target_vl_size: { nodeId: '1', fieldName: 'target_vl_size' },
        llmApiBaseUrl: { nodeId: '27', fieldName: 'api_baseurl' },
        llmApiKey: { nodeId: '27', fieldName: 'api_key' },
        llmModel: { nodeId: '27', fieldName: 'model' },
      },
      shotGridApp: {
        apiVersion: 'v2',
        kind: 'ai-app',
        instanceType: 'default',
        prompt: { nodeId: '13', fieldName: 'prompt' },
        aspectRatio: { nodeId: '14', fieldName: 'aspectRatio' },
        resolution: { nodeId: '14', fieldName: 'resolution' },
        image1: { nodeId: '2', fieldName: 'image' },
        image2: { nodeId: '8', fieldName: 'image' },
        image3: { nodeId: '9', fieldName: 'image' },
        image4: { nodeId: '10', fieldName: 'image' },
      },
      h3Combat: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        image1: { nodeId: '526', fieldName: 'image' },
        idea: { nodeId: '528', fieldName: 'prompt' },
        duration: { nodeId: '529', fieldName: 'value' },
        aspectRatio: { nodeId: '456', fieldName: 'aspect_ratio' },
        megapixels: { nodeId: '456', fieldName: 'megapixels' },
      },
      h3V4: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        prompt: { nodeId: '1400', fieldName: 'value' },
        image0: { nodeId: '1399', fieldName: 'image' },
        image1: { nodeId: '1395', fieldName: 'image' },
        image2: { nodeId: '1394', fieldName: 'image' },
        image3: { nodeId: '1398', fieldName: 'image' },
        image4: { nodeId: '1397', fieldName: 'image' },
        image5: { nodeId: '1396', fieldName: 'image' },
        image6: { nodeId: '1401', fieldName: 'image' },
        image7: { nodeId: '1403', fieldName: 'image' },
        image8: { nodeId: '1402', fieldName: 'image' },
        audio0: { nodeId: '1404', fieldName: 'audio' },
        audio1: { nodeId: '1406', fieldName: 'audio' },
        audio2: { nodeId: '1405', fieldName: 'audio' },
        duration: { nodeId: '1412', fieldName: 'value' },
        aspectRatio: { nodeId: '1410', fieldName: 'aspect_ratio' },
        megapixels: { nodeId: '1410', fieldName: 'megapixels' },
        combatLora: { nodeId: '1414', fieldName: 'lora_name' },
        combatLoraStrength: { nodeId: '1414', fieldName: 'strength_model' },
        unetName: { nodeId: '1380', fieldName: 'unet_name' },
        firstPassSteps: { nodeId: '124', fieldName: 'steps' },
        firstPassDenoise: { nodeId: '124', fieldName: 'denoise' },
        secondPassSteps: { nodeId: '1329', fieldName: 'steps' },
        secondPassDenoise: { nodeId: '1329', fieldName: 'denoise' },
        upscaleMegapixels: { nodeId: '1407', fieldName: 'value' },
        seed: { nodeId: '129', fieldName: 'noise_seed' },
      },
      get h3V4mc() {
        return { ...this.h3V4, video: { nodeId: '2001', fieldName: 'file' } }
      },
    },
  },

  image: {
    provider: process.env.IMAGE_PROVIDER || 'zikl',
    zikl: {
      apiKey: process.env.ZIKL_API_KEY || '',
      baseURL: process.env.ZIKL_BASE_URL || 'https://img.zikl.dev',
      model: process.env.ZIKL_IMAGE_MODEL || 'gpt-image-2',
      size: process.env.ZIKL_IMAGE_SIZE || '1K',
      proxy: LOCAL_PROXY_URL,
    },
    visionary: {
      apiKey: process.env.VISIONARY_API_KEY || '',
      baseURL: process.env.VISIONARY_BASE_URL || 'https://api.visionary.beer',
      proxy: process.env.VISIONARY_PROXY || LOCAL_PROXY_URL,
      model: process.env.VISIONARY_IMAGE_MODEL || 'nano-banana-pro',
      resolution: process.env.VISIONARY_IMAGE_RESOLUTION || '2K',
      size: process.env.VISIONARY_IMAGE_SIZE || '16:9',
      optimizeChineseText: process.env.VISIONARY_OPTIMIZE_CHINESE_TEXT === 'true',
      pollIntervalMs: Number(process.env.VISIONARY_POLL_INTERVAL_MS) || 3000,
      maxPollMs: Number(process.env.VISIONARY_MAX_POLL_MS) || 600000,
    },
  },

  db: {
    path: process.env.DB_PATH || path.join(serverDir, 'data.db'),
  },

  video: {
    defaultAspectRatio: process.env.DEFAULT_ASPECT_RATIO || '9:16 (Portrait Widescreen)',
    aspectRatios: [
      '4:3 (Standard)',
      '9:16 (Portrait Widescreen)',
      '16:9 (Widescreen)',
      '21:9 (Ultrawide)',
      '1:1 (Square)',
      '3:4 (Portrait Standard)',
    ],
    combatAspectRatios: [
      '1:1 (Square)',
      '2:3 (Portrait Photo)',
      '3:2 (Photo)',
      '3:4 (Portrait Standard)',
      '4:3 (Standard)',
      '9:16 (Portrait Widescreen)',
      '16:9 (Widescreen)',
      '21:9 (Ultrawide)',
    ],
    combatDurationMin: Math.max(1, Number(process.env.COMBAT_SHOT_MIN_SEC) || 5),
    combatDurationMax: Math.max(1, Number(process.env.COMBAT_SHOT_MAX_SEC) || 15),
    combatDefaultDuration: Math.max(1, Number(process.env.COMBAT_SHOT_DEFAULT_SEC) || 6),
  },

  ipRouter: {
    highConfidenceScore: Number(process.env.IP_ROUTER_HIGH_SCORE ?? 4),
    scoreIpName: Number(process.env.IP_ROUTER_SCORE_IP ?? 3),
    scoreCharacter: Number(process.env.IP_ROUTER_SCORE_CHAR ?? 2),
    scoreAlias: Number(process.env.IP_ROUTER_SCORE_ALIAS ?? 1),
    scoreMultiCharacter: Number(process.env.IP_ROUTER_SCORE_MULTI ?? 2),
    scoreBoundIp: Number(process.env.IP_ROUTER_SCORE_BOUND ?? 2),
    enableLlm: process.env.IP_ROUTER_ENABLE_LLM !== '0',
  },

  security: {
    downloadAllowHosts: String(process.env.DOWNLOAD_ALLOW_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
}
