// 使用官方编程 API，避开旧 CLI 的 yargs 无扩展名入口与新版 Node 的 ESM 冲突。
const { rebuild } = require('@electron/rebuild')
const path = require('node:path')
const manifest = require('../package.json')

/** 只重建唯一原生依赖，目标始终取项目固定 Electron 版本，不取开发机 Node ABI。 */
async function rebuildElectron({ args = process.argv.slice(2), env = process.env, rebuildImpl = rebuild } = {}) {
  if (args.some(arg => arg !== '--force')) throw new Error('仅支持 --force 参数')
  await rebuildImpl({
    buildPath: path.resolve(__dirname, '..'),
    electronVersion: manifest.devDependencies.electron,
    onlyModules: ['better-sqlite3'],
    force: args.includes('--force'),
    buildFromSource: env.npm_config_build_from_source === 'true',
    arch: env.npm_config_arch || process.arch
  })
}

// 被测试导入时不启动重建，不下载文件或改动任何原生模块。
if (require.main === module) {
  rebuildElectron().catch(error => {
    console.error('[rebuild:electron]', error instanceof Error ? error.message : '原生模块重建失败')
    process.exitCode = 1
  })
}
module.exports = { rebuildElectron }
