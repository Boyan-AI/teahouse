// macOS 安装助手原生验收，所有应用、日志和数据均位于项目 out 隔离目录。
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const execute = promisify(execFile)
const repo = path.resolve(__dirname, '..')
const helper = path.join(repo, 'scripts/macos-update-helper.sh')

/** 让启动助手的父进程退出，验证助手脱离父进程后仍能完成替换。 */
async function launchParent() {
  const [target, transaction, token] = process.argv.slice(3)
  if (process.env.PANTRY_INSTALLER_FIXTURE) {
    await require(process.env.PANTRY_INSTALLER_FIXTURE).launchMacInstall({ target, directory: transaction, token })
    return
  }
  const child = spawn('/bin/sh', [helper, target, transaction, String(process.pid), token, '5', '10'], {
    detached: true, stdio: 'ignore', cwd: transaction
  })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('spawn', () => child.unref())
}

/** 轮询明确事务状态，超时视为失败。 */
async function untilStatus(directory, expected) {
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    const status = await fs.readFile(path.join(directory, 'status'), 'utf8').catch(() => '')
    if (status.trim() === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`安装助手未达到 ${expected}，目录 ${directory}`)
}

/** 构造真实 ad-hoc 签名的最小 Mach-O 应用，失败夹具直接退出，不启动真实茶话间。 */
async function makeBundle(directory, source, version) {
  await fs.mkdir(path.join(directory, 'Contents/MacOS'), { recursive: true })
  const plist = { CFBundleIdentifier: 'com.pantry.app', CFBundleName: 'Teahouse', CFBundleExecutable: 'Teahouse',
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: version }
  await fs.writeFile(path.join(directory, 'Contents/Info.plist'), JSON.stringify(plist))
  await execute('/usr/bin/plutil', ['-convert', 'xml1', path.join(directory, 'Contents/Info.plist')])
  const sdk = process.env.SDKROOT ? ['-isysroot', process.env.SDKROOT] : []
  await execute('/usr/bin/clang', [...sdk, source, '-o', path.join(directory, 'Contents/MacOS/Teahouse')])
  await execute('/usr/bin/codesign', ['--sign', '-', '--timestamp=none', directory])
}

/** 覆盖成功、父进程仍存活、签名损坏、启动失败与恢复，保留证据供复查。 */
async function run() {
  assert.equal(process.platform, 'darwin', '仅在 macOS 执行原生安装验收')
  const output = await fs.mkdtemp(path.join(repo, 'out/macos-update-'))
  const good = path.join(output, 'good.c'), bad = path.join(output, 'bad.c')
  await fs.writeFile(good, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
/* 测试应用使用真实可执行路径构造助手握手，模拟生产启动完成。 */
int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--cabinet-update-token") != 0) return 0;
  char binary[PATH_MAX], ready[PATH_MAX], pidfile[PATH_MAX]; uint32_t size = sizeof(binary);
  if (_NSGetExecutablePath(binary, &size) != 0) return 2;
  char *parent = dirname(dirname(dirname(dirname(binary))));
  snprintf(ready, sizeof(ready), "%s/.teahouse-update-%s/ready", parent, argv[2]);
  snprintf(pidfile, sizeof(pidfile), "%s/.teahouse-update-%s/test.pid", parent, argv[2]);
  FILE *pid = fopen(pidfile, "w"); if (!pid) return 3;
  fprintf(pid, "%d", getpid()); fclose(pid);
  FILE *file = fopen(ready, "wx"); if (!file) return 4;
  fputs(argv[2], file); fclose(file); sleep(15); return 0;
}
`)
  await fs.writeFile(bad, '/* 故意模拟无法启动的新版本。 */\nint main(void) { return 1; }\n')
  const goodBundle = path.join(output, 'Good.app'), badBundle = path.join(output, 'Bad.app')
  await makeBundle(goodBundle, good, '0.66.0')
  await makeBundle(badBundle, bad, '0.65.0')
  for (const scenario of ['success', 'parent-running', 'invalid-signature', 'permission-denied', 'rolled-back']) {
    const directory = path.join(output, scenario)
    await fs.mkdir(directory)
    const target = path.join(directory, 'Teahouse.app'), token = randomUUID()
    const transaction = path.join(directory, '.teahouse-update-' + token)
    await fs.mkdir(transaction, { mode: 0o700 })
    await execute('/usr/bin/ditto', [badBundle, target])
    await execute('/usr/bin/ditto', [scenario === 'rolled-back' ? badBundle : goodBundle, path.join(transaction, 'next.app')])
    if (scenario === 'invalid-signature') await fs.appendFile(path.join(transaction, 'next.app/Contents/Info.plist'), 'tampered')
    if (scenario === 'permission-denied') await fs.chmod(directory, 0o500)
    if (scenario === 'parent-running') {
      await execute('/bin/sh', [helper, target, transaction, String(process.pid), token, '1', '3']).catch(error => assert.equal(error.code, 11))
    } else await execute(process.execPath, [__filename, '--parent', target, transaction, token])
    await untilStatus(transaction, scenario === 'success' ? 'completed' : scenario)
    if (scenario === 'permission-denied') await fs.chmod(directory, 0o700)
    const result = await execute('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(target, 'Contents/Info.plist')])
    assert.equal(result.stdout.trim(), scenario === 'success' ? '0.66.0' : '0.65.0')
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
    if (scenario === 'success') {
      const pid = Number(await fs.readFile(path.join(transaction, 'test.pid'), 'utf8'))
      process.kill(pid, 'SIGTERM')
      assert((await fs.stat(path.join(transaction, 'previous.app'))).isDirectory())
    }
    console.log('PASS', scenario)
  }
  if (process.env.PANTRY_UPDATE_DMG && process.env.PANTRY_UPDATE_BASE_APP) {
    await verifyPackagedUpdate(output)
  }
  console.log('MACOS_UPDATE_SELFTEST_OK', output)
}

/** 使用实际签名 Electron 包验证生产准备函数、同卷替换与新应用启动握手。 */
async function verifyPackagedUpdate(output, options = {}) {
  const base = path.resolve(options.base || process.env.PANTRY_UPDATE_BASE_APP)
  const dmg = path.resolve(options.dmg || process.env.PANTRY_UPDATE_DMG)
  assert(base.startsWith(repo + path.sep) && dmg.startsWith(repo + path.sep), '安装夹具必须来自本项目')
  const version = /^Teahouse-(\d+\.\d+\.\d+)-mac-arm64\.dmg$/.exec(path.basename(dmg))?.[1]
  assert(version)
  const fixture = path.join(output, 'installer.cjs')
  require('esbuild').buildSync({ entryPoints: [path.join(repo, 'src/main/services/macos-updater.ts')], bundle: true,
    platform: 'node', target: 'node16', outfile: fixture, logLevel: 'silent' })
  const installer = require(fixture)
  const directory = path.join(output, 'electron'), target = path.join(directory, 'Teahouse.app')
  await fs.mkdir(directory)
  await execute('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', '--qtn', base, target])
  const transaction = await installer.prepareMacInstall({ executable: path.join(target, 'Contents/MacOS/Teahouse'),
    dmg, cache: output, version, arch: 'arm64', helper })
  const resources = path.join(transaction.directory, 'next.app/Contents/Resources')
  assert.equal(await fs.readFile(path.join(resources, 'macos-update-helper.sh'), 'utf8'), await fs.readFile(helper, 'utf8'))
  const asar = require('@electron/asar')
  const entries = asar.listPackage(path.join(resources, 'app.asar'))
  assert(!entries.some(entry => /\/\.agent\/|\/out\/.*selftest|\.db$|\.env$/.test(entry)), '打包产物不得包含本地数据/测试脚本')
  await execute(process.execPath, [__filename, '--parent', transaction.target, transaction.directory, transaction.token], {
    env: { ...process.env, PANTRY_INSTALLER_FIXTURE: fixture, PANTRY_SMOKE: '1', PANTRY_USER_DATA: path.join(output, 'receiver-data'),
      PANTRY_UDP_PORT: '39871', PANTRY_TCP_PORT: '39872', PANTRY_PEERS: '' }
  })
  await untilStatus(transaction.directory, 'completed')
  await installer.verifyMacBundle(target, version, 'arm64')
  assert.equal((await fs.readFile(path.join(transaction.directory, 'ready'), 'utf8')).trim(), transaction.token)
  assert((await fs.stat(path.join(output, 'receiver-data/config.json'))).isFile())
  console.log('PASS actual Electron package preparation, replacement, renderer startup and isolated data')
}

module.exports = { verifyPackagedUpdate }
if (require.main === module) {
  if (process.argv[2] === '--parent') launchParent().catch(error => { console.error(error); process.exitCode = 1 })
  else run().catch(error => { console.error(error); process.exitCode = 1 })
}
