import { describe, expect, it } from 'vitest'
import { hasMessageMarkdown, messageMarkdownText, parseMessageMarkdown, safeMessageLink } from './message-markdown'

describe('安全消息 Markdown', () => {
  it('加粗、斜体、删除线和行内代码保留有限语义', () => {
    const blocks = parseMessageMarkdown('**重点**、*强调*、~~旧版~~、`a\\n**b**`')
    expect(blocks[0]).toMatchObject({ kind: 'paragraph', children: [
      { kind: 'strong', children: [{ kind: 'text', text: '重点' }] }, { kind: 'text', text: '、' },
      { kind: 'em', children: [{ kind: 'text', text: '强调' }] }, { kind: 'text', text: '、' },
      { kind: 'del', children: [{ kind: 'text', text: '旧版' }] }, { kind: 'text', text: '、' },
      { kind: 'code', text: 'a\\n**b**' }
    ] })
    expect(parseMessageMarkdown('my_variable_name **未闭合')).toMatchObject([{ kind: 'paragraph', children: [{ kind: 'text', text: 'my_variable_name **未闭合' }] }])
  })
  it('标题、两类列表、引用、代码块和表格均可读', () => {
    const blocks = parseMessageMarkdown('# 标题\n- 第一项\n- **第二项**\n\n3. 第三项\n4. 第四项\n\n> 说明\n> 下一行\n\n```js\nconst a = "\\n";\n```\n\n| 名称 | 状态 |\n| --- | :---: |\n| AI | 正常 |')
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'list', 'list', 'quote', 'code', 'table'])
    expect(blocks[2]).toMatchObject({ ordered: true, start: 3 })
    expect(blocks[4]).toEqual({ kind: 'code', language: 'js', text: 'const a = "\\n";' })
    expect(blocks[5]).toMatchObject({ header: [[{kind:'text',text:'名称'}],[{kind:'text',text:'状态'}]], rows: [[[{kind:'text',text:'AI'}],[{kind:'text',text:'正常'}]]] })
  })
  it('只转换 Agent 的转义换行，普通文本、代码和 Windows 路径不变', () => {
    const text = '**结论**\\n- 第一项\\n- 第二项'
    expect(messageMarkdownText(text, true)).toBe('**结论**\n- 第一项\n- 第二项')
    expect(messageMarkdownText(text, false)).toBe(text)
    expect(messageMarkdownText('代码 `x\\ny`\\n说明', true)).toBe('代码 `x\\ny`\n说明')
    expect(messageMarkdownText('代码 ``x\\ny``\\n说明', true)).toBe('代码 ``x\\ny``\n说明')
    expect(messageMarkdownText('~~~js\nx\\ny\n~~~\\n说明', true)).toBe('~~~js\nx\\ny\n~~~\n说明')
    expect(messageMarkdownText('路径 C:\\new\\notes\n下一段\\n末尾', true)).toBe('路径 C:\\new\\notes\n下一段\n末尾')
  })
  it('HTML 只保留为文字，图片不生成资源，危险链接不转成可点击节点', () => {
    const blocks = parseMessageMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[危险](javascript:alert) ![图片](https://example.invalid/pixel)')
    expect(JSON.stringify(blocks)).toContain('<script>')
    expect(JSON.stringify(blocks)).not.toContain('"kind":"link"')
    expect(JSON.stringify(blocks)).toContain('图片')
    for (const url of ['javascript:alert(1)','data:text/html,abc','file:///etc/passwd','https://user:secret@example.invalid/']) expect(safeMessageLink(url)).toBeNull()
    expect(safeMessageLink('http://192.168.1.2:8000/doc')).toBe('http://192.168.1.2:8000/doc')
    expect(parseMessageMarkdown('[文档](https://example.invalid/doc)')).toMatchObject([{ children: [{ kind: 'link', url: 'https://example.invalid/doc' }] }])
  })
  it('普通消息保持快速路径；规模过大的文本不继续解析或丢失原文', () => {
    expect(hasMessageMarkdown('你好\n第二行 https://example.invalid')).toBe(false)
    expect(hasMessageMarkdown('my_variable_name')).toBe(false)
    for (const text of ['*斜体*', '_斜体_', '~~~js\n代码\n~~~', 'a | b\n--- | ---\n1 | 2', '**重点**','- 清单','`代码`','[文档](http://127.0.0.1)','| a | b |']) expect(hasMessageMarkdown(text)).toBe(true)
    const large = '**' + 'x'.repeat(65536)
    expect(parseMessageMarkdown(large)).toEqual([{kind:'paragraph',children:[{kind:'text',text:large}]}])
    expect(parseMessageMarkdown('`'.repeat(20000))[0].kind).toBe('code')
  })
})
