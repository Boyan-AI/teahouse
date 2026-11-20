import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestAgent } from './model'
import { agentEndpoint, isAgentInput } from '../../../shared/agents'
import type { AgentConfig } from '../../store/agent-store'
const servers: Server[] = []
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })
/** 模型测试仅绑定回环地址，不会请求真实服务或消耗密钥额度。 */
async function mock(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<AgentConfig> {
  const server = createServer(handler); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test bind failed')
  return { id: 'test', name: '测试助手', persona: '只回答工作问题', model: 'local-dsh', endpoint: 'http://127.0.0.1:' + address.port, enabled: true, encryptedKey: '' }
}
/** 本地模拟返回标准 Anthropic Messages 文字响应。 */
function reply(res: ServerResponse, text: string): void { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'msg_local', type: 'message', role: 'assistant', model: 'local-dsh', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })) }

describe('内网 Anthropic 兼容服务', () => {
  it('显式模型、密钥、人设和路径正确，不依赖全局fetch', async () => {
    let actual: unknown, path = '', key: string | undefined, auth: string | undefined
    const config = await mock((req, res) => {
      path = req.url ?? ''; key = req.headers['x-api-key'] as string; auth = req.headers.authorization
      let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => { actual = JSON.parse(body); reply(res, '你好') })
    })
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-use'); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'must-not-use')
    expect(await requestAgent(config, 'local-test-key', [{ role: 'user', content: '问题' }], new AbortController().signal)).toBe('你好')
    expect(path).toBe('/v1/messages'); expect(key).toBe('local-test-key'); expect(auth).toBeUndefined()
    expect(actual).toMatchObject({ model: 'local-dsh', system: config.persona, max_tokens: 1024, messages: [{ role: 'user', content: '问题' }] })
  })
  it('拒绝重定向，不把服务错误正文和密钥转发出去', async () => {
    const config = await mock((_req, res) => { res.writeHead(302, { location: 'https://example.invalid/steal' }); res.end() })
    await expect(requestAgent(config, 'secret', [{ role: 'user', content: 'x' }], new AbortController().signal)).rejects.toThrow('内网模型请求失败')
    const bad = await mock((_req, res) => { res.writeHead(401); res.end('secret-server-body') })
    await expect(requestAgent(bad, 'secret', [{ role: 'user', content: 'x' }], new AbortController().signal)).rejects.toThrow('模型认证失败')
  })
  it('限制响应体，并能取消正在等待的请求', async () => {
    const large = await mock((_req, res) => reply(res, 'x'.repeat(70_000)))
    await expect(requestAgent(large, 'secret', [{ role: 'user', content: 'x' }], new AbortController().signal)).rejects.toThrow('内网模型请求失败')
    const slow = await mock((_req, res) => { res.on('close', () => res.destroy()) })
    const controller = new AbortController()
    const result = requestAgent(slow, 'secret', [{ role: 'user', content: 'x' }], controller.signal)
    controller.abort()
    await expect(result).rejects.toThrow('请求已取消')
  })
  it('响应头已返回但响应体挂起时仍受60秒总截止时间约束', async () => {
    let headers!: () => void
    const received = new Promise<void>(resolve => { headers = resolve })
    const config = await mock((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); headers() })
    vi.useFakeTimers()
    const result = requestAgent(config, 'secret', [{ role: 'user', content: 'x' }], new AbortController().signal)
    const rejection = expect(result).rejects.toThrow('内网模型请求失败')
    await received
    await vi.advanceTimersByTimeAsync(60_001)
    await rejection
    vi.useRealTimers()
  })
  it('UTF8文字按聊天字节限额返回，DEBUG启用时拒绝泄密日志', async () => {
    const config = await mock((_req, res) => reply(res, '中'.repeat(2000)))
    const result = await requestAgent(config, 'secret', [{ role: 'user', content: 'x' }], new AbortController().signal)
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(4096); expect(result).not.toContain('�')
    vi.stubEnv('DEBUG', 'true')
    await expect(requestAgent(config, 'secret', [], new AbortController().signal)).rejects.toThrow('DEBUG')
  })
  it('拒绝公网、域名、URL凭证、歧义IP和重复API路径', () => {
    for (const url of ['https://8.8.8.8', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://0177.0.0.1', 'http://u:p@127.0.0.1', 'http://127.0.0.1/v1/messages', 'http://127.0.0.1?a=1', 'file:///tmp/x', 'http://169.254.169.254']) expect(agentEndpoint(url)).toBeNull()
    for (const url of ['http://10.0.0.1:8000', 'http://172.16.1.1/prefix', 'https://192.168.0.2', 'http://127.0.0.1']) expect(agentEndpoint(url)).not.toBeNull()
    expect(isAgentInput({ name: 'a', persona: '', model: 'm', enabled: true, endpoint: 'http://127.0.0.1', apiKey: 'key\nInjected: bad' })).toBe(false)
  })
  it('官方 SDK 同条请求携带 base64 图片与说明，不发送远程 URL', async () => {
    let actual: unknown
    const config = await mock((req,res) => {
      let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{actual=JSON.parse(body);reply(res,'图像已收到')})
    })
    const image={type:'image' as const,source:{type:'base64' as const,media_type:'image/png' as const,data:'cG5n'}}
    expect(await requestAgent(config,'secret',[{role:'user',content:'说明和引用',images:[image]}],new AbortController().signal)).toBe('图像已收到')
    expect(actual).toMatchObject({messages:[{role:'user',content:[image,{type:'text',text:'说明和引用'}]}]})
  })
  it.each([400,413,422])('视觉接口拒绝 %i 时明确提示且不泄露模型正文', async status => {
    const config=await mock((_req,res)=>{res.writeHead(status);res.end('secret-private-model-error')})
    await expect(requestAgent(config,'secret',[{role:'user',content:'识图',images:[{type:'image',source:{type:'base64',media_type:'image/png',data:'cG5n'}}]}],new AbortController().signal)).rejects.toThrow('模型无法处理图片，请检查视觉能力、图片格式与服务限制')
  })

})
