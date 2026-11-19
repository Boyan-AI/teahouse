import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { createRequire } from 'node:module'
import { computed, createSSRApp, defineComponent, h, nextTick, reactive, ref, watch } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPlainEscape } from '../utils/escape'

const menuSource = readFileSync(new URL('../components/MemberAvatar.vue', import.meta.url), 'utf8')
const chatSource = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
const rowSource = readFileSync(new URL('../components/MessageRow.vue', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('../components/GroupPanel.vue', import.meta.url), 'utf8')

/** 从生产组件提取真实函数，避免把测试写成另一套菜单实现。 */
function functionsOf(source: string, names: string[]): string {
  const script = source.split('<script setup lang="ts">')[1].split('</script>')[0]
  const ast = ts.createSourceFile('component.ts', script, ts.ScriptTarget.Latest, true)
  return ast.statements.filter((statement) => ts.isFunctionDeclaration(statement) &&
    names.includes(statement.name?.text ?? '')).map((statement) => statement.getText(ast)).join('\n')
}

/** 菜单最小 DOM 桩记录焦点与监听，真实业务函数及 Vue 响应式仍直接执行。 */
function menuHarness() {
  const doc = { activeElement: null as unknown, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const win = { innerWidth: 320, innerHeight: 200, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  class TestNode {}
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  vi.stubGlobal('Node', TestNode)
  const anchor = Object.assign(new TestNode(), {
    getBoundingClientRect: () => ({ left: 310, bottom: 190 }),
    focus: vi.fn(), contains: (node: unknown) => node === anchor
  })
  const buttons = [0, 1].map(() => ({ focus: vi.fn(function (this: unknown) { doc.activeElement = this }) }))
  const menu = Object.assign(new TestNode(), {
    querySelector: () => buttons[0], querySelectorAll: () => buttons,
    contains: (node: unknown) => node === menu
  })
  const actual = functionsOf(menuSource, ['close', 'toggle', 'onOutsidePointer', 'onDocumentKeydown',
    'onViewportChange', 'onMenuKeydown', 'select'])
  const compiled = ts.transpileModule(`
    const { ref, computed, reactive, watch, nextTick, isPlainEscape, anchorElement, menuElement, emit } = deps;
    const props = reactive({ canMention: true, canOpenChat: true });
    const interactive = computed(() => props.canMention || props.canOpenChat);
    const anchor = ref(anchorElement), menu = ref(menuElement), opened = ref(false), position = ref({ x: 8, y: 8 });
    ${actual}
    const stop = watch([() => props.canMention, () => props.canOpenChat], () => close());
    return { toggle, close, select, onOutsidePointer, onDocumentKeydown, onMenuKeydown,
      onViewportChange, opened, position, props, dispose() { stop(); close(); } };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  const emit = vi.fn()
  const h = new Function('deps', compiled)({ ref, computed, reactive, watch, nextTick,
    isPlainEscape, anchorElement: anchor, menuElement: menu, emit })
  return { ...h, doc, win, anchor, menu, buttons, emit, TestNode }
}

/** 构造完整键盘状态，让修饰键、输入法和已消费事件沿用真实 Esc 门禁。 */
function key(key: string, extra = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, defaultPrevented: false, isComposing: false, keyCode: 0,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra }
}

afterEach(() => vi.unstubAllGlobals())

/** 编译并渲染生产 SFC，确认多根节点属性透传和原生按钮语义没有被函数桩掩盖。 */
async function renderAvatar(canInteract: boolean): Promise<string> {
  const { descriptor } = parse(menuSource)
  const script = compileScript(descriptor, { id: 'avatar-test', inlineTemplate: true })
  const compiled = ts.transpileModule(script.content, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS
  } }).outputText
  const actualRequire = createRequire(import.meta.url)
  const avatarStub = defineComponent({ props: ['name'], setup: (props) => () => h('span', props.name) })
  const localRequire = (name: string): unknown => {
    if (name.endsWith('AvatarMark.vue')) return { default: avatarStub }
    if (name.endsWith('/i18n')) return { tr: (text: string) => text }
    if (name.endsWith('/escape')) return { isPlainEscape }
    return actualRequire(name)
  }
  const exports = {} as { default: Parameters<typeof createSSRApp>[0] }
  new Function('require', 'exports', compiled)(localRequire, exports)
  return renderToString(createSSRApp(exports.default, { avatar: 1, avatarHash: '', name: 'Alice',
    canMention: canInteract, canOpenChat: canInteract, class: 'msg-avatar' }))
}

describe('共享头像菜单真实交互', () => {
  it('生产 SFC 渲染保留头像尺寸 class，可交互成员使用原生按钮，本人使用静态容器', async () => {
    const member = await renderAvatar(true)
    expect(member).toMatch(/<button[^>]*class="[^"]*msg-avatar/)
    expect(member).toContain('aria-haspopup="menu"')
    const self = await renderAvatar(false)
    expect(self).toMatch(/<span[^>]*class="[^"]*msg-avatar/)
    expect(self).not.toContain('<button')
  })

  it('点击才监听全局事件，定位不越界，首项获得焦点', async () => {
    const h = menuHarness()
    expect(h.doc.addEventListener).not.toHaveBeenCalled()
    h.toggle()
    await nextTick()
    expect(h.opened.value).toBe(true)
    expect(h.position.value).toEqual({ x: 152, y: 112 })
    expect(h.buttons[0].focus).toHaveBeenCalledOnce()
    expect(h.doc.addEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function), true)
    h.dispose()
    expect(h.doc.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    expect(h.win.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('提及与私聊各自只触发一个事件，权限变化关闭旧菜单并拒绝迟到操作', async () => {
    const h = menuHarness()
    h.toggle(); h.select('mention')
    expect(h.opened.value).toBe(false)
    expect(h.emit.mock.calls).toEqual([['mention']])
    h.toggle(); h.select('open-chat')
    expect(h.emit.mock.calls).toEqual([['mention'], ['open-chat']])
    h.toggle()
    h.props.canMention = false
    await nextTick()
    expect(h.opened.value).toBe(false)
    h.select('mention')
    expect(h.emit).toHaveBeenCalledTimes(2)
    h.props.canOpenChat = false
    h.toggle()
    expect(h.opened.value).toBe(false)
    h.dispose()
  })

  it('菜单内点击不关闭，外部点击、滚动和缩放关闭且不抢焦点', async () => {
    const h = menuHarness()
    h.toggle(); await nextTick()
    h.onOutsidePointer({ target: h.menu })
    expect(h.opened.value).toBe(true)
    h.onOutsidePointer({ target: new h.TestNode() })
    expect(h.opened.value).toBe(false)
    expect(h.anchor.focus).not.toHaveBeenCalled()
    h.toggle(); h.onViewportChange()
    expect(h.opened.value).toBe(false)
    h.dispose()
  })

  it('方向键导航、Esc 回焦以及组合输入保护不相互干扰', async () => {
    const h = menuHarness()
    h.toggle(); await nextTick()
    h.onMenuKeydown(key('ArrowDown'))
    expect(h.buttons[1].focus).toHaveBeenCalledOnce()
    h.onMenuKeydown(key('Home'))
    expect(h.buttons[0].focus).toHaveBeenCalledTimes(2)
    h.onDocumentKeydown(key('Escape', { isComposing: true }))
    expect(h.opened.value).toBe(true)
    const escape = key('Escape')
    h.onDocumentKeydown(escape)
    expect(escape.stopPropagation).toHaveBeenCalledOnce()
    expect(h.opened.value).toBe(false)
    expect(h.anchor.focus).toHaveBeenCalledOnce()
    h.dispose()
  })

  it('多根节点显式透传尺寸，两个群聊入口均有提及和私聊接线', () => {
    expect(menuSource).toContain('defineOptions({ inheritAttrs: false })')
    expect(menuSource).toContain('v-bind="$attrs"')
    expect(menuSource).toContain('role="menuitem"')
    for (const source of [rowSource, panelSource]) {
      expect(source).toContain('<MemberAvatar')
      expect(source).toContain(':can-mention=')
      expect(source).toContain(':can-open-chat=')
      expect(source).toContain('@mention=')
      expect(source).toContain('@open-chat=')
    }
    expect(chatSource).toContain('@mention-member="mentionMember"')
    expect(chatSource).toContain('@open-member-chat="openMemberChat"')
  })
})

describe('本人资料与成员导航', () => {
  it('本人不查通讯录，使用实时昵称、内置头像与自定义图片哈希', () => {
    const actual = functionsOf(chatSource, ['senderName', 'senderAvatar', 'senderAvatarHash'])
    const compiled = ts.transpileModule(actual + '\nreturn { senderName, senderAvatar, senderAvatarHash };',
      { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    const self = { selfNick: '本机用户', selfAvatar: 7, selfAvatarHash: 'custom-hash' }
    const peers = { nameOf: vi.fn(() => 'Alice'), byId: vi.fn(() => ({ avatar: 3, avatarHash: '' })) }
    const h = new Function('chatStore', 'peersStore', 'tr', compiled)(self, peers, (text: string) => text)
    const mine = { isMine: true, senderId: 'self' }, peer = { isMine: false, senderId: 'alice' }
    expect(h.senderName(mine)).toBe('本机用户')
    expect(h.senderAvatar(mine)).toBe(7)
    expect(h.senderAvatarHash(mine)).toBe('custom-hash')
    expect(peers.byId).not.toHaveBeenCalled()
    self.selfNick = '新昵称'; self.selfAvatar = -2; self.selfAvatarHash = ''
    expect(h.senderName(mine)).toBe('新昵称')
    expect(h.senderAvatar(mine)).toBe(-2)
    expect(h.senderAvatarHash(mine)).toBe('')
    expect(h.senderName(peer)).toBe('Alice')
    expect(h.senderAvatar(peer)).toBe(3)
    expect(rowSource).toContain('showSender.value && (props.isGroupConv || props.msg.isMine)')
  })

  it('私聊复用已有导航，拒绝本人、未知联系人及非群聊来源', async () => {
    const actual = functionsOf(chatSource, ['canOpenMemberChat', 'openMemberChat'])
    const compiled = ts.transpileModule(actual + '\nreturn { openMemberChat };',
      { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    const chat = { selfId: 'self', openPeer: vi.fn() }, isGroup = ref(true)
    const peers = { byId: (id: string) => id === 'alice' ? { nodeId: id } : null }
    const h = new Function('chatStore', 'peersStore', 'isGroup', compiled)(chat, peers, isGroup)
    await h.openMemberChat('self'); await h.openMemberChat('ghost')
    expect(chat.openPeer).not.toHaveBeenCalled()
    await h.openMemberChat('alice')
    expect(chat.openPeer).toHaveBeenCalledWith('alice')
    expect(chat.openPeer).toHaveBeenCalledOnce()
    isGroup.value = false
    await h.openMemberChat('alice')
    expect(chat.openPeer).toHaveBeenCalledOnce()
  })
})
