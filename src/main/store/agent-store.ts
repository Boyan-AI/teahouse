import { readFileSync, chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { atomicWriteJson } from '../util/atomic-write'
import { AGENT_LIMIT, agentEndpoint, isAgentInput, type AgentInput } from '../../shared/agents'

export interface AgentConfig extends Omit<AgentInput, 'id' | 'apiKey'> { id: string; encryptedKey: string }
export interface SecretCodec { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }

/** 配置独立原子存储；密钥仅保存系统密文，无系统安全存储时拒绝明文回退。 */
export class AgentStore {
  private configs: AgentConfig[] = []
  private readonly sessionKeys = new Map<string, string>()
  constructor(private readonly path: string, private readonly secrets: SecretCodec) {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Agent 配置无法读取，未覆盖原文件') }
    if (!Array.isArray(raw) || raw.length > AGENT_LIMIT) throw new Error('Agent 配置格式无效')
    for (const item of raw) {
      if (!item || typeof item !== 'object') throw new Error('Agent 配置格式无效')
      const { encryptedKey, ...input } = item
      if (!isAgentInput(input) || 'apiKey' in input || !input.id || typeof encryptedKey !== 'string' || encryptedKey.length > 32768 || this.configs.some(c => c.id === input.id)) throw new Error('Agent 配置格式无效')
      this.configs.push({ ...input, id: input.id, encryptedKey })
    }
  }
  /** 配置副本只能用于主进程，不作为渲染层返回值。 */
  list(): AgentConfig[] { return this.configs.map(config => ({ ...config })) }
  /** 明文只在请求模型前按需解密，不缓存到可广播状态。 */
  key(id: string): string {
    const config = this.configs.find(c => c.id === id)
    const session = this.sessionKeys.get(id)
    if (session) return session
    if (!config?.encryptedKey || !this.secrets.available()) throw new Error('系统安全存储不可用，请重新填写会话密钥')
    try { return this.secrets.decrypt(Buffer.from(config.encryptedKey, 'base64')) }
    catch { throw new Error('密钥无法解密，请重新填写') }
  }
  /** 先持久化再替换内存；空密钥保留原值，更新不改变独立节点 ID。 */
  save(input: AgentInput): AgentConfig {
    if (!isAgentInput(input)) throw new Error('Agent 配置无效，请检查名称、内网地址和模型 ID')
    const previous = input.id ? this.configs.find(c => c.id === input.id) : undefined
    if (input.id && !previous) throw new Error('Agent 不存在')
    if (!previous && this.configs.length >= AGENT_LIMIT) throw new Error('最多创建 8 个 Agent')
    let encryptedKey = previous?.encryptedKey ?? ''
    const id = previous?.id ?? randomUUID()
    const sessionKey = !this.secrets.available() ? input.apiKey || this.sessionKeys.get(id) : undefined
    if (input.apiKey) encryptedKey = this.secrets.available() ? this.secrets.encrypt(input.apiKey).toString('base64') : ''
    if (input.enabled && !encryptedKey && !sessionKey) throw new Error('请填写模型服务密钥')
    const config: AgentConfig = { id, name: input.name.trim(), persona: input.persona,
      endpoint: agentEndpoint(input.endpoint)!, model: input.model.trim(), enabled: input.enabled, encryptedKey }
    this.persist([...this.configs.filter(c => c.id !== config.id), config])
    if (sessionKey) this.sessionKeys.set(id, sessionKey)
    else if (input.apiKey) this.sessionKeys.delete(id)
    return { ...config }
  }
  /** 删除只移除托管配置和密钥；保留聊天历史，避免隐式破坏数据。 */
  remove(id: string): void { this.persist(this.configs.filter(c => c.id !== id)); this.sessionKeys.delete(id) }
  /** 安全后端不可验证时仅内存保管密钥，重启必须重填，不落明文。 */
  sessionOnly(): boolean { return !this.secrets.available() }
  /** 列表仅报告密钥存在状态，绝不回传密钥内容。 */
  hasKey(id: string): boolean { return Boolean(this.sessionKeys.has(id) || this.configs.find(c => c.id === id)?.encryptedKey) }
  /** 文件权限限制当前用户；磁盘失败不提交新内存配置。 */
  private persist(configs: AgentConfig[]): void {
    atomicWriteJson(this.path, configs); chmodSync(this.path, 0o600); this.configs = configs
  }
}
