<script lang="ts">
import { computed, defineComponent, h, onMounted, type VNodeChild } from 'vue'
import { parseMessageMarkdown, type MessageInline } from '../utils/message-markdown'
import { splitEmojiText } from '../utils/compat-emoji'
import CompatEmoji from './CompatEmoji.vue'

/** 只渲染有限 AST 为 Vue 文本节点；不使用 v-html，不创建远程图片或原生链接导航。 */
export default defineComponent({
  props: { text: { type: String, required: true } },
  setup(props) {
    // 与邀请卡共用按需样式，保持沙箱与主窗 CSS 启动预算。
    onMounted(() => { void import('../styles/extension-messages.css') })
    const blocks = computed(() => parseMessageMarkdown(props.text))
    /** 普通文字保留本地兼容表情，代码字面内容不替换表情或转义字符。 */
    const renderInline = (nodes: MessageInline[], inLink = false): VNodeChild[] => nodes.flatMap((node): VNodeChild[] => {
      if (node.kind === 'text') return splitEmojiText(node.text).map(part => part.emoji ? h(CompatEmoji, { emoji: part.text }) : part.text)
      if (node.kind === 'code') return [h('code', node.text)]
      // 链接说明中的裸 URL 仅作为文字，不能嵌套按钮或一次打开两个地址。
      if (node.kind === 'link') return inLink ? renderInline(node.children, true) : [h('button', { type: 'button', class: 'markdown-link', onClick: () => { void window.pantry.openUrl(node.url) } }, renderInline(node.children, true))]
      return 'children' in node ? [h(node.kind, renderInline(node.children, inLink))] : [node.text]
    })
    return () => h('div', { class: 'rich-message' }, blocks.value.map(block => {
      if (block.kind === 'code') return h('pre', [block.language ? h('small', block.language) : null, h('code', block.text)])
      if (block.kind === 'list') return h(block.ordered ? 'ol' : 'ul', block.ordered ? { start: block.start } : {}, block.items.map(item => h('li', renderInline(item))))
      if (block.kind === 'table') return h('div', { class: 'table-scroll' }, [h('table', [h('thead', [h('tr', block.header.map(cell => h('th', renderInline(cell))))]), h('tbody', block.rows.map(row => h('tr', row.map(cell => h('td', renderInline(cell))))))])])
      return h(block.kind === 'heading' ? 'h' + Math.min(6, block.level + 2) : block.kind === 'quote' ? 'blockquote' : 'p', renderInline(block.children))
    }))
  }
})
</script>
