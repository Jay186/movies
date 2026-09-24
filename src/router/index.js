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
    component: () => import('../views/AssetsView.vue'),
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

router.beforeEach(async (to) => {
  if (to.meta.tab === 'episodes') {
    const store = useProjectStore()
    if (!store.initialized) {
      await Promise.race([store.ensureReady(), new Promise((r) => setTimeout(r, 5000))])
    }
    if (!store.currentProjectId) return { path: '/projects' }
    return
  }
  if (to.meta.tab !== 'script' && to.meta.tab !== 'projects') {
    const store = useProjectStore()
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
