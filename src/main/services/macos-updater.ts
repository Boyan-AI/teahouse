// macOS 确认式更新的本地安装边界，网络下载与用户确认由上层编排。
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** 安装事务只含本机主进程生成的路径，不接受清单提供安装位置。 */
export interface MacInstallTransaction {
  target: string
  directory: string
  token: string
}

/** 根据真实可执行文件定位当前安装包，拒绝转移运行、磁盘映像和链接安装位置。 */
export async function macInstallTarget(executable: string): Promise<string> {
  const absolute = resolve(executable)
  const target = dirname(dirname(dirname(absolute)))
  if (basename(absolute) !== 'Teahouse' || absolute !== join(target, 'Contents', 'MacOS', 'Teahouse') ||
    !target.endsWith('.app') || target.includes('/AppTranslocation/') || target.startsWith('/Volumes/') ||
    await realpath(target) !== target || await realpath(absolute) !== absolute || (await lstat(target)).isSymbolicLink()) {
    throw new Error('manual-install')
  }
  try {
    await access(dirname(target), constants.W_OK)
    await access(target, constants.W_OK)
  } catch { throw new Error('manual-install') }
  return target
}

/** 完整验证签名、包标识、版本、架构及符号链接归属；ad-hoc 签名只保证完整性。 */
export async function verifyMacBundle(bundle: string, version: string, arch: string): Promise<void> {
  const root = await realpath(bundle)
  if (root !== resolve(bundle) || !(await lstat(bundle)).isDirectory()) throw new Error('invalid-bundle')
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')], { timeout: 10_000 })
  const info = JSON.parse(stdout)
  if (info.CFBundleIdentifier !== 'com.pantry.app' || info.CFBundleShortVersionString !== version ||
    info.CFBundleExecutable !== 'Teahouse' || info.CFBundlePackageType !== 'APPL') throw new Error('invalid-bundle')
  const binary = join(bundle, 'Contents', 'MacOS', 'Teahouse')
  const architectures = await execute('/usr/bin/lipo', ['-archs', binary], { timeout: 10_000 })
  if (arch !== 'arm64' || architectures.stdout.trim() !== arch) throw new Error('wrong-architecture')
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120_000 })
  // 签名严格模式同时验证嵌套代码和链接，补充拒绝任何逃出包的目录/资源链接。
  await verifyBundleLinks(root, root)
}

/** 逐层检查包内链接，不跟随目录链接递归，避免循环与目录逃逸。 */
async function verifyBundleLinks(root: string, directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const destination = await realpath(path)
      if (!destination.startsWith(root + sep)) throw new Error('invalid-bundle-link')
    } else if (entry.isDirectory()) await verifyBundleLinks(root, path)
    else if (!entry.isFile()) throw new Error('invalid-bundle-entry')
  }
}

/** 只读挂载已校验缓存，准备同卷新副本并复核签名；此时旧应用仍正常运行。 */
export async function prepareMacInstall(options: {
  executable: string
  dmg: string
  cache: string
  version: string
  arch: string
  helper: string
}): Promise<MacInstallTransaction> {
  const target = await macInstallTarget(options.executable)
  const token = randomUUID()
  const directory = join(dirname(target), `.teahouse-update-${token}`)
  const mount = await mkdtemp(join(options.cache, 'mount-'))
  let attached = false
  let created = false
  try {
    await execute('/usr/bin/hdiutil', ['attach', options.dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist'], { timeout: 120_000 })
    attached = true
    const entries = await readdir(mount, { withFileTypes: true })
    if (entries.some(entry => !entry.name.startsWith('.') && !['Teahouse.app', 'Applications'].includes(entry.name))) throw new Error('invalid-bundle')
    const apps = entries.filter(entry => entry.name.endsWith('.app'))
    if (apps.length !== 1 || apps[0].name !== 'Teahouse.app' || !apps[0].isDirectory()) throw new Error('invalid-bundle')
    const source = join(mount, 'Teahouse.app')
    await verifyMacBundle(source, options.version, options.arch)
    await mkdir(directory, { mode: 0o700 })
    created = true
    await execute('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', '--qtn', source, join(directory, 'next.app')], { timeout: 180_000 })
    await verifyMacBundle(join(directory, 'next.app'), options.version, options.arch)
    await copyFile(options.helper, join(directory, 'helper.sh'), constants.COPYFILE_EXCL)
    await writeFile(join(directory, 'transaction.json'), JSON.stringify({ target, token, version: options.version, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 })
    // 卸载成功才交付事务；卸载失败也进入准备失败清理，避免留下无法接管的新包。
    await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 })
    attached = false
    return { target, directory, token }
  } catch (error) {
    // 仅清理当前调用随机创建的准备目录，失败不会触碰当前安装包。
    if (created) await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    if (attached) await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 })
    await rm(mount, { recursive: true, force: true })
  }
}

/** 取消安装准备时仅移除当前进程创建、尚未启动助手的事务。 */
export async function discardMacPreparation(transaction: MacInstallTransaction): Promise<void> {
  const metadata = JSON.parse(await readFile(join(transaction.directory, 'transaction.json'), 'utf8'))
  if (metadata.target !== transaction.target || metadata.token !== transaction.token ||
    transaction.directory !== join(dirname(transaction.target), `.teahouse-update-${transaction.token}`)) throw new Error('invalid-transaction')
  // 助手写入 status 后不可再作为准备目录清理。
  try { await lstat(join(transaction.directory, 'status')); return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rm(transaction.directory, { recursive: true, force: true })
}

/** 启动时报告旧事务失败，仅清理成功七天后的自有备份，失败包保留供人工恢复。 */
export async function inspectMacInstallHistory(executable: string): Promise<string | null> {
  const target = await macInstallTarget(executable)
  const parent = dirname(target)
  let latest: { createdAt: number; status: string } | null = null
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.teahouse-update-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.name)) continue
    const directory = join(parent, entry.name)
    try {
      if ((await lstat(directory)).uid !== process.getuid?.() || await realpath(directory) !== directory) continue
      const metadata = JSON.parse(await readFile(join(directory, 'transaction.json'), 'utf8'))
      if (metadata.target !== target || entry.name !== `.teahouse-update-${metadata.token}` || !Number.isSafeInteger(metadata.createdAt)) continue
      const status = (await readFile(join(directory, 'status'), 'utf8')).trim()
      if (!latest || metadata.createdAt > latest.createdAt) latest = { createdAt: metadata.createdAt, status }
      if (status === 'completed' && Date.now() - metadata.createdAt > 7 * 86400_000) {
        await rm(directory, { recursive: true, force: true })
      }
    } catch { /* 不完整或不可读事务留给人工检查，不扩大清理范围。 */ }
  }
  if (latest?.status === 'rolled-back') return 'rolled-back'
  if (latest && ['parent-running', 'permission-denied', 'invalid-signature', 'backup-failed', 'replace-failed', 'recovery-required'].includes(latest.status)) return 'install-failed'
  return null
}

/** 启动随包助手并确认进程创建成功，上层随后走应用既有退出清理流程。 */
export async function launchMacInstall(transaction: MacInstallTransaction): Promise<void> {
  const child = spawn('/bin/sh', [join(transaction.directory, 'helper.sh'), transaction.target,
    transaction.directory, String(process.pid), transaction.token, '120', '60'], {
    detached: true, stdio: 'ignore', cwd: transaction.directory
  })
  await new Promise<void>((resolveSpawn, reject) => {
    child.once('error', reject)
    child.once('spawn', () => { resolveSpawn() })
  })
  // 助手已进入等待旧进程退出状态才允许应用退出，启动即失败时仍保留当前窗口。
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const status = await readFile(join(transaction.directory, 'status'), 'utf8').catch(() => '')
    if (status.trim() === 'waiting') { child.unref(); return }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  child.kill()
  child.unref()
  throw new Error('install-failed')
}

/** 新应用完成正常启动后写入受限握手文件；仅匹配当前 bundle 相邻的本次事务。 */
export async function acknowledgeMacInstall(executable: string, args: string[]): Promise<void> {
  const index = args.indexOf('--cabinet-update-token')
  if (index < 0) return
  const token = args[index + 1]
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token ?? '')) return
  const target = await macInstallTarget(executable)
  const directory = join(dirname(target), `.teahouse-update-${token}`)
  if (await realpath(directory) !== directory || (await lstat(directory)).uid !== process.getuid?.()) return
  if ((await readFile(join(directory, 'status'), 'utf8')).trim() !== 'starting') return
  await writeFile(join(directory, 'ready'), token, { flag: 'wx', mode: 0o600 })
}
