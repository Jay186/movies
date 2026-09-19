import { createRouter, createWebHistory } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { toastWarn } from '../services/dialog'

const routes = [
  { path: '/', redirect: '/projects' },
  {
    path: '/projects',
    name: 'projects',
    component: () => import('../views/ProjectsView.vue'),
    meta: { tab: 'projects', title: '我的项目' },
  },
  {
    path: '/episodes',
    name: 'episodes',
    component: () => import('../views/EpisodesView.vue'),
    meta: { tab: 'episodes', title: '剧集' },
  },
  {
    path: '/script',
    name: 'script',
    component: () => import('../views/ScriptView.vue'),
    meta: { tab: 'script', title: '剧本' },
  },
  {
    path: '/art',
    name: 'art',
    component: () => import('../views/StyleStepView.vue'),
    meta: { tab: 'art', title: '画风' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { tab: 'settings', title: '设定' },
  },
  {
    path: '/storyboard',
    name: 'storyboard',
    component: () => import('../views/StoryboardView.vue'),
    meta: { tab: 'storyboard', title: '分镜' },
  },
  {
    path: '/video',
    name: 'video',
    component: () => import('../views/VideoView.vue'),
    meta: { tab: 'video', title: '短片' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 全局前置守卫：
//  - 项目列表 / 剧集列表是入口与项目主页，不被剧本/分镜确认校验拦截
//  - 进入设定/分镜/短片前必须已确认剧本；短片页额外要求分镜已确认
router.beforeEach(async (to) => {
  // 剧集列表需要已选中项目（刷新直达时兜底）
  if (to.meta.tab === 'episodes') {
    const store = useProjectStore()
    if (!store.initialized) {
      await Promise.race([store.ensureReady(), new Promise((r) => setTimeout(r, 5000))])
    }
    if (!store.currentProjectId) return { path: '/projects' }
    return
  }
  // 项目列表是工作台入口，不应被剧本/分镜确认校验拦截
  if (to.meta.tab !== 'script' && to.meta.tab !== 'projects') {
    const store = useProjectStore()
    // 等待初始化完成（刷新时 initProject 还在从后端加载数据），
    // 最多等 5 秒，超时按未确认处理，避免 !initialized 时直接放行绕过卡点
    if (!store.initialized) {
      await Promise.race([
        store.ensureReady(),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    }
    if (!store.scriptConfirmed) {
      toastWarn('请先在剧本页确认剧本', { detail: '确认后才能进入下一步' })
      return { path: '/script' }
    }
    if (to.meta.tab === 'video' && !store.storyboardConfirmed) {
      toastWarn('请先在分镜页确认分镜', { detail: '确认后才能进入短片创作' })
      return { path: '/storyboard' }
    }
  }
})

export default router
