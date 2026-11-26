// 固定文件柜更新源编排，检查不下载安装包，下载与安装分别需要用户操作。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { CABINET_MANIFEST_MAX_BYTES, CABINET_MANIFEST_NAME, normalizeCabinetUpdateConfig,
  parseCabinetManifest, type CabinetUpdateConfig, type CabinetUpdateManifest, type CabinetUpdateState } from '../../shared/cabinet-update'
import { compareSemver } from '../util/semver'

/** 数据面由主入口装配为既有文件柜限额单文件下载，所有测试可仅使用回环或本地夹具。 */
export interface CabinetUpdaterDeps {
  version: string
  platform: string
  arch: string
  cache: string
  source: (nodeId: string) => { name: string; error: string | null }
  fetch: (options: { nodeId: string; path: string; size?: number; maxBytes: number; directory: string;
    signal: AbortSignal; onProgress: (bytes: number) => void }) => Promise<string>
  changed: (state: CabinetUpdateState) => void
  available: (state: CabinetUpdateState) => void
}

/** 串行检查/下载，切换来源、休眠、退出时撤销在途工作并丢弃旧回调。 */
export class CabinetUpdater {
  private state: CabinetUpdateState
  private task: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private suspended = false
  private stopped = false
  private prompted = new Set<string>()
  private readyPath: string | null = null
  private readyDirectory: string | null = null

  /** 老配置经统一规范化后默认不产生任何网络请求。 */
  constructor(private readonly deps: CabinetUpdaterDeps, config: CabinetUpdateConfig) {
    const clean = normalizeCabinetUpdateConfig(config)
    this.state = { config: clean, status: clean.nodeId ? 'idle' : 'unconfigured', checkedAt: null,
      sourceName: '', manifest: null, bytes: 0, packageReady: false, error: null }
  }

  /** 返回可安全跨 IPC 使用的独立快照。 */
  snapshot(): CabinetUpdateState {
    return { ...this.state, config: { ...this.state.config }, manifest: this.state.manifest ? { ...this.state.manifest } : null }
  }

  /** 配置变更撤销旧授权，下一次检查使用新的固定节点与目录。 */
  configure(config: CabinetUpdateConfig): void {
    this.cancel()
    this.state.config = normalizeCabinetUpdateConfig(config)
    this.state.checkedAt = null
    this.state.sourceName = ''
    this.state.status = this.state.config.nodeId ? 'idle' : 'unconfigured'
    this.publish()
    this.schedule(15_000)
  }

  /** 启动延迟检查，避免网络发现尚未完成时误报离线。 */
  start(): void { this.stopped = false; this.schedule(15_000) }

  /** 休眠撤销检查和下载，恢复仅重新安排一次检查。 */
  suspend(): void { this.suspended = true; this.cancel(); this.clearTimer() }

  /** 不补发休眠期间积压任务。 */
  resume(): void { this.suspended = false; this.schedule(3000) }

  /** 退出时撤销定时与一次性下载授权。 */
  stop(): void { this.stopped = true; this.cancel(); this.discardReadyPackage(); this.clearTimer() }

  /** 清除受管缓存及在途任务；正在退出交接的安装不可取消。 */
  cancel(): void {
    if (this.state.status === 'installing') return
    this.task?.abort()
    this.discardReadyPackage()
    this.state.manifest = null
    this.state.bytes = 0
    this.state.packageReady = false
    this.state.error = null
    this.state.status = this.state.config.nodeId ? 'idle' : 'unconfigured'
    this.publish()
  }

  /** 只获取 64 KiB 上限的小清单，校验失败保持错误状态。 */
  async check(): Promise<CabinetUpdateState> {
    if (!this.canStart() || this.readyPath) return this.snapshot()
    const controller = new AbortController()
    this.task = controller
    this.state.status = 'checking'
    this.state.error = null
    this.state.manifest = null
    this.publish()
    let directory: string | null = null
    let notifyAvailable = false
    try {
      this.validateSource()
      directory = await this.createDirectory()
      const path = await this.fetch(CABINET_MANIFEST_NAME, directory, CABINET_MANIFEST_MAX_BYTES, controller)
      const info = await lstat(path)
      if (!info.isFile() || info.size > CABINET_MANIFEST_MAX_BYTES) throw new Error('invalid-manifest')
      const manifest = parseCabinetManifest(await readFile(path, 'utf8'))
      if (controller.signal.aborted) return this.snapshot()
      this.state.checkedAt = Date.now()
      this.state.manifest = manifest
      this.state.status = compareSemver(manifest.version, this.deps.version) > 0 ? 'available' : 'latest'
      this.publish()
      const key = `${this.state.config.nodeId}/${this.state.config.directory}/${manifest.version}`
      if (this.state.status === 'available' && !this.prompted.has(key)) {
        this.prompted.add(key)
        notifyAvailable = true
      }
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error)
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      if (this.task === controller) this.task = null
      this.schedule(30 * 60_000)
    }
    // 清单任务完全结束再提示，立即确认也能启动下载，不被串行锁误拒绝。
    if (notifyAvailable && !controller.signal.aborted) this.deps.available(this.snapshot())
    return this.snapshot()
  }

  /** 用户确认后下载已提示的精确文件，复核实际落盘大小和 SHA256 后进入待安装状态。 */
  async download(): Promise<CabinetUpdateState> {
    const manifest = this.state.manifest
    if (!this.canStart() || !manifest || compareSemver(manifest.version, this.deps.version) <= 0 || this.readyPath) return this.snapshot()
    const controller = new AbortController()
    this.task = controller
    this.state.status = 'downloading'
    this.state.bytes = 0
    this.state.error = null
    this.publish()
    let directory: string | null = null
    try {
      this.validateSource()
      directory = await this.createDirectory()
      const path = await this.fetch(manifest.file, directory, manifest.size, controller, manifest.size)
      if (controller.signal.aborted) return this.snapshot()
      this.state.status = 'verifying'
      this.publish()
      await verifyCabinetPackage(path, manifest, controller.signal)
      if (controller.signal.aborted) return this.snapshot()
      this.readyDirectory = directory
      this.readyPath = path
      directory = null
      this.state.status = 'ready'
      this.state.packageReady = true
      this.publish()
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error)
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      if (this.task === controller) this.task = null
      this.schedule(30 * 60_000)
    }
    return this.snapshot()
  }

  /** 安装入口只拿本次校验过的受管副本，失败仍可重新校验重试。 */
  installation(): { path: string; manifest: CabinetUpdateManifest } | null {
    if (!this.readyPath || !this.state.manifest || !['ready', 'error'].includes(this.state.status)) return null
    return { path: this.readyPath, manifest: { ...this.state.manifest } }
  }

  /** 交接助手期间锁定所有更新操作。 */
  installing(): void { this.state.status = 'installing'; this.state.error = null; this.clearTimer(); this.publish() }

  /** 准备后用户选择稍后，恢复可安装状态并保留已下载缓存。 */
  deferInstall(): void { this.state.status = 'ready'; this.state.error = null; this.publish(); this.schedule(30 * 60_000) }

  /** 安装失败通过同一状态流提示，保留已校验副本供重试。 */
  fail(error: unknown): void {
    this.state.status = 'error'
    this.state.error = error instanceof Error ? error.message : 'update-failed'
    this.state.checkedAt ??= Date.now()
    this.publish()
  }

  /** 只在当前平台、固定来源与空闲状态下发起网络工作。 */
  private canStart(): boolean {
    return this.deps.platform === 'darwin' && this.deps.arch === 'arm64' && !!this.state.config.nodeId &&
      !this.task && !this.stopped && !this.suspended && this.state.status !== 'installing'
  }

  /** 不依赖发布者运行版本，权限仍由文件柜服务端判定。 */
  private validateSource(): void {
    const source = this.deps.source(this.state.config.nodeId)
    this.state.sourceName = source.name
    if (source.error) throw new Error(source.error)
  }

  /** 每次请求独立目录避免覆盖、同名去重和旧任务结果混用。 */
  private async createDirectory(): Promise<string> {
    await mkdir(this.deps.cache, { recursive: true, mode: 0o700 })
    return mkdtemp(join(await realpath(this.deps.cache), 'request-'))
  }

  /** 目录来自本地设置，文件名来自严格清单，下载器只允许单文件。 */
  private async fetch(name: string, directory: string, maxBytes: number, controller: AbortController, size?: number): Promise<string> {
    const config = this.state.config
    const path = await this.deps.fetch({ nodeId: config.nodeId, path: config.directory ? `${config.directory}/${name}` : name,
      maxBytes, size, directory, signal: controller.signal, onProgress: bytes => {
        if (controller.signal.aborted || this.state.status !== 'downloading') return
        this.state.bytes = bytes
        this.publish()
      } })
    if (controller.signal.aborted) throw new Error('canceled')
    if (dirname(path) !== directory || await realpath(path) !== path) throw new Error('invalid-file')
    return path
  }

  /** 单次定时器天然合并重复触发，不积压补偿执行。 */
  private schedule(delay: number): void {
    this.clearTimer()
    if (!this.state.config.autoCheck || !this.state.config.nodeId || this.stopped || this.suspended || this.state.status === 'installing') return
    this.timer = setTimeout(() => { this.timer = null; void this.check() }, delay)
    this.timer.unref?.()
  }

  /** 取消当前唯一计时器。 */
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }

  /** 助手接管前已复制新应用，退出时可以清理下载缓存而不触碰安装事务。 */
  private discardReadyPackage(): void {
    this.readyPath = null
    const directory = this.readyDirectory
    this.readyDirectory = null
    if (directory) void rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }

  /** 变更始终输出独立快照，订阅者不能改写主进程状态。 */
  private publish(): void { this.deps.changed(this.snapshot()) }
}

/** 使用流式哈希避免大包挤占内存，安装前也复用这一校验。 */
export async function verifyCabinetPackage(path: string, manifest: CabinetUpdateManifest, signal?: AbortSignal): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.size !== manifest.size) throw new Error('integrity-failed')
  const hash = createHash('sha256')
  let bytes = 0
  if (signal?.aborted) throw new Error('canceled')
  const stream = createReadStream(path)
  const abort = (): void => { stream.destroy(new Error('canceled')) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk) }
  } finally { signal?.removeEventListener('abort', abort) }
  if (bytes !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('integrity-failed')
}
