
export const STORAGE_KEYS = {
  CURRENT_PROJECT: 'story-current-project-id',
  EPISODE_SELECTION: 'wb_last_episode_selection',
  PENDING_ASSET_GENS: 'wb_pending_asset_gens',
  IMAGE_MODEL: 'assetImageModel',
  VIDEO_MODEL: 'shotVideoModel',
}
export const STORAGE_KEY_PREFIX = {
  EXTRACT_FP: 'extract-fp-',
  STORYBOARD_FP: 'storyboard-fp-',
}

export const POLL = {
  INTERVAL_MS: 8000,
  MAX_POLLS: {
    IMAGE_JOB: 40,
    SHOT_GRID: 45,
    VIDEO_JOB: 60,
  },
}

export const TIMEOUTS = {
  ASSET_GEN_MS: 15 * 60 * 1000, 
}
export const DELAYS = {
  LOAD_RETRY_MS: 1200, 
  POLL_ERROR_RETRY_MS: 3000, 
  FULL_GEN_ERROR_STREAK: 10, 
  RESULT_BANNER_MS: 5000, 
}

export const BATCH_GEN = {
  IMAGE_CONCURRENCY: 5, 
  FRAME_RETRY: 1, 
  STORYBOARD_PROGRESS_POLL_MS: 1500, 
  PROGRESS_CLEAR_AFTER_MS: 6000,
}

export const DEFAULTS = {
  PROJECT_TITLE: '布布与一二的野日记',
  EPISODE_THEME: '做美食',
  ART_STYLE: '吉卜力风格',
  EMPTY_SUMMARY: '（暂无摘要）',
  AI_GREETING: '你可以先输入创作想法，我来生成剧本；也可以先导入剧本，再继续告诉我怎么修改。',
  ASPECT_RATIO: '9:16 (Portrait Widescreen)',
}

export const ASPECT_RATIO_OPTIONS = [
  { value: '9:16 (Portrait Widescreen)', label: '9:16', desc: '竖屏' },
  { value: '16:9 (Widescreen)', label: '16:9', desc: '横屏' },
  { value: '21:9 (Ultrawide)', label: '21:9', desc: '宽银幕' },
  { value: '1:1 (Square)', label: '1:1', desc: '方形' },
  { value: '4:3 (Standard)', label: '4:3', desc: '横向' },
  { value: '3:4 (Portrait Standard)', label: '3:4', desc: '竖向' },
]

export const FALLBACK_STYLE = {
  key: 'ghibli',
  label: '吉卜力风格',
  labelEn: 'Studio Ghibli Style',
  emoji: '',
  prompt: '',
  category: '2d',
}
