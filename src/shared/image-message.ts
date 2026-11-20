import { GROUP_MAX_MEMBERS, TEXT_TCP_LIMIT } from './protocol'

/** 图文说明与引用只含有限字段，复用图片传输，不传递引用正文。 */
export interface ImageMessageMeta { caption?: string; mentions?: string[]; replyTo?: string }

/** IPC/报文共同校验，不允许任意对象、超长文本或伪造引用内容。 */
export function parseImageMessageMeta(value: unknown): ImageMessageMeta | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const m = value as ImageMessageMeta
  if (Object.keys(m).some(k => !['caption','mentions','replyTo'].includes(k))) return null
  if (m.caption !== undefined && (typeof m.caption !== 'string' || new TextEncoder().encode(m.caption).length > TEXT_TCP_LIMIT)) return null
  if (m.replyTo !== undefined && (typeof m.replyTo !== 'string' || !m.replyTo || m.replyTo.length > 64)) return null
  if (m.mentions !== undefined && (!Array.isArray(m.mentions) || m.mentions.length > GROUP_MAX_MEMBERS || !m.mentions.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64))) return null
  return { ...(m.caption ? { caption:m.caption } : {}), ...(m.replyTo ? { replyTo:m.replyTo } : {}), ...(m.mentions?.length ? { mentions:[...new Set(m.mentions)] } : {}) }
}
