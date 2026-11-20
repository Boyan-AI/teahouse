import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { computed, createSSRApp, reactive, ref } from 'vue'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialGame, legalXiangqiMove, type BoardView } from '../../../shared/board-games'
const source = readFileSync(new URL('../BoardGameApp.vue', import.meta.url), 'utf8')
afterEach(() => vi.unstubAllGlobals())

/** 提取生产事件处理函数，断言旁观门禁与实际落子 IPC，而非另造实现。 */
function harness(game: 'gomoku' | 'xiangqi' = 'gomoku') {
  const ast = ts.createSourceFile('board.ts', source.split('<script setup lang="ts">')[1].split('</script>')[0], ts.ScriptTarget.Latest, true)
  const actual = ast.statements.filter(s => ts.isFunctionDeclaration(s) && ['accept', 'act', 'play', 'spectate'].includes(s.name?.text ?? '')).map(s => s.getText(ast)).join('\n')
  const view = ref<BoardView>({ room: { roomId: 'r', hostId: 'host', groupId: '', game, createdAt: 1, revision: 1,
    seats: ['host', 'peer'], viewers: ['host', 'peer', 'viewer'], ready: [], phase: 'playing', state: initialGame(game), reason: 'none' }, selfId: 'viewer', names: {}, error: '' })
  const selected = ref(-1), pending = ref(false), error = ref(''), room = computed(() => view.value.room)
  const mySide = computed(() => room.value.seats.indexOf(view.value.selfId))
  const myTurn = computed(() => room.value.phase === 'playing' && mySide.value === room.value.state.turn)
  const send = vi.fn(async () => true); vi.stubGlobal('window', { pantry: { actBoardGame: send } }); vi.stubGlobal('confirm', vi.fn(() => false))
  const code = ts.transpileModule(actual + '\nreturn { play, act, accept, spectate };', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  const h = new Function('view', 'room', 'roomId', 'selected', 'pending', 'error', 'mySide', 'myTurn', 'legalXiangqiMove', 'tr', code)(view, room, 'r', selected, pending, error, mySide, myTurn, legalXiangqiMove, (s: string) => s)
  return { ...h, view, selected, pending, send }
}

/** 真正编译并SSR渲染独立根，确保两个棋种棋格数量和旁观禁用实际落在模板中。 */
async function renderBoard(game: 'gomoku' | 'xiangqi', finished = false): Promise<string> {
  const fixture = harness(game).view.value
  if (finished) { fixture.room.phase = 'finished'; fixture.room.state.winner = 0 }
  vi.stubGlobal('location', { hash: '#/board?room=r' })
  const script = compileScript(parse(source).descriptor, { id: 'board-test', inlineTemplate: true })
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
  const require = createRequire(import.meta.url)
  const localRequire = (name: string): unknown => {
    if (name === 'vue') return { ...require(name), ref: (value: unknown) => ref(value === null ? fixture : value), onMounted: () => undefined, onUnmounted: () => undefined }
    if (name.endsWith('/i18n')) return { tr: (text: string) => text, language: ref('zh-CN') }
    if (name.endsWith('/appearance')) return { applyAppearance: () => undefined }
    if (name.endsWith('/board-games')) return { legalXiangqiMove }
    return require(name)
  }
  const exports = {} as { default: Parameters<typeof createSSRApp>[0] }
  new Function('require', 'exports', code)(localRequire, exports)
  return renderToString(createSSRApp(exports.default))
}

describe('棋盘生产交互', () => {
  it('结束展示原生结果对话框，旁观者可继续或结束，不代替玩家准备', async () => {
    const html = await renderBoard('gomoku', true)
    expect(html).toContain('<dialog')
    expect(html).toContain('game-result-title')
    expect(html).toContain('继续旁观')
    expect(html).toContain('end-game')
  })
  it('结束通过现有窗口 IPC 退出，忙碌时不重复触发', async () => {
    const ast = ts.createSourceFile('board.ts', source.split('<script setup lang="ts">')[1].split('</script>')[0], ts.ScriptTarget.Latest, true)
    const actual = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'endGame')!.getText(ast)
    const pending = ref(true), error = ref(''), close = vi.fn(async () => undefined)
    vi.stubGlobal('window', { pantry: { closeWindow: close } })
    const code = ts.transpileModule(actual + '\nreturn endGame;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    const end = new Function('pending', 'error', 'tr', code)(pending, error, (s: string) => s)
    await end(); expect(close).not.toHaveBeenCalled()
    pending.value = false; await end(); expect(close).toHaveBeenCalledOnce()
  })
  it('旁观者/非当前回合不提交动作，当前玩家只发送一次走子', async () => {
    const h = harness(); h.play(0); expect(h.send).not.toHaveBeenCalled()
    h.view.value.selfId = 'peer'; h.play(0); expect(h.send).not.toHaveBeenCalled()
    h.view.value.selfId = 'host'; h.play(0); h.play(1)
    expect(h.send).toHaveBeenCalledOnce(); expect(h.send).toHaveBeenCalledWith('r', { kind: 'move', from: -1, to: 0 })
  })
  it('象棋先选己子，禁止非法走法；取消认输确认不提交', async () => {
    const h = harness('xiangqi'); h.view.value.selfId = 'host'
    h.play(54); expect(h.selected.value).toBe(54)
    h.play(55); expect(h.send).not.toHaveBeenCalled()
    h.play(45); expect(h.send).toHaveBeenCalledWith('r', { kind: 'move', from: 54, to: 45 })
    await Promise.resolve(); h.send.mockClear(); await h.spectate(); expect(h.send).not.toHaveBeenCalled()
  })
  it.each([['gomoku', 225], ['xiangqi', 90]] as const)('%s 渲染全部棋格且旁观时禁用落子', async (game, count) => {
    const html = await renderBoard(game)
    const grid = html.split('role="group"')[1].split('</div>')[0]
    expect((grid.match(/<button/g) ?? []).length).toBe(count)
    expect((grid.match(/disabled/g) ?? []).length).toBe(count)
    expect(html).toContain('正在旁观')
  })
})

/** 实际邀请卡处理响应式 props 时，必须发送 Electron 可结构化克隆的普通对象。 */
describe('邀请卡 IPC 边界', () => {
  it('点击响应式邀请可以进入，且只发送五个协议字段', async () => {
    const source = readFileSync(new URL('../components/BoardGameInvite.vue', import.meta.url), 'utf8')
    const script = source.split('<script setup lang="ts">')[1].split('</script>')[0]
    const ast = ts.createSourceFile('invite.ts', script, ts.ScriptTarget.Latest, true)
    const actual = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'open')!.getText(ast)
    const invite = { roomId: 'r', hostId: 'host', game: 'xiangqi', groupId: '', createdAt: 1 }
    const props = reactive({ invite }), pending = ref(false), failed = ref(false)
    const send = vi.fn(async value => { structuredClone(value); return true })
    vi.stubGlobal('window', { pantry: { openBoardGame: send } })
    const code = ts.transpileModule(actual + '\nreturn open;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    const open = new Function('props', 'pending', 'failed', code)(props, pending, failed)
    await open()
    expect(failed.value).toBe(false)
    expect(pending.value).toBe(false)
    expect(send).toHaveBeenCalledWith(invite)
    expect(send.mock.calls[0][0]).not.toBe(props.invite)
  })
})
