import { textParts } from './message-row'

/** 有限 Markdown 语法树：不接收 HTML 标签、任意属性或可执行节点。 */
export type MessageInline =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: MessageInline[] }
  | { kind: 'link'; url: string; children: MessageInline[] }
export type MessageBlock =
  | { kind: 'paragraph' | 'quote'; children: MessageInline[] }
  | { kind: 'heading'; level: number; children: MessageInline[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MessageInline[][] }
  | { kind: 'table'; header: MessageInline[][]; rows: MessageInline[][][] }
interface Budget { left: number }
const MAX_TEXT = 64 * 1024
const MAX_NODES = 2048

/** 只容许现有受控外链通道支持的 HTTP(S)；图片/脚本/data/file 均不创建资源。 */
export function safeMessageLink(value: string): string | null {
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

/** Agent 双重转义换行兼容：不改普通聊天、代码片段、路径或数据库原文。 */
export function messageMarkdownText(text: string, agent = false): string {
  if (!agent || !text.includes('\\n')) return text
  // 代码与 Windows 路径按字面显示；不通过 JSON.parse/eval 解码模型输出。
  return text.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\n]*?\2|[a-zA-Z]:\\[^\s]+|\\r\\n|\\n/g,
    part => part === '\\n' || part === '\\r\\n' ? '\n' : part)
}

/** 普通聊天保持既有快速路径，仅确有格式标记时启用富文本渲染。 */
export function hasMessageMarkdown(text: string): boolean {
  return /(?:\*\*|__|~~|`|\*[^*\n]+\*|(?:^|[^\p{L}\p{N}])_[^_\n]+_|\[[^\]\n]+\]\([^\s)]+\)|^\s{0,3}(?:~{3,}|#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)|^\|.+\||^[^\n]*\|[^\n]*\n\s*\|?\s*:?-{3,})/mu.test(text)
}

/** 文本保留既有裸链接识别；危险协议只产生普通文字。 */
function plain(text: string, budget: Budget): MessageInline[] {
  const parts = textParts(text), result: MessageInline[] = []
  for (let i = 0; i < parts.length; i++) {
    if (budget.left <= 0) { result.push({ kind: 'text', text: parts.slice(i).map(part => part.text).join('') }); break }
    budget.left--
    const part = parts[i]
    const url = part.url && safeMessageLink(part.url)
    result.push(url ? { kind: 'link', url, children: [{ kind: 'text', text: part.text }] } : { kind: 'text', text: part.text })
  }
  return result
}

/** 有深度/节点上限的行内解析，未知或未闭合标记退回文本，代码永不二次解析。 */
function inline(text: string, budget: Budget, depth = 0): MessageInline[] {
  if (depth >= 5 || budget.left <= 0) return [{ kind: 'text', text }]
  const nodes: MessageInline[] = []
  let buffer = '', i = 0
  /** 合并连续文本，避免逐字创建 Vue 节点。 */
  const flush = (): void => { if (buffer) { nodes.push(...plain(buffer, budget)); buffer = '' } }
  while (i < text.length && budget.left > 0) {
    if (text[i] === '\\' && /[\\`*_[\]~]/.test(text[i + 1] ?? '')) { buffer += text[i + 1]; i += 2; continue }
    if (text[i] === '`') {
      const ticks = /^`+/.exec(text.slice(i))![0], end = text.indexOf(ticks, i + ticks.length)
      if (end >= 0) {
        flush(); nodes.push({ kind: 'code', text: text.slice(i + ticks.length, end) }); budget.left--; i = end + ticks.length; continue
      }
      buffer += ticks; i += ticks.length; continue
    }
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1)
      if (end >= 0) { flush(); nodes.push({ kind: 'text', text: text.slice(i, end + 1) }); budget.left--; i = end + 1; continue }
    }
    const image = text.startsWith('![', i)
    if (text[i] === '[' || image) {
      const match = /^\[([^\]\n]{1,512})\]\(([^()\s]{1,2048})\)/.exec(text.slice(i + (image ? 1 : 0)))
      if (match) {
        flush(); budget.left--
        const url = !image && safeMessageLink(match[2])
        nodes.push(url ? { kind: 'link', url, children: inline(match[1], budget, depth + 1) } : { kind: 'text', text: image ? match[1] : match[0] })
        i += match[0].length + (image ? 1 : 0); continue
      }
    }
    const marker = ['**', '__', '~~', '*', '_'].find(mark => text.startsWith(mark, i) &&
      (mark !== '_' || !/[\p{L}\p{N}]/u.test(text[i - 1] ?? '')))
    if (marker) {
      const end = text.indexOf(marker, i + marker.length)
      if (end > i + marker.length && text.slice(i + marker.length, end).trim()) {
        flush(); budget.left--
        nodes.push({ kind: marker === '~~' ? 'del' : marker.length === 2 ? 'strong' : 'em', children: inline(text.slice(i + marker.length, end), budget, depth + 1) })
        i = end + marker.length; continue
      }
    }
    buffer += text[i++]
  }
  buffer += text.slice(i); flush()
  return nodes
}

/** 表格仅按文本列拆分；列数有限，代码内的竖线可以使用转义写法。 */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).slice(0, 20).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

/** 将常用消息 Markdown 转成安全 AST；规模受协议文本上限和解析预算约束。 */
export function parseMessageMarkdown(text: string): MessageBlock[] {
  if (text.length > MAX_TEXT) return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }]
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), blocks: MessageBlock[] = [], budget = { left: MAX_NODES }
  let i = 0
  /** 后续块起点使普通段落在标题、列表、引用和代码前自然结束。 */
  const startsBlock = (line: string): boolean => /^\s{0,3}(?:`{3,}|~{3,}|#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)/.test(line)
  while (i < lines.length && budget.left > 0) {
    if (!lines[i].trim()) { i++; continue }
    budget.left--
    const fence = /^\s{0,3}(`{3,}|~{3,})([^\s]*)\s*$/.exec(lines[i])
    if (fence) {
      const body: string[] = []; i++
      const closing = new RegExp('^\\s{0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$')
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) i++
      blocks.push({ kind: 'code', language: /^[\w+-]{0,24}$/.test(fence[2]) ? fence[2] : '', text: body.join('\n') }); continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i])
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length, children: inline(heading[2], budget) }); i++; continue }
    const list = /^\s{0,3}(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[i])
    if (list) {
      const ordered = Boolean(list[2]), items: MessageInline[][] = [], start = Number(list[2]) || 1
      while (i < lines.length && budget.left > 0) {
        const item = /^\s{0,3}(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[i])
        if (!item || Boolean(item[2]) !== ordered) break
        budget.left--; items.push(inline(item[3], budget)); i++
      }
      blocks.push({ kind: 'list', ordered, start: Math.min(start, 999999), items }); continue
    }
    if (/^\s{0,3}>/.test(lines[i])) {
      const quoted: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}> ?/, ''))
      blocks.push({ kind: 'quote', children: inline(quoted.join('\n'), budget) }); continue
    }
    if (i + 1 < lines.length && lines[i].includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const header = cells(lines[i]).map(cell => inline(cell, budget)), rows: MessageInline[][][] = []; i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && budget.left > 0) {
        budget.left--; rows.push(cells(lines[i++]).slice(0, header.length).map(cell => inline(cell, budget)))
      }
      blocks.push({ kind: 'table', header, rows }); continue
    }
    const paragraph = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(i + 1 < lines.length && lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]))) paragraph.push(lines[i++])
    blocks.push({ kind: 'paragraph', children: inline(paragraph.join('\n'), budget) })
  }
  if (i < lines.length) blocks.push({ kind: 'paragraph', children: [{ kind: 'text', text: lines.slice(i).join('\n') }] })
  return blocks
}
