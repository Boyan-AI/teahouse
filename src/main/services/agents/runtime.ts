import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Envelope, MsgPayload, Profile } from '../../../shared/protocol'
import { MSG_TYPES } from '../../../shared/protocol'
import { AGENT_CAP } from '../../../shared/agents'
import { UdpChannel } from '../../net/udp'
import { PeerRegistry, type PeerRecord } from '../../net/peer-registry'
import { Discovery } from '../../net/discovery'
import { Messenger } from '../../net/messenger'
import { encodeFrame, FrameReader } from '../../net/frame'
import { openDatabase, type AppDatabase } from '../../store/db'
import { ConvRepo } from '../../store/conv-repo'
import { MsgRepo } from '../../store/msg-repo'
import { GroupRepo } from '../../store/group-repo'
import { QueueRepo } from '../../store/queue-repo'
import { DedupRepo } from '../../store/dedup-repo'
import { ChatService } from '../chat'
import { GroupsService } from '../groups'
import { requestAgent, type ModelTurn } from './model'
import type { AgentConfig } from '../../store/agent-store'

export interface AgentRuntimeDeps {
  config: AgentConfig
  dataDir: string
  profile: Profile
  seeds(): Array<{ host: string; port: number }>
  key(): string
  error(message: string): void
  loopback?: boolean
}

/** 每个 Agent 是独立的 P2P 节点，复用真实发现、TCP、群协议和持久去重。 */
export class AgentRuntime {
  private readonly udp: UdpChannel
  private readonly registry: PeerRegistry
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer(socket => this.accept(socket))
  private readonly controller = new AbortController()
  private readonly histories = new Map<string, ModelTurn[]>()
  private readonly jobs: Array<{ from: string; text: string; groupId: string }> = []
  private discovery: Discovery | null = null
  private messenger: Messenger | null = null
  private db: AppDatabase | null = null
  private groups: GroupsService | null = null
  private chat: ChatService | null = null
  private groupRepo: GroupRepo | null = null
  private msgRepo: MsgRepo | null = null
  private working = false
  private stopped = false
  private announceTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.udp = new UdpChannel({ port: 0, broadcastTargets: [], ...(deps.loopback ? { bindAddress: '127.0.0.1' } : {}) })
    this.registry = new PeerRegistry(deps.config.id)
  }

  /** 启动成功后才公告身份，临时端口通过发现协议传给其他客户端。 */
  async start(): Promise<void> {
    const config = this.deps.config
    this.db = openDatabase(join(this.deps.dataDir, config.id + '.db'))
    const convRepo = new ConvRepo(this.db), msgRepo = new MsgRepo(this.db), groupRepo = new GroupRepo(this.db)
    this.groupRepo = groupRepo; this.msgRepo = msgRepo
    this.messenger = new Messenger({ selfId: config.id, udp: this.udp, registry: this.registry,
      queue: new QueueRepo(this.db), dedup: new DedupRepo(this.db) })
    this.chat = new ChatService({ selfId: config.id, messenger: this.messenger, convRepo, msgRepo })
    this.groups = new GroupsService({ selfId: config.id, messenger: this.messenger, convRepo, msgRepo, groupRepo })
    this.messenger.on('incoming', (env: Envelope) => this.receive(env))
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, this.deps.loopback ? '127.0.0.1' : '0.0.0.0', () => {
        this.server.removeListener('error', reject); resolve()
      })
    })
    this.server.on('error', () => this.deps.error('Agent TCP 监听失败'))
    if (this.stopped) { this.server.close(); return }
    await this.udp.start()
    if (this.stopped) { await this.udp.stop(); return }
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Agent TCP 监听失败')
    // 无自定义头像时必须省略哈希；空字符串会被发现协议白名单拒绝。
    const profile: Profile = { ...this.deps.profile, nodeId: config.id, nick: config.name, company: '', dept: '', team: '', avatar: 200,
      avatarHash: undefined, profileRev: Date.now(), tcpPort: address.port, caps: [AGENT_CAP, 'gr1'] }
    this.discovery = new Discovery({ udp: this.udp, registry: this.registry, profile, manualPeers: this.deps.seeds() })
    this.discovery.start()
    // 动态端口不向相同随机端口广播；定期探测宿主已知联系人，覆盖新上线节点与跨网段。
    this.announceTimer = setInterval(() => {
      for (const peer of this.deps.seeds()) this.discovery?.probe(peer.host, peer.port)
    }, 30_000)
    this.announceTimer.unref?.()
  }

  /** 宿主结识新节点时立即探测，避免等待下一次公告周期。 */
  probe(peer: PeerRecord): void { if (!this.stopped) this.discovery?.probe(peer.ip, peer.udpPort) }

  /** 禁用/删除先取消模型，再发退出并停止网络，最后等待回调落定再关闭独立数据库。 */
  async stop(): Promise<void> {
    this.stopped = true; this.controller.abort(); this.jobs.length = 0
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.discovery?.stop(); this.messenger?.stop()
    for (const socket of this.sockets) socket.destroy()
    if (this.server.listening) this.server.close()
    await this.udp.stop()
    await new Promise<void>(resolve => setImmediate(resolve))
    this.db?.close(); this.db = null; this.histories.clear()
  }

  /** 只处理已被消息服务实际接收的文本；群内明确 @自己且仍在群内才回复。 */
  private receive(env: Envelope): void {
    if (this.stopped || env.type !== MSG_TYPES.msg || !this.msgRepo?.get(env.id)) return
    const payload = env.payload as MsgPayload
    if (payload.kind !== 'text' && payload.kind !== 'group-text') return
    const peer = this.registry.get(env.from)
    if (!peer || peer.profile.caps.includes(AGENT_CAP)) return
    let groupId = ''
    if (payload.kind === 'group-text') {
      groupId = payload.groupId
      const meta = this.groupRepo?.get(groupId)
      if (payload.resend || !payload.mentions?.includes(this.deps.config.id) || !meta?.members.includes(this.deps.config.id) || !meta.members.includes(env.from)) return
    }
    if (this.jobs.length >= 8) { this.deps.error('Agent 请求过多，待处理队列已满'); return }
    this.jobs.push({ from: env.from, text: payload.text, groupId })
    void this.drain()
  }

  /** 单 Agent 串行处理，最多8条排队和32个上下文，删除后迟到结果不会发送。 */
  private async drain(): Promise<void> {
    if (this.working || this.stopped) return
    this.working = true
    try {
      while (this.jobs.length && !this.stopped) {
        const job = this.jobs.shift()!, key = job.groupId ? 'group:' + job.groupId : 'single:' + job.from
        const allowed = (): boolean => !job.groupId || Boolean(this.groupRepo?.get(job.groupId)?.members.includes(this.deps.config.id) && this.groupRepo.get(job.groupId)?.members.includes(job.from))
        if (!allowed()) continue
        const turns = [...this.histories.get(key) ?? [], { role: 'user' as const, content: job.text }].slice(-11)
        try {
          const text = await requestAgent(this.deps.config, this.deps.key(), turns, this.controller.signal)
          if (this.stopped || !allowed()) continue
          this.histories.delete(key)
          if (this.histories.size >= 32) this.histories.delete(this.histories.keys().next().value!)
          this.histories.set(key, [...turns, { role: 'assistant', content: text }])
          if (job.groupId) this.groups?.sendText(job.groupId, text)
          else this.chat?.sendText(job.from, text)
          this.deps.error('')
        } catch (error) {
          if (this.stopped) break
          const message = error instanceof Error ? error.message : '内网模型请求失败'
          this.deps.error(message)
          if (allowed()) {
            if (job.groupId) this.groups?.sendText(job.groupId, '[Agent] ' + message)
            else this.chat?.sendText(job.from, '[Agent] ' + message)
          }
        }
      }
    } finally { this.working = false }
  }

  /** Agent 仅接受可靠消息帧，不开放文件传输；来源必须匹配已发现节点。 */
  private accept(socket: Socket): void {
    if (this.stopped || this.sockets.size >= 32) { socket.destroy(); return }
    this.sockets.add(socket); socket.setTimeout(10_000, () => socket.destroy())
    socket.on('error', () => socket.destroy()); socket.on('close', () => this.sockets.delete(socket))
    const reader = new FrameReader(frame => {
      if (frame.type !== 'msg') { socket.destroy(); return }
      const peer = this.registry.get(frame.envelope.from)
      const ip = socket.remoteAddress?.replace(/^::ffff:/, '')
      if (!peer || peer.ip !== ip || ![MSG_TYPES.msg, MSG_TYPES.group].includes(frame.envelope.type as 'msg' | 'group')) { socket.destroy(); return }
      if (this.messenger?.acceptTcpEnvelope(frame.envelope, ip)) socket.end(encodeFrame({ type: 'msg-ack', ackFor: frame.envelope.id }))
      else socket.destroy()
    }, () => socket.destroy(), () => socket.destroy())
    socket.on('data', chunk => reader.feed(chunk))
  }
}
