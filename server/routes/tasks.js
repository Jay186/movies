import { Router } from 'express'
import { queryOne } from '../db.js'

const router = Router()

// 查询任务状态
router.get('/:taskId', (req, res) => {
  const task = queryOne('SELECT * FROM tasks WHERE id = ?', [req.params.taskId])
  if (!task) return res.status(404).json({ error: '任务不存在' })

  let result = null
  if (task.result) {
    try {
      result = JSON.parse(task.result)
    } catch {
      result = task.result
    }
  }

  res.json({
    id: task.id,
    type: task.type,
    status: task.status,
    progress: task.progress,
    message: task.message,
    result,
    error: task.error,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  })
})

export default router
