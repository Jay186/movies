
import { LAYOUT_IMAGE_SUBJECT, LAYOUT_IMAGE_NEGATIVE } from './anchorTypes.js'

const PLAIN = '本画面的时间、光线方向与色调以场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。'
const LC_RE = /（本场景光照常量：([^）]*)）本画面的时间、光线方向与色调以该光照常量与场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。/
const PLAIN_ANCHORED = '本画面的时段、天气与色温以场景描述为准，画风只统一笔触、上色与线条质感；空间结构、地标物体的形态与相对位置、光照方向以参考锚图为准，与锚图保持连续；但视角、机位高度、景别与画面主体占比不受锚图约束，一律以本场景文字描述为准。'
const lcAnchored = (lc) =>
  `（本场景光照常量：${lc}）本画面的时段、天气与色温以场景描述为准，画风只统一笔触、上色与线条质感；空间结构、地标物体的形态与相对位置、光照方向以参考锚图为准，与锚图保持连续；但视角、机位高度、景别与画面主体占比不受锚图约束，一律以本场景文字描述为准。`

export const ANCHOR_PRIORITY_NOTE =
  '【锚图优先级】本句中「锚图」专指用于锁定空间结构、地标物体形态与光照方向的那几张参考图；' +
  '仅作画法示意（如俯视/轴测的布局图）或仅作画风参考的图不算锚图，' +
  '不得把它们的视角、构图、光影、色温或示意画法带入本画面。' +
  '当本句与画面描述中关于光照、空间结构或地标物体形态的表述冲突时，以参考图（锚图）为准；' +
  '但视角、机位高度、景别与画面主体占比以本场景文字描述为准，不受锚图约束；' +
  '时段、天气与色温以本场景文字描述为准。'

export function swapSceneLightingNote(prompt) {
  let s = String(prompt || '')
  s = s.split(PLAIN).join(PLAIN_ANCHORED) 
  s = s.replace(LC_RE, (_, lc) => lcAnchored(lc)) 
  return s
}


export function buildLayoutImagePrompt(p = {}) {
  const group = String(p.group || '').trim()
  const roles = (Array.isArray(p.roles) ? p.roles : []).map((s) => String(s || '').trim()).filter(Boolean)
  const landmarks = (Array.isArray(p.landmarks) ? p.landmarks : []).map((s) => String(s || '').trim()).filter(Boolean)
  const env = (Array.isArray(p.env) ? p.env : []).map((s) => String(s || '').trim()).filter(Boolean)
  const styleText = String(p.styleText || '').trim()
  const retryNote = String(p.retryNote || '')


  const landmarksNote = landmarks.length
    ? `空间里要摆出的东西：${landmarks.join('、')}。` +
      `把其中属于地形、水体、植被、建筑、道具的，用形状与色块**直接画出来**，画出它们各自的形态、位置与朝向。` +
      `雾、云、雨、雪、水汽、天光、色调属于大气与光照，不在本图表达范围内。`
    : ''
  const rolesNote = roles.length
    ? `本空间有这几个观察位置：${roles.join('；')}。` +
      `它们的作用只是帮你确认物体之间的方位关系（谁在谁对面、谁在谁上方），` +
      `用来安排物体的相互位置即可，它们本身不出现在画面上。`
    : ''
  const envNote = env.length
    ? `这个地点的背景交代：${env.join('、')}。` +
      `它们只是地点层面的背景，不保证每个观察位置都看得见，` +
      `画成远处背景的一层色带示意就够，具体形态留到各个场景里去表现。`
    : ''

  const styleNote = styleText ? `绘制风格：${styleText}，但仅为示意，不追求写实渲染。` : ''

  return (
    `${LAYOUT_IMAGE_SUBJECT}（${group || '该空间'}）。` +
    `画法：斜俯视的等轴测，像一块可以拿在手里的**分层积木**——崖顶、坡面、谷底、水面各在一个高度上，` +
    `层与层之间的高低落差一眼就读得出来。` +
    `${landmarksNote}${rolesNote}${envNote}` +
    `物体之间的相对位置、朝向与距离比例要清楚可读，不同物体靠**形状、色块和线条**区分开。` +
    `${styleNote}` +
    `${LAYOUT_IMAGE_NEGATIVE}` +
    `${retryNote}`
  )
}

