<script setup>
import { computed, ref } from 'vue'
import { useProjectStore } from '../stores/project'

const props = defineProps({
  plan: { type: Object, default: null },
  shot: { type: Object, default: null },
  compact: { type: Boolean, default: false },
})

const store = useProjectStore()
const expanded = ref(false)

const STAGE_W = 540
const STAGE_H = 960

const clamp = (v, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return Math.round(max / 2)
  return Math.round(Math.min(Math.max(n, 0), max))
}
const safePlan = computed(() => {
  const p = props.plan
  if (!p) return null
  const clone = JSON.parse(JSON.stringify(p))
  const fixXY = (o) => {
    if (o && typeof o === 'object') {
      if (o.x !== undefined) o.x = clamp(o.x, STAGE_W)
      if (o.y !== undefined) o.y = clamp(o.y, STAGE_H)
    }
  }
  for (const r of clone.regions || []) fixXY(r)
  for (const pr of clone.props || []) fixXY(pr)
  for (const c of clone.cameras || []) fixXY(c)
  for (const c of clone.characters || []) {
    fixXY(c.start)
    fixXY(c.end)
    for (const a of c.actions || []) fixXY(a.to)
  }
  for (const x of clone.intersections || []) fixXY(x)
  for (const d of (Array.isArray(clone.dialogue) ? clone.dialogue : (clone.dialogue ? [clone.dialogue] : []))) fixXY(d)
  return clone
})

const stagePoints = '120,180 420,180 460,840 80,840'

const CHAR_COLOR_POOL = ['#6b9bd1', '#e8a849', '#a86bd1', '#6bd1a8', '#d16b9b', '#d1a86b']
function getCharColor(c) {
  if (c?.color) return c.color
  const fromStore = store.characters.find((x) => x.name === c?.name)?.color
  return fromStore || CHAR_COLOR_POOL[0]
}

function buildPath(c) {
  const pts = []
  if (c?.start) pts.push(c.start)
  if (Array.isArray(c?.actions)) for (const a of c.actions) if (a?.to) pts.push(a.to)
  if (c?.end) pts.push(c.end)
  if (pts.length < 2) return ''
  return 'M ' + pts.map((p) => `${p.x},${p.y}`).join(' L ')
}

function gazeTarget(c) {
  if (!c?.gaze || !c?.start) return null
  const g = String(c.gaze)
  const atMatch = g.match(/@(.+)/)
  if (atMatch) {
    const targetName = atMatch[1]
    const targetChar = (safePlan.value?.characters || []).find((x) => x.name === targetName)
    if (targetChar?.start) return { x: targetChar.start.x, y: targetChar.start.y }
    const targetProp = (safePlan.value?.props || []).find((x) => x.name === targetName)
    if (targetProp) return { x: targetProp.x, y: targetProp.y }
  }
  if (g.includes('镜头')) return { x: STAGE_W / 2, y: 120 }
  if (g.includes('左')) return { x: Math.max(40, c.start.x - 80), y: c.start.y }
  if (g.includes('右')) return { x: Math.min(STAGE_W - 40, c.start.x + 80), y: c.start.y }
  if (g.includes('上')) return { x: c.start.x, y: Math.max(120, c.start.y - 80) }
  if (g.includes('下')) return { x: c.start.x, y: Math.min(STAGE_H - 40, c.start.y + 80) }
  return null
}

function toggleExpand() {
  if (props.compact) expanded.value = true
}
function closeExpand(e) {
  if (e.target === e.currentTarget) expanded.value = false
}
function open() {
  expanded.value = true
}
function close() {
  expanded.value = false
}
defineExpose({ open, close })

const hasContent = computed(() => !!safePlan.value && Array.isArray(safePlan.value.characters) && safePlan.value.characters.length > 0)
</script>

<template>
  <div v-if="!hasContent" class="empty">未生成</div>

  <div v-else class="blocking-chart" :class="{ compact }">
    <div class="svg-wrap" @click="toggleExpand">
      <svg :viewBox="`0 0 ${STAGE_W} ${STAGE_H}`" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="镜头站位图">
        <defs>
          <marker id="gazeArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </marker>
        </defs>
        <polygon :points="stagePoints" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.25)" stroke-width="2" />
        <line :x1="STAGE_W / 2" y1="180" :y2="840" :x2="STAGE_W / 2" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4 6" />

        <template v-for="(wall, i) in safePlan.sceneLayout?.walls || []" :key="'wall' + i">
          <line
            v-if="wall.points && wall.points.length >= 2"
            :x1="wall.points[0][0]" :y1="wall.points[0][1]"
            :x2="wall.points[1][0]" :y2="wall.points[1][1]"
            stroke="rgba(180,180,200,0.5)" stroke-width="3" stroke-linecap="round"
          />
          <text v-if="!compact && wall.label" :x="(wall.points[0][0] + wall.points[1][0]) / 2" :y="(wall.points[0][1] + wall.points[1][1]) / 2 - 8" text-anchor="middle" fill="rgba(180,180,200,0.6)" font-size="10">{{ wall.label }}</text>
        </template>

        <template v-for="(furn, i) in safePlan.sceneLayout?.furniture || []" :key="'furn' + i">
          <rect
            :x="furn.x - (furn.width || 60) / 2" :y="furn.y - (furn.height || 40) / 2"
            :width="furn.width || 60" :height="furn.height || 40"
            :rx="4" :transform="furn.rotation ? `rotate(${furn.rotation} ${furn.x} ${furn.y})` : ''"
            fill="rgba(150,150,170,0.2)" stroke="rgba(150,150,170,0.6)" stroke-width="1.5"
          />
          <text v-if="!compact" :x="furn.x" :y="furn.y + 4" text-anchor="middle" fill="rgba(180,180,200,0.7)" font-size="10">{{ furn.name }}</text>
        </template>

        <template v-for="r in safePlan.regions || []" :key="r.id">
          <circle :cx="r.x" :cy="r.y" r="3" fill="rgba(255,255,255,0.35)" />
          <text v-if="!compact" :x="r.x" :y="r.y - 10" text-anchor="middle" fill="rgba(255,255,255,0.55)" font-size="12">{{ r.id }}</text>
          <text v-if="!compact" :x="r.x" :y="r.y + 8" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">{{ r.label }}</text>
        </template>

        <template v-for="(p, i) in safePlan.props || []" :key="'p' + i">
          <rect :x="p.x - 9" :y="p.y - 9" width="18" height="18" rx="3" fill="rgba(234,154,73,0.25)" stroke="#e8a849" stroke-width="1.2" />
          <text v-if="!compact" :x="p.x" :y="p.y + 26" text-anchor="middle" fill="#e8a849" font-size="11">{{ p.name }}</text>
        </template>

        <template v-for="(cam, i) in safePlan.cameras || []" :key="'cam' + i">
          <polygon :points="`${cam.x},${cam.y - 10} ${cam.x - 8},${cam.y + 6} ${cam.x + 8},${cam.y + 6}`" fill="rgba(234,154,73,0.35)" stroke="#e8a849" stroke-width="1.2" />
          <text :x="cam.x" :y="cam.y + 2" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">{{ cam.id }}</text>
          <text v-if="!compact" :x="cam.x" :y="cam.y + 22" text-anchor="middle" fill="#e8a849" font-size="9">{{ cam.label }}</text>
        </template>

        <template v-for="(c, i) in safePlan.characters || []" :key="'gaze' + i">
          <line v-if="!compact && gazeTarget(c)" :x1="c.start.x" :y1="c.start.y" :x2="gazeTarget(c).x" :y2="gazeTarget(c).y" stroke="rgba(255,255,255,0.45)" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#gazeArrow)" />
        </template>

        <template v-for="(c, i) in safePlan.characters || []" :key="'c' + i">
          <path :d="buildPath(c)" :stroke="getCharColor(c)" stroke-width="2.5" fill="none" stroke-dasharray="7 5" opacity="0.75" />
          <template v-for="(a, ai) in c.actions || []" :key="ai">
            <circle :cx="a.to.x" :cy="a.to.y" r="9" :fill="getCharColor(c)" opacity="0.85" />
            <text v-if="!compact" :x="a.to.x" :y="a.to.y + 4" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">{{ a.seq }}</text>
            <text v-if="!compact" :x="a.to.x" :y="a.to.y - 14" text-anchor="middle" :fill="getCharColor(c)" font-size="10">{{ a.label }}</text>
          </template>
          <circle :cx="c.start.x" :cy="c.start.y" r="16" :fill="getCharColor(c)" stroke="#fff" stroke-width="2.5" />
          <text v-if="!compact" :x="c.start.x" :y="c.start.y + 5" text-anchor="middle" fill="#fff" font-size="13" font-weight="700">{{ (c.name || '?').charAt(0) }}</text>
          <text v-if="!compact" :x="c.start.x" :y="c.start.y + 30" text-anchor="middle" :fill="getCharColor(c)" font-size="11">{{ c.name }}</text>
          <circle :cx="c.end.x" :cy="c.end.y" r="11" :fill="getCharColor(c)" opacity="0.35" stroke="none" />
        </template>

        <template v-for="(x, i) in safePlan.intersections || []" :key="'x' + i">
          <circle :cx="x.x" :cy="x.y" r="14" fill="none" stroke="#e24b4a" stroke-width="3" />
          <text v-if="!compact" :x="x.x" :y="x.y - 18" text-anchor="middle" fill="#e24b4a" font-size="11" font-weight="700">{{ x.label }}</text>
        </template>

        <template v-for="(d, i) in safePlan.dialogue || []" :key="'d' + i">
          <g v-if="!compact">
            <rect :x="d.x - 48" :y="d.y - 22" width="96" height="36" rx="8" fill="rgba(0,0,0,0.65)" stroke="rgba(255,255,255,0.35)" stroke-width="1" />
            <text :x="d.x" :y="d.y - 8" text-anchor="middle" fill="#e8a849" font-size="10" font-weight="700">{{ d.character }}</text>
            <text :x="d.x" :y="d.y + 6" text-anchor="middle" fill="#fff" font-size="10">{{ (d.text || '').length > 9 ? (d.text || '').slice(0, 9) + '…' : d.text }}</text>
          </g>
        </template>
      </svg>
    </div>

    <div v-if="!compact" class="legend">
      <div class="legend-row" v-for="(c, i) in safePlan.characters || []" :key="i">
        <span class="dot" :style="{ background: getCharColor(c) }"></span>
        <span class="name">{{ c.name }}</span>
        <span class="facing" v-if="c.facing">朝向 {{ c.facing }}</span>
      </div>
      <div class="legend-row" v-if="(safePlan.intersections || []).length">
        <span class="ring"></span>
        <span class="name">交汇点</span>
      </div>
      <div class="legend-row" v-if="shot">
        <span class="meta">镜号 {{ shot.shotNumber }} · {{ shot.duration }}s · {{ shot.shotType }}</span>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="expanded" class="overlay" @click="closeExpand">
        <div class="overlay-card">
          <div class="overlay-head">
            <span>站位图 · 镜头 {{ shot?.shotNumber }}</span>
            <button @click="expanded = false">✕</button>
          </div>
          <div class="overlay-body">
            <div class="blocking-chart" style="height: auto; max-height: 70vh;">
              <div class="svg-wrap" style="max-height: 70vh;">
                <svg :viewBox="`0 0 ${STAGE_W} ${STAGE_H}`" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
                  <defs>
                    <marker id="gazeArrow2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </marker>
                  </defs>
                  <polygon :points="stagePoints" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.25)" stroke-width="2" />
                  <line :x1="STAGE_W / 2" y1="180" :y2="840" :x2="STAGE_W / 2" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4 6" />
                  <template v-for="(wall, i) in safePlan.sceneLayout?.walls || []" :key="'wall2' + i">
                    <line
                      v-if="wall.points && wall.points.length >= 2"
                      :x1="wall.points[0][0]" :y1="wall.points[0][1]"
                      :x2="wall.points[1][0]" :y2="wall.points[1][1]"
                      stroke="rgba(180,180,200,0.5)" stroke-width="3" stroke-linecap="round"
                    />
                    <text v-if="wall.label" :x="(wall.points[0][0] + wall.points[1][0]) / 2" :y="(wall.points[0][1] + wall.points[1][1]) / 2 - 8" text-anchor="middle" fill="rgba(180,180,200,0.6)" font-size="10">{{ wall.label }}</text>
                  </template>
                  <template v-for="(furn, i) in safePlan.sceneLayout?.furniture || []" :key="'furn2' + i">
                    <rect
                      :x="furn.x - (furn.width || 60) / 2" :y="furn.y - (furn.height || 40) / 2"
                      :width="furn.width || 60" :height="furn.height || 40"
                      :rx="4" :transform="furn.rotation ? `rotate(${furn.rotation} ${furn.x} ${furn.y})` : ''"
                      fill="rgba(150,150,170,0.2)" stroke="rgba(150,150,170,0.6)" stroke-width="1.5"
                    />
                    <text :x="furn.x" :y="furn.y + 4" text-anchor="middle" fill="rgba(180,180,200,0.7)" font-size="10">{{ furn.name }}</text>
                  </template>
                  <template v-for="r in safePlan.regions || []" :key="r.id">
                    <circle :cx="r.x" :cy="r.y" r="3" fill="rgba(255,255,255,0.35)" />
                    <text :x="r.x" :y="r.y - 10" text-anchor="middle" fill="rgba(255,255,255,0.55)" font-size="12">{{ r.id }}</text>
                    <text :x="r.x" :y="r.y + 8" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">{{ r.label }}</text>
                  </template>
                  <template v-for="(p, i) in safePlan.props || []" :key="'p' + i">
                    <rect :x="p.x - 9" :y="p.y - 9" width="18" height="18" rx="3" fill="rgba(234,154,73,0.25)" stroke="#e8a849" stroke-width="1.2" />
                    <text :x="p.x" :y="p.y + 26" text-anchor="middle" fill="#e8a849" font-size="11">{{ p.name }}</text>
                  </template>
                  <template v-for="(cam, i) in safePlan.cameras || []" :key="'cam' + i">
                    <polygon :points="`${cam.x},${cam.y - 10} ${cam.x - 8},${cam.y + 6} ${cam.x + 8},${cam.y + 6}`" fill="rgba(234,154,73,0.35)" stroke="#e8a849" stroke-width="1.2" />
                    <text :x="cam.x" :y="cam.y + 2" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">{{ cam.id }}</text>
                    <text :x="cam.x" :y="cam.y + 22" text-anchor="middle" fill="#e8a849" font-size="9">{{ cam.label }}</text>
                  </template>
                  <template v-for="(c, i) in safePlan.characters || []" :key="'gaze' + i">
                    <line v-if="gazeTarget(c)" :x1="c.start.x" :y1="c.start.y" :x2="gazeTarget(c).x" :y2="gazeTarget(c).y" stroke="rgba(255,255,255,0.45)" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#gazeArrow2)" />
                  </template>
                  <template v-for="(c, i) in safePlan.characters || []" :key="'c' + i">
                    <path :d="buildPath(c)" :stroke="getCharColor(c)" stroke-width="2.5" fill="none" stroke-dasharray="7 5" opacity="0.75" />
                    <template v-for="(a, ai) in c.actions || []" :key="ai">
                      <circle :cx="a.to.x" :cy="a.to.y" r="9" :fill="getCharColor(c)" opacity="0.85" />
                      <text :x="a.to.x" :y="a.to.y + 4" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">{{ a.seq }}</text>
                      <text :x="a.to.x" :y="a.to.y - 14" text-anchor="middle" :fill="getCharColor(c)" font-size="10">{{ a.label }}</text>
                    </template>
                    <circle :cx="c.start.x" :cy="c.start.y" r="16" :fill="getCharColor(c)" stroke="#fff" stroke-width="2.5" />
                    <text :x="c.start.x" :y="c.start.y + 5" text-anchor="middle" fill="#fff" font-size="13" font-weight="700">{{ (c.name || '?').charAt(0) }}</text>
                    <text :x="c.start.x" :y="c.start.y + 30" text-anchor="middle" :fill="getCharColor(c)" font-size="11">{{ c.name }}</text>
                    <circle :cx="c.end.x" :cy="c.end.y" r="11" :fill="getCharColor(c)" opacity="0.35" stroke="none" />
                  </template>
                  <template v-for="(x, i) in safePlan.intersections || []" :key="'x' + i">
                    <circle :cx="x.x" :cy="x.y" r="14" fill="none" stroke="#e24b4a" stroke-width="3" />
                    <text :x="x.x" :y="x.y - 18" text-anchor="middle" fill="#e24b4a" font-size="11" font-weight="700">{{ x.label }}</text>
                  </template>
                  <template v-for="(d, i) in safePlan.dialogue || []" :key="'d' + i">
                    <g>
                      <rect :x="d.x - 48" :y="d.y - 22" width="96" height="36" rx="8" fill="rgba(0,0,0,0.65)" stroke="rgba(255,255,255,0.35)" stroke-width="1" />
                      <text :x="d.x" :y="d.y - 8" text-anchor="middle" fill="#e8a849" font-size="10" font-weight="700">{{ d.character }}</text>
                      <text :x="d.x" :y="d.y + 6" text-anchor="middle" fill="#fff" font-size="10">{{ (d.text || '').length > 9 ? (d.text || '').slice(0, 9) + '…' : d.text }}</text>
                    </g>
                  </template>
                </svg>
              </div>
              <div class="legend">
                <div class="legend-row" v-for="(c, i) in safePlan.characters || []" :key="i">
                  <span class="dot" :style="{ background: getCharColor(c) }"></span>
                  <span class="name">{{ c.name }}</span>
                  <span class="facing" v-if="c.facing">朝向 {{ c.facing }}</span>
                </div>
                <div class="legend-row" v-if="(safePlan.intersections || []).length">
                  <span class="ring"></span><span class="name">交汇点</span>
                </div>
                <div class="legend-row" v-if="shot">
                  <span class="meta">镜号 {{ shot.shotNumber }} · {{ shot.duration }}s · {{ shot.shotType }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
}
.blocking-chart {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(30, 30, 40, 0.4), rgba(20, 20, 30, 0.6));
  border-radius: 8px;
  overflow: hidden;
}
.blocking-chart.compact .svg-wrap {
  cursor: zoom-in;
}
.svg-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.legend {
  padding: 6px 8px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.7);
  background: rgba(0, 0, 0, 0.3);
  flex-shrink: 0;
}
.legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.ring {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid #e24b4a;
  display: inline-block;
  box-sizing: border-box;
}
.name {
  font-weight: 500;
}
.facing {
  color: rgba(255, 255, 255, 0.5);
  margin-left: auto;
}
.meta {
  color: rgba(255, 255, 255, 0.4);
  font-size: 9px;
}
.overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.8);
  padding: 24px;
}
.overlay-card {
  background: #1a1a22;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  max-width: 520px;
  width: 100%;
  overflow: hidden;
}
.overlay-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
}
.overlay-head button {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 16px;
  cursor: pointer;
}
.overlay-body {
  padding: 16px;
}
</style>
