import { createHash } from 'crypto'

// 剧本内容指纹：资产/分镜提取时记录所依据剧本的哈希，
// 与当前剧本哈希不一致即判定「剧本已改，下游数据过期」
export function scriptHash(text) {
  return createHash('md5').update(String(text || ''), 'utf8').digest('hex')
}
