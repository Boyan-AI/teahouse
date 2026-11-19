import type { BoardGame, GameState, Side } from './types'

/** 创建空五子棋盘或标准中国象棋初始盘面；所有返回值均为可序列化数据。 */
export function initialGame(game: BoardGame): GameState {
  const board = Array<number>(game === 'gomoku' ? 225 : 90).fill(0)
  if (game === 'xiangqi') {
    const back = [5, 4, 3, 2, 1, 2, 3, 4, 5]
    for (let x = 0; x < 9; x++) { board[x] = -back[x]; board[81 + x] = back[x] }
    for (const x of [1, 7]) { board[18 + x] = -6; board[63 + x] = 6 }
    for (const x of [0, 2, 4, 6, 8]) { board[27 + x] = -7; board[54 + x] = 7 }
  }
  return { board, turn: 0, winner: null, plies: 0 }
}

/** 象棋正数为红方，负数为黑方；空格没有归属。 */
function owns(piece: number, side: Side): boolean {
  return side === 0 ? piece > 0 : piece < 0
}

/** 统计横线或竖线两点间的阻挡子数，斜线不参与车炮规则。 */
function blockers(board: number[], from: number, to: number): number {
  if (from % 9 !== to % 9 && Math.floor(from / 9) !== Math.floor(to / 9)) return -1
  const step = from % 9 === to % 9 ? (to > from ? 9 : -9) : (to > from ? 1 : -1)
  let count = 0
  for (let i = from + step; i !== to; i += step) if (board[i]) count++
  return count
}

/** 象棋基础走法：含马腿、象眼、炮架、河界、九宫及将帅照面。 */
function pseudoLegal(board: number[], from: number, to: number, side: Side): boolean {
  if (from === to || !owns(board[from], side) || owns(board[to], side)) return false
  const x = from % 9, y = Math.floor(from / 9), tx = to % 9, ty = Math.floor(to / 9)
  const dx = tx - x, dy = ty - y, ax = Math.abs(dx), ay = Math.abs(dy)
  const palace = tx >= 3 && tx <= 5 && (side === 0 ? ty >= 7 : ty <= 2)
  switch (Math.abs(board[from])) {
    case 1:
      if (Math.abs(board[to]) === 1 && x === tx && blockers(board, from, to) === 0) return true
      return palace && ax + ay === 1
    case 2: return palace && ax === 1 && ay === 1
    case 3: return ax === 2 && ay === 2 && (side === 0 ? ty >= 5 : ty <= 4) && !board[from + dy / 2 * 9 + dx / 2]
    case 4:
      if (ax === 2 && ay === 1) return !board[from + Math.sign(dx)]
      return ax === 1 && ay === 2 && !board[from + Math.sign(dy) * 9]
    case 5: return blockers(board, from, to) === 0
    case 6: return blockers(board, from, to) === (board[to] ? 1 : 0)
    case 7:
      return (dx === 0 && dy === (side === 0 ? -1 : 1)) ||
        ((side === 0 ? y <= 4 : y >= 5) && ay === 0 && ax === 1)
    default: return false
  }
}

/** 判断一方是否被将军；缺少本方将帅同样视为不可继续。 */
export function inCheck(board: number[], side: Side): boolean {
  const king = board.indexOf(side === 0 ? 1 : -1)
  if (king < 0) return true
  for (let from = 0; from < 90; from++) {
    if (owns(board[from], side === 0 ? 1 : 0) && pseudoLegal(board, from, king, side === 0 ? 1 : 0)) return true
  }
  return false
}

/** 先验证基础走法，再模拟落子，禁止自陷将军或暴露将帅照面。 */
export function legalXiangqiMove(board: number[], side: Side, from: number, to: number): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= 90 || to < 0 || to >= 90) return false
  if (!pseudoLegal(board, from, to, side)) return false
  const next = [...board]; next[to] = next[from]; next[from] = 0
  return !inCheck(next, side)
}

/** 检查是否尚有合法应手；象棋困毙与将死均判无应手一方负。 */
function hasLegalMove(board: number[], side: Side): boolean {
  for (let from = 0; from < 90; from++) {
    if (!owns(board[from], side)) continue
    for (let to = 0; to < 90; to++) if (legalXiangqiMove(board, side, from, to)) return true
  }
  return false
}

/** 检查五子棋四条轴线的连续子数；休闲规则五连或以上均获胜。 */
function fiveInRow(board: number[], at: number): boolean {
  const x = at % 15, y = Math.floor(at / 15), piece = board[at]
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let count = 1
    for (const direction of [-1, 1]) {
      let nx = x + dx * direction, ny = y + dy * direction
      while (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && board[ny * 15 + nx] === piece) {
        count++; nx += dx * direction; ny += dy * direction
      }
    }
    if (count >= 5) return true
  }
  return false
}

/** 不修改原盘面；非法走子返回 null，胜负只由规则引擎裁定。 */
export function moveGame(game: BoardGame, state: GameState, from: number, to: number): GameState | null {
  if (state.winner !== null || !Number.isInteger(to) || to < 0 || to >= state.board.length) return null
  if (game === 'gomoku' ? state.board[to] !== 0 : !legalXiangqiMove(state.board, state.turn, from, to)) return null
  const board = [...state.board]
  if (game === 'gomoku') board[to] = state.turn + 1
  else { board[to] = board[from]; board[from] = 0 }
  const next = (state.turn === 0 ? 1 : 0) as Side
  let winner: GameState['winner'] = null
  if (game === 'gomoku') {
    if (fiveInRow(board, to)) winner = state.turn
    else if (board.every(Boolean)) winner = 'draw'
  } else if (!hasLegalMove(board, next)) winner = state.turn
  return { board, turn: next, winner, plies: state.plies + 1 }
}

/** 重复局面必须包含轮到谁走；历史仅保存在房主，不随快照重复广播。 */
export function positionKey(state: GameState): string {
  return state.turn + ':' + state.board.map(piece => String.fromCharCode(piece + 72)).join('')
}
