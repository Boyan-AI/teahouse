import { afterEach, describe, expect, it } from 'vitest'
import { BoardGamesService, BOARD_CAP } from './board-games'
import type { BoardInvite, BoardPacket } from '../../shared/board-games'

const active: BoardGamesService[] = []
afterEach(() => { for (const service of active.splice(0)) service.stop() })

/** 内存网络逐包序列化，模拟实际进程边界，不共享可变棋盘对象。 */
function network(group = true, game: 'gomoku' | 'xiangqi' = 'gomoku') {
  const services = new Map<string, BoardGamesService>()
  const invites = new Map<string, BoardInvite[]>()
  let members = ['a', 'b', 'c'], now = 100_000
  for (const selfId of ['a', 'b', 'c', 'outsider']) {
    const service = new BoardGamesService({ selfId,
      peer: id => services.has(id) ? { name: id, online: true, caps: [BOARD_CAP] } : null,
      members: () => [...members], now: () => now,
      send: async (id, packet) => { services.get(id)?.receive(selfId, JSON.parse(JSON.stringify(packet))); return services.has(id) },
      inviteMessage: invite => { invites.set(selfId, [...invites.get(selfId) ?? [], invite]) }
    })
    services.set(selfId, service); active.push(service)
  }
  const host = services.get('a')!, b = services.get('b')!, c = services.get('c')!
  const invite = host.create(group ? 'group:g' : 'single:b', game)!
  return { host, b, c, services, invite, invites, remove: (id: string) => { members = members.filter(x => x !== id) }, advance: () => { now += 7_200_001 } }
}

describe('棋类单主机房间', () => {
  it.each([true, false])('同会话双方从 PK 入口进入同一房间（群聊=%s）', async group => {
    const n = network(group), id = n.invite.roomId
    const joined = await n.b.enter(group ? 'group:g' : 'single:a', 'gomoku')
    expect(joined?.roomId).toBe(id)
    expect(n.host.view(id)?.room.viewers).toEqual(['a', 'b'])
    expect((await n.host.enter(group ? 'group:g' : 'single:b', 'gomoku'))?.roomId).toBe(id)
    expect(n.invites.get('a')).toHaveLength(1)
    expect((await n.host.enter(group ? 'group:other' : 'single:c', 'gomoku'))?.roomId).not.toBe(id)
    expect((await n.b.enter(group ? 'group:g' : 'single:a', 'xiangqi'))?.roomId).not.toBe(id)
  })
  it('首次对局必须双人入座并由玩家明确开始，旁观者不能代开', async () => {
    const n = network(), id = n.invite.roomId
    await n.b.open(n.invite); await n.c.open(n.invite)
    expect(await n.host.action(id, { kind: 'start' })).toBe(false)
    await n.host.action(id, { kind: 'seat', side: 0 })
    expect(await n.host.action(id, { kind: 'start' })).toBe(false)
    await n.b.action(id, { kind: 'seat', side: 1 })
    expect(n.host.view(id)?.room.phase).toBe('waiting')
    await n.c.action(id, { kind: 'start' })
    expect(n.host.view(id)?.room.phase).toBe('waiting')
    await n.b.action(id, { kind: 'start' })
    expect(n.c.view(id)?.room.phase).toBe('playing')
    expect(await n.host.action(id, { kind: 'start' })).toBe(false)
  })
  it('邀请不自动加入，选座只容纳两人，其余旁观且不能走子', async () => {
    const n = network(); const id = n.invite.roomId
    expect(n.c.view(id)?.room.viewers).toEqual([])
    await n.b.open(n.invite); await n.c.open(n.invite)
    await n.host.action(id, { kind: 'seat', side: 0 }); await n.b.action(id, { kind: 'seat', side: 1 }); await n.host.action(id, { kind: 'start' })
    expect(n.c.view(id)?.room.phase).toBe('playing')
    await n.c.action(id, { kind: 'move', from: -1, to: 10 })
    expect(n.host.view(id)?.room.state.plies).toBe(0)
    await n.c.action(id, { kind: 'seat', side: 1 })
    expect(n.host.view(id)?.room.seats).toEqual(['a', 'b'])
    await n.host.action(id, { kind: 'move', from: -1, to: 10 })
    expect(n.b.view(id)?.room.state.board[10]).toBe(1)
    await n.host.action(id, { kind: 'move', from: -1, to: 11 })
    expect(n.host.view(id)?.room.state.plies).toBe(1)
    await n.b.action(id, { kind: 'move', from: -1, to: 11 })
    expect(n.c.view(id)?.room.state.plies).toBe(2)
  })
  it('旧修订抢座和重复走子不二次生效', async () => {
    const n = network(); const id = n.invite.roomId
    await n.b.open(n.invite); await n.c.open(n.invite)
    const revision = n.host.view(id)!.room.revision
    n.host.receive('b', { op: 'request', roomId: id, revision, action: { kind: 'seat', side: 0 } })
    n.host.receive('c', { op: 'request', roomId: id, revision, action: { kind: 'seat', side: 0 } })
    expect(n.host.view(id)?.room.seats).toEqual(['b', null]); expect(n.c.view(id)?.error).toBe('stale')
    await n.host.action(id, { kind: 'seat', side: 1 }); await n.host.action(id, { kind: 'start' })
    const packet: BoardPacket = { op: 'request', roomId: id, revision: n.host.view(id)!.room.revision, action: { kind: 'move', from: -1, to: 0 } }
    n.host.receive('b', packet); n.host.receive('b', packet)
    expect(n.host.view(id)?.room.state.plies).toBe(1)
  })
  it('陌生人知道房间ID也不能入场；单聊不接收第三方', async () => {
    const n = network(false), id = n.invite.roomId
    expect(await n.c.open(n.invite)).toBe(false)
    n.host.receive('outsider', { op: 'request', roomId: id, revision: 0, action: { kind: 'join' } })
    expect(n.host.view(id)?.room.viewers).toEqual(['a'])
  })
  it('离群即丧失权限，已入座者离开视为认输', async () => {
    const n = network(), id = n.invite.roomId
    await n.b.open(n.invite); await n.host.action(id, { kind: 'seat', side: 0 }); await n.b.action(id, { kind: 'seat', side: 1 }); await n.host.action(id, { kind: 'start' })
    n.remove('b'); n.host.prune()
    expect(n.host.view(id)?.room.state.winner).toBe(0)
    expect(n.host.view(id)?.room.seats).toEqual(['a', null])
    expect(await n.b.action(id, { kind: 'move', from: -1, to: 0 })).toBe(false)
  })
  it('拒绝伪造房主、篡改邀请、旧快照和非法动作', async () => {
    const n = network(), id = n.invite.roomId
    await n.b.open(n.invite)
    const before = n.b.view(id)!.room
    n.b.receive('c', { op: 'state', room: { ...before, revision: 999 } })
    expect(n.b.view(id)?.room.revision).toBe(before.revision)
    expect(await n.b.open({ ...n.invite, game: 'xiangqi' })).toBe(false)
    expect(await n.host.action(id, { kind: 'seat', side: 2 } as never)).toBe(false)
    expect(n.invites.get('b')).toHaveLength(1)
  })
  it('象棋同一轮次局面出现三次判和，重开必须双方准备', async () => {
    const n = network(false, 'xiangqi'), id = n.invite.roomId
    await n.b.open(n.invite); await n.host.action(id, { kind: 'seat', side: 0 }); await n.b.action(id, { kind: 'seat', side: 1 }); await n.host.action(id, { kind: 'start' })
    for (let i = 0; i < 2; i++) {
      await n.host.action(id, { kind: 'move', from: 82, to: 63 })
      await n.b.action(id, { kind: 'move', from: 1, to: 18 })
      await n.host.action(id, { kind: 'move', from: 63, to: 82 })
      await n.b.action(id, { kind: 'move', from: 18, to: 1 })
    }
    expect(n.host.view(id)?.room.state.winner).toBe('draw')
    expect(n.b.view(id)?.room.phase).toBe('finished')
    await n.host.action(id, { kind: 'ready' }); expect(n.host.view(id)?.room.phase).toBe('finished')
    await n.b.action(id, { kind: 'ready' }); expect(n.host.view(id)?.room.phase).toBe('playing')
    expect(n.host.view(id)?.room.state.plies).toBe(0)
  })
  it('窗口离开不结束房主房间；应用退出同步结束；超时不可重进', async () => {
    const n = network(), id = n.invite.roomId
    await n.b.open(n.invite)
    await n.host.action(id, { kind: 'leave' })
    expect(n.b.view(id)?.room.phase).toBe('waiting')
    await n.host.open(n.invite)
    n.host.stop()
    expect(n.b.view(id)?.room.reason).toBe('host-left')
    expect(await n.b.open(n.invite)).toBe(false)
    const m = network(); m.advance(); m.host.prune(); expect(await m.b.open(m.invite)).toBe(false)
  })
})
