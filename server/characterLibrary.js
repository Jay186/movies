// 项目级 IP 角色库：跨集共享的角色"主设定"
//
// 背景：布布、一二这类主角贯穿全剧，但以前每集各存一份 character 行（各自 AI 提取、
// 各自换图改描述），结果跨集形象漂移——第 11 集一二是熊猫，第 13 集一二是浅棕小熊，
// 视频生成时参考图与文字描述还会互相打架。
//
// 方案：主设定只存 project_characters 一份；各集 characters 行通过 project_character_id
// 链接过来，读时以主设定为准、编辑时回写主设定并同步所有集。
import { query, queryOne, execute, transaction } from './db.js'
// 重新提取覆盖保护（2026-09-16 P1）：覆盖前快照 + 智能 diff + 「全部保留我的」决策应用
import {
  snapshotBeforeExtract,
  computeExtractDiff,
  applyKeepForCharacters,
} from './ai/extractGuard.js'

// 英文字段（2026-09-14，选角雷根治）：中文/英文双份描述。英文供 H3 全英文 prompt
// 消费；description_en 必须含物种/毛色等硬特征（extractAssets prompt 侧强制）。
const MASTER_FIELDS = ['name', 'role', 'description', 'appearance', 'image_url', 'audio_url', 'color', 'name_en', 'description_en']

// 取某项目的主设定列表（按 id 索引）
export function getProjectCharacters(projectId) {
  if (!projectId) return []
  return query('SELECT * FROM project_characters WHERE project_id = ? ORDER BY id', [projectId])
}

// 取主设定（按 id 或按名）
export function findProjectCharacter(projectId, { id, name }) {
  if (!projectId) return null
  if (id) {
    const row = queryOne('SELECT * FROM project_characters WHERE id = ? AND project_id = ?', [id, projectId])
    if (row) return row
  }
  if (name) {
    return queryOne('SELECT * FROM project_characters WHERE project_id = ? AND name = ?', [projectId, String(name).trim()]) || null
  }
  return null
}

export function createProjectCharacter(projectId, data = {}) {
  const name = String(data.name || '').trim()
  if (!name) return null
  const r = execute(
    `INSERT INTO project_characters (project_id, name, role, description, appearance, image_url, audio_url, color, name_en, description_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      name,
      data.role || '配角',
      data.description || '',
      data.appearance || '',
      data.image_url || data.imageUrl || '',
      data.audio_url || data.audioUrl || '',
      data.color || '#6b9bd1',
      data.name_en || data.nameEn || '',
      data.description_en || data.descriptionEn || '',
    ]
  )
  return queryOne('SELECT * FROM project_characters WHERE id = ?', [r.lastInsertRowid])
}

// 取主设定，没有就新建（资产提取时把新角色自动提升为项目角色）
export function ensureProjectCharacter(projectId, data = {}) {
  const found = findProjectCharacter(projectId, { id: data.project_character_id || data.projectCharacterId, name: data.name })
  if (found) return found
  return createProjectCharacter(projectId, data)
}

// 用新值更新主设定。
// allowClear=false（默认）：空字符串视为"本次不带该字段"，保留原值，避免提取流程把已确认的设定洗掉；
// allowClear=true：空字符串表示用户主动清空（设定页提交的是完整状态，空即为空）
export function updateProjectCharacter(masterId, data = {}, { allowClear = false } = {}) {
  const current = queryOne('SELECT * FROM project_characters WHERE id = ?', [masterId])
  if (!current) return null
  const next = {}
  for (const f of MASTER_FIELDS) {
    const incoming = data[f]
    if (incoming === undefined || incoming === null) continue
    const value = String(incoming)
    if (value === '' && !allowClear) continue
    next[f] = value
  }
  if (Object.keys(next).length === 0) return current
  const sets = Object.keys(next).map((f) => `${f} = ?`).join(', ')
  execute(
    `UPDATE project_characters SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...Object.values(next), masterId]
  )
  return queryOne('SELECT * FROM project_characters WHERE id = ?', [masterId])
}

// 把主设定推送到所有链接它的集角色行（含重命名）
export function syncProjectCharacterToEpisodes(masterId) {
  const master = queryOne('SELECT * FROM project_characters WHERE id = ?', [masterId])
  if (!master) return 0
  const r = execute(
    `UPDATE characters SET
       name = ?, role = ?, description = ?, appearance = ?,
       image_url = ?, audio_url = ?, color = ?, name_en = ?, description_en = ?
     WHERE project_character_id = ?`,
    [master.name, master.role, master.description || '', master.appearance || '',
      master.image_url || '', master.audio_url || '', master.color || '#6b9bd1',
      master.name_en || '', master.description_en || '', masterId]
  )
  return r.changes || 0
}

// 主设定删除：解除所有集的链接，各集保留各自现有副本（不删历史镜头引用）
export function unlinkProjectCharacter(masterId) {
  const r = execute('UPDATE characters SET project_character_id = NULL WHERE project_character_id = ?', [masterId])
  return r.changes || 0
}

// 读取集角色时用主设定覆盖关键字段：任何绕过写同步的路径都能拿到一致数据
export function mergeMasterIntoEpisodeCharacters(rows = []) {
  if (!rows.length) return rows
  const ids = [...new Set(rows.map((r) => r.project_character_id).filter(Boolean))]
  if (!ids.length) return rows
  const masters = new Map(
    query(`SELECT * FROM project_characters WHERE id IN (${ids.map(() => '?').join(',')})`, ids).map((m) => [m.id, m])
  )
  return rows.map((row) => {
    const master = masters.get(row.project_character_id)
    if (!master) return row
    return {
      ...row,
      name: master.name,
      role: master.role,
      description: master.description ?? row.description,
      appearance: master.appearance ?? row.appearance,
      image_url: master.image_url ?? row.image_url,
      audio_url: master.audio_url ?? row.audio_url,
      color: master.color || row.color,
      name_en: master.name_en || row.name_en || '',
      description_en: master.description_en || row.description_en || '',
      // 供前端/生成链路判断：该行由项目库托管，描述与图片不可在集内单独改
      projectCharacterId: master.id,
      linkedToProject: true,
    }
  })
}

// 整集替换角色（唯一写入入口：设定页编辑与 AI 资产提取都走这里，行为保证一致）
//
// source='edit'    → 用户手动编辑：回写主设定并同步到项目下所有集
// source='extract' → AI 提取：主设定为准，LLM 的猜测不得覆盖已确认的形象/描述/音色
//
// P1（2026-09-16）重新提取覆盖保护：
//   - source='extract' 时，DELETE 之前自动快照现有角色行（兜底可还原）；
//   - guard=true（前端交互式提取传 true；后端一键全流程传 false，因后台无人可确认）时，
//     落库前做智能 diff：有风险且未决策 → **不落库**，返回 { risk:true, report } 交前端确认；
//     decision='keep' → 受保护字段回退旧值、被删角色整行复原；decision='accept' → 维持覆盖。
//   - source='edit' 路径完全不受影响（手动编辑就是要以提交的状态为准）。
export function replaceEpisodeCharacters(episodeId, projectId, characters = [], { source = 'edit', decision = '', guard = false } = {}) {
  const isExtract = source === 'extract'

  // ── P1：覆盖前快照 + 智能 diff（仅提取路径）──
  let effectiveCharacters = characters
  if (isExtract) {
    const oldRows = query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [episodeId])
    if (guard) {
      // 旧值用「主设定合并后」的口径、新值用「主设定为准的最终值」——
      // 这样链接了项目主设定的角色（最终值本就等于主设定）不会被误判为用户损失。
      const diffOld = mergeMasterIntoEpisodeCharacters(oldRows)
      const incomingRows = characters.map((c) => {
        const name = String(c.name || '').trim()
        const master = findProjectCharacter(projectId, { id: c.projectCharacterId || c.project_character_id, name })
        const eff = master || c
        return {
          name,
          role: eff.role || '配角',
          description: eff.description || '',
          appearance: eff.appearance || '',
          image_url: eff.image_url || eff.imageUrl || '',
          audio_url: eff.audio_url || eff.audioUrl || '',
          color: eff.color || '#6b9bd1',
          name_en: eff.name_en || eff.nameEn || '',
          description_en: eff.description_en || eff.descriptionEn || '',
        }
      })
      const report = computeExtractDiff({ table: 'characters', oldRows: diffOld, incoming: incomingRows })
      // decision 白名单 fail-safe（2026-09-16）：仅 'keep'/'accept' 有效，非法值（'Keep'/'ACCEPT'/任意脏值）
      // 一律按「未决策」处理，返回风险报告交前端确认，绝不落到覆盖分支（原 fail-open 方向错误）。
      if (report.hasRisk && decision !== 'keep' && decision !== 'accept') {
        return { risk: true, table: 'characters', report }
      }
      if (report.hasRisk && decision === 'keep') {
        effectiveCharacters = applyKeepForCharacters(characters, oldRows)
      }
    }
    // 覆盖前自动快照（在 DELETE 之前；失败只记告警、不阻断提取）
    snapshotBeforeExtract({ episodeId, trigger: 'extract-characters', tables: ['characters'] })
  }

  const isExtractWrite = isExtract
  transaction(() => {
    execute('DELETE FROM characters WHERE episode_id = ?', [episodeId])
    for (const c of effectiveCharacters) {
      const name = String(c.name || '').trim()
      if (!name) continue
      const incoming = {
        name,
        role: c.role || '配角',
        description: c.description || '',
        appearance: c.appearance || '',
        image_url: c.image_url || c.imageUrl || '',
        audio_url: c.audio_url || c.audioUrl || '',
        color: c.color || '#6b9bd1',
        name_en: c.name_en || c.nameEn || '',
        description_en: c.description_en || c.descriptionEn || '',
        project_character_id: c.projectCharacterId || c.project_character_id || null,
      }

      let master = findProjectCharacter(projectId, { id: incoming.project_character_id, name })
      if (!master) {
        // 首次出现：自动提升为项目角色，后续所有集共用同一份设定
        master = createProjectCharacter(projectId, incoming)
      } else if (isExtractWrite) {
        // 提取时以主设定为准，只补齐主设定里还空着的字段（例如在别的集刚传的图/音色；
        // 英文字段同理：老主设定没跑过英文提取的，新提取的 nameEn/descriptionEn 补位）
        const fill = {}
        for (const f of ['image_url', 'audio_url', 'description', 'appearance', 'name_en', 'description_en']) {
          if (!master[f] && incoming[f]) fill[f] = incoming[f]
        }
        if (Object.keys(fill).length) {
          master = updateProjectCharacter(master.id, fill)
          syncProjectCharacterToEpisodes(master.id)
        }
      } else {
        // 手动编辑：回写主设定并同步全项目（提交的是完整状态，空值按"用户清空"处理）
        master = updateProjectCharacter(master.id, incoming, { allowClear: true })
        syncProjectCharacterToEpisodes(master.id)
      }

      const effective = master || incoming
      execute(
        'INSERT INTO characters (episode_id, name, role, description, appearance, image_url, color, audio_url, project_character_id, name_en, description_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          episodeId,
          effective.name,
          effective.role || '配角',
          effective.description || '',
          effective.appearance || '',
          effective.image_url || '',
          effective.color || '#6b9bd1',
          effective.audio_url || '',
          master?.id ?? null,
          effective.name_en || '',
          effective.description_en || '',
        ]
      )
    }
  })
  return { risk: false }
}

// 统计每个主设定被多少集使用（前端展示"N 集共用"）
export function countEpisodeUsage(projectId) {
  if (!projectId) return new Map()
  const rows = query(
    `SELECT pc.id AS master_id, COUNT(DISTINCT c.episode_id) AS episodes, COUNT(c.id) AS rows_count
     FROM project_characters pc
     LEFT JOIN characters c ON c.project_character_id = pc.id
     WHERE pc.project_id = ?
     GROUP BY pc.id`,
    [projectId]
  )
  return new Map(rows.map((r) => [r.master_id, { episodes: r.episodes || 0, rows: r.rows_count || 0 }]))
}
