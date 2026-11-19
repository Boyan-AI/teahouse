<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { tr } from '../utils/i18n'
import { isPlainEscape } from '../utils/escape'
import AvatarMark from './AvatarMark.vue'

// 保持单个可见根（Teleport 放根内），让调用方 scoped 尺寸样式正确作用到头像。
defineOptions({ inheritAttrs: false })

/** 群消息和成员列表共用头像菜单；仅菜单打开期间监听全局事件。 */
const props = defineProps<{
  avatar: number
  avatarHash: string
  name: string
  presence?: 'online' | 'offline'
  canMention: boolean
  canOpenChat: boolean
}>()
const emit = defineEmits<{ mention: []; 'open-chat': [] }>()
const interactive = computed(() => props.canMention || props.canOpenChat)
const anchor = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const opened = ref(false)
const position = ref({ x: 8, y: 8 })

/** 关闭时清理监听；仅 Esc 主动回焦，点击外部不夺取用户新焦点。 */
function close(restoreFocus = false): void {
  opened.value = false
  document.removeEventListener('mousedown', onOutsidePointer, true)
  document.removeEventListener('keydown', onDocumentKeydown, true)
  window.removeEventListener('resize', onViewportChange)
  document.removeEventListener('scroll', onViewportChange, true)
  if (restoreFocus) anchor.value?.focus()
}

/** 相对于头像定位，并将两项菜单约束在窗口可视区内。 */
function toggle(): void {
  if (opened.value) return close()
  if (!interactive.value || !anchor.value) return
  const rect = anchor.value.getBoundingClientRect()
  const height = 12 + 34 * (Number(props.canMention) + Number(props.canOpenChat))
  position.value = {
    x: Math.max(8, Math.min(rect.left, window.innerWidth - 168)),
    y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))
  }
  opened.value = true
  document.addEventListener('mousedown', onOutsidePointer, true)
  document.addEventListener('keydown', onDocumentKeydown, true)
  window.addEventListener('resize', onViewportChange)
  document.addEventListener('scroll', onViewportChange, true)
  void nextTick(() => { if (opened.value) menu.value?.querySelector('button')?.focus() })
}

/** 外部点击只关闭菜单；头像按钮本身交由 toggle 处理。 */
function onOutsidePointer(event: MouseEvent): void {
  const target = event.target
  if (target instanceof Node && !anchor.value?.contains(target) && !menu.value?.contains(target)) close()
}

/** Esc 在捕获阶段消费，避免同时关闭聊天区其他浮层。 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (!isPlainEscape(event)) return
  event.preventDefault()
  event.stopPropagation()
  close(true)
}

/** 滚动或缩放后关闭旧位置的菜单，避免操作目标与头像错位。 */
function onViewportChange(): void {
  close()
}

/** 菜单方向键循环移动，Tab 保持原生导航并收起菜单。 */
function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Tab') return close()
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const index = buttons.findIndex((button) => button === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}

/** 点击时再次检查权限，避免群成员状态变化后沿用旧菜单操作。 */
function select(action: 'mention' | 'open-chat'): void {
  const allowed = action === 'mention' ? props.canMention : props.canOpenChat
  close()
  if (!allowed) return
  if (action === 'mention') emit('mention')
  else emit('open-chat')
}

watch([() => props.canMention, () => props.canOpenChat], () => close())
onBeforeUnmount(() => close())
</script>

<template>
  <component
    :is="interactive ? 'button' : 'span'"
    ref="anchor"
    v-bind="$attrs"
    class="avatar"
    :class="{ interactive }"
    :type="interactive ? 'button' : undefined"
    :aria-label="interactive ? tr('打开 {0} 的成员操作', { 0: name }) : undefined"
    :aria-haspopup="interactive ? 'menu' : undefined"
    :aria-expanded="interactive ? opened : undefined"
    @click.stop="toggle"
  >
    <AvatarMark class="face" :avatar="avatar" :avatar-hash="avatarHash" :name="name" :presence="presence" />
  <Teleport to="body">
    <div
      v-if="opened"
      ref="menu"
      class="menu"
      role="menu"
      :aria-label="tr('成员操作')"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @keydown.stop="onMenuKeydown"
      @mousedown.stop
    >
      <button v-if="canMention" type="button" role="menuitem" @click="select('mention')">{{ tr('@该成员') }}</button>
      <button v-if="canOpenChat" type="button" role="menuitem" @click="select('open-chat')">{{ tr('发起私聊') }}</button>
    </div>
  </Teleport>
  </component>
</template>

<style scoped>
.avatar {
  display: inline-grid;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
}
.avatar.interactive { cursor: pointer; }
.face { width: 100%; height: 100%; }
.menu {
  display: grid;
  position: fixed;
  z-index: 300;
  width: 160px;
  max-width: calc(100vw - 16px);
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--bg-window);
  box-shadow: var(--shadow-float);
}
.menu button {
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
}
.menu button:is(:hover, :focus-visible) { background: var(--surface-hover); outline: none; }
</style>
