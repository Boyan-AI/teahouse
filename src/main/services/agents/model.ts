import '@anthropic-ai/sdk/shims/node'
import Anthropic from '@anthropic-ai/sdk'
import nodeFetch, { type RequestInit } from 'node-fetch'
import { agentEndpoint } from '../../../shared/agents'
import type { AgentConfig } from '../../store/agent-store'

export interface ModelTurn { role: 'user' | 'assistant'; content: string }

/** 官方 SDK 只连接显式内网根地址；禁跳转、禁重试、限制响应体和整个请求时长。 */
export async function requestAgent(config: AgentConfig, key: string, turns: ModelTurn[], signal: AbortSignal): Promise<string> {
  const endpoint = agentEndpoint(config.endpoint)
  if (process.env['DEBUG'] === 'true') throw new Error('请关闭 SDK DEBUG 日志后使用 Agent，避免泄露密钥')
  if (!endpoint || !key || signal.aborted) throw new Error('模型配置或请求状态无效')
  const client = new Anthropic({ apiKey: key, authToken: null, baseURL: endpoint, maxRetries: 0, timeout: 60_000,
    fetch: (url, init) => {
      const target = new URL(String(url))
      if (target.origin !== new URL(endpoint).origin || target.href !== endpoint + '/v1/messages') throw new Error('拒绝非配置模型目标')
      return nodeFetch(String(url), { ...init as RequestInit, redirect: 'error', size: 64 * 1024 })
    }
  })
  const deadline = new AbortController()
  const abort = (): void => deadline.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 60_000)
  try {
    const response = await client.messages.create({ model: config.model, system: config.persona, max_tokens: 1024,
      messages: turns.slice(-12).map(turn => ({ role: turn.role, content: turn.content.slice(0, 4096) })) }, { signal: deadline.signal })
    if ((response.stop_reason as string) === 'refusal') throw new Error('模型拒绝了本次请求')
    const text = response.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n').trim()
    if (!text) throw new Error('模型未返回文字内容')
    // 沿用聊天4096字节上限，避免生成成功但无法实际发送；不切断UTF-8字符。
    return Buffer.from(text).subarray(0, 4096).toString('utf8').replace(/\uFFFD$/, '')
  } catch (error) {
    // SDK 错误可能携带服务返回的敏感正文，不透传、不打印。
    if (signal.aborted) throw new Error('请求已取消')
    if (error instanceof Anthropic.APIError && error.status === 401) throw new Error('模型认证失败，请检查密钥')
    throw new Error('内网模型请求失败，请检查地址、模型、证书与服务状态')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
