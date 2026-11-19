/** 棋类独立于骰子/猜拳；0 方为五子棋黑方或象棋红方。 */
export type BoardGame = 'gomoku' | 'xiangqi'
export type Side = 0 | 1
export interface GameState {
  board: number[]
  turn: Side
  winner: Side | 'draw' | null
  plies: number
}
export interface BoardInvite {
  roomId: string
  hostId: string
  game: BoardGame
  groupId: string
  createdAt: number
}
export interface BoardRoom extends BoardInvite {
  revision: number
  seats: [string | null, string | null]
  viewers: string[]
  ready: string[]
  phase: 'waiting' | 'playing' | 'finished' | 'closed'
  state: GameState
  reason: 'none' | 'win' | 'draw' | 'resigned' | 'host-left' | 'expired'
}
export type BoardAction =
  | { kind: 'join' | 'spectate' | 'leave' | 'resign' | 'ready' }
  | { kind: 'seat'; side: Side }
  | { kind: 'move'; from: number; to: number }
export type BoardPacket =
  | { op: 'invite'; invite: BoardInvite }
  | { op: 'state'; room: BoardRoom }
  | { op: 'request'; roomId: string; revision: number; action: BoardAction }
  | { op: 'error'; roomId: string; reason: 'stale' | 'forbidden' | 'full' | 'illegal' | 'unavailable' }
export interface BoardView {
  room: BoardRoom
  selfId: string
  names: Record<string, string>
  error: string
}
