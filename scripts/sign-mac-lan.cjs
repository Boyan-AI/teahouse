// 内网测试包专用钩子：补齐完整临时签名，不使用个人证书或声称已公证。
const { join } = require('node:path')
const { signAsync } = require('@electron/osx-sign')
const entitlements = require.resolve('app-builder-lib/templates/entitlements.mac.plist')

/** 在打包完成、生成DMG前由官方库按内外顺序签名；失败直接阻断产物构建。 */
async function signMacLan(context, sign = signAsync) {
  if (context.electronPlatformName !== 'darwin') throw new Error('内网临时签名仅支持 macOS')
  const app = join(context.appOutDir, context.packager.appInfo.productFilename + '.app')
  await sign({
    app,
    identity: '-',
    identityValidation: false,
    platform: 'darwin',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // 保留库默认的 --strict；显式 true 在旧库中会变成无效的 --strict=true。
    // 使用打包器既有Electron权限模板：保留hardened runtime，允许加载临时签名框架和SQLite。
    // 此权限仅作用于本应用，不改变macOS系统保护；不使用库默认的摄像头/定位等额外权限。
    optionsForFile: () => ({ timestamp: 'none', entitlements })
  })
}
module.exports = signMacLan
