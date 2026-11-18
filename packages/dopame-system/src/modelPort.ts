import type { DocumentRef } from '../../dopame/src/domain/collaboration'

export type WritingPurpose = 'polish' | 'continue' | 'summarize'

export interface ApprovedGenerationInput {
  generationId: string
  purpose: WritingPurpose
  document: DocumentRef
  range: { start: number; end: number }
  excerpt: string
  modelId: string
  instruction?: string
}

export type GenerationEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }

/**
 * Adapter boundary for the platform model gateway (SP-04).
 * Until SP-04 is verified on the target system, no endpoint or credential is guessed.
 */
export interface SystemModelPort {
  availability(): Promise<{ available: boolean; reason?: string; models?: string[] }>
  availabilitySync?(): { available: boolean; reason?: string; models?: string[] }
  generate(input: ApprovedGenerationInput, signal: AbortSignal): AsyncIterable<GenerationEvent>
}

export function buildWritingMessages(input: ApprovedGenerationInput): Array<{ role: 'system' | 'user'; content: string }> {
  const systemPrompts: Record<WritingPurpose, string> = {
    polish: '你是一个专业的 Markdown 写作润色助手。请仅对用户提供的选区文本进行润色，保持原有的 Markdown 结构与核心事实，直接输出润色后的 Markdown 文本，不要包含多余解释。',
    continue: '你是一个专业的 Markdown 写作续写助手。请根据用户提供的上下文紧接着向后续写，保持风格与 Markdown 格式一致，直接输出新增的续写段落，不要重复原文。',
    summarize: '你是一个专业的文档总结助手。请对用户提供的 Markdown 文本生成简明扼要的只读摘要，不要修改原文。',
  }
  const userContent = input.instruction?.trim()
    ? `【补充指令】\n${input.instruction.trim()}\n\n【待处理文本】\n${input.excerpt}`
    : input.excerpt
  return [
    { role: 'system', content: systemPrompts[input.purpose] },
    { role: 'user', content: userContent },
  ]
}

function extractTextFromJsonPayload(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const record = data as {
    text?: unknown
    response?: unknown
    message?: { content?: unknown }
    content?: Array<{ text?: unknown }>
    choices?: Array<{
      text?: unknown
      message?: { content?: unknown }
      delta?: { content?: unknown }
    }>
  }
  if (typeof record.text === 'string') return record.text
  if (typeof record.response === 'string') return record.response
  const choice = record.choices?.[0]
  if (choice) {
    if (typeof choice.delta?.content === 'string') return choice.delta.content
    if (typeof choice.message?.content === 'string') return choice.message.content
    if (typeof choice.text === 'string') return choice.text
  }
  if (typeof record.message?.content === 'string') return record.message.content
  if (Array.isArray(record.content) && typeof record.content[0]?.text === 'string') {
    return record.content[0].text
  }
  return ''
}

export function createEnvModelPort(env: Record<string, string | undefined> = process.env): SystemModelPort {
  const rawModels = env.MARKTEXT_MODEL_ID?.trim() ?? ''
  const models = rawModels.split(',').map(s => s.trim()).filter(Boolean)
  const endpoint = env.MARKTEXT_MODEL_ENDPOINT?.trim()
  const apiKey = env.MARKTEXT_MODEL_TOKEN?.trim()
  const requestStream = env.MARKTEXT_MODEL_STREAM !== 'false'

  function status() {
    if (!models.length || !endpoint) {
      return {
        available: false,
        reason: 'The system model contract has not been verified.',
      }
    }
    return {
      available: true,
      models,
    }
  }

  return {
    availabilitySync: () => status(),
    availability: async () => status(),
    async *generate(input: ApprovedGenerationInput, signal: AbortSignal): AsyncIterable<GenerationEvent> {
      const current = status()
      if (!current.available || !endpoint) {
        throw new Error(current.reason ?? 'System model gateway is not configured.')
      }
      if (endpoint === 'local-adapter') {
        const chunks = input.purpose === 'summarize'
          ? ['【摘要】', `${input.excerpt.trim().slice(0, 120)}`]
          : input.purpose === 'continue'
            ? ['\n', `${input.excerpt.trim()}（续写段落）\n`]
            : [`${input.excerpt.trim()}`]
        let full = ''
        for (const chunk of chunks) {
          if (signal.aborted) return
          await new Promise(resolve => setTimeout(resolve, 5))
          if (signal.aborted) return
          full += chunk
          yield { type: 'delta', text: chunk }
        }
        yield { type: 'done', text: full }
        return
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.modelId,
          messages: buildWritingMessages(input),
          stream: requestStream,
          purpose: input.purpose,
          excerpt: input.excerpt,
          ...(input.instruction ? { instruction: input.instruction } : {}),
        }),
        signal,
      })
      if (!response.ok) {
        throw new Error(`System model gateway returned HTTP ${response.status}.`)
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream') && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let full = ''
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ''
            for (const rawLine of lines) {
              const line = rawLine.trim()
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (!payload || payload === '[DONE]') continue
              try {
                const parsed = JSON.parse(payload)
                const delta = extractTextFromJsonPayload(parsed)
                if (delta) {
                  full += delta
                  yield { type: 'delta', text: delta }
                }
              } catch { /* ignore non-JSON keepalive comments */ }
            }
          }
        } finally {
          reader.releaseLock()
        }
        if (signal.aborted) return
        if (!full) throw new Error('System model gateway stream returned an empty response.')
        yield { type: 'done', text: full }
        return
      }

      const data: unknown = await response.json()
      const text = extractTextFromJsonPayload(data)
      if (!text) throw new Error('System model gateway returned an empty response.')
      yield { type: 'delta', text }
      yield { type: 'done', text }
    },
  }
}
