import { createHash } from 'crypto'

export function scriptHash(text) {
  return createHash('md5').update(String(text || ''), 'utf8').digest('hex')
}
