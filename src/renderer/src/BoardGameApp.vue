<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { tr, language } from './utils/i18n'
import { applyAppearance } from './utils/appearance'
import { legalXiangqiMove, type BoardAction, type BoardView, type Side } from '../../shared/board-games'

const roomId = new URLSearchParams(location.hash.split('?')[1] ?? '').get('room') ?? ''
const view = ref<BoardView | null>(null)
const selected = ref(-1)
const error = ref('')
const pending = ref(false)
const resultDialog = ref<HTMLDialogElement | null>(null)
const viewport = ref<HTMLElement | null>(null)
const canvas = ref<HTMLElement | null>(null)
const scale = ref(1)
let fitObserver: ResizeObserver | undefined
/** 同时适配宽高；读取未变换的逻辑尺寸，名单、状态和字体变化时也重新适配。 */
function fitViewport(): void {
  if (!viewport.value || !canvas.value) return
  scale.value = Math.min(1, viewport.value.clientWidth / 660, viewport.value.clientHeight / canvas.value.offsetHeight)
}
const subscriptions: Array<() => void> = []
const room = computed(() => view.value?.room)
const mySide = computed(() => room.value?.seats.indexOf(view.value?.selfId ?? '') ?? -1)
const myTurn = computed(() => room.value?.phase === 'playing' && mySide.value === room.value.state.turn)
const title = computed(() => tr(room.value?.game === 'xiangqi' ? '中国象棋' : '五子棋'))
const status = computed(() => {
  const r = room.value
  if (!r) return tr('正在连接房间…')
  if (r.phase === 'closed') return tr(r.reason === 'expired' ? '房间已过期' : '房主已离线，房间结束')
  if (r.phase === 'waiting') return tr(r.seats.every(Boolean) ? '双方已入座，点击开始对局' : '请选择座位，等待另一位玩家加入')
  if (r.state.winner === 'draw') return tr('和棋')
  if (r.state.winner !== null) return tr('{0} 获胜', { 0: sideLabel(r.state.winner) })
  return tr('轮到 {0}', { 0: sideLabel(r.state.turn) })
})
/** 双方称谓明确区别棋种，避免象棋误显示黑先。 */
function sideLabel(side: Side): string { return tr(room.value?.game === 'xiangqi' ? (side === 0 ? '红方' : '黑方') : (side === 0 ? '黑方' : '白方')) }
/** 棋子用本地文字绘制，不加载外网图片；英文界面使用国际化缩写。 */
function pieceLabel(piece: number): string {
  if (!piece) return ''
  if (room.value?.game === 'gomoku') return piece === 1 ? tr('黑子') : tr('白子')
  if (language.value === 'en') return ['', 'K', 'A', 'E', 'H', 'R', 'C', 'P'][Math.abs(piece)]
  return (piece > 0 ? ['', '帅', '仕', '相', '马', '车', '炮', '兵'] : ['', '将', '士', '象', '马', '车', '炮', '卒'])[Math.abs(piece)]
}
/** 只接收本窗口房间及不倒退的修订，落子最终仍由主机复核。 */
function accept(next: BoardView | null): void {
  if (!next || next.room.roomId !== roomId || (view.value && next.room.revision < view.value.room.revision)) return
  view.value = next; selected.value = -1
}
/** 动作串行提交，清晰显示断线、旧修订和权限错误。 */
async function act(action: BoardAction): Promise<void> {
  if (pending.value) return
  pending.value = true; error.value = ''
  try { if (!await window.pantry.actBoardGame(roomId, action)) error.value = tr('操作失败，请检查连接或重新进入房间') }
  catch { error.value = tr('操作失败，请检查连接或重新进入房间') }
  finally { pending.value = false }
}
/** 旁观者和非当前回合不可发走子；象棋先选己子，再选合法落点。 */
function play(index: number): void {
  const r = room.value
  if (!r || !myTurn.value || pending.value) return
  if (r.game === 'gomoku') { if (!r.state.board[index]) void act({ kind: 'move', from: -1, to: index }); return }
  const piece = r.state.board[index]
  if (piece && (mySide.value === 0 ? piece > 0 : piece < 0)) { selected.value = index; return }
  if (selected.value >= 0 && legalXiangqiMove(r.state.board, mySide.value as Side, selected.value, index)) void act({ kind: 'move', from: selected.value, to: index })
}
/** 对弈中离座需要明确确认，认输动作由房主同步给所有观众。 */
async function spectate(): Promise<void> {
  if (room.value?.phase === 'playing' && mySide.value >= 0 && !confirm(tr('离座将视为认输，确定继续？'))) return
  await act({ kind: 'spectate' })
}
/** 使用原生模态框提供焦点约束；同一局结束只弹一次，选择返回后不反复打断。 */
watch(() => room.value?.phase, phase => {
  if (phase === 'finished' && resultDialog.value && !resultDialog.value.open) resultDialog.value.showModal()
}, { flush: 'post' })
/** 结束只退出本人的棋盘，主进程照常处理离场，不替其他成员关闭房间。 */
async function endGame(): Promise<void> {
  if (pending.value) return
  try { await window.pantry.closeWindow() }
  catch { error.value = tr('操作失败，请检查连接或重新进入房间') }
}
/** 初始化先订阅再取快照，避免独立入口懒加载期间丢失同步事件。 */
onMounted(async () => {
  fitObserver = new ResizeObserver(fitViewport)
  if (viewport.value) fitObserver.observe(viewport.value)
  if (canvas.value) fitObserver.observe(canvas.value)
  fitViewport()
  subscriptions.push(window.pantry.onBoardGame(accept), window.pantry.onSettingsUpdated(applyAppearance))
  try { applyAppearance(await window.pantry.getSettings()); accept(await window.pantry.getBoardGame(roomId)) }
  catch { error.value = tr('初始化失败') }
  requestAnimationFrame(() => requestAnimationFrame(() => window.pantry.settingsReady()))
})
onUnmounted(() => { fitObserver?.disconnect(); for (const stop of subscriptions) stop() })
</script>

<template>
  <div ref="viewport" class="game-viewport">
  <main ref="canvas" class="game" :style="{ transform: `translate(-50%, -50%) scale(${scale})` }">
    <header><h1>{{ title }}</h1><span>{{ tr('双人对弈 · 自由旁观') }}</span></header>
    <p role="status" class="status">{{ status }}</p>
    <template v-if="room && view">
      <section class="seats" :aria-label="tr('对弈座位')">
        <button v-for="side in ([0, 1] as const)" :key="side" type="button" :disabled="pending || room.phase === 'playing' || room.phase === 'closed' || !!room.seats[side]" @click="act({ kind: 'seat', side })">
          {{ sideLabel(side) }} · {{ room.seats[side] ? (view.names[room.seats[side]!] || tr('已入座')) : tr('点击入座') }}
          {{ room.seats[side] === view.selfId ? ' (' + tr('我') + ')' : '' }}
        </button>
      </section>
      <p class="hint">{{ tr('房间：{0}', { 0: room.roomId.slice(0, 8) }) }} · {{ tr('已加入：{0}', { 0: room.viewers.map(id => view?.names[id] || id.slice(0, 8)).join('、') }) }}</p>
      <button v-if="room.phase === 'waiting'" class="start" type="button" :disabled="pending || mySide < 0 || !room.seats.every(Boolean)" @click="act({ kind: 'start' })">{{ tr('开始对局') }}</button>
      <div class="board" :class="room.game" role="group" :aria-label="title">
        <button v-for="(piece, index) in room.state.board" :key="index" type="button" :class="{ selected: selected === index }" :disabled="!myTurn || pending || (room.game === 'gomoku' && !!piece)" :aria-label="tr('第 {0} 行，第 {1} 列：{2}', { 0: Math.floor(index / (room.game === 'gomoku' ? 15 : 9)) + 1, 1: index % (room.game === 'gomoku' ? 15 : 9) + 1, 2: pieceLabel(piece) || tr('空位') })" @click="play(index)">
          <span v-if="piece" class="piece" :class="{ dark: room.game === 'gomoku' ? piece === 1 : piece < 0, light: room.game === 'gomoku' && piece === 2, red: room.game === 'xiangqi' && piece > 0 }">{{ room.game === 'xiangqi' ? pieceLabel(piece) : '' }}</span>
        </button>
      </div>
      <footer>
        <button type="button" :disabled="pending || room.phase === 'closed'" @click="spectate">{{ tr(mySide >= 0 ? '离座 / 旁观' : '正在旁观') }}</button>
        <button v-if="room.phase === 'finished' && mySide >= 0" type="button" :disabled="pending || room.ready.includes(view.selfId)" @click="act({ kind: 'ready' })">{{ tr(room.ready.includes(view.selfId) ? '等待对方准备' : '准备再来一局') }}</button>
        <span>{{ tr('旁观人数：{0}', { 0: room.viewers.filter(id => !room?.seats.includes(id)).length }) }}</span>
      </footer>
      <p class="hint">{{ tr(room.game === 'gomoku' ? '15 路无禁手，五连及以上获胜。' : '常规象棋规则；困毙判负，三次重复和棋，不采用竞赛长将长捉裁定。') }}</p>
      <p class="hint">{{ tr('房主退出应用或断线后房间结束；房间最长保留两小时。') }}</p>
      <p v-if="view.error" role="alert">{{ tr('房间操作被拒绝：{0}', { 0: tr(({ stale: '状态已更新，请重试', forbidden: '无权执行此操作', full: '座位已满', illegal: '非法走子', unavailable: '房主暂不可达' } as Record<string, string>)[view.error] || '操作失败') }) }}</p>
    </template>
    <dialog v-if="room?.phase === 'finished' && view" ref="resultDialog" class="result" :style="{ transform: `translate(-50%, -50%) scale(${scale})` }" aria-labelledby="game-result-title" aria-describedby="game-result-help" @cancel.prevent>
      <span class="result-mark" aria-hidden="true">{{ room.state.winner === 'draw' ? '＝' : '★' }}</span>
      <p class="result-caption">{{ tr('本局已结束') }}</p>
      <h2 id="game-result-title">{{ status }}</h2>
      <p id="game-result-help">{{ tr(mySide >= 0 ? '双方选择再来一局后，将重新开始对局。结束只退出你自己的棋盘。' : '你正在旁观。可以继续等待下一局，或结束旁观。') }}</p>
      <p v-if="mySide >= 0 && !room.seats.every(Boolean)" role="status">{{ tr('有玩家已离座，可返回棋盘等待新玩家加入。') }}</p>
      <div class="result-actions">
        <button v-if="mySide >= 0" class="again" type="button" :disabled="pending || !room.seats.every(Boolean) || room.ready.includes(view.selfId)" @click="act({ kind: 'ready' })">{{ tr(room.ready.includes(view.selfId) ? '等待对方准备' : '再来一局') }}</button>
        <button v-else type="button" class="again" @click="resultDialog?.close()">{{ tr('继续旁观') }}</button>
        <button class="end-game" type="button" :disabled="pending" @click="endGame">{{ tr('结束') }}</button>
      </div>
      <button v-if="mySide >= 0" class="return-board" type="button" @click="resultDialog?.close()">{{ tr('返回棋盘') }}</button>
      <p v-if="view.error || error" role="alert">{{ error || tr('操作失败，请检查连接或重新进入房间') }}</p>
    </dialog>
    <p v-if="error" role="alert">{{ error }}</p>
  </main>
  </div>
</template>

<style scoped>
/* 固定逻辑画布整体缩放，避免只缩棋盘导致底部操作被裁掉。 */
.game-viewport { position:fixed; inset:0; overflow:hidden; }
.game { position:absolute; left:50%; top:50%; width:660px; box-sizing:border-box; padding:16px; color:var(--text-1); transform-origin:center; }
.hint { overflow-wrap:anywhere; }
.seats button { min-width:0; overflow-wrap:anywhere; }
header, .seats, footer { display:flex; align-items:center; gap:12px; justify-content:space-between; flex-wrap:wrap; }
h1 { font-size:22px; margin:0; } header span, .hint { color:var(--text-2); font-size:13px; line-height:1.6; }
.status { font-weight:600; margin:16px 0; } .seats { margin-bottom:16px; } .seats button { flex:1; }
button { padding:8px 12px; border:1px solid var(--line); border-radius:6px; font:inherit; color:var(--text-1); background:var(--surface-hover); cursor:pointer; }
.start { display:block; margin:0 auto 16px; background:var(--primary); color:var(--on-primary); } button:disabled { opacity:.55; cursor:default; } footer { margin-top:16px; font-size:13px; }
.board { display:grid; width:min(100%,600px); margin:auto; padding:8px; box-sizing:border-box; border:1px solid var(--primary-border); background:var(--bg-list); }
.gomoku { grid-template-columns:repeat(15,minmax(0,1fr)); aspect-ratio:1; }
.xiangqi { grid-template-columns:repeat(9,minmax(0,1fr)); aspect-ratio:9/10; max-width:504px; }
.board button { aspect-ratio:1; padding:0; min-width:0; border:none; border-radius:0; display:grid; place-items:center; position:relative; background:linear-gradient(var(--text-3),var(--text-3)) center/1px 100% no-repeat,linear-gradient(var(--text-3),var(--text-3)) center/100% 1px no-repeat; }
.board .selected { outline:3px solid var(--primary); outline-offset:-3px; z-index:1; }
.piece { width:80%; height:80%; border-radius:50%; display:grid; place-items:center; box-sizing:border-box; border:2px solid var(--text-1); background:var(--bg-window); font-size:30px; font-weight:700; user-select:none; }
.gomoku .dark { background:#20242c; border-color:#050505; } .gomoku .light { background:#fafafa; border-color:#555; }
.xiangqi .dark { color:var(--text-1); } .red { color:var(--danger); border-color:var(--danger); }
.result { position:fixed; inset:50% auto auto 50%; margin:0; width:360px; max-width:none; max-height:none; overflow:visible; box-sizing:border-box; padding:28px; border:1px solid var(--line); border-radius:16px; background:var(--bg-window); color:var(--text-1); text-align:center; box-shadow:var(--shadow-float); }
.result::backdrop { background:rgb(0 0 0 / 38%); } .result-mark { display:grid; place-items:center; margin:0 auto 16px; width:56px; height:56px; border-radius:50%; background:var(--primary-weak); color:var(--primary); font-size:30px; }
.result h2 { margin:8px 0 16px; font-size:24px; } .result p { font-size:13px; line-height:1.7; color:var(--text-2); } .result-caption { margin:0; }
.result-actions { display:flex; gap:12px; margin-top:24px; } .result-actions button { flex:1; } .again { background:var(--primary); color:var(--on-primary); border-color:var(--primary); }
.return-board { margin-top:16px; border:0; background:transparent; color:var(--text-2); font-size:12px; }
[role=alert] { color:var(--danger); }
</style>
