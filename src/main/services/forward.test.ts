import { describe, expect, it, vi } from 'vitest'
import type { FileRefView, ForwardTarget, MessageView, TableTextMeta } from '../../shared/ipc'
import type { MsgRepo, MsgRow } from '../store/msg-repo'
import type { FilesService } from './files'
import type { ChatService } from './chat'
import type { GroupsService } from './groups'
import { ForwardService } from './forward'

function row(overrides: Partial<MsgRow>): MsgRow {
  return {
    id: 'msg-1',
    conv_id: 'single:node-a',
    sender_id: 'node-a',
    is_mine: 0,
    kind: 'image',
    content: '[图片]',
    file_ref: null,
    ts: 1,
    seq: 1,
    status: 'sent',
    ...overrides
  }
}

function fileRef(overrides: Partial<FileRefView> = {}): string {
  return JSON.stringify({
    transferId: 'transfer-1',
    name: '表格.png',
    size: 10,
    count: 1,
    dir: false,
    ...overrides
  } satisfies FileRefView)
}

describe('ForwardService', () => {
  it('转发表格图片时保留图片文字视图元数据', async () => {
    const calls: Array<{
      groupId: string
      paths: string[]
      want: string
      tableText?: TableTextMeta
    }> = []
    const files = {
      transferView: (transferId: string) =>
        transferId === 'transfer-1' ? { transferId, savedPath: '/tmp/table.png' } : null,
      offerGroupPaths: async (
        groupId: string,
        paths: string[],
        want: string,
        tableText?: TableTextMeta
      ): Promise<MessageView | null> => {
        calls.push({ groupId, paths, want, tableText })
        return {
          id: 'forwarded',
          convId: `group:${groupId}`,
          senderId: 'self',
          isMine: true,
          kind: 'image',
          text: '[图片]',
          ts: 2,
          seq: 2,
          status: 'sending'
        }
      }
    } as unknown as FilesService
    const msgRepo = {
      get: () =>
        row({
          file_ref: fileRef({
            tableText: '姓名\t分数\n张三\t100',
            tableTextTruncated: true
          })
        })
    } as unknown as MsgRepo
    const forward = new ForwardService({
      msgRepo,
      files,
      chat: {} as ChatService,
      groups: {} as GroupsService
    })

    const result = await forward.forward('msg-1', [{ type: 'group', id: 'group-1' }] satisfies ForwardTarget[])

    expect(result.ok).toBe(1)
    expect(calls).toEqual([
      {
        groupId: 'group-1',
        paths: ['/tmp/table.png'],
        want: 'image',
        tableText: {
          tableText: '姓名\t分数\n张三\t100',
          tableTextTruncated: true
        }
      }
    ])
  })

  it('转发时把未通过像素门禁的图片降级为普通文件', async () => {
    const calls: Array<{ want: string; tableText?: TableTextMeta }> = []
    const files = {
      transferView: () => ({ transferId: 'transfer-1', savedPath: '/tmp/oversized.png' }),
      offerGroupPaths: async (
        _groupId: string,
        _paths: string[],
        want: string,
        tableText?: TableTextMeta
      ): Promise<MessageView | null> => {
        calls.push({ want, tableText })
        return {} as MessageView
      }
    } as unknown as FilesService
    const msgRepo = {
      get: () => row({ file_ref: fileRef({ tableText: '姓名\t分数' }) })
    } as unknown as MsgRepo
    const forward = new ForwardService({
      msgRepo,
      files,
      chat: {} as ChatService,
      groups: {} as GroupsService,
      canInlineImage: async () => false
    })

    const result = await forward.forward('msg-1', [{ type: 'group', id: 'group-1' }])

    expect(result.ok).toBe(1)
    expect(calls).toEqual([{ want: 'file', tableText: undefined }])
  })
  it('转发图文保留说明，但不跨会话传递引用或提及意图', async () => {
    const offerPaths=vi.fn().mockResolvedValue({id:'forwarded'})
    const forward=new ForwardService({msgRepo:{get:()=>row({reply_to:'private-source',file_ref:fileRef({caption:'保留说明',mentions:['agent'],replyTo:'private-source'})})} as unknown as MsgRepo,files:{transferView:()=>({savedPath:'/tmp/a.png'}),offerPaths} as unknown as FilesService,chat:{} as ChatService,groups:{} as GroupsService})
    expect(await forward.forward('msg-1',[{type:'single',id:'new-peer'}])).toMatchObject({ok:1})
    expect(offerPaths).toHaveBeenCalledWith('new-peer',['/tmp/a.png'],'image',undefined,{caption:'保留说明'})
  })

})
