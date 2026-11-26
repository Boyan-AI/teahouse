// 文件柜更新的跨进程协议；任何清单都必须完整验证后才能用于提示或下载。
import { LIMITS, SHARE_MAX_DEPTH, SHARE_NAME_MAX, SHARE_PATH_MAX, UPDATE_PACKAGE_MAX_BYTES } from './protocol'

export const CABINET_MANIFEST_NAME = 'teahouse-update.json'
export const CABINET_MANIFEST_MAX_BYTES = 64 * 1024
export const CABINET_NOTES_MAX_LENGTH = 4000

/** 第一版仅支持无不兼容数据变更的 macOS arm64 稳定版本。 */
export interface CabinetUpdateManifest {
  schema: 1
  version: string
  platform: 'mac'
  arch: 'arm64'
  file: string
  size: number
  sha256: string
  notes: string
  dataCompatible: true
}

/** 固定节点身份与柜内目录独立于 IP 和发布者当前运行版本。 */
export interface CabinetUpdateConfig {
  nodeId: string
  directory: string
  autoCheck: boolean
}

/** 更新过程只向渲染层公开展示数据和受限操作状态。 */
export interface CabinetUpdateState {
  config: CabinetUpdateConfig
  status: 'unconfigured' | 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'
  checkedAt: number | null
  sourceName: string
  manifest: CabinetUpdateManifest | null
  bytes: number
  packageReady: boolean
  error: string | null
}

/** 公开错误保持可操作且不泄露底层路径，未知错误使用统一重试提示。 */
export const CABINET_UPDATE_ERROR_TEXT: Record<string, string> = {
  'rolled-back': '新版本启动失败，已恢复旧版本。请联系发布者检查安装包。',
  'install-failed': '上次安装未完成，旧应用已保留。请检查安装目录权限后重试。',
  'invalid-config': '更新来源或目录格式无效，请选择文件柜内的相对目录。',
  offline: '更新源离线，请等待发布者上线后重试。',
  unsupported: '该节点尚不支持文件柜，请更换更新源。',
  off: '没有读取该文件柜的权限，请联系发布者。',
  'not-found': '更新目录或清单不存在，请检查来源目录。',
  'manifest-missing': '更新目录中没有更新清单，请联系发布者。',
  'directory-missing': '更新目录不存在，请重新选择目录。',
  busy: '该文件柜正忙，请稍后重试。',
  timeout: '读取更新超时，请检查连接后重试。',
  'invalid-manifest': '更新清单无效，请联系发布者重新生成。',
  'invalid-file': '收到的文件与更新请求不符，已停止下载。',
  'integrity-failed': '安装包校验失败，请重新下载或联系发布者。',
  'download-failed': '更新下载失败，请检查连接后重试。',
  'manual-install': '请先将茶话间安装到可写的应用目录，再重试安装。',
  'invalid-bundle': '安装包中的应用标识或版本不符，请联系发布者。',
  'wrong-architecture': '安装包架构不符，需要 macOS arm64 版本。',
  'update-failed': '更新未完成，请重试；仍失败时联系发布者。'
}

/** 只接受现有版本比较器能精确比较的三段稳定版本。 */
export function isCabinetVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
}

/** 严格限制字段、类型、大小和包名，阻止远程路径或命令参数进入安装链路。 */
export function parseCabinetManifest(text: string): CabinetUpdateManifest {
  if (new TextEncoder().encode(text).length > CABINET_MANIFEST_MAX_BYTES) throw new Error('invalid-manifest')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('invalid-manifest') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-manifest')
  const manifest = value as Record<string, unknown>
  const keys = ['schema', 'version', 'platform', 'arch', 'file', 'size', 'sha256', 'notes', 'dataCompatible']
  if (Object.keys(manifest).length !== keys.length || Object.keys(manifest).some(key => !keys.includes(key)) ||
    manifest.schema !== 1 || !isCabinetVersion(manifest.version) || manifest.platform !== 'mac' || manifest.arch !== 'arm64' ||
    manifest.file !== `Teahouse-${manifest.version}-mac-arm64.dmg` ||
    typeof manifest.size !== 'number' || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > UPDATE_PACKAGE_MAX_BYTES ||
    typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    typeof manifest.notes !== 'string' || manifest.notes.length > CABINET_NOTES_MAX_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(manifest.notes) || manifest.dataCompatible !== true) {
    throw new Error('invalid-manifest')
  }
  return manifest as unknown as CabinetUpdateManifest
}

/** 配置加载与 IPC 共用格式约束，缺失配置安全退化为未设置来源。 */
export function normalizeCabinetUpdateConfig(value: unknown): CabinetUpdateConfig {
  const fallback: CabinetUpdateConfig = { nodeId: '', directory: '', autoCheck: true }
  if (!value || typeof value !== 'object') return fallback
  const raw = value as Partial<CabinetUpdateConfig>
  // 为最长合法版本的 DMG 文件名预留空间，目录能保存就必须能读取其中的更新文件。
  const fileReserve = '/Teahouse-999999.999999.999999-mac-arm64.dmg'.length
  if (typeof raw.nodeId !== 'string' || raw.nodeId.length > LIMITS.id || /[\s/\\\u0000]/.test(raw.nodeId) ||
    typeof raw.directory !== 'string' || new TextEncoder().encode(raw.directory).length + fileReserve > SHARE_PATH_MAX || /[\\:\u0000-\u001f]/.test(raw.directory) ||
    (raw.directory !== '' && raw.directory.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.length > SHARE_NAME_MAX)) ||
    raw.directory.split('/').length >= SHARE_MAX_DEPTH || typeof raw.autoCheck !== 'boolean') return fallback
  return { nodeId: raw.nodeId, directory: raw.directory, autoCheck: raw.autoCheck }
}
