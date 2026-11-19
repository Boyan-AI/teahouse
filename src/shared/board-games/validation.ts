import type { BoardAction, BoardInvite, BoardPacket, BoardRoom } from './types'

/** 网络和 IPC 共用的有限对象校验，不允许额外字段或原型载荷。 */
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** 标识均使用项目既有节点/消息 ID 长度范围。 */
export function boardId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[a-zA-Z0-9:_-]+$/.test(value)
}
/** 所有可写请求均为小型定长对象，拒绝未知键。 */
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
/** 校验创建邀请；时间戳不参与授权，实际群资格由主进程复核。 */
export function isBoardInvite(value: unknown): value is BoardInvite {
  return record(value) && keys(value, ['roomId', 'hostId', 'game', 'groupId', 'createdAt']) &&
    boardId(value.roomId) && boardId(value.hostId) && (value.game === 'gomoku' || value.game === 'xiangqi') &&
    (value.groupId === '' || boardId(value.groupId)) && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) > 0
}
/** 主进程只接受明确定义的席位、走子和生命周期动作。 */
export function isBoardAction(value: unknown): value is BoardAction {
  if (!record(value)) return false
  if (value.kind === 'seat') return keys(value, ['kind', 'side']) && (value.side === 0 || value.side === 1)
  if (value.kind === 'move') return keys(value, ['kind', 'from', 'to']) &&
    Number.isInteger(value.from) && Number(value.from) >= -1 && Number(value.from) < 225 &&
    Number.isInteger(value.to) && Number(value.to) >= 0 && Number(value.to) < 225
  return keys(value, ['kind']) && ['join', 'spectate', 'leave', 'resign', 'ready'].includes(String(value.kind))
}
/** 快照包含固定长度棋盘和有上限的成员列表，防止超量分配与非法枚举。 */
export function isBoardRoom(value: unknown): value is BoardRoom {
  if (!record(value)) return false
  const invite = { roomId: value.roomId, hostId: value.hostId, game: value.game, groupId: value.groupId, createdAt: value.createdAt }
  if (!isBoardInvite(invite) || !keys(value, [...Object.keys(invite), 'revision', 'seats', 'viewers', 'ready', 'phase', 'state', 'reason'])) return false
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return false
  if (!Array.isArray(value.seats) || value.seats.length !== 2 || !value.seats.every(id => id === null || boardId(id))) return false
  if (value.seats[0] !== null && value.seats[0] === value.seats[1]) return false
  for (const list of [value.viewers, value.ready]) {
    if (!Array.isArray(list) || list.length > 200 || !list.every(boardId) || new Set(list).size !== list.length) return false
  }
  if (!(value.seats as unknown[]).every(id => id === null || (value.viewers as unknown[]).includes(id))) return false
  if (!(value.ready as unknown[]).every(id => (value.seats as unknown[]).includes(id))) return false
  if (!['waiting', 'playing', 'finished', 'closed'].includes(String(value.phase)) ||
    !['none', 'win', 'draw', 'resigned', 'host-left', 'expired'].includes(String(value.reason))) return false
  const state = value.state
  return record(state) && keys(state, ['board', 'turn', 'winner', 'plies']) &&
    (state.turn === 0 || state.turn === 1) && (state.winner === null || state.winner === 0 || state.winner === 1 || state.winner === 'draw') &&
    Number.isInteger(state.plies) && Number(state.plies) >= 0 && Number.isSafeInteger(state.plies) &&
    Array.isArray(state.board) && state.board.length === (value.game === 'gomoku' ? 225 : 90) &&
    state.board.every(piece => Number.isInteger(piece) && (value.game === 'gomoku' ? piece >= 0 && piece <= 2 : piece >= -7 && piece <= 7))
}
/** 单独控制类型可被旧客户端平滑忽略，不污染现有文本/随机 PK 协议。 */
export function isBoardPacket(value: unknown): value is BoardPacket {
  if (!record(value)) return false
  if (value.op === 'invite') return keys(value, ['op', 'invite']) && isBoardInvite(value.invite)
  if (value.op === 'state') return keys(value, ['op', 'room']) && isBoardRoom(value.room)
  if (value.op === 'request') return keys(value, ['op', 'roomId', 'revision', 'action']) && boardId(value.roomId) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && isBoardAction(value.action)
  return value.op === 'error' && keys(value, ['op', 'roomId', 'reason']) && boardId(value.roomId) &&
    ['stale', 'forbidden', 'full', 'illegal', 'unavailable'].includes(String(value.reason))
}
