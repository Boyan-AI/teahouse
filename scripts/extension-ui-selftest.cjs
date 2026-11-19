// 真实双 Electron + 生产 IPC/界面验收；数据隔离，所有网络强制回环。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const repo = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
/** 等待可观察状态而非用固定延时冒充功能验证。 */
async function until(check, label, timeout = 18000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(80) }
  throw new Error('等待超时：' + label)
}
/** 获取不影响真实客户端的随机回环端口。 */
async function freePort(type) {
  if (type === 'udp') return new Promise(resolve => {
    const s = require('node:dgram').createSocket('udp4')
    s.bind(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)) })
  })
  return new Promise(resolve => {
    const s = require('node:net').createServer()
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)) })
  })
}
/** 子进程运行完整生产入口，不为 renderer 开放任何额外能力。 */
async function client() {
  const { app, BrowserWindow, globalShortcut } = require('electron')
  const c = JSON.parse(process.env.PANTRY_UI_CLIENT)
  Object.assign(process.env, { PANTRY_USER_DATA: c.data, PANTRY_SMOKE: '1', PANTRY_UDP_PORT: String(c.udp),
    PANTRY_TCP_PORT: String(c.tcp), PANTRY_PEERS: c.peers })
  app.getAppPath = () => repo
  app.getVersion = () => require(path.join(repo, 'package.json')).version
  app.getPreferredSystemLanguages = () => ['zh-CN']
  globalShortcut.register = () => false
  // 仅抑制现有烟测定时退出；就绪后恢复，让用户可正常退出试用环境。
  const quit = app.quit.bind(app)
  app.quit = () => undefined
  const fixture = require(c.fixture)
  const state = fixture.loadAppState(c.data, app.getVersion(), c.tcp, c.udp, [], 'zh-CN')
  fixture.saveProfile(state, { nick: c.name, company: '', dept: '', team: '', avatar: c.avatar, fileDir: '' })
  const dgram = require('node:dgram'), createSocket = dgram.createSocket
  dgram.createSocket = function (...args) {
    const socket = createSocket.apply(this, args), bind = socket.bind, send = socket.send
    socket.bind = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return bind.call(this, port, address, ...rest) }
    socket.send = function (...params) { assert.equal(params.find(v => typeof v === 'string'), '127.0.0.1'); return send.apply(this, params) }
    return socket
  }
  const net = require('node:net'), listen = net.Server.prototype.listen, connect = net.createConnection
  net.Server.prototype.listen = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return listen.call(this, port, address, ...rest) }
  net.createConnection = function (options, ...rest) { assert.equal(options.host, '127.0.0.1'); return connect.call(this, options, ...rest) }
  const errors = []
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (_e, _level, message) => {
      if (/Uncaught|Unhandled|TypeError|ReferenceError|\[Vue warn\]|Refused to/.test(message)) errors.push(message)
    })
    win.webContents.on('render-process-gone', (_e, details) => errors.push(JSON.stringify(details)))
  })
  require(path.join(repo, 'out/main/index.js'))
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('index.html')), '主窗')
  await pause(2000)
  app.quit = quit
  /** 主进程测试控制器驱动真实窗口，走生产 preload 和 IPC。 */
  process.on('message', async r => {
    try {
      const windows = BrowserWindow.getAllWindows()
      const win = windows.find(w => r.route === 'main' ? !w.webContents.getURL().includes('#/') : w.webContents.getURL().includes('#/' + r.route))
      let value
      if (r.op === 'exit') { app.exit(0); return }
      if (r.op === 'errors') value = errors
      else if (r.op === 'windows') value = windows.map(w => w.webContents.getURL())
      else if (!win) throw new Error('窗口不存在：' + r.route)
      else if (r.op === 'capture') { fs.writeFileSync(r.file, (await win.webContents.capturePage()).toPNG()); value = true }
      else if (r.op === 'close') { win.close(); value = true }
      else if (r.op === 'size') { win.setSize(...r.size); win.show(); value = true }
      else value = await win.webContents.executeJavaScript(r.code, true)
      process.send({ id: r.id, value })
    } catch (error) { process.send({ id: r.id, error: String(error.stack || error) }) }
  })
  process.send({ ready: true, nodeId: state.nodeId })
}
/** 管理两个独立客户端；所有 RPC 均有超时，保留截图和数据便于复查。 */
async function run() {
  const output = fs.mkdtempSync(path.join(repo, 'out/extension-ui-'))
  const fixture = path.join(output, 'fixture.cjs')
  require('esbuild').buildSync({ entryPoints: [path.join(repo, 'src/main/store/app-state.ts')], bundle: true,
    platform: 'node', target: 'node16', outfile: fixture, logLevel: 'silent' })
  const ports = await Promise.all(['udp', 'tcp', 'udp', 'tcp', 'udp', 'tcp'].map(freePort))
  const clients = []
  /** 启动真实桌面进程并等待其生产窗口就绪。 */
  const start = async (index, name) => {
    const log = process.env.PANTRY_UI_KEEP ? fs.openSync(path.join(output, 'client-' + index + '.log'), 'a') : null
    const child = spawn(require('electron'), [__filename], { cwd: repo, detached: Boolean(process.env.PANTRY_UI_KEEP),
      stdio: ['ignore', log ?? 'inherit', log ?? 'inherit', 'ipc'], env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '',
      PANTRY_UI_CLIENT: JSON.stringify({ data: path.join(output, 'client-' + index), name, avatar: index === 0 ? -1 : 2,
        udp: ports[index * 2], tcp: ports[index * 2 + 1], peers: ports.filter((_p, i) => i % 2 === 0 && i !== index * 2).map(port => '127.0.0.1:' + port).join(','), fixture }) } })
    if (log !== null) fs.closeSync(log)
    let sequence = 0, nodeId = '', exited = false
    const pending = new Map()
    child.on('message', message => {
      if (message.ready) nodeId = message.nodeId
      const item = pending.get(message.id)
      if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error)) : item.resolve(message.value) }
    })
    child.on('exit', code => { exited = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('客户端退出：' + code)) } pending.clear() })
    const rpc = request => new Promise((resolve, reject) => {
      if (exited) return reject(new Error('客户端已退出'))
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC 超时：' + JSON.stringify(request))) }, 20000)
      pending.set(id, { resolve, reject, timer }); child.send({ id, route: 'main', ...request })
    })
    const instance = { child, rpc, js: (code, route = 'main') => rpc({ code, route }), get nodeId() { return nodeId } }
    clients.push(instance)
    await until(() => nodeId, '客户端 ' + name)
    return instance
  }
  try {
    const a = await start(0, '联机测试·甲'), b = await start(1, '联机测试·乙')
    for (const [self, peer] of [[a, b], [b, a]]) {
      await until(async () => (await self.js('window.pantry.getPeers()')).some(p => p.nodeId === peer.nodeId && p.online), '双方发现')
      await self.js(`window.pantry.openConversation(${JSON.stringify(peer.nodeId)})`)
    }
    console.log('CLIENTS_READY', output)
    for (const [self, name] of [[a, '联机测试·乙'], [b, '联机测试·甲']]) {
      await self.js(`Array.from(document.querySelectorAll('.conv')).find(el => el.textContent.includes(${JSON.stringify(name)})).click()`)
      await until(() => self.js('!!document.querySelector("textarea.input")'), '聊天界面')
      await self.js(`(() => { const el=document.querySelector('textarea.input'); el.value='本机头像验证'; el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await self.js(`document.querySelector('.send').click()`)
    }
    await until(async () => await a.js('document.querySelectorAll(".msg-avatar").length >= 2'), '双方消息')
    await pause(300)
    const avatarBounds = await a.js(`Array.from(document.querySelectorAll('.msg-avatar,.msg-avatar .face,.msg-avatar .avatar-face')).map(el=>({class:el.className,w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height,display:getComputedStyle(el).display}))`)
    console.log('AVATAR_BOUNDS', JSON.stringify(avatarBounds))
    assert(avatarBounds.every(rect => rect.w === 30 && rect.h === 30), '双方头像必须实际可见')
    await a.rpc({op:'capture',file:path.join(output,'chat-avatars-initial.png')})
    /** 使用生产 PK 菜单，验证从入口重进与邀请卡进入两条路径。 */
    const create = async (self, index) => {
      await self.js("document.querySelector('.pk-scope .tool').click()")
      await until(() => self.js('!!document.querySelector(".pk-popover")'), 'PK 菜单')
      await self.js(`document.querySelectorAll('.pk-popover button')[${index}].click()`)
    }
    /** 按 DOM 真正点击，等待双端快照一致，不手改客户端状态。 */
    const click = (self, selector, route = 'main') => self.js(`document.querySelector(${JSON.stringify(selector)}).click()`, route)
    const snapshot = (self, route) => self.js("window.pantry.getBoardGame(new URLSearchParams(location.hash.split('?')[1]).get('room'))", route)
    // 试用模式保留两个干净客户端，棋盘不预先入座/开局，让用户亲自操作。
    if (process.env.PANTRY_UI_KEEP) {
      await create(a,0)
      const url = await until(async ()=>(await a.rpc({op:'windows'})).find(url=>url.includes('#/board')),'试用棋盘')
      const roomId = new URLSearchParams(url.split('?')[1]).get('room')
      await until(async ()=>(await b.js("window.pantry.pageMessages('single:"+a.nodeId+"',null,100)")).some(m=>m.id==='board:'+roomId),'试用邀请')
      await create(b,0)
      await until(async ()=>(await b.rpc({op:'windows'})).some(url=>url.includes(roomId)),'试用同房间')
      await click(a,'button[aria-label="Agent 管理"]')
      await until(async ()=>(await a.rpc({op:'windows'})).some(url=>url.includes('#/agents')),'试用 AI 窗口创建')
      await until(()=>a.js('!!document.querySelector("#agent-name")','agents'),'试用 AI 管理窗')
      await a.rpc({op:'capture',route:'board?room='+roomId,file:path.join(output,'preview-board.png')})
      await a.rpc({op:'capture',route:'agents',file:path.join(output,'preview-agents.png')})
      console.log('PREVIEW_READY',JSON.stringify({output,roomId,clients:clients.map(c=>({pid:c.child.pid,nodeId:c.nodeId}))}))
      for (const c of clients) { c.child.disconnect(); c.child.unref() }
      return
    }
    const games = []
    for (const [index, game] of ['gomoku', 'xiangqi'].entries()) {
      await create(a, index)
      const hostUrl = await until(async () => (await a.rpc({op:'windows'})).find(url => url.includes('#/board')), '房主棋盘')
      const roomId = new URLSearchParams(hostUrl.split('?')[1]).get('room'), route = 'board?room=' + roomId
      console.log('BOARD_TEST', game, roomId)
      await until(async () => (await b.js(`window.pantry.pageMessages('single:${a.nodeId}', null, 100)`)).some(m => m.id === 'board:' + roomId), '收到棋局邀请')
      if (game === 'gomoku') await create(b, index)
      else {
        await until(() => b.js(`!!document.getElementById('msg-board:${roomId}')?.querySelector('button.message-surface')`), '邀请卡')
        await b.js(`document.getElementById('msg-board:${roomId}').querySelector('button.message-surface').click()`)
      }
      try { await until(async () => (await b.rpc({op:'windows'})).some(url => url.includes('#/' + route)), '访客进入同一房间') }
      catch (e) { console.log('JOIN_FAILURE', await b.rpc({op:'windows'}), await b.rpc({op:'errors'})); throw e }
      await until(async () => (await snapshot(b, route))?.room.viewers.length === 2, '双方加入同步')
      await until(() => a.js('!!document.querySelector(".seats button")', route), '棋盘渲染')
      assert.equal(await a.js('document.querySelector(".start").disabled', route), true)
      await click(a, '.seats button:nth-child(1)', route)
      await until(async () => (await snapshot(b, route)).room.seats[0] === a.nodeId, '黑/红方座位同步')
      await click(b, '.seats button:nth-child(2)', route)
      await until(async () => (await snapshot(a, route)).room.seats[1] === b.nodeId, '白/黑方座位同步')
      assert.equal((await snapshot(a, route)).room.phase, 'waiting', '入座不能悄悄自动开始')
      await until(() => b.js('!document.querySelector(".start").disabled', route), '开始按钮可用')
      await click(b, '.start', route)
      await until(async () => (await snapshot(a, route)).room.phase === 'playing' && (await snapshot(b, route)).room.phase === 'playing', '双方开始')
      const moves = game === 'gomoku' ? [[a, -1, 112], [b, -1, 113]] : [[a, 54, 45], [b, 27, 36]]
      for (const [ply, [self, from, to]] of moves.entries()) {
        await until(() => self.js('!document.querySelectorAll(".board button")[' + (from < 0 ? to : from) + '].disabled', route), '轮到玩家走子')
        if (from >= 0) await click(self, '.board button:nth-child(' + (from + 1) + ')', route)
        await click(self, '.board button:nth-child(' + (to + 1) + ')', route)
        await until(async () => (await snapshot(a, route)).room.state.plies === ply + 1 && (await snapshot(b, route)).room.state.plies === ply + 1, '双方走子同步')
      }
      const av = await snapshot(a, route), bv = await snapshot(b, route)
      assert.deepEqual(av.room, bv.room)
      assert.equal(av.names[b.nodeId], '联机测试·乙')
      await a.rpc({op:'capture',route,file:path.join(output, game + '-host.png')})
      await b.rpc({op:'capture',route,file:path.join(output, game + '-guest.png')})
      games.push({game,roomId,plies:av.room.state.plies,seats:av.room.seats})
      if (game === 'gomoku') {
        await a.js(`window.pantry.actBoardGame('${roomId}', {kind:'resign'})`, route)
        await until(async () => (await snapshot(b, route)).room.phase === 'finished', '认输同步')
        await a.rpc({op:'close',route}); await b.rpc({op:'close',route})
        await until(async () => !(await a.rpc({op:'windows'})).some(url=>url.includes('#/' + route)) && !(await b.rpc({op:'windows'})).some(url=>url.includes('#/' + route)), '棋盘关闭完成')
      }
    }
    // 第三个真实客户端验证群聊房间、满座旁观与头像菜单。
    const c = await start(2, '联机测试·丙')
    for (const self of [a, b]) await until(async () => (await self.js('window.pantry.getPeers()')).some(p=>p.nodeId===c.nodeId && p.online), '发现旁观者')
    const group = await a.js(`window.pantry.createGroup('联机验证讨论组',${JSON.stringify([b.nodeId,c.nodeId])})`)
    assert(group, '创建回环讨论组')
    for (const self of [a,b,c]) {
      await until(async () => (await self.js('window.pantry.listGroups()')).some(g=>g.groupId===group.groupId), '群聊同步')
      await until(() => self.js(`Array.from(document.querySelectorAll('.conv')).some(el=>el.textContent.includes('联机验证讨论组'))`), '群聊天入口')
      await self.js(`Array.from(document.querySelectorAll('.conv')).find(el=>el.textContent.includes('联机验证讨论组')).click()`)
      await until(() => self.js('!!document.querySelector("textarea.input")'), '群聊天窗口')
      await self.js(`(() => {const el=document.querySelector('textarea.input');el.value='群聊头像与旁观验证';el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await click(self,'.send')
    }
    await until(() => c.js('document.querySelectorAll(".row .msg-avatar").length >= 3'), '群聊双方头像')
    const groupAvatars = await c.js(`Array.from(document.querySelectorAll('.msg-avatar')).map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}))`)
    assert(groupAvatars.every(r=>r.width===30 && r.height===30))
    await click(c,'.row.peer button.msg-avatar')
    await until(() => c.js('document.querySelectorAll("[role=menuitem]").length >= 2'), '头像提及/私聊菜单')
    await c.rpc({op:'capture',file:path.join(output,'group-avatar-menu.png')})
    await c.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    await create(c,0)
    const groupUrl = await until(async ()=>(await c.rpc({op:'windows'})).find(url=>url.includes('#/board')), '群聊棋盘')
    const groupRoom = new URLSearchParams(groupUrl.split('?')[1]).get('room'), groupRoute='board?room='+groupRoom
    for (const self of [a,b]) {
      await until(async ()=>(await self.js(`window.pantry.pageMessages('group:${group.groupId}',null,100)`)).some(m=>m.id==='board:'+groupRoom),'群邀请送达')
      await create(self,0)
      await until(async ()=>(await self.rpc({op:'windows'})).some(url=>url.includes('#/'+groupRoute)),'进入同一群棋局')
    }
    await until(async ()=>(await snapshot(a,groupRoute)).room.viewers.length===3,'三端成员同步')
    await until(()=>a.js('!!document.querySelector(".seats button")',groupRoute),'群棋盘加载')
    await click(a,'.seats button:nth-child(1)',groupRoute)
    await until(async ()=>(await snapshot(b,groupRoute)).room.seats[0]===a.nodeId,'群选座同步')
    await click(b,'.seats button:nth-child(2)',groupRoute)
    await until(async ()=>(await snapshot(c,groupRoute)).room.seats[1]===b.nodeId,'旁观座位同步')
    await until(()=>c.js('document.querySelectorAll(".seats button:disabled").length===2 && document.querySelector(".start").disabled',groupRoute),'满座仅旁观')
    await until(()=>a.js('!document.querySelector(".start").disabled',groupRoute),'群开局可用')
    await click(a,'.start',groupRoute)
    await until(async ()=>(await snapshot(c,groupRoute)).room.phase==='playing','旁观开局同步')
    assert.equal(await c.js('document.querySelectorAll(".board button:disabled").length',groupRoute),225)
    await click(a,'.board button:nth-child(1)',groupRoute)
    await until(async ()=>(await snapshot(c,groupRoute)).room.state.plies===1,'旁观实时收到走子')
    await c.rpc({op:'capture',route:groupRoute,file:path.join(output,'group-spectator.png')})
    games.push({game:'group-gomoku',roomId:groupRoom,viewers:3,spectator:c.nodeId})
    // 双主题、窄窗口和真实保存：只创建禁用 Agent，绝不调用真实模型。
    await click(a, 'button[aria-label="Agent 管理"]')
    await until(async () => (await a.rpc({op:'windows'})).some(url=>url.includes('#/agents')), 'AI 管理窗')
    await until(() => a.js('!!document.querySelector("#agent-name")', 'agents'), 'AI 表单')
    await a.rpc({op:'capture',route:'agents',file:path.join(output,'agents-empty-light.png')})
    await a.js(`(() => { for (const [id,value] of [['agent-name','本机测试助手'],['agent-persona','你是一个耐心的研发助手，回答简洁、准确。'],['agent-endpoint','http://127.0.0.1:9'],['agent-model','local-test']]) { const el=document.getElementById(id); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); } document.querySelector('.enabled input').click(); })()`, 'agents')
    await click(a, 'button[type=submit]', 'agents')
    await until(async () => (await a.js('window.pantry.listAgents()', 'agents')).length === 1, 'AI 保存配置')
    await until(() => a.js('document.querySelectorAll(".agent-item").length === 1 && document.querySelector("h2").textContent.includes("我的 Agent")', 'agents'), 'AI 列表更新')
    assert.equal(await a.js('document.getElementById("agent-key").value', 'agents'), '')
    assert.equal((await a.js('window.pantry.listAgents()', 'agents'))[0].enabled, false)
    await a.js("document.documentElement.dataset.theme='dark'", 'agents')
    await a.rpc({op:'size',route:'agents',size:[620,820]})
    await pause(200)
    assert.equal(await a.js('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".agents").scrollWidth <= innerWidth', 'agents'), true)
    await a.rpc({op:'capture',route:'agents',file:path.join(output,'agents-edit-dark-narrow.png')})
    await a.js("document.documentElement.dataset.theme='light'", 'agents')
    await a.rpc({op:'size',route:'agents',size:[950,900]})
    await a.rpc({op:'capture',route:'agents',file:path.join(output,'agents-edit-light.png')})
    await a.rpc({op:'capture',file:path.join(output,'chat-avatars.png')})
    const errors = await Promise.all(clients.map(c=>c.rpc({op:'errors'})))
    assert.deepEqual(errors, clients.map(() => []), '渲染进程不得有异常、Vue 警告或 CSP 拒绝')
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({electron:'22.3.27',games,avatarBounds,errors},null,2))
    console.log('EXTENSION_UI_SELFTEST_OK',output)

  } finally {
    for (const c of clients) if (c.child.connected) { c.child.send({ id: -1, op: 'exit' }); c.child.disconnect() }
  }
}
if (process.versions.electron) void client().catch(error => { console.error(error); require('electron').app.exit(1) })
else void run().catch(error => { console.error(error); process.exitCode = 1 })
