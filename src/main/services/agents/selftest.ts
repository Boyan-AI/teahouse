// Electron/Node16 原生验收：真实 SQLite、独立 Agent 节点、TCP 长文本与本地模型 mock。
// 所有监听仅绑定127.0.0.1；不读取实际配置、不请求真实模型、不消耗密钥额度。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { UdpChannel } from '../../net/udp'
import { PeerRegistry } from '../../net/peer-registry'
import { Discovery } from '../../net/discovery'
import { Messenger } from '../../net/messenger'
import { FilesService } from '../files'
import { TransferRepo } from '../../store/transfer-repo'
import { openDatabase } from '../../store/db'
import { QueueRepo } from '../../store/queue-repo'
import { DedupRepo } from '../../store/dedup-repo'
import { ConvRepo } from '../../store/conv-repo'
import { MsgRepo, msgRowToView } from '../../store/msg-repo'
import { GroupRepo } from '../../store/group-repo'
import { ChatService } from '../chat'
import { GroupsService } from '../groups'
import { AgentRuntime } from './runtime'
import { AGENT_CAP } from '../../../shared/agents'
import type { Profile } from '../../../shared/protocol'

/** 有限轮询使用本地事件循环，不允许网络验收无限挂起。 */
async function until(stage: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Agent 原生回环验收超时：' + stage)
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}

/** 每个人类测试节点都有独立真实数据库和控制帧接收端。 */
async function human(dir: string, name: string) {
  const db = openDatabase(join(dir, name + '.db'))
  const profile: Profile = { nodeId: randomUUID(), nick: name, company: '', dept: '', team: '', avatar: -1, profileRev: 1,
    host: 'loopback-test', platform: 'mac', tcpPort: 1, ver: '0.0.0-test', caps: ['dp1', 'gr1', 'mrec1'] }
  const udp = new UdpChannel({ port: 0, bindAddress: '127.0.0.1', broadcastTargets: [] })
  const registry = new PeerRegistry(profile.nodeId)
  const messenger = new Messenger({ selfId: profile.nodeId, udp, registry, queue: new QueueRepo(db), dedup: new DedupRepo(db), timings: { ackRetrySchedule: [50, 100, 200] } })
  const discovery = new Discovery({ udp, registry, profile, timings: { entryReplyJitterBase: 1, entryReplyJitterMax: 1 } })
  const convRepo = new ConvRepo(db), msgRepo = new MsgRepo(db), groupRepo = new GroupRepo(db)
  const chat = new ChatService({ selfId: profile.nodeId, messenger, convRepo, msgRepo, groupRepo,
    mediaRecall: {canRecall:row=>files.canRecallMessage(row.id),applyLocalRecall:row=>{files.applyRecallMessage(row.id)},applyIncomingRecall:row=>files.applyRecallMessage(row.id)} })
  const groups = new GroupsService({ selfId: profile.nodeId, messenger, convRepo, msgRepo, groupRepo })
  const files = new FilesService({selfId:profile.nodeId,messenger,registry,convRepo,msgRepo,groupRepo,
    transferRepo:new TransferRepo(db),tcpPort:0,bindAddress:'127.0.0.1',getImagesDir:()=>dir,getSaveDir:()=>dir})
  await files.start();profile.tcpPort=files.availability().port;await udp.start()
  discovery.start()
  return { files, profile, udp, registry, chat, groups, msgRepo, discovery,
    async stop(): Promise<void> { discovery.stop(); messenger.stop(); await files.stop(); await udp.stop(); await new Promise<void>(resolve => setImmediate(resolve)); db.close() } }
}

/** 本地模拟 Anthropic 服务验证密钥、模型、人设与文字请求的真实 Node16 路径。 */
async function main(): Promise<void> {
  assert.equal(process.versions.electron, '22.3.27', '原生验收必须使用项目锁定的 Electron')
  assert.equal(process.versions.node.split('.')[0], '16', '原生验收必须使用真实 Node16')
  const dir = mkdtempSync(join(tmpdir(), 'pantry-agent-native-'))
  const modelRequests: Array<Record<string, unknown>> = []
  const model = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      assert.equal(req.url, '/v1/messages'); assert.equal(req.headers['x-api-key'], 'local-test-secret')
      const parsed = JSON.parse(body) as Record<string, unknown>; modelRequests.push(parsed)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'msg_local', type: 'message', role: 'assistant', model: 'local-test', content: [{ type: 'text', text: '本地验收回复' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    })
  })
  let owner: Awaited<ReturnType<typeof human>> | undefined, peer: Awaited<ReturnType<typeof human>> | undefined, runtime: AgentRuntime | undefined
  try {
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    const address = model.address(); assert.ok(address && typeof address !== 'string')
    owner = await human(dir, 'owner'); peer = await human(dir, 'peer')
    owner.discovery.probe('127.0.0.1', peer.udp.port)
    await until('用户互相发现', () => owner!.registry.get(peer!.profile.nodeId)?.online === true)
    const id = randomUUID()
    runtime = new AgentRuntime({ config: { id, name: '本地助手', persona: '只回答测试问题', endpoint: 'http://127.0.0.1:' + address.port,
      model: 'local-test', enabled: true, encryptedKey: '' }, dataDir: dir, profile: owner.profile,
      seeds: () => [owner!, peer!].map(h => ({ host: '127.0.0.1', port: h.udp.port })), key: () => 'local-test-secret', loopback: true,
      error: message => { if (message) throw new Error(message) } })
    await runtime.start()
    await until('双端发现 Agent', () => Boolean(owner!.registry.get(id)?.online && peer!.registry.get(id)?.online))
    assert.ok(owner.registry.get(id)?.profile.caps.includes(AGENT_CAP))
    assert.equal(owner.registry.get(id)?.profile.avatarHash, undefined)
    assert.equal(peer.registry.get(id)?.profile.nick, '本地助手')
    owner.chat.sendText(id, '长文字测试'.repeat(200))
    await until('TCP 私聊模型回复', () => owner!.msgRepo.page('single:' + id, null, 20).some(row => !row.is_mine && row.content === '本地验收回复'))
    assert.equal(modelRequests[0].model, 'local-test'); assert.equal(modelRequests[0].system, '只回答测试问题')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6p8AAAAASUVORK5CYII=','base64')
    const imagePath = join(dir,'vision.png');writeFileSync(imagePath,png)
    const beforeImage = modelRequests.length
    const image = await owner.files.offerPaths(id,[imagePath],'image',undefined,{caption:'说明：识别这张图'})
    assert.ok(image);assert.equal(image.text,'说明：识别这张图')
    await until('真实图文进入模型',()=>modelRequests.length===beforeImage+1)
    const imageTurn = (modelRequests.at(-1)!.messages as Array<{content:unknown}>).at(-1)!.content as Array<{type:string;source?:{data:string};text?:string}>
    assert.equal(imageTurn.find(b=>b.type==='image')?.source?.data,png.toString('base64'))
    assert.ok(imageTurn.some(b=>b.type==='text'&&b.text?.includes('说明：识别这张图')))
    owner.chat.sendText(id,'读取引用的图片',image.id)
    await until('引用图文进入模型',()=>modelRequests.length===beforeImage+2)
    const quoteTurn=(modelRequests.at(-1)!.messages as Array<{content:unknown}>).at(-1)!.content as Array<{type:string;text?:string}>
    assert.ok(quoteTurn.some(b=>b.type==='image'));assert.ok(quoteTurn.some(b=>b.text?.includes('说明：识别这张图')&&b.text.includes('读取引用的图片')))
    // 真实撤回后再引用，验证 Agent 接收撤回状态而非继续上传旧图片。
    assert.equal(owner.chat.recall(image.id),true)
    const internalMessages=runtime as unknown as {msgRepo:MsgRepo|null}
    await until('Agent 采纳图片撤回',()=>internalMessages.msgRepo?.get(image.id)?.status==='recalled')
    const beforeRecallQuote=modelRequests.length
    owner.chat.sendText(id,'读取已撤回的引用',image.id)
    await until('撤回引用进入模型',()=>modelRequests.length===beforeRecallQuote+1)
    const unavailableTurn=(modelRequests.at(-1)!.messages as Array<{content:unknown}>).at(-1)!.content
    assert.equal(typeof unavailableTurn,'string');assert.ok((unavailableTurn as string).includes('引用消息不可用或已撤回'))
    const group = owner.groups.createGroup('原生回环群', [peer.profile.nodeId, id]); assert.ok(group)
    // 读取运行时已采纳的真实群元数据，保证测试不依赖任意延时猜测。
    const internal = runtime as unknown as { groups: GroupsService | null }
    await until('Agent 采纳群邀请', () => internal.groups?.get(group.groupId)?.amMember === true)
    const previous = modelRequests.length
    owner.groups.sendText(group.groupId, '@所有人 测试不触发', ['@all'])
    await new Promise<void>(resolve => setTimeout(resolve, 200)); assert.equal(modelRequests.length, previous)
    owner.groups.sendText(group.groupId, '@本地助手 测试明确提及', [id])
    await until('群明确提及回复', () => peer!.msgRepo.page('group:' + group.groupId, null, 20).some(row => row.sender_id === id && row.content === '本地验收回复'))
    // 未提及的群图片只在本地接收，后续显式引用才进入模型。
    const beforeGroupImage=modelRequests.length
    const groupImage=await owner.files.offerGroupPaths(group.groupId,[imagePath],'image',undefined,{caption:'群图片参考'})
    assert.ok(groupImage)
    const internalFiles=runtime as unknown as {files:FilesService|null}
    await until('群图片本地接收完成',()=>{
      const row=internalMessages.msgRepo?.get(groupImage.id)
      const transferId=row?.file_ref ? (JSON.parse(row.file_ref) as {transferId:string}).transferId : ''
      return internalFiles.files?.transferView(transferId)?.status==='done'
    })
    await new Promise<void>(resolve=>setTimeout(resolve,150));assert.equal(modelRequests.length,beforeGroupImage)
    owner.groups.sendText(group.groupId,'@本地助手 引用群图片',[id],groupImage.id)
    await until('明确提及引用群图片',()=>modelRequests.length===beforeGroupImage+1)
    const groupQuote=(modelRequests.at(-1)!.messages as Array<{content:unknown}>).at(-1)!.content as Array<{type:string;text?:string}>
    assert.ok(groupQuote.some(block=>block.type==='image'));assert.ok(groupQuote.some(block=>block.text?.includes('群图片参考')))
    const beforeMentionImage=modelRequests.length
    await owner.files.offerGroupPaths(group.groupId,[imagePath],'image',undefined,{caption:'@本地助手 识别群图文',mentions:[id]})
    await until('群图文提及直接触发',()=>modelRequests.length===beforeMentionImage+1)
    const invite = { roomId: randomUUID(), hostId: owner.profile.nodeId, game: 'gomoku' as const, groupId: group.groupId, createdAt: Date.now() }
    owner.msgRepo.insert({ id: 'board:' + invite.roomId, convId: 'group:' + group.groupId, senderId: owner.profile.nodeId, isMine: true, kind: 'text', content: '五子棋邀请', fileRef: JSON.stringify(invite), ts: invite.createdAt, status: 'sent' })
    assert.deepEqual(msgRowToView(owner.msgRepo.get('board:' + invite.roomId)!).boardRef, invite)
    await runtime.stop(); runtime = undefined
    await until('Agent 退出离线', () => owner!.registry.get(id)?.online === false)
    console.log('[agent-selftest] PASS：Node16 SDK、本地模型、真实数据库、双端发现、TCP长文本、真实图文、图片/撤回引用、群图文提及及退出全部通过')
  } finally {
    await runtime?.stop(); await owner?.stop(); await peer?.stop()
    await new Promise<void>(resolve => model.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}
void main().catch(error => { console.error('[agent-selftest] FAIL', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1 })
