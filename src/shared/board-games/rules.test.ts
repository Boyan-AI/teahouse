import { describe, expect, it } from 'vitest'
import { initialGame, inCheck, legalXiangqiMove, moveGame, positionKey } from './rules'
import { isBoardAction, isBoardInvite, isBoardPacket, isBoardRoom } from './validation'
import type { GameState } from './types'

/** 构造不照面的少子盘面，专项测试走子约束。 */
function sparse(): number[] { const b = Array<number>(90).fill(0); b[3] = -1; b[85] = 1; return b }
/** 将测试盘面包装成红方待走状态。 */
function state(board: number[]): GameState { return { board, turn: 0, winner: null, plies: 0 } }

describe('五子棋休闲棋规', () => {
  it.each([[1, 0], [0, 1], [1, 1], [1, -1]])('检测四轴五连 %s/%s', (dx, dy) => {
    const s = initialGame('gomoku')
    for (let i = 0; i < 4; i++) s.board[(7 + i * dy) * 15 + 4 + i * dx] = 1
    expect(moveGame('gomoku', s, -1, (7 + 4 * dy) * 15 + 4 + 4 * dx)?.winner).toBe(0)
  })
  it('不跨行拼出五连且不修改输入', () => {
    const s = initialGame('gomoku'); for (const i of [12, 13, 14, 15]) s.board[i] = 1
    const next = moveGame('gomoku', s, -1, 16)!
    expect(next.winner).toBeNull(); expect(s.board[16]).toBe(0); expect(next.turn).toBe(1)
  })
  it('长连获胜；结束后、越界、非整数及占点不能落子', () => {
    const s = initialGame('gomoku'); for (const i of [0, 1, 2, 4, 5]) s.board[i] = 1
    expect(moveGame('gomoku', s, -1, 3)?.winner).toBe(0)
    for (const to of [-1, 225, 1.5, NaN, 0]) expect(moveGame('gomoku', s, -1, to)).toBeNull()
    expect(moveGame('gomoku', { ...s, winner: 'draw' }, -1, 9)).toBeNull()
  })
  it('无五连的满盘判和', () => {
    const s = initialGame('gomoku')
    s.board = s.board.map((_, i) => (i % 15 + 2 * Math.floor(i / 15)) % 4 < 2 ? 1 : 2)
    s.board[0] = 0
    expect(moveGame('gomoku', s, -1, 0)?.winner).toBe('draw')
  })
})

describe('中国象棋合法走子', () => {
  it('标准开局32枚棋子，红先且两方不被将军', () => {
    const s = initialGame('xiangqi')
    expect(s.board.filter(Boolean)).toHaveLength(32)
    expect(inCheck(s.board, 0)).toBe(false); expect(inCheck(s.board, 1)).toBe(false)
    expect(moveGame('xiangqi', s, 54, 45)?.board[45]).toBe(7)
  })
  it('马腿限制', () => {
    const b = sparse(); b[67] = 4
    expect(legalXiangqiMove(b, 0, 67, 48)).toBe(true)
    b[58] = 7; expect(legalXiangqiMove(b, 0, 67, 48)).toBe(false)
  })
  it('象眼、象不能过河', () => {
    const b = sparse(); b[65] = 3
    expect(legalXiangqiMove(b, 0, 65, 49)).toBe(true)
    b[57] = 7; expect(legalXiangqiMove(b, 0, 65, 49)).toBe(false)
    b[57] = 0; b[49] = 3; expect(legalXiangqiMove(b, 0, 49, 29)).toBe(false)
  })
  it('士帅不能离开九宫，帅不能斜走', () => {
    const b = sparse(); b[75] = 2
    expect(legalXiangqiMove(b, 0, 75, 67)).toBe(true)
    expect(legalXiangqiMove(b, 0, 75, 65)).toBe(false)
    expect(legalXiangqiMove(b, 0, 85, 84)).toBe(true)
    expect(legalXiangqiMove(b, 0, 85, 76)).toBe(true)
    expect(legalXiangqiMove(b, 0, 85, 75)).toBe(false)
  })
  it('车不能越子；炮移动不能越子，吃子必须恰一个炮架', () => {
    const b = sparse(); b[63] = 6; b[27] = -5
    expect(legalXiangqiMove(b, 0, 63, 27)).toBe(false)
    expect(legalXiangqiMove(b, 0, 63, 36)).toBe(true)
    b[45] = 7; expect(legalXiangqiMove(b, 0, 63, 27)).toBe(true)
    expect(legalXiangqiMove(b, 0, 63, 36)).toBe(false)
    b[36] = -7; expect(legalXiangqiMove(b, 0, 63, 27)).toBe(false)
    b[63] = 5; expect(legalXiangqiMove(b, 0, 63, 27)).toBe(false)
  })
  it('兵过河才能横走且不可后退', () => {
    const b = sparse(); b[54] = 7
    expect(legalXiangqiMove(b, 0, 54, 55)).toBe(false)
    expect(legalXiangqiMove(b, 0, 54, 63)).toBe(false)
    b[36] = 7; expect(legalXiangqiMove(b, 0, 36, 37)).toBe(true)
    expect(legalXiangqiMove(b, 0, 36, 27)).toBe(true)
  })
  it('禁止暴露将帅照面及自陷将军', () => {
    const b = sparse(); b[3] = 0; b[4] = -1; b[49] = 5
    expect(legalXiangqiMove(b, 0, 49, 48)).toBe(false)
    expect(legalXiangqiMove(b, 0, 49, 40)).toBe(true)
    b[49] = 0; expect(inCheck(b, 0)).toBe(true)
    const c = sparse(); c[4] = -5; c[76] = 5
    expect(legalXiangqiMove(c, 0, 76, 77)).toBe(false)
  })
  it('将死和困毙均判负', () => {
    // 黑将(4,0)被两侧车封锁；红方补上中路车即将死。
    const b = sparse(); b[3] = 0; b[4] = -1; b[12] = 5; b[14] = 5; b[22] = 5
    expect(moveGame('xiangqi', state(b), 22, 13)?.winner).toBe(0)
    // 宫外红兵走一步，左右车保持封锁但不将军，构成困毙。
    const c = sparse(); c[3] = 0; c[4] = -1; c[12] = 5; c[14] = 5; c[76] = 2; c[54] = 7
    const result = moveGame('xiangqi', state(c), 54, 45)!
    expect(inCheck(result.board, 1)).toBe(false); expect(result.winner).toBe(0)
  })
  it('非法索引、空子和对方子不可移动，局面键包含轮次', () => {
    const s = initialGame('xiangqi')
    for (const [from, to] of [[-1, 0], [90, 0], [0.5, 1], [0, 9], [45, 36]]) expect(moveGame('xiangqi', s, from, to)).toBeNull()
    expect(positionKey(s)).not.toBe(positionKey({ ...s, turn: 1 }))
  })
})

describe('棋类报文白名单', () => {
  const invite = { roomId: 'room', hostId: 'host', game: 'gomoku' as const, groupId: '', createdAt: 1 }
  const room = { ...invite, revision: 0, seats: [null, null], viewers: ['host'], ready: [], phase: 'waiting', reason: 'none', state: initialGame('gomoku') }
  it('接受合法邀请和固定长度棋盘', () => {
    expect(isBoardInvite(invite)).toBe(true); expect(isBoardRoom(room)).toBe(true)
    expect(isBoardPacket({ op: 'state', room })).toBe(true)
  })
  it('拒绝额外字段、超长标识、非法动作与棋盘', () => {
    expect(isBoardInvite({ ...invite, secret: 'bad' })).toBe(false)
    expect(isBoardInvite({ ...invite, hostId: 'a'.repeat(65) })).toBe(false)
    for (const action of [{ kind: 'seat', side: 2 }, { kind: 'move', from: 0, to: 225 }, { kind: 'join', side: 0 }]) expect(isBoardAction(action)).toBe(false)
    expect(isBoardRoom({ ...room, state: { ...room.state, board: [0] } })).toBe(false)
    expect(isBoardRoom({ ...room, seats: ['host', 'host'] })).toBe(false)
    expect(isBoardRoom({ ...room, seats: ['unknown', null] })).toBe(false)
    expect(isBoardRoom({ ...room, viewers: ['host', 'host'] })).toBe(false)
    expect(isBoardRoom({ ...room, ready: ['unknown'] })).toBe(false)
    expect(isBoardPacket({ op: 'request', roomId: 'room', revision: -1, action: { kind: 'join' } })).toBe(false)
  })
})
