import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { initialGame, isBoardPacket, isBoardAction, isBoardInvite, moveGame, positionKey, type BoardAction, type BoardGame,
  type BoardInvite, type BoardPacket, type BoardRoom, type BoardView } from '../../shared/board-games'

export const BOARD_CAP = 'board1'
export interface BoardDeps {
  selfId: string
  selfName?: () => string
  peer(id: string): { name: string; online: boolean; caps: string[] } | null
  members(groupId: string): string[] | null
  send(id: string, packet: BoardPacket): Promise<boolean>
  inviteMessage(invite: BoardInvite, from: string, mine: boolean, peerId: string): void
  canRestoreInvite?(invite: BoardInvite): boolean
  correctTime?: (peerId: string, ts: number) => number
  now?: () => number
}
interface Entry {
  room: BoardRoom
  opponent: string
  joined: boolean
  error: string
  positions: Map<string, number>
}
const MAX_ROOMS = 32
const MAX_AGE = 2 * 60 * 60_000

/** 无中心服务器的棋类房间；房主串行裁定选座与走子，访客只能提交动作。 */
export class BoardGamesService extends EventEmitter {
  private readonly entries = new Map<string, Entry>()
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly deps: BoardDeps) {
    super()
    this.timer = setInterval(() => this.prune(), 10_000)
    this.timer.unref?.()
  }

  /** 只向支持房间协议的在线会话成员发送邀请，不强行唤起对方窗口。 */
  create(convId: string, game: BoardGame): BoardInvite | null {
    this.prune()
    if (this.entries.size >= MAX_ROOMS) return null
    const groupId = convId.startsWith('group:') ? convId.slice(6) : ''
    const opponent = convId.startsWith('single:') ? convId.slice(7) : ''
    const members = groupId ? this.deps.members(groupId) : [this.deps.selfId, opponent]
    if (!members?.includes(this.deps.selfId) || (!groupId && (!opponent || opponent === this.deps.selfId))) return null
    const recipients = members.filter(id => id !== this.deps.selfId && this.supported(id))
    if (!recipients.length) return null
    const invite: BoardInvite = { roomId: randomUUID(), hostId: this.deps.selfId, game, groupId, createdAt: this.now() }
    const room: BoardRoom = { ...invite, revision: 0, seats: [null, null], viewers: [this.deps.selfId], ready: [],
      phase: 'waiting', state: initialGame(game), reason: 'none' }
    this.entries.set(invite.roomId, { room, opponent, joined: true, error: '', positions: new Map() })
    this.deps.inviteMessage(invite, this.deps.selfId, true, opponent)
    for (const id of recipients) void this.deps.send(id, { op: 'invite', invite })
    this.publish(invite.roomId)
    return invite
  }

  /** 历史邀请重新进入时仍复核主机和原会话资格，不信任 renderer 传来的房间状态。 */
  async open(invite: BoardInvite): Promise<boolean> {
    if (!isBoardInvite(invite)) return false
    this.prune()
    if (!this.entries.has(invite.roomId)) {
      if (!invite.groupId && !this.deps.canRestoreInvite?.(invite)) return false
      if (this.entries.size >= MAX_ROOMS || !this.acceptInvite(invite.hostId, invite, false)) return false
    }
    const entry = this.entries.get(invite.roomId)!
    if (!this.sameInvite(entry.room, invite)) return false
    if (entry.room.phase === 'closed' || !this.authorized(entry, this.deps.selfId)) return false
    entry.joined = true
    return this.action(invite.roomId, { kind: 'join' })
  }

  /** 生成只读视图，姓名从本地通讯录解析，不信任网络传来的显示文案。 */
  view(roomId: string): BoardView | null {
    const entry = this.entries.get(roomId)
    if (!entry) return null
    const names: Record<string, string> = {}
    for (const id of entry.room.viewers) names[id] = id === this.deps.selfId ? this.deps.selfName?.() ?? id.slice(0, 8) : this.deps.peer(id)?.name ?? id.slice(0, 8)
    return { room: JSON.parse(JSON.stringify(entry.room)) as BoardRoom, selfId: this.deps.selfId, names, error: entry.error }
  }

  /** 本机房主直接裁定；访客向唯一房主请求，不在本地乐观改盘。 */
  async action(roomId: string, action: BoardAction): Promise<boolean> {
    const entry = this.entries.get(roomId)
    if (!entry || !entry.joined || !isBoardAction(action)) return false
    if (entry.room.phase === 'closed') {
      if (action.kind === 'leave') { entry.joined = false; this.prune(); return true }
      return false
    }
    if (entry.room.hostId === this.deps.selfId) return this.apply(entry, this.deps.selfId, action, entry.room.revision)
    if (!this.authorized(entry, this.deps.selfId)) return false
    entry.error = ''
    const delivered = await this.deps.send(entry.room.hostId, { op: 'request', roomId, revision: entry.room.revision, action })
    if (!delivered) { entry.error = 'unavailable'; this.publish(roomId) }
    return delivered
  }

  /** 入站仅接受协议白名单；调用者还需在传输层绑定发送节点地址。 */
  receive(from: string, raw: unknown): void {
    if (!isBoardPacket(raw) || from === this.deps.selfId) return
    if (raw.op === 'invite') { this.acceptInvite(from, raw.invite, true); return }
    const id = raw.op === 'state' ? raw.room.roomId : raw.roomId
    const entry = this.entries.get(id)
    if (!entry) return
    if (raw.op === 'request') {
      if (entry.room.hostId === this.deps.selfId) this.apply(entry, from, raw.action, raw.revision)
      return
    }
    if (from !== entry.room.hostId || entry.room.phase === 'closed' || !this.authorized(entry, this.deps.selfId)) return
    if (raw.op === 'error') { entry.error = raw.reason; this.publish(id); return }
    if (raw.op === 'state' && this.sameInvite(entry.room, raw.room) && raw.room.revision >= entry.room.revision) {
      entry.room = raw.room; entry.error = ''; this.publish(id)
    }
  }

  /** 应用退出才关闭房主房间；关闭普通棋盘窗口只提交离开动作。 */
  stop(): void {
    clearInterval(this.timer)
    for (const entry of this.entries.values()) {
      if (entry.room.hostId === this.deps.selfId) this.closeRoom(entry, 'host-left')
      else if (entry.joined) void this.deps.send(entry.room.hostId, {
        op: 'request', roomId: entry.room.roomId, revision: entry.room.revision, action: { kind: 'leave' }
      })
    }
    this.entries.clear()
  }

  /** 回收过期房间；离群/离线成员不得继续占座，房主离线则明确结束而非伪装可继续。 */
  prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.age(entry.room) > MAX_AGE) {
        if (entry.room.phase !== 'closed') {
          if (entry.room.hostId === this.deps.selfId) this.closeRoom(entry, 'expired')
          else { entry.room.phase = 'closed'; entry.room.reason = 'expired'; this.publish(id) }
        }
        if (!entry.joined) this.entries.delete(id)
      } else if (entry.room.hostId !== this.deps.selfId && !this.deps.peer(entry.room.hostId)?.online) {
        if (entry.room.phase !== 'closed') { entry.room.phase = 'closed'; entry.room.reason = 'host-left'; this.publish(id) }
      } else if (entry.room.hostId === this.deps.selfId && entry.room.phase !== 'closed') {
        for (const member of [...entry.room.viewers]) {
          if (member !== this.deps.selfId && (!this.authorized(entry, member) || !this.deps.peer(member)?.online)) {
            this.depart(entry, member); this.commit(entry)
          }
        }
        if (!this.authorized(entry, this.deps.selfId)) this.closeRoom(entry, 'host-left')
      }
    }
  }

  /** 接受邀请时限制来源、数量和时效；仅首次入库聊天卡片。 */
  private acceptInvite(from: string, invite: BoardInvite, record: boolean): boolean {
    if (invite.hostId !== from || !this.supported(from) || this.age(invite) > MAX_AGE || this.age(invite) < -60_000) return false
    const previous = this.entries.get(invite.roomId)
    if (previous) return this.sameInvite(previous.room, invite)
    if (this.entries.size >= MAX_ROOMS) return false
    const entry: Entry = { room: { ...invite, revision: 0, seats: [null, null], viewers: [], ready: [],
      phase: 'waiting', state: initialGame(invite.game), reason: 'none' }, opponent: from, joined: false, error: '', positions: new Map() }
    if (!this.authorized(entry, this.deps.selfId)) return false
    this.entries.set(invite.roomId, entry)
    if (record) this.deps.inviteMessage(invite, from, false, from)
    return true
  }

  /** 动态群资格与单聊双方是唯一授权边界，知道房间 ID 不代表有权限。 */
  private authorized(entry: Entry, id: string): boolean {
    const room = entry.room
    if (room.groupId) {
      const members = this.deps.members(room.groupId)
      return Boolean(members?.includes(id) && members.includes(room.hostId))
    }
    return id === this.deps.selfId || id === entry.opponent || id === room.hostId
  }

  /** 不允许同一房间 ID 被篡改为其他会话、棋种或房主。 */
  private sameInvite(a: BoardInvite, b: BoardInvite): boolean {
    return a.roomId === b.roomId && a.hostId === b.hostId && a.game === b.game && a.groupId === b.groupId && a.createdAt === b.createdAt
  }

  /** 能力协商排除旧客户端和不具备棋盘功能的机器人。 */
  private supported(id: string): boolean {
    const peer = this.deps.peer(id)
    return Boolean(peer?.online && peer.caps.includes(BOARD_CAP))
  }

  /** 房主同步执行所有动作；抢座和回合冲突无法通过并行请求绕过。 */
  private apply(entry: Entry, from: string, action: BoardAction, revision: number): boolean {
    const room = entry.room
    if (!this.authorized(entry, from) || room.phase === 'closed') return this.reject(entry, from, 'forbidden')
    if (action.kind === 'join') {
      if (!room.viewers.includes(from)) {
        if (room.viewers.length >= 200) return this.reject(entry, from, 'full')
        room.viewers.push(from)
      }
      this.commit(entry); return true
    }
    if (!room.viewers.includes(from)) return this.reject(entry, from, 'forbidden')
    if (action.kind === 'leave') {
      this.depart(entry, from); this.commit(entry); return true
    }
    if (revision !== room.revision) return this.reject(entry, from, 'stale')
    const side = room.seats.indexOf(from)
    if (action.kind === 'seat') {
      if (room.phase === 'playing') return this.reject(entry, from, 'forbidden')
      if (room.seats[action.side] && room.seats[action.side] !== from) return this.reject(entry, from, 'full')
      if (side >= 0) room.seats[side] = null
      room.seats[action.side] = from; room.ready = []
      if (room.phase === 'waiting' && room.seats.every(Boolean)) this.begin(entry)
    } else if (action.kind === 'spectate' || action.kind === 'resign') {
      if (side >= 0) this.depart(entry, from, false)
    } else if (action.kind === 'ready') {
      if (side < 0 || room.phase !== 'finished') return this.reject(entry, from, 'forbidden')
      if (!room.ready.includes(from)) room.ready.push(from)
      if (room.seats.every(id => id && room.ready.includes(id))) this.begin(entry)
    } else if (action.kind === 'move') {
      if (room.phase !== 'playing' || side < 0 || room.state.turn !== side) return this.reject(entry, from, 'forbidden')
      const state = moveGame(room.game, room.state, action.from, action.to)
      if (!state) return this.reject(entry, from, 'illegal')
      const key = positionKey(state), repeats = (entry.positions.get(key) ?? 0) + 1
      entry.positions.set(key, repeats)
      if (room.game === 'xiangqi' && repeats >= 3 && state.winner === null) state.winner = 'draw'
      room.state = state
      if (state.winner !== null) { room.phase = 'finished'; room.reason = state.winner === 'draw' ? 'draw' : 'win' }
    }
    this.commit(entry); return true
  }

  /** 双方到齐或共同申请重开时初始化盘面，不自动替旁观者入座。 */
  private begin(entry: Entry): void {
    entry.room.state = initialGame(entry.room.game); entry.room.phase = 'playing'; entry.room.reason = 'none'; entry.room.ready = []
    entry.positions = new Map([[positionKey(entry.room.state), 1]])
  }

  /** 对弈中离座即认输，旁观者离开不改变胜负。 */
  private depart(entry: Entry, id: string, leave = true): void {
    const room = entry.room, side = room.seats.indexOf(id)
    if (side >= 0) {
      if (room.phase === 'playing') { room.state.winner = side === 0 ? 1 : 0; room.phase = 'finished'; room.reason = 'resigned' }
      room.seats[side] = null; room.ready = []
    }
    if (leave) { room.viewers = room.viewers.filter(member => member !== id); if (id === this.deps.selfId) entry.joined = false }
  }

  /** 拒绝时同步当前快照，访客能从乱序或抢座冲突中恢复。 */
  private reject(entry: Entry, to: string, reason: 'stale' | 'forbidden' | 'full' | 'illegal'): false {
    if (to === this.deps.selfId) { entry.error = reason; this.publish(entry.room.roomId) }
    else {
      if (this.authorized(entry, to)) void this.deps.send(to, { op: 'state', room: entry.room })
      void this.deps.send(to, { op: 'error', roomId: entry.room.roomId, reason })
    }
    return false
  }

  /** 广播前快照由传输层编码；每次成功变更只增加一次修订号。 */
  private commit(entry: Entry): void {
    entry.room.revision++; entry.error = ''
    for (const id of entry.room.viewers) if (id !== this.deps.selfId) void this.deps.send(id, { op: 'state', room: entry.room })
    this.publish(entry.room.roomId)
  }

  /** 关闭状态保留到窗口离开，便于用户看清结束原因。 */
  private closeRoom(entry: Entry, reason: 'host-left' | 'expired'): void {
    entry.room.phase = 'closed'; entry.room.reason = reason; this.commit(entry)
  }

  /** 统一推送只读视图，窗口不能拿到主进程可变对象引用。 */
  private publish(id: string): void { const view = this.view(id); if (view) this.emit('state', view) }
  /** 邀请时间按发现层时钟校准，避免不同电脑时钟偏差导致有效房间被拒绝。 */
  private age(invite: BoardInvite): number {
    const created = invite.hostId === this.deps.selfId ? invite.createdAt : this.deps.correctTime?.(invite.hostId, invite.createdAt) ?? invite.createdAt
    return this.now() - created
  }
  /** 时钟可注入，过期回收无需真实等待。 */
  private now(): number { return this.deps.now?.() ?? Date.now() }
}
