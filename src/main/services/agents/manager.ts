import { EventEmitter } from 'node:events'
import type { Profile } from '../../../shared/protocol'
import type { AgentInput, AgentView } from '../../../shared/agents'
import { AgentStore } from '../../store/agent-store'
import { AgentRuntime } from './runtime'
import type { PeerRecord } from '../../net/peer-registry'

/** 只有本机创建者持有配置和密钥；串行管理操作避免启停竞态重复托管。 */
export class AgentManager extends EventEmitter {
  private readonly runtimes = new Map<string, AgentRuntime>()
  private readonly states = new Map<string, Pick<AgentView, 'status' | 'error'>>()
  private serial = Promise.resolve()
  private stopped = false
  private paused = false
  constructor(private readonly store: AgentStore, private readonly options: {
    dataDir: string; profile(): Profile; seeds(): Array<{ host: string; port: number }>; loopback?: boolean
  }) { super() }

  /** 渲染视图显式挑选字段，绝不传播密钥密文或明文。 */
  list(): AgentView[] {
    return this.store.list().map(config => ({ id: config.id, name: config.name, persona: config.persona, endpoint: config.endpoint, model: config.model, enabled: config.enabled, hasKey: this.store.hasKey(config.id), sessionKey: this.store.sessionOnly(),
      ...this.states.get(config.id) ?? { status: 'stopped' as const, error: '' } }))
  }
  /** 应用启动恢复已启用节点，单个失败不阻止其余节点和聊天功能。 */
  start(): Promise<void> {
    return this.run(async () => { for (const config of this.store.list()) if (config.enabled && !this.stopped && !this.paused) await this.launch(config.id) })
  }
  /** 休眠立即取消模型，串行清理节点；恢复后按已保存启用状态重新托管。 */
  pause(): Promise<void> {
    this.paused = true
    const stopping = Promise.all([...this.runtimes.values()].map(runtime => runtime.stop()))
    return this.run(async () => {
      await stopping; this.runtimes.clear(); this.states.clear(); this.changed()
    })
  }
  /** 恢复操作排在休眠清理之后，避免旧节点迟到关闭新节点。 */
  resume(): Promise<void> {
    return this.run(async () => {
      this.paused = false
      for (const config of this.store.list()) if (config.enabled && !this.stopped && !this.paused) await this.launch(config.id)
    })
  }
  /** 编辑会取消原请求并重建运行时，独立节点身份保持不变。 */
  save(input: AgentInput): Promise<AgentView[]> {
    return this.run(async () => {
      const config = this.store.save(input)
      await this.runtimes.get(config.id)?.stop(); this.runtimes.delete(config.id)
      this.states.delete(config.id)
      if (config.enabled && !this.stopped && !this.paused) await this.launch(config.id)
      return this.changed()
    })
  }
  /** 删除不清空聊天历史或远端成员记录；联系人通过 exit 公告变为离线。 */
  remove(id: string): Promise<AgentView[]> {
    return this.run(async () => {
      this.store.remove(id)
      await this.runtimes.get(id)?.stop(); this.runtimes.delete(id); this.states.delete(id)
      return this.changed()
    })
  }
  /** 传播新发现节点给所有本机 Agent，不伪造宿主通讯录记录。 */
  probe(peer: PeerRecord): void { for (const runtime of this.runtimes.values()) runtime.probe(peer) }
  /** 停止所有托管任务；进行中的启动看到 stopped 标记后不会重新复活。 */
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.stop()))
    this.runtimes.clear()
  }
  /** 启动前先解密检验密钥，错误仅保留已脱敏的本机状态。 */
  private async launch(id: string): Promise<void> {
    const config = this.store.list().find(c => c.id === id)
    if (!config || this.stopped || this.paused) return
    this.states.set(id, { status: 'starting', error: '' }); this.changed()
    let runtime: AgentRuntime | undefined
    try {
      this.store.key(id)
      runtime = new AgentRuntime({ config, ...this.options, profile: this.options.profile(), key: () => this.store.key(id), error: error => {
        if (this.runtimes.get(id) !== runtime || this.stopped) return
        this.states.set(id, { status: error ? 'error' : 'running', error }); this.changed()
      } })
      this.runtimes.set(id, runtime); await runtime.start()
      if (this.stopped || this.paused) { await runtime.stop(); return }
      this.states.set(id, { status: 'running', error: '' })
    } catch {
      await runtime?.stop(); this.runtimes.delete(id)
      this.states.set(id, { status: 'error', error: 'Agent 启动失败，请检查密钥、安全存储与本地数据库' })
    }
    this.changed()
  }
  /** 后续任务在失败后仍能执行，错误原样返回当前管理调用者。 */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.serial.then(() => { if (this.stopped) throw new Error('Agent 服务已停止'); return job() })
    this.serial = next.then(() => undefined, () => undefined); return next
  }
  /** 管理状态只在本机窗口通知，不随 P2P 资料广播。 */
  private changed(): AgentView[] { const views = this.list(); this.emit('changed', views); return views }
}
