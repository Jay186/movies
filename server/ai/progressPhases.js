
export const PHASE = {
  START: 'start',            
  PREPARE: 'prepare',        
  DONE: 'done',              

  SCENES: 'scenes',          
  AIRLOCK: 'airlock',        
  SINGLE: 'single',          

  NORMALIZE: 'normalize',    
  RETRY: 'retry',            

  ENRICH: 'enrich',          
  AXIS: 'axis',              
}

const PHASE_LABEL = {
  [PHASE.START]: '准备中',
  [PHASE.PREPARE]: '准备中',
  [PHASE.DONE]: '已完成',

  [PHASE.SCENES]: '分场生成',
  [PHASE.AIRLOCK]: '画面衔接',
  [PHASE.SINGLE]: '整本生成',

  [PHASE.NORMALIZE]: '结构规整',
  [PHASE.RETRY]: '自动重试',

  [PHASE.ENRICH]: '提示词补全',
  [PHASE.AXIS]: '越轴巡检',
}

export function labelOfPhase(phase) {
  const key = String(phase || '')
  if (!key) return ''
  return PHASE_LABEL[key] || key
}

export function allPhases() {
  return Object.values(PHASE)
}
