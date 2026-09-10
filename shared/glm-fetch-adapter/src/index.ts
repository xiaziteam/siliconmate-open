/**
 * GLM Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to
 * GLM (智谱) OpenAI-compatible API, translating between Anthropic
 * Messages API format and OpenAI Chat Completions API format.
 *
 * Supports:
 * - Text messages (user/assistant/system)
 * - System prompts → standalone `system` parameter
 * - Tool definitions (Anthropic input_schema → OpenAI function.parameters)
 * - Tool use (tool_use → function_call, tool_result → role:tool)
 * - Streaming events translation (OpenAI SSE → Anthropic SSE)
 * - Non-streaming response translation
 *
 * Reference: /tmp/free-code/src/services/api/codex-fetch-adapter.ts
 */

import { translateToGlmBody } from './translateRequest.js'
import { translateGlmStreamToAnthropic, translateGlmResponseToAnthropic } from './translateStream.js'

// ── Configuration ───────────────────────────────────────────────────

export interface GlmAdapterConfig {
  /** GLM API key (e.g. from open.bigmodel.cn) */
  apiKey: string
  /** GLM API base URL (default: https://open.bigmodel.cn/api/paas/v4) */
  baseUrl?: string
  /** Default GLM model (default: glm-4-flash) */
  defaultModel?: string
  /** Whether to stream by default (default: true) */
  stream?: boolean
}

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEFAULT_MODEL = 'glm-4-flash'

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

// ── Model mapping ───────────────────────────────────────────────────

/**
 * Maps Claude model names to GLM model names.
 * If the model already looks like a GLM model, pass through.
 */
export function mapClaudeModelToGlm(claudeModel: string | null | undefined): string {
  if (!claudeModel) return DEFAULT_MODEL
  const lower = claudeModel.toLowerCase()
  // Pass through known GLM models
  if (lower.startsWith('glm-')) return claudeModel
  // Map Claude model tiers to GLM equivalents
  if (lower.includes('opus')) return 'glm-4-plus'
  if (lower.includes('sonnet')) return 'glm-4-flash'
  if (lower.includes('haiku')) return 'glm-4-flash'
  return DEFAULT_MODEL
}

// ── Main fetch interceptor ──────────────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them to GLM.
 *
 * Usage in free-code settings.json:
 * ```json
 * {
 *   "customFetch": "require('/path/to/glm-fetch-adapter').createGlmFetch({...})"
 * }
 * ```
 *
 * @param config - GLM adapter configuration
 * @returns A fetch function that translates Anthropic requests to GLM format
 */
export function createGlmFetch(
  config: GlmAdapterConfig,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL
  const defaultModel = config.defaultModel || DEFAULT_MODEL

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept Anthropic API message calls
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    // Parse the Anthropic request body
    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    // Translate to GLM/OpenAI format
    const { glmBody, glmModel } = translateToGlmBody(anthropicBody, defaultModel)

    // Determine if streaming
    const isStreaming = glmBody.stream === true

    // Call GLM API
    const glmEndpoint = `${baseUrl}/chat/completions`
    const glmResponse = await globalThis.fetch(glmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(glmBody),
    })

    if (!glmResponse.ok) {
      const errorText = await glmResponse.text()
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `GLM API error (${glmResponse.status}): ${errorText}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: glmResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Translate response
    if (isStreaming) {
      return translateGlmStreamToAnthropic(glmResponse, glmModel)
    } else {
      return translateGlmResponseToAnthropic(glmResponse, glmModel)
    }
  }
}

// ── Convenience exports ─────────────────────────────────────────────

export { translateToGlmBody } from './translateRequest.js'
export { translateGlmStreamToAnthropic, translateGlmResponseToAnthropic } from './translateStream.js'
