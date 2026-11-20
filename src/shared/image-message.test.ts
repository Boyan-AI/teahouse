import { describe, expect, it } from 'vitest'
import { parseImageMessageMeta } from './image-message'
import { GROUP_MAX_MEMBERS, TEXT_TCP_LIMIT } from './protocol'

/** 共享图文元数据必须在 IPC 与网络边界具有相同的有限语义。 */
describe('图文消息元数据', () => {
  it('兼容旧端空元数据，去重提及但不修改调用者数组', () => {
    expect(parseImageMessageMeta(undefined)).toEqual({})
    const mentions = ['agent', 'agent', '@all']
    expect(parseImageMessageMeta({caption:'说明\n**重点**', mentions, replyTo:'source'})).toEqual({caption:'说明\n**重点**', mentions:['agent','@all'],replyTo:'source'})
    expect(mentions).toHaveLength(3)
  })
  it('按 UTF8 字节而不是字符数量限制说明', () => {
    expect(parseImageMessageMeta({caption:'a'.repeat(TEXT_TCP_LIMIT)})).not.toBeNull()
    expect(parseImageMessageMeta({caption:'a'.repeat(TEXT_TCP_LIMIT+1)})).toBeNull()
    expect(parseImageMessageMeta({caption:'中'.repeat(Math.floor(TEXT_TCP_LIMIT/3)+1)})).toBeNull()
  })
  it.each([null, [], 'caption', {text:'伪造正文'}, {replyTo:{id:'x',text:'伪造引用'}}, {replyTo:''}, {replyTo:'x'.repeat(65)}, {caption:1}, {mentions:['']}, {mentions:[123]}, {mentions:Array(GROUP_MAX_MEMBERS+1).fill('x')}])('拒绝未授权结构与越界字段 %j', value => {
    expect(parseImageMessageMeta(value)).toBeNull()
  })
})
