import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h } from 'vue'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseMessageMarkdown } from '../utils/message-markdown'
import { splitEmojiText } from '../utils/compat-emoji'

/** 编译真正的生产渲染器，检查输出标签而不是仅检查 AST。 */
async function renderMessage(text: string): Promise<string> {
  const source = readFileSync(new URL('../components/RichMessage.vue', import.meta.url), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'rich-message-test' })
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
  const realRequire = createRequire(import.meta.url)
  const emoji = defineComponent({ props: ['emoji'], setup: props => () => h('span', { class: 'compat-emoji' }, props.emoji) })
  const localRequire = (name: string): unknown => {
    if (name.endsWith('/message-markdown')) return { parseMessageMarkdown }
    if (name.endsWith('/compat-emoji')) return { splitEmojiText }
    if (name.endsWith('/CompatEmoji.vue')) return { default: emoji }
    return realRequire(name)
  }
  const exports = {} as { default: Parameters<typeof createSSRApp>[0] }
  new Function('require', 'exports', code)(localRequire, exports)
  return renderToString(createSSRApp(exports.default, { text }))
}

describe('富文本生产渲染安全边界', () => {
  it('真正生成加粗、列表、代码与受控链接，不显示格式标记', async () => {
    const html = await renderMessage('**重点**\n- 第一项\n- 第二项\n\n```js\nconst a = "\\n";\n```\n[文档](https://example.invalid)')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>第一项</li>')
    expect(html).toContain('const a = &quot;\\n&quot;;')
    expect(html).toContain('class="markdown-link"')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('**重点**')
  })
  it('链接说明中的 URL 不嵌套可点击按钮', async () => {
    const html = await renderMessage('[https://example.invalid/label](http://127.0.0.1/doc)')
    expect((html.match(/<button/g) ?? []).length).toBe(1)
    expect(html).toContain('https://example.invalid/label')
  })
  it('模型 HTML 与图片永不成为 DOM 资源或脚本，兼容表情仍可见', async () => {
    const html = await renderMessage('**你好** 😀\n<img src="https://example.invalid/tracker" onerror="alert(1)">\n<script>alert(1)</script>\n![远程图片](https://example.invalid/pixel)\n[x](javascript:alert)')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('compat-emoji')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('class="markdown-link"')
  })
})
