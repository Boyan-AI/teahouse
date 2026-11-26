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
  // 仅为显式排队的隔离夹具代答原生选图；其余操作仍使用真实系统选择器。
  const { dialog } = require('electron'), showOpenDialog = dialog.showOpenDialog.bind(dialog)
  let nextPickedFiles = null
  const updatePrompts = []
  let updateResponse = 0
  const showMessageBox = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = (...args) => {
    const options = args.at(-1)
    if (process.env.PANTRY_CABINET_TEST && /文件柜更新|Cabinet update|安装更新|Install the update/.test(options.message || '')) {
      updatePrompts.push(options)
      return Promise.resolve({ response: updateResponse, checkboxChecked: false })
    }
    return showMessageBox(...args)
  }
  dialog.showOpenDialog = (...args) => {
    if (!nextPickedFiles) return showOpenDialog(...args)
    const filePaths = nextPickedFiles; nextPickedFiles = null
    return Promise.resolve({canceled:false,filePaths})
  }
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
      else if (r.op === 'update-prompts') value = updatePrompts
      else if (r.op === 'update-response') { updateResponse = r.response; value = true }
      else if (r.op === 'picker') {
        assert(r.files.every(file=>fs.realpathSync(file).startsWith(path.dirname(c.data)+path.sep)),'选图夹具必须在本次隔离目录内')
        nextPickedFiles = r.files; value = true
      }
      else if (r.op === 'windows') value = windows.map(w => w.webContents.getURL())
      else if (!win) throw new Error('窗口不存在：' + r.route)
      else if (r.op === 'capture') {
        // 截图前显式展示测试窗口，避免 macOS 遮挡节流挂起 requestAnimationFrame。
        win.show(); win.focus()
        // 等待布局与合成帧，避免 DOM 已更新而截图仍是上一帧。
        await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        fs.writeFileSync(r.file, (await win.webContents.capturePage()).toPNG()); value = true
      }
      else if (r.op === 'close') { win.close(); value = true }
      else if (r.op === 'size') { win.setSize(...r.size); win.show(); value = true }
      else if (r.op === 'zoom') { win.webContents.setZoomFactor(r.factor); value = true }
      else if (r.op === 'mouse') {
        // 真实输入命中缩放后的坐标，不能用 DOM.click 冒充变换后的鼠标可用性。
        win.show(); win.focus()
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:r.x,y:r.y})
        win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:r.x,y:r.y})
        value = true
      }
      else value = await win.webContents.executeJavaScript(r.code, true)
      process.send({ id: r.id, value })
    } catch (error) { process.send({ id: r.id, error: String(error.stack || error) + '\nRPC: ' + JSON.stringify(r) }) }
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
  let modelServer = null, modelRequests = 0
  const modelBodies = []
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
    if (process.env.PANTRY_CABINET_TEST) {
      await cabinetUpdateTest(a, b, output)
      return
    }
    for (const [self, name] of [[a, '联机测试·乙'], [b, '联机测试·甲']]) {
      await until(()=>self.js(`Array.from(document.querySelectorAll('.conv')).some(el=>el.textContent.includes(${JSON.stringify(name)}))`),'会话列表渲染')
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
    /** 通过真实粘贴事件加入附件，正文输入和点击发送均走生产 UI，不占用系统剪贴板。 */
    const composeImage = async (self, caption) => {
      await self.js(`(async()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=96;const ctx=canvas.getContext('2d');ctx.fillStyle='#28695c';ctx.fillRect(0,0,160,96);ctx.fillStyle='#fff';ctx.font='20px sans-serif';ctx.fillText('LOCAL IMAGE',12,54);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const data=new DataTransfer();data.items.add(new File([blob],'local-image.png',{type:'image/png'}));document.querySelector('textarea.input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`)
      await until(()=>self.js('document.querySelectorAll(".attachment-card").length===1'),'图片进入待发送草稿')
      await self.js('(()=>{const el=document.querySelector("textarea.input");el.value='+JSON.stringify(caption)+';el.dispatchEvent(new Event("input",{bubbles:true}));})()')
    }
    /** 试用素材仅在隔离数据库中生成，经生产收藏 IPC 保存。 */
    const addLocalStickers = self => self.js(`(async()=>{const items=[];for(const color of ['#cb8264','#4f938c','#6c75aa']){const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,96,96);ctx.fillStyle='white';ctx.font='44px sans-serif';ctx.fillText('☺',26,60);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp'));items.push(await window.pantry.addSticker(await blob.arrayBuffer(),'.webp',96,96));}return items})()`)
    // 试用保留两个独立客户端与管理入口，不启用模型，不接触用户已有数据。
    if (process.env.PANTRY_UI_KEEP) {
      const sample='**图文与引用试用**\n- 选择或粘贴图片后输入说明，一起发送\n- 文字和图片均可右键引用\n- 表情包第一格点齿轮，拖动排序或选择删除'
      await a.js('(()=>{const el=document.querySelector("textarea.input");el.value='+JSON.stringify(sample)+';el.dispatchEvent(new Event("input",{bubbles:true}));})()')
      await click(a,'.send')
      await composeImage(a,'**图文试用**：图片和说明是同一条消息，可右键引用。')
      await click(a,'.send')
      await until(()=>b.js('!!document.querySelector(".image-caption strong")'),'试用图文展示')
      await addLocalStickers(b)
      await b.js('window.pantry.openStickerManager()')
      await until(async()=>(await b.rpc({op:'windows'})).some(url=>url.includes('#/stickers')),'试用管理窗口')
      await until(()=>b.js('document.querySelectorAll(".sticker-tile").length===3','stickers'),'试用收藏列表')
      await b.rpc({op:'capture',route:'stickers',file:path.join(output,'preview-stickers.png')})
      await b.rpc({op:'close',route:'stickers'})
      await until(async()=>!(await b.rpc({op:'windows'})).some(url=>url.includes('#/stickers')),'试用管理窗关闭')
      // 展示新的首格入口，由用户自己点击跳转，不让管理窗口遮住发送面板。
      await click(b,'button[aria-label="表情"]')
      await until(()=>b.js('!!document.querySelector(".emoji-scope .tabs")'),'试用表情面板')
      await b.js('Array.from(document.querySelectorAll(".emoji-scope .tabs button")).find(el=>el.textContent.includes("表情包")).click()')
      await until(()=>b.js('document.querySelectorAll(".sticker-grid .stk").length===3'),'试用收藏同步')
      await b.rpc({op:'capture',file:path.join(output,'preview-caption.png')})
      console.log('PREVIEW_READY',JSON.stringify({output,clients:clients.map(c=>({pid:c.child.pid,nodeId:c.nodeId}))}))
      for (const c of clients) { c.child.disconnect(); c.child.unref() }
      return
    }
    /** 检查完整画布及文档无滚动，窗口变形和125%字号均需通过。 */
    const fitBoard = async (self, route, game) => {
      for (const [label, size, factor] of [['default',[780,820],1],['wide',[1000,500],1],['tall',[320,760],1],['small-zoom',[460,480],1.25],['small',[320,320],1]]) {
        await self.rpc({op:'zoom',route,factor})
        await self.rpc({op:'size',route,size})
        await until(()=>self.js(`(()=>{const r=document.querySelector('.game').getBoundingClientRect();return r.left>=-1 && r.top>=-1 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1 && document.documentElement.scrollHeight<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth+1})()`,route),game+' '+label+'完整可见')
        if (label==='small') assert.equal(await self.js('innerWidth<=320 && innerHeight<=320',route),true,'原生最小窗口确实放宽')
        await self.rpc({op:'capture',route,file:path.join(output,game+'-'+label+'.png')})
      }
    }
    /** 从可见棋格中心发真实鼠标事件，验证CSS变换后的点击坐标。 */
    const mouseClick = async (self, selector, route) => {
      const point = await self.js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,route)
      await self.rpc({op:'mouse',route,...point})
    }
    const games = []
    for (const [index, game] of ['gomoku', 'xiangqi'].entries()) {
      await create(a, index)
      const hostUrl = await until(async () => (await a.rpc({op:'windows'})).find(url => url.includes('#/board')), '房主棋盘')
      const roomId = new URLSearchParams(hostUrl.split('?')[1]).get('room'), route = 'board?room=' + roomId
      console.log('BOARD_TEST', game, roomId)
      await until(async () => (await b.js(`window.pantry.pageMessages('single:${a.nodeId}', null, 100)`)).some(m => m.id === 'board:' + roomId), '收到棋局邀请')
      await until(()=>b.js('!!document.getElementById("msg-board:'+roomId+'")?.querySelector(".board-invite")'),'特殊棋局卡片')
      await b.rpc({op:'capture',file:path.join(output,game+'-invitation-card.png')})
      if (game === 'gomoku') await create(b, index)
      else {
        await until(() => b.js(`!!document.getElementById('msg-board:${roomId}')?.querySelector('.join-board')`), '邀请卡')
        await b.js(`document.getElementById('msg-board:${roomId}').querySelector('.join-board').click()`)
      }
      try { await until(async () => (await b.rpc({op:'windows'})).some(url => url.includes('#/' + route)), '访客进入同一房间') }
      catch (e) { console.log('JOIN_FAILURE', await b.rpc({op:'windows'}), await b.rpc({op:'errors'})); throw e }
      await until(async () => (await snapshot(b, route))?.room.viewers.length === 2, '双方加入同步')
      await until(() => a.js('!!document.querySelector(".seats button")', route), '棋盘渲染')
      await fitBoard(a, route, game)
      await b.rpc({op:'size',route,size:[320,320]})
      assert.equal(await a.js('document.querySelector(".start").disabled', route), true)
      await mouseClick(a, '.seats button:nth-child(1)', route)
      await until(async () => (await snapshot(b, route)).room.seats[0] === a.nodeId, '黑/红方座位同步')
      await mouseClick(b, '.seats button:nth-child(2)', route)
      await until(async () => (await snapshot(a, route)).room.seats[1] === b.nodeId, '白/黑方座位同步')
      assert.equal((await snapshot(a, route)).room.phase, 'waiting', '入座不能悄悄自动开始')
      await until(() => b.js('!document.querySelector(".start").disabled', route), '开始按钮可用')
      await mouseClick(b, '.start', route)
      await until(async () => (await snapshot(a, route)).room.phase === 'playing' && (await snapshot(b, route)).room.phase === 'playing', '双方开始')
      const moves = game === 'gomoku' ? [[a, -1, 112], [b, -1, 113]] : [[a, 54, 45], [b, 27, 36]]
      for (const [ply, [self, from, to]] of moves.entries()) {
        await until(() => self.js('!document.querySelectorAll(".board button")[' + (from < 0 ? to : from) + '].disabled', route), '轮到玩家走子')
        if (from >= 0) await mouseClick(self, '.board button:nth-child(' + (from + 1) + ')', route)
        await mouseClick(self, '.board button:nth-child(' + (to + 1) + ')', route)
        await until(async () => (await snapshot(a, route)).room.state.plies === ply + 1 && (await snapshot(b, route)).room.state.plies === ply + 1, '双方走子同步')
      }
      const av = await snapshot(a, route), bv = await snapshot(b, route)
      assert.deepEqual(av.room, bv.room)
      assert.equal(av.names[b.nodeId], '联机测试·乙')
      await a.rpc({op:'capture',route,file:path.join(output, game + '-host.png')})
      await b.rpc({op:'capture',route,file:path.join(output, game + '-guest.png')})
      games.push({game,roomId,plies:av.room.state.plies,seats:av.room.seats})
      if (game === 'gomoku') {
        // 实际交替落子形成五连，不直接修改棋盘或伪造获胜快照。
        for (const [step,[self,to]] of [[a,111],[b,114],[a,110],[b,115],[a,109],[b,116],[a,108]].entries()) {
          await until(()=>self.js('!document.querySelectorAll(".board button")['+to+'].disabled',route),'五连走子回合')
          await click(self,'.board button:nth-child('+(to+1)+')',route)
          await until(async ()=>(await snapshot(a,route)).room.state.plies===step+3 && (await snapshot(b,route)).room.state.plies===step+3,'五连盘面同步')
        }
        assert.equal((await snapshot(b,route)).room.state.winner,0)
        for (const self of [a,b]) await until(()=>self.js('!!document.querySelector("dialog.result")?.open',route),'获胜弹窗')
        // 通配样式不可破坏原生 dialog 的居中定位；同时验证可见边界。
        console.log('RESULT_BOUNDS',await a.js(`(()=>{const d=document.querySelector('dialog.result');return {rect:d.getBoundingClientRect().toJSON(),client:d.clientHeight,scroll:d.scrollHeight,return:d.querySelector('.return-board').getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight],style:{height:getComputedStyle(d).height,maxHeight:getComputedStyle(d).maxHeight,overflow:getComputedStyle(d).overflow,transform:getComputedStyle(d).transform}}})()`,route))
        await a.rpc({op:'capture',route,file:path.join(output,'game-winner-dialog.png')})
        for (const self of [a,b]) assert.equal(await self.js('(()=>{const d=document.querySelector("dialog.result"),r=d.getBoundingClientRect(),b=d.querySelector(".return-board").getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<2 && Math.abs(r.y+r.height/2-innerHeight/2)<2 && r.top>=0 && r.bottom<=innerHeight && d.scrollHeight<=d.clientHeight+1 && b.bottom<=r.bottom})()',route),true,'结果弹窗及返回按钮必须居中且完整可见，无内部滚动')
        await a.rpc({op:'capture',route,file:path.join(output,'game-winner-dialog.png')})
        await mouseClick(a,'.result .again',route)
        await until(async ()=>(await snapshot(b,route)).room.ready.includes(a.nodeId),'重开等待同步')
        assert.equal((await snapshot(b,route)).room.phase,'finished','一人准备不能重开')
        await mouseClick(b,'.result .again',route)
        await until(async ()=>(await snapshot(a,route)).room.phase==='playing' && (await snapshot(b,route)).room.state.plies===0,'双方确认重开')
        await until(()=>a.js('!document.querySelector("dialog.result")',route),'新局关闭结果窗')
        games[games.length-1].winnerDialog=true; games[games.length-1].rematch=true
        await a.js(`window.pantry.actBoardGame('${roomId}', {kind:'resign'})`, route)
        await until(async () => (await snapshot(b, route)).room.phase === 'finished', '认输同步')
        for (const self of [a,b]) {
          await until(()=>self.js('!!document.querySelector("dialog.result")?.open',route),'认输结果窗')
          await click(self,'.end-game',route)
        }
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
    // 真正获胜保留玩家座位；认输按既有规则离座，不能直接由原座位准备。
    for (const [step,[self,to]] of [[b,15],[a,1],[b,16],[a,2],[b,17],[a,3],[b,18],[a,4]].entries()) {
      await until(()=>self.js('!document.querySelectorAll(".board button")['+to+'].disabled',groupRoute),'群获胜走子回合')
      await click(self,'.board button:nth-child('+(to+1)+')',groupRoute)
      await until(async ()=>(await snapshot(c,groupRoute)).room.state.plies===step+2,'群获胜同步旁观者')
    }
    // 旁观者仅选择继续观看或退出，不可替玩家准备重开。
    await until(()=>c.js('!!document.querySelector("dialog.result")?.open',groupRoute),'旁观结果窗')
    assert.equal(await c.js('document.querySelector(".result .again").textContent',groupRoute),'继续旁观')
    await click(c,'.result .again',groupRoute)
    assert.equal(await c.js('document.querySelector("dialog.result").open',groupRoute),false)
    for (const self of [a,b]) {
      await until(()=>self.js('!!document.querySelector("dialog.result")?.open && !document.querySelector(".result .again").disabled',groupRoute),'玩家可确认下一局')
      await click(self,'.result .again',groupRoute)
      await until(async ()=>{const r=(await snapshot(c,groupRoute)).room;return r.phase==='playing'||r.ready.includes(self.nodeId)},'准备广播到房主')
      if(self===a) await until(async ()=>(await snapshot(b,groupRoute)).room.ready.includes(a.nodeId),'另一玩家收到准备修订')
    }
    await until(async ()=>(await snapshot(c,groupRoute)).room.phase==='playing','旁观下一局')
    await a.js("window.pantry.actBoardGame('"+groupRoom+"',{kind:'resign'})",groupRoute)
    await until(()=>c.js('!!document.querySelector("dialog.result")?.open',groupRoute),'新局结果再次弹出')
    await c.rpc({op:'capture',route:groupRoute,file:path.join(output,'spectator-result-dialog.png')})
    await click(c,'.result .end-game',groupRoute)
    await until(async ()=>!(await c.rpc({op:'windows'})).some(url=>url.includes('#/'+groupRoute)),'旁观退出')
    // 使用本地 HTTP mock 经生产 SDK/Agent/P2P/聊天渲染完整验证，不连接真实模型。
    const modelText = '**本地模型结论**\\n- 第一项：正常\\n- 第二项：支持换行\\n行内代码：`a\\nb`\\n<img src="http://127.0.0.1:1/forbidden" onerror="alert(1)">'
    modelServer = require('node:http').createServer((req,res)=>{
      assert.equal(req.socket.remoteAddress,'127.0.0.1')
      assert.equal(req.url,'/v1/messages')
      let body=''; req.on('data',chunk=>{body+=chunk})
      req.on('end',()=>{ modelBodies.push(JSON.parse(body)); modelRequests++; res.setHeader('content-type','application/json'); res.end(JSON.stringify({id:'msg_local',type:'message',role:'assistant',model:'local-test',content:[{type:'text',text:modelText}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}})) })
    })
    await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve))
    const modelEndpoint = 'http://127.0.0.1:'+modelServer.address().port
    await click(a, 'button[aria-label="Agent 管理"]')
    await until(async () => (await a.rpc({op:'windows'})).some(url=>url.includes('#/agents')), 'AI 管理窗')
    await until(() => a.js('!!document.querySelector("#agent-name")', 'agents'), 'AI 表单')
    await a.rpc({op:'capture',route:'agents',file:path.join(output,'agents-empty-light.png')})
    await a.js(`(() => { for (const [id,value] of [['agent-name','本机测试助手'],['agent-persona','你是一个耐心的研发助手，回答简洁、准确。'],['agent-endpoint',${JSON.stringify(modelEndpoint)}],['agent-model','local-test'],['agent-key','local-ui-test-key']]) { const el=document.getElementById(id); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); } })()`, 'agents')
    await click(a, 'button[type=submit]', 'agents')
    await until(async () => (await a.js('window.pantry.listAgents()', 'agents')).length === 1, 'AI 保存配置')
    await until(() => a.js('document.querySelectorAll(".agent-item").length === 1 && document.querySelector("h2").textContent.includes("我的 Agent")', 'agents'), 'AI 列表更新')
    assert.equal(await a.js('document.getElementById("agent-key").value', 'agents'), '')
    assert.equal((await a.js('window.pantry.listAgents()', 'agents'))[0].enabled, true)
    const agent = await until(async ()=>(await a.js('window.pantry.listAgents()','agents')).find(agent=>agent.status==='running'),'本地 Agent 运行')
    await until(async ()=>(await b.js('window.pantry.getPeers()')).some(p=>p.nodeId===agent.id && p.online && p.caps.includes('agent1')),'发现本地 Agent')
    await b.js('window.pantry.openConversation('+JSON.stringify(agent.id)+')')
    await until(()=>b.js("Array.from(document.querySelectorAll('.conv')).some(el=>el.textContent.includes('本机测试助手'))"),'Agent 会话入口')
    await b.js("Array.from(document.querySelectorAll('.conv')).find(el=>el.textContent.includes('本机测试助手')).click()")
    await until(()=>b.js('!!document.querySelector("textarea.input")'),'Agent 聊天窗口')
    await b.js("(()=>{const el=document.querySelector('textarea.input');el.value='检查 Markdown 展示';el.dispatchEvent(new Event('input',{bubbles:true}));})()")
    await click(b,'.send')
    await until(()=>b.js('!!document.querySelector(".row.peer .rich-message strong")'),'模型加粗渲染')
    assert.equal(await b.js('document.querySelector(".row.peer .rich-message strong").textContent'),'本地模型结论')
    assert.equal(await b.js('document.querySelectorAll(".row.peer .rich-message li").length'),2)
    assert.equal(await b.js('document.querySelector(".row.peer .rich-message code").textContent'),'a\\nb')
    assert.equal(await b.js('document.querySelectorAll(".row.peer .rich-message img,.row.peer .rich-message script").length'),0)
    assert((await b.js("window.pantry.pageMessages('single:"+agent.id+"',null,100)")).some(m=>!m.isMine && m.text===modelText),'数据库保留原始模型内容')
    assert.equal(modelRequests,1)
    await b.rpc({op:'capture',file:path.join(output,'agent-markdown-chat.png')})

    await composeImage(b,'图文说明：**识别这张图片**')
    assert.equal(modelRequests,1,'图片入草稿时不提前触发模型')
    await b.rpc({op:'capture',file:path.join(output,'image-caption-draft.png')})
    await click(b,'.send')
    await until(()=>modelRequests===2,'UI 图文进入模型')
    let blocks=modelBodies.at(-1).messages.at(-1).content
    assert(blocks.some(block=>block.type==='image' && block.source.type==='base64' && block.source.data.length>50))
    assert(blocks.some(block=>block.type==='text' && block.text.includes('图文说明：**识别这张图片**')))
    const captionMessage=await until(async()=>(await b.js("window.pantry.pageMessages('single:"+agent.id+"',null,100)")).find(m=>m.kind==='image' && m.isMine),'图文入库')
    assert.equal(captionMessage.text,'图文说明：**识别这张图片**')
    assert.equal((await b.js("window.pantry.pageMessages('single:"+agent.id+"',null,100)")).filter(m=>m.isMine).length,2,'说明不能另发一条文本重复触发模型')
    await until(()=>b.js('!!document.getElementById('+JSON.stringify('msg-'+captionMessage.id)+')?.querySelector(".image-caption strong")'),'图片说明富文本')
    await b.js('document.getElementById('+JSON.stringify('msg-'+captionMessage.id)+').querySelector("img.thumb").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:650,clientY:300}))')
    await until(()=>b.js('Array.from(document.querySelectorAll(".img-bubble .ctx button")).some(el=>el.textContent.includes("引用回复"))'),'图片引用菜单')
    await b.js('Array.from(document.querySelectorAll(".img-bubble .ctx button")).find(el=>el.textContent.includes("引用回复")).click()')
    await b.js('(()=>{const el=document.querySelector("textarea.input");el.value="读取被引用的图片";el.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await click(b,'.send')
    await until(()=>modelRequests===3,'UI 引用图片进入模型')
    blocks=modelBodies.at(-1).messages.at(-1).content
    assert(blocks.some(block=>block.type==='image'))
    assert(blocks.some(block=>block.type==='text' && block.text.includes('图文说明：') && block.text.includes('读取被引用的图片')))
    await b.rpc({op:'capture',file:path.join(output,'agent-image-caption-quote.png')})

    // 正常聊天也可发送 Markdown；长代码/宽表格只能在内部滚动，不能撑破消息区域。
    await b.js("Array.from(document.querySelectorAll('.conv')).find(el=>el.textContent.includes('联机测试·甲')).click()")
    await until(()=>b.js('!!document.querySelector("textarea.input")'),'普通聊天窗口')
    const wideText = '*普通消息斜体*\n\n' + '```text\n' + 'long_code_'.repeat(120) + '\n```\n\n| ' + Array.from({length:12},(_,i)=>'列'+i).join(' | ') + ' |\n| '+Array(12).fill('---').join(' | ')+' |\n| '+Array(12).fill('单元格内容').join(' | ')+' |'
    await b.js('(()=>{const el=document.querySelector("textarea.input");el.value='+JSON.stringify(wideText)+';el.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await click(b,'.send')
    await until(()=>b.js('!!document.querySelector(".row.mine .rich-message pre")'),'普通消息代码/表格')
    await b.rpc({op:'size',size:[850,800]})
    await pause(200)
    assert.equal(await b.js('(()=>{const root=document.querySelector(".row.mine .rich-message"),r=root.getBoundingClientRect();return !!root.querySelector("em") && r.left>=0 && r.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth && [root.querySelector("pre"),root.querySelector(".table-scroll")].every(el=>el.scrollWidth>el.clientWidth && ["auto","scroll"].includes(getComputedStyle(el).overflowX))})()'),true,'长代码和宽表格在窄窗内部滚动')
    await b.rpc({op:'capture',file:path.join(output,'markdown-wide-narrow.png')})

    // 普通双端图文也只能产生同一条消息；先从群聊切回对应私聊再检查 DOM。
    await a.js("Array.from(document.querySelectorAll('.conv')).find(el=>el.textContent.includes('联机测试·乙')).click()")
    await composeImage(b,'双端图文：图片和说明同一条')
    await click(b,'.send')
    const peerImage=await until(async()=>(await a.js("window.pantry.pageMessages('single:"+b.nodeId+"',null,100)")).find(m=>m.kind==='image' && m.text==='双端图文：图片和说明同一条'),'双端图文')
    await until(()=>a.js('!!document.getElementById('+JSON.stringify('msg-'+peerImage.id)+')?.querySelector("img.thumb")?.naturalWidth'),'接收端真实图片可见')
    await a.rpc({op:'capture',file:path.join(output,'peer-image-caption.png')})
    // 从生产发送面板进入管理窗，先验证空态，再创建本地测试素材。
    await click(b,'button[aria-label="表情"]')
    await until(()=>b.js('!!document.querySelector(".emoji-scope .tabs")'),'表情面板')
    await b.js('Array.from(document.querySelectorAll(".emoji-scope .tabs button")).find(el=>el.textContent.includes("表情包")).click()')
    assert.equal(await b.js('document.querySelector(".sticker-grid").firstElementChild.matches("button.sticker-settings")'),true,'空收藏首格始终提供设置入口')
    assert.equal(await b.js('Array.from(document.querySelectorAll(".emoji-scope .tabs button")).some(el=>el.textContent==="管理")'),false,'顶部不再显示管理页签')
    await b.rpc({op:'capture',file:path.join(output,'sticker-settings-empty.png')})
    await click(b,'.sticker-settings')
    await until(async()=>(await b.rpc({op:'windows'})).some(url=>url.includes('#/stickers')),'表情管理窗口')
    await until(()=>b.js('!!document.querySelector(".empty")','stickers'),'收藏空态')
    await b.rpc({op:'capture',route:'stickers',file:path.join(output,'stickers-empty-light.png')})
    const added=await addLocalStickers(b)
    assert(added.every(Boolean),'本地收藏入库')
    await until(()=>b.js('document.querySelectorAll(".sticker-tile").length===3','stickers'),'管理窗同步新增')
    const original=(await b.js('window.pantry.listStickers()')).map(item=>item.id)
    await b.js('Array.from(document.querySelectorAll(".emoji-scope .tabs button")).find(el=>el.textContent.includes("表情包")).click()')
    const panelIds=()=>b.js('Array.from(document.querySelectorAll(".emoji-scope .stk img")).map(el=>el.src.replace("pantry-sticker://",""))')
    await until(async()=>(await panelIds()).length===3,'发送面板同步新增')
    assert.equal(await b.js('document.querySelector(".sticker-grid").firstElementChild.matches("button.sticker-settings")'),true,'新增收藏不改变设置入口首位')
    await b.rpc({op:'capture',file:path.join(output,'sticker-settings-filled.png')})
    // 主窗不能绕过管理页删除或排序；外部拖放也没有内部 dragged ID。
    await b.js('window.pantry.removeSticker('+JSON.stringify(original[0])+')')
    assert.equal((await b.js('window.pantry.listStickers()')).length,3)
    await b.js('document.querySelector(".emoji-scope .stk").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))')
    assert.equal((await b.js('window.pantry.listStickers()')).length,3,'右键不删除收藏')
    await b.js(`(()=>{const tiles=document.querySelectorAll('.sticker-tile'),data=new DataTransfer();tiles[0].dispatchEvent(new DragEvent('dragstart',{dataTransfer:data,bubbles:true}));tiles[2].dispatchEvent(new DragEvent('dragover',{dataTransfer:data,bubbles:true,cancelable:true}));tiles[2].dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));})()`,'stickers')
    const reordered=[original[1],original[2],original[0]]
    await until(async()=>JSON.stringify((await b.js('window.pantry.listStickers()')).map(item=>item.id))===JSON.stringify(reordered),'拖动顺序持久化')
    await until(async()=>JSON.stringify(await panelIds())===JSON.stringify(reordered),'发送面板同步拖动顺序')
    await b.js('document.querySelector(".sticker-tile").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",altKey:true,bubbles:true,cancelable:true}))','stickers')
    const keyboardOrder=[original[2],original[1],original[0]]
    await until(async()=>JSON.stringify((await b.js('window.pantry.listStickers()')).map(item=>item.id))===JSON.stringify(keyboardOrder),'键盘移动')
    await b.rpc({op:'capture',route:'stickers',file:path.join(output,'stickers-order-light.png')})
    await b.rpc({op:'close',route:'stickers'})
    await until(async()=>!(await b.rpc({op:'windows'})).some(url=>url.includes('#/stickers')),'管理窗彻底关闭')
    await b.js('window.pantry.openStickerManager()')
    await until(async()=>(await b.rpc({op:'windows'})).some(url=>url.includes('#/stickers')),'管理窗重新创建')
    await until(()=>b.js('document.querySelectorAll(".sticker-tile").length===3','stickers'),'重开管理窗')
    assert.deepEqual(await b.js('Array.from(document.querySelectorAll(".sticker-tile")).map(el=>el.dataset.id)','stickers'),keyboardOrder)
    // 原生确认的返回值由隔离测试代答，必须先取消无变化，再确认执行实际删除 IPC。
    await b.js('window.__confirmText="";window.confirm=text=>{window.__confirmText=text;return false};document.querySelector(".sticker-tile .preview").click()','stickers')
    await click(b,'.delete','stickers')
    assert.equal((await b.js('window.pantry.listStickers()')).length,3,'取消删除不改变收藏')
    assert((await b.js('window.__confirmText','stickers')).includes('仅移除收藏'))
    // 发过的表情被移出收藏后，历史图片仍必须可用。
    const removed=keyboardOrder[0]
    await b.js('document.querySelector(".emoji-scope .stk").click()')
    const sentSticker=await until(async()=>(await a.js("window.pantry.pageMessages('single:"+b.nodeId+"',null,100)")).find(m=>m.kind==='sticker'),'真实表情发送')
    await until(()=>a.js('!!document.getElementById('+JSON.stringify('msg-'+sentSticker.id)+')?.querySelector("img.thumb")?.naturalWidth'),'历史表情可见')
    await b.js('void(window.confirm=()=>true)','stickers');await click(b,'.delete','stickers')
    await until(async()=>(await b.js('window.pantry.listStickers()')).length===2,'确认删除')
    assert(!(await b.js('window.pantry.listStickers()')).some(item=>item.id===removed))
    assert.equal(await b.js('(async()=>{const source=await window.pantry.fetchStickerSource('+JSON.stringify(sentSticker.fileRef.transferId)+');return !!source?.bytes.byteLength})()'),true,'移除收藏不删除历史素材')
    await b.js("document.documentElement.dataset.theme='dark'",'stickers')
    await b.rpc({op:'size',route:'stickers',size:[580,680]})
    assert.equal(await b.js('document.documentElement.scrollWidth<=innerWidth','stickers'),true,'管理窄窗无横向溢出')
    await b.rpc({op:'capture',route:'stickers',file:path.join(output,'stickers-dark-narrow.png')})
    await b.js('document.querySelector(".toolbar input").click()','stickers');await click(b,'.delete','stickers')
    await until(async()=>(await b.js('window.pantry.listStickers()')).length===0,'批量删除')
    await until(()=>b.js('!!document.querySelector(".empty")','stickers'),'删除后空态')
    // 真正走管理导入按钮、专用选择授权、canvas 压缩及跨窗事件，而非直接入库替代导入。
    const pickerFixture=path.join(output,'picker-fixture.webp')
    const sourceBytes=await b.js('(async()=>{const source=await window.pantry.fetchStickerSource('+JSON.stringify(sentSticker.fileRef.transferId)+');return Array.from(new Uint8Array(source.bytes))})()')
    fs.writeFileSync(pickerFixture,Buffer.from(sourceBytes))
    await b.rpc({op:'picker',files:[pickerFixture]});await click(b,'.import','stickers')
    await until(()=>b.js('document.querySelectorAll(".sticker-tile").length===1','stickers'),'管理窗真实导入')
    assert.equal((await b.js('window.pantry.listStickers()')).length,1,'收藏事件与 IPC 返回不能重复添加')
    await b.rpc({op:'capture',route:'stickers',file:path.join(output,'stickers-imported-dark.png')})
    await b.rpc({op:'picker',files:[pickerFixture]});await click(b,'button[aria-label="发送图片"]')
    await until(()=>b.js('document.querySelectorAll(".attachment-card").length===1'),'图片选择进入草稿')
    assert.equal(await b.js('window.pantry.readImageDraft('+JSON.stringify(pickerFixture)+')'),null,'已消费的图片路径授权不能重复读盘')
    await b.js('(()=>{const el=document.querySelector("textarea.input");el.value="选择器图文";el.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await click(b,'.send')
    await until(async()=>(await a.js("window.pantry.pageMessages('single:"+b.nodeId+"',null,100)")).some(message=>message.kind==='image'&&message.text==='选择器图文'),'选择器图文双端投递')


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
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({electron:'22.3.27',games,avatarBounds,modelRequests,errors},null,2))
    console.log('EXTENSION_UI_SELFTEST_OK',output)

  } finally {
    for (const c of clients) if (c.child.connected) { c.child.send({ id: -1, op: 'exit' }); c.child.disconnect() }
    if (modelServer) await new Promise(resolve=>modelServer.close(resolve))
  }
}

/** 真实双客户端走文件柜与生产 IPC，发布者运行 0.65.0 仍可发布更高版本清单。 */
async function cabinetUpdateTest(publisher, receiver, output) {
  const cabinet = path.join(output, 'publisher-cabinet'), updates = path.join(cabinet, 'mac')
  fs.mkdirSync(updates, { recursive: true })
  const packageName = 'Teahouse-0.66.0-mac-arm64.dmg'
  // 可选使用本项目生成的真实签名 DMG，将文件柜下载结果直接交给隔离安装验收。
  const actualDmg = process.env.PANTRY_UPDATE_DMG ? fs.realpathSync(process.env.PANTRY_UPDATE_DMG) : null
  if (actualDmg) assert(actualDmg.startsWith(repo + path.sep), '更新包夹具必须来自本项目')
  const bytes = actualDmg ? fs.readFileSync(actualDmg) : Buffer.alloc(4 * 1024 * 1024, 65)
  fs.writeFileSync(path.join(updates, packageName), bytes)
  const manifest = { schema: 1, version: '0.66.0', platform: 'mac', arch: 'arm64', file: packageName,
    size: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
    notes: '隔离测试更新说明\nFile cabinet update verification', dataCompatible: true }
  fs.writeFileSync(path.join(updates, 'teahouse-update.json'), JSON.stringify(manifest))
  await publisher.rpc({ op: 'picker', files: [cabinet] })
  assert((await publisher.js('window.pantry.setShareRoot()')).ok)
  await publisher.js("window.pantry.setShareMode('read')")
  await receiver.js('window.pantry.openSettings()')
  await until(() => receiver.js('!!document.querySelector(".settings")', 'settings').catch(() => false), '设置窗口')
  await receiver.js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='关于').click()", 'settings')
  await until(() => receiver.js('!!document.querySelector(".cabinet-update-settings")', 'settings'), '文件柜更新设置')
  const config = { nodeId: publisher.nodeId, directory: 'mac', autoCheck: false }
  await receiver.js('window.pantry.configureCabinetUpdate(' + JSON.stringify(config) + ')', 'settings')
  await receiver.js('window.__cabinetStates=[];void window.pantry.onCabinetUpdate(state=>window.__cabinetStates.push({status:state.status,bytes:state.bytes}))')
  // 重新打开组件让保存的来源反映到编辑草稿，浏览按钮必须能进入真实柜内目录。
  await receiver.rpc({ op: 'close', route: 'settings' })
  await until(async () => !(await receiver.rpc({ op: 'windows' })).some(url => url.includes('#/settings')), '设置窗口关闭完成')
  await receiver.js('window.pantry.openSettings()')
  await until(() => receiver.js('!!document.querySelector(".settings")', 'settings').catch(() => false), '重开设置')
  await receiver.js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='关于').click()", 'settings')
  await until(() => receiver.js('!!document.querySelector(".cabinet-update-settings")', 'settings'), '更新来源回显')
  await receiver.js("Array.from(document.querySelectorAll('.cabinet-update-settings button')).find(b=>b.textContent.trim()==='浏览').click()", 'settings')
  await until(() => receiver.js('document.querySelector(".folder-toolbar")?.textContent.includes("mac")', 'settings'), '真实目录浏览')
  await receiver.js("Array.from(document.querySelectorAll('.cabinet-update-settings button')).find(b=>b.textContent.trim()==='使用此目录').click()", 'settings')
  await receiver.js("Array.from(document.querySelectorAll('.cabinet-update-settings button')).find(b=>b.textContent.trim()==='保存更新源').click()", 'settings')
  await receiver.js("Array.from(document.querySelectorAll('.cabinet-update-settings button')).find(b=>b.textContent.trim()==='立即检查').click()", 'settings')
  await until(async () => (await receiver.js('window.pantry.getCabinetUpdate()')).status === 'available', '回环清单检查')
  await until(async () => (await receiver.rpc({ op: 'update-prompts' })).length === 1, '首次确认提示')
  assert.equal((await receiver.js('window.pantry.getCabinetUpdate()')).manifest.version, '0.66.0')
  assert.equal((await receiver.js('window.pantry.listTransfers()')).some(item => item.name === 'teahouse-update.json'), false, '清单传输隐藏')
  await receiver.js('window.pantry.checkCabinetUpdate()')
  assert.equal((await receiver.rpc({ op: 'update-prompts' })).length, 1, '同版本不重复弹窗')
  await receiver.js('document.querySelector(".cabinet-update-settings").scrollIntoView({block:"start"})', 'settings')
  await receiver.rpc({ op: 'capture', route: 'settings', file: path.join(output, 'cabinet-update-zh-light.png') })
  await receiver.rpc({ op: 'update-response', response: 1 })
  await receiver.js('window.pantry.downloadCabinetUpdate()')
  const downloaded = await receiver.js('window.pantry.getCabinetUpdate()')
  assert.equal(downloaded.packageReady, true, '实际文件柜下载与 SHA256 校验通过')
  assert.equal(downloaded.error, 'manual-install', '开发实例禁止覆盖安装')
  const states = await receiver.js('window.__cabinetStates')
  assert(states.some(state => state.status === 'downloading' && state.bytes > 0), '真实传输进度可见')
  assert(states.some(state => state.status === 'verifying'), '下载后进入校验状态')
  if (actualDmg) {
    const cache = path.join(output, 'client-1/data/updates/cabinet')
    const packages = fs.readdirSync(cache).map(name => path.join(cache, name, packageName)).filter(file => fs.existsSync(file))
    assert.equal(packages.length, 1, '只安装生产下载器实际收到并校验的缓存')
    await require('./macos-update-selftest.cjs').verifyPackagedUpdate(output, { dmg: packages[0] })
  }
  await receiver.js('window.pantry.cancelCabinetUpdate()')
  await publisher.js("window.pantry.setShareMode('off')")
  assert.equal((await receiver.js('window.pantry.checkCabinetUpdate()')).error, 'off')
  await publisher.js("window.pantry.setShareMode('read')")
  fs.writeFileSync(path.join(updates, 'teahouse-update.json'), '{')
  assert.equal((await receiver.js('window.pantry.checkCabinetUpdate()')).error, 'invalid-manifest')
  fs.writeFileSync(path.join(updates, 'teahouse-update.json'), JSON.stringify(manifest))
  await receiver.js('window.pantry.configureCabinetUpdate(' + JSON.stringify({ ...config, directory: 'missing' }) + ')')
  assert.equal((await receiver.js('window.pantry.checkCabinetUpdate()')).error, 'directory-missing')
  await receiver.js('window.pantry.configureCabinetUpdate(' + JSON.stringify(config) + ')')
  await receiver.js("window.pantry.saveAppSettings({language:'en',theme:'dark'})")
  await receiver.rpc({ op: 'size', route: 'settings', size: [720, 780] })
  await until(() => receiver.js('document.querySelector("#cabinet-update-heading")?.textContent === "File cabinet updates"', 'settings'), '英文更新界面')
  assert.equal(await receiver.js('document.documentElement.scrollWidth <= innerWidth', 'settings'), true, '英文窄窗无横向溢出')
  await receiver.js('document.querySelector(".cabinet-update-settings").scrollIntoView({block:"start"})', 'settings')
  await until(() => receiver.js('getComputedStyle(document.querySelector(".cabinet-update-settings .n-input")).backgroundColor === "rgb(32, 42, 56)"', 'settings'), '深色控件完成主题更新')
  await receiver.rpc({ op: 'capture', route: 'settings', file: path.join(output, 'cabinet-update-en-dark.png') })
  const errors = await Promise.all([publisher.rpc({ op: 'errors' }), receiver.rpc({ op: 'errors' })])
  assert.deepEqual(errors, [[], []])
  fs.writeFileSync(path.join(output, 'cabinet-result.json'), JSON.stringify({ prompts: await receiver.rpc({ op: 'update-prompts' }), downloaded, errors }, null, 2))
  console.log('CABINET_UPDATE_UI_SELFTEST_OK', output)
}

if (process.versions.electron) void client().catch(error => { console.error(error); require('electron').app.exit(1) })
else void run().catch(error => { console.error(error); process.exitCode = 1 })
