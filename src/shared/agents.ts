/** 软件内托管的机器人能力位，远端据此阻止机器人互相回复。 */
export const AGENT_CAP = 'agent1'
export const AGENT_LIMIT = 8
export interface AgentInput {
  id?: string
  name: string
  persona: string
  endpoint: string
  model: string
  apiKey?: string
  enabled: boolean
}
/** 配置视图永不回传密钥；空密钥编辑表示保留既有密钥。 */
export interface AgentView extends Omit<AgentInput, 'apiKey'> {
  id: string
  hasKey: boolean
  sessionKey: boolean
  status: 'stopped' | 'starting' | 'running' | 'error'
  error: string
}
/** 限定字面 IPv4 私网/回环地址，无 DNS 重绑定或 URL 凭证歧义。 */
export function agentEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256) return null
  try {
    const url = new URL(value)
    const raw = /^https?:\/\/(\d+\.\d+\.\d+\.\d+)(?::\d+)?(?:\/[^?#]*)?$/.exec(value)
    if (!raw || url.username || url.password || url.search || url.hash) return null
    const octets = raw[1].split('.').map(Number)
    if (octets.some((n, i) => n > 255 || String(n) !== raw[1].split('.')[i]) || url.hostname !== raw[1]) return null
    const [a, b] = octets
    if (!(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return null
    if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(url.pathname)) return null
    // 填服务根地址或代理前缀；SDK 自行追加 /v1/messages，防止重复路径。
    if (/\/v1(?:\/messages)?\/?$/.test(url.pathname)) return null
    return url.href.replace(/\/$/, '')
  } catch { return null }
}
/** IPC 与磁盘恢复使用同一配置约束，不把任意字段扩散到网络资料。 */
export function isAgentInput(value: unknown): value is AgentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const a = value as Record<string, unknown>
  return Object.keys(a).every(key => ['id', 'name', 'persona', 'endpoint', 'model', 'apiKey', 'enabled'].includes(key)) &&
    (a.id === undefined || (typeof a.id === 'string' && /^[a-f0-9-]{36}$/.test(a.id))) &&
    typeof a.name === 'string' && a.name.trim().length > 0 && a.name.length <= 32 &&
    typeof a.persona === 'string' && a.persona.length <= 8000 && agentEndpoint(a.endpoint) !== null &&
    typeof a.model === 'string' && a.model.trim().length > 0 && a.model.length <= 128 &&
    (a.apiKey === undefined || (typeof a.apiKey === 'string' && a.apiKey.length <= 4096 && !/[\r\n]/.test(a.apiKey))) &&
    typeof a.enabled === 'boolean'
}
