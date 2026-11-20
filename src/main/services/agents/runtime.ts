import { readFile, stat, readdir, mkdir } from 'node:fs/promises'
import type Anthropic from '@anthropic-ai/sdk'
import { FilesService } from '../files'
import { TransferRepo } from '../../store/transfer-repo'
import { ImagePreviewService } from '../image-preview'
import type { FileCtlOffer } from '../../../shared/protocol'
import type { TransferView, FileRefView } from '../../../shared/ipc'
import { join } from 'node:path'
import type { Envelope, MsgPayload, Profile } from '../../../shared/protocol'
import { MSG_TYPES, CAPS } from '../../../shared/protocol'
import { AGENT_CAP } from '../../../shared/agents'
import { UdpChannel } from '../../net/udp'
import { PeerRegistry, type PeerRecord } from '../../net/peer-registry'
import { Discovery } from '../../net/discovery'
import { Messenger } from '../../net/messenger'
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
  private files: FilesService | null = null
  private readonly seenImages = new Set<string>()
  private mediaBytes = 0
  private readonly imagePreview: ImagePreviewService
  private readonly controller = new AbortController()
  private readonly histories = new Map<string, ModelTurn[]>()
  private readonly jobs: Array<{ from: string; text: string; groupId: string; replyTo?: string; transferId?: string }> = []
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
    this.imagePreview = new ImagePreviewService(join(deps.dataDir,deps.config.id,'thumbs'))
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
    // 与普通客户端复用媒体撤回，引用不能继续读取已经撤回的图片。
    this.chat = new ChatService({ selfId: config.id, messenger: this.messenger, convRepo, msgRepo, groupRepo,
      mediaRecall: {
        canRecall: row => this.files?.canRecallMessage(row.id) ?? false,
        applyLocalRecall: row => { this.files?.applyRecallMessage(row.id) },
        applyIncomingRecall: row => this.files?.applyRecallMessage(row.id) ?? false
      } })
    this.groups = new GroupsService({ selfId: config.id, messenger: this.messenger, convRepo, msgRepo, groupRepo })
    this.messenger.on('incoming', (env: Envelope) => this.receive(env))
    const mediaDir = join(this.deps.dataDir, config.id, 'images')
    await mkdir(mediaDir,{recursive:true})
    if (this.stopped) return
    for (const name of await readdir(mediaDir)) { try { this.mediaBytes += (await stat(join(mediaDir,name))).size } catch { /* 文件可能已不存在 */ } }
    // 扫描缓存期间可能收到休眠/退出，不能用已关闭的数据库继续构建服务。
    if (this.stopped) return
    this.files = new FilesService({ selfId:config.id, messenger:this.messenger, registry:this.registry, convRepo,msgRepo,groupRepo,
      transferRepo:new TransferRepo(this.db), tcpPort:0, getSaveDir:()=>mediaDir,getImagesDir:()=>mediaDir,
      ...(this.deps.loopback ? {bindAddress:'127.0.0.1'} : {}),
      allowDirectFileSend:()=>false,
      allowOffer:(from,offer)=>this.allowImage(from,offer),
      validateReceivedImage:async path=>Boolean(await this.imagePreview.inspectInlinePath(path)) })
    this.files.on('transfer',(view:TransferView)=>this.imageReceived(view))
    await this.files.start()
    if (this.stopped) { await this.files.stop(); return }
    await this.udp.start()
    if (this.stopped) { await this.udp.stop(); return }
    const port = this.files.availability().port
    // 无自定义头像时必须省略哈希；空字符串会被发现协议白名单拒绝。
    const profile: Profile = { ...this.deps.profile, nodeId: config.id, nick: config.name, company: '', dept: '', team: '', avatar: 200,
      avatarHash: undefined, profileRev: Date.now(), tcpPort: port, caps: [AGENT_CAP, CAPS.groupRoles, CAPS.transferAck, CAPS.mediaRecall] }
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
    await this.files?.stop()
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
    this.jobs.push({ from: env.from, text: payload.text, groupId, replyTo:payload.replyTo })
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
        try {
          const turn = await this.makeTurn(job,key)
          if (this.stopped || !allowed()) continue
          const turns = [...this.histories.get(key) ?? [], turn].slice(-11)
          const text = await requestAgent(this.deps.config, this.deps.key(), turns, this.controller.signal)
          if (this.stopped || !allowed()) continue
          this.histories.delete(key)
          if (this.histories.size >= 32) this.histories.delete(this.histories.keys().next().value!)
          // 历史仅保留文字，不让 base64 图片在32个会话内长期驻留。
          this.histories.set(key, [...turns.map(({role,content})=>({role,content})), { role: 'assistant', content: text }])
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

  /** 只接收小型真实图片；普通文件/机器人/越权群媒体不会拉取或落盘。 */
  private allowImage(from: string, offer: FileCtlOffer): boolean {
    const peer = this.registry.get(from)
    if (!peer || peer.profile.caps.includes(AGENT_CAP) || offer.purpose !== 'image') return false
    const members = offer.groupId ? this.groupRepo?.get(offer.groupId)?.members : undefined
    if (offer.groupId && (!members?.includes(from) || !members.includes(this.deps.config.id))) return false
    const valid = offer.total === 1 && offer.seq === 1 && offer.fileCount === 1 && offer.files.length === 1 && !offer.files[0].isDir &&
      offer.totalSize > 0 && offer.totalSize <= 5*1024*1024 && this.mediaBytes + offer.totalSize <= 128*1024*1024
    if (valid) { this.mediaBytes += offer.totalSize; return true }
    if (!offer.groupId || offer.mentions?.includes(this.deps.config.id)) {
      const text = '[Agent] 图片超过接收限制：单图5MB，每个 Agent 图片缓存128MB'
      if (offer.groupId) this.groups?.sendText(offer.groupId,text); else this.chat?.sendText(from,text)
    }
    return false
  }

  /** 必须等校验与落盘完成才触发视觉请求；群内不提及时仅保留可被引用的本地图片。 */
  private imageReceived(view: TransferView): void {
    if (this.stopped || view.direction !== 'in' || view.status !== 'done' || this.seenImages.has(view.msgId)) return
    const row = this.msgRepo?.get(view.msgId)
    if (!row || row.kind !== 'image' || row.status === 'recalled') return
    this.seenImages.add(view.msgId)
    if (this.seenImages.size > 512) this.seenImages.delete(this.seenImages.values().next().value!)
    let ref: FileRefView
    try { ref = JSON.parse(row.file_ref || '{}') } catch { return }
    const groupId = row.conv_id.startsWith('group:') ? row.conv_id.slice(6) : ''
    if (groupId && !ref.mentions?.includes(this.deps.config.id)) return
    if (this.jobs.length >= 8) { this.deps.error('Agent 请求过多，待处理队列已满'); return }
    this.jobs.push({from:row.sender_id,text:ref.caption || '请描述这张图片',groupId,replyTo:row.reply_to ?? undefined,transferId:view.transferId})
    void this.drain()
  }

  /** 图片只从本节点受管传输中读取，限额与真实格式双重复核，不访问发送方 URL/路径。 */
  private async modelImage(transferId: string): Promise<Anthropic.ImageBlockParam> {
    try {
    const view = this.files?.transferView(transferId)
    if (!view?.savedPath || view.status !== 'done' || view.direction !== 'in') throw new Error('引用图片尚未接收完成或不可用')
    const info = await stat(view.savedPath)
    if (!info.isFile() || info.size > 5*1024*1024) throw new Error('图片超过模型接收限制')
    const meta = await this.imagePreview.inspectInlinePath(view.savedPath)
    if (!meta || meta.format === 'bmp') throw new Error('AI 图片仅支持 PNG、JPEG、GIF、WebP')
    const data = await readFile(view.savedPath)
    return {type:'image',source:{type:'base64',media_type:('image/'+meta.format) as Anthropic.ImageBlockParam.Source['media_type'],data:data.toString('base64')}}
    } catch { throw new Error('图片不可用、超限或格式不受支持（PNG/JPEG/GIF/WebP）') }
  }

  /** 引用只查询同会话已接收原文；撤回/不存在/跨会话引用不泄露内容，不递归整段历史。 */
  private async makeTurn(job: {text:string;replyTo?:string;transferId?:string}, convId:string): Promise<ModelTurn> {
    const images: Anthropic.ImageBlockParam[] = []
    if (job.transferId) images.push(await this.modelImage(job.transferId))
    let quoted = ''
    if (job.replyTo) {
      const row = this.msgRepo?.get(job.replyTo)
      if (!row || row.conv_id !== convId || row.status === 'recalled') quoted = '[引用消息不可用或已撤回]'
      else {
        quoted = '[引用消息，仅作本次问题的参考]\n'+row.content.slice(0,2048)
        if (row.kind === 'image') {
          try { const ref = JSON.parse(row.file_ref || '{}') as FileRefView; images.push(await this.modelImage(ref.transferId)) }
          catch { quoted += '\n[引用图片尚未接收完成或不可用]' }
        }
      }
    }
    return {role:'user',content:(quoted ? quoted+'\n\n[当前消息]\n' : '')+job.text,...(images.length ? {images} : {})}
  }
}
