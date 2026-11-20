import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { usePendingAttachments } from '../utils/pending-attachments'

// 执行真实组件发送函数与附件状态机，覆盖首次图文成功和异步失败后的草稿归属。
const source=readFileSync(new URL('../components/ChatPane.vue',import.meta.url),'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
const ast=ts.createSourceFile('ChatPane.ts',source,ts.ScriptTarget.Latest,true)
const actual=ast.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='send')!.getText(ast)

/** 仅替换边界 I/O；正文摘取、首图选择和恢复逻辑来自生产函数。 */
function harness() {
  const submit=vi.fn().mockResolvedValue(true), sendText=vi.fn().mockResolvedValue(true)
  const compiled=ts.transpileModule(`
    const {ref,computed,usePendingAttachments,submit,sendText}=deps;
    const draft=ref(''),mentionIds=ref([]),replyToId=ref(null),isGroup=ref(true);
    const MENTION_ALL='@all',hasMentionAllToken=text=>text.includes('@所有人');
    const peersStore={nameOf:()=> 'Agent'},closeMentionPicker=()=>{};
    const attachments=usePendingAttachments({createObjectURL:()=> 'blob:local',revokeObjectURL:()=>{}});
    const sendDisabled=computed(()=>attachments.busy.value||(!draft.value.trim()&&!attachments.items.value.length));
    const chatStore={activeConvId:'group:g',send:sendText},submitAttachment=submit;
    ${actual}
    return {draft,mentionIds,replyToId,isGroup,attachments,chatStore,send};
  `,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText
  return {...new Function('deps',compiled)({ref,computed,usePendingAttachments,submit,sendText}),submit,sendText}
}

describe('图文组合发送的真实事件函数',()=>{
  it('说明、引用和提及只绑定首张图片，不先发额外文字',async()=>{
    const h=harness();h.draft.value='@Agent 图片说明';h.mentionIds.value=['agent'];h.replyToId.value='source'
    h.attachments.add(new Blob(['first']),'a.png');h.attachments.add(new Blob(['second']),'b.png')
    await h.send()
    expect(h.sendText).not.toHaveBeenCalled();expect(h.submit).toHaveBeenCalledTimes(2)
    expect(h.submit.mock.calls[0][2]).toEqual({caption:'@Agent 图片说明',mentions:['agent'],replyTo:'source'})
    expect(h.submit.mock.calls[1][2]).toBeUndefined();expect(h.draft.value).toBe('');expect(h.attachments.items.value).toHaveLength(0)
  })
  it('首图失败保留附件、正文和引用，可重试而不重复发送文本',async()=>{
    const h=harness();h.draft.value='未发说明';h.replyToId.value='source';h.attachments.add(new Blob(['a']),'a.png')
    h.submit.mockResolvedValueOnce(false)
    await h.send();expect(h.draft.value).toBe('未发说明');expect(h.replyToId.value).toBe('source');expect(h.attachments.failed.value).toBe(true)
    await h.send();expect(h.sendText).not.toHaveBeenCalled();expect(h.attachments.items.value).toHaveLength(0)
  })
  it('首图已成功但后续图片失败时，不恢复已发送的说明',async()=>{
    const h=harness();h.draft.value='已经发送';h.attachments.add(new Blob(['a']),'a.png');h.attachments.add(new Blob(['b']),'b.png')
    h.submit.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await h.send();expect(h.draft.value).toBe('');expect(h.attachments.items.value.map((item:{name:string})=>item.name)).toEqual(['b.png'])
  })
  it('发送期间新输入不会被失败恢复覆盖',async()=>{
    const h=harness();h.draft.value='旧说明';h.attachments.add(new Blob(['a']),'a.png')
    let finish!:(ok:boolean)=>void;h.submit.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const sending=h.send();await vi.waitUntil(()=>typeof finish==='function')
    h.draft.value='新输入';finish(false);await sending
    expect(h.draft.value).toBe('旧说明\n新输入')
  })
  it('切换会话后不能把旧说明恢复到新会话',async()=>{
    const h=harness();h.draft.value='旧说明';h.attachments.add(new Blob(['a']),'a.png')
    let finish!:(ok:boolean)=>void;h.submit.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const sending=h.send();await vi.waitUntil(()=>typeof finish==='function')
    h.chatStore.activeConvId='single:other';h.attachments.clear();h.draft.value='新会话输入';finish(false);await sending
    expect(h.draft.value).toBe('新会话输入')
  })
  it('私聊纯文字也传递引用 ID，不携带群提及',async()=>{
    const h=harness();h.isGroup.value=false;h.draft.value='引用问题';h.replyToId.value='source'
    await h.send();expect(h.sendText).toHaveBeenCalledWith('引用问题',[],'source')
  })
})
