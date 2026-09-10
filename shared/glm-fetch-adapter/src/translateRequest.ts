/**
 * GLM Request Translation
 *
 * Translates Anthropic Messages API request format to
 * OpenAI Chat Completions API format (GLM-compatible).
 *
 * Key translations:
 * - messages[{role:system}] → standalone `system` parameter
 * - content_blocks[{type:text}] → `content` string or array
 * - content_blocks[{type:tool_use}] → tool_calls[{type:"function",function:{name,arguments}}]
 * - content_blocks[{type:tool_result}] → role:"tool", tool_call_id
 * - tools[].input_schema → tools[].function.parameters
 * - thinking blocks → discarded (GLM doesn't support extended thinking)
 */

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: {
    type?: string
    media_type?: string
    data?: string
    [key: string]: unknown
  }
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

// ── Tool translation: Anthropic → OpenAI ────────────────────────────

/**
 * Translates Anthropic tool definitions to OpenAI function format.
 * Anthropic: { name, description, input_schema }
 * OpenAI:    { type: "function", function: { name, description, parameters } }
 */
export function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

// ── Message translation: Anthropic → OpenAI ─────────────────────────

/**
 * Translates Anthropic message format to OpenAI Chat Completions format.
 *
 * Key differences:
 * - Anthropic uses content_blocks (array), OpenAI uses content (string or array)
 * - Anthropic tool_use → OpenAI tool_calls on assistant message
 * - Anthropic tool_result → OpenAI role:"tool" message with tool_call_id
 * - Anthropic system messages → standalone system parameter (extracted separately)
 */
export function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const openaiMessages: Array<Record<string, unknown>> = []
  let toolCallCounter = 0

  for (const msg of anthropicMessages) {
    // Skip system messages (handled separately as system parameter)
    if (msg.role === 'system') continue

    // String content - simple case
    if (typeof msg.content === 'string') {
      openaiMessages.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      // User messages: handle tool_result and text
      const textParts: string[] = []
      const toolResults: Array<Record<string, unknown>> = []

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // Anthropic tool_result → OpenAI role:"tool" message
          const toolCallId = block.tool_use_id || `call_${toolCallCounter++}`
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text') return c.text || ''
                if (c.type === 'image') return '[Image data]'
                return ''
              })
              .join('\n')
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: outputText,
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'image' && block.source?.type === 'base64') {
          // Image content: GLM supports multimodal via content array
          textParts.push(`[Image: ${block.source.media_type || 'image/png'}, base64 data]`)
        }
      }

      // Add text message if any
      if (textParts.length > 0) {
        openaiMessages.push({ role: 'user', content: textParts.join('\n') })
      }
      // Add tool results
      openaiMessages.push(...toolResults)

    } else if (msg.role === 'assistant') {
      // Assistant messages: handle text and tool_use
      const textParts: string[] = []
      const toolCalls: Array<Record<string, unknown>> = []

      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          // Anthropic tool_use → OpenAI tool_calls
          const callId = block.id || `call_${toolCallCounter++}`
          toolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: typeof block.input === 'object'
                ? JSON.stringify(block.input)
                : '{}',
            },
          })
        } else if (block.type === 'thinking') {
          // Discard thinking blocks - GLM doesn't support extended thinking
          // Silently skip
        }
      }

      // Build assistant message
      const assistantMsg: Record<string, unknown> = { role: 'assistant' }
      if (textParts.length > 0) {
        assistantMsg.content = textParts.join('\n')
      } else {
        // OpenAI requires content even if null when tool_calls present
        assistantMsg.content = toolCalls.length > 0 ? null : ''
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      openaiMessages.push(assistantMsg)
    }
  }

  return openaiMessages
}

// ── Full request translation ────────────────────────────────────────

/**
 * Translates a complete Anthropic API request body to GLM/OpenAI format.
 *
 * @param anthropicBody - The Anthropic request body
 * @param defaultModel - Default GLM model to use if not specified
 * @returns Object containing the translated GLM body and model name
 */
export function translateToGlmBody(
  anthropicBody: Record<string, unknown>,
  defaultModel: string = 'glm-4-flash',
): { glmBody: Record<string, unknown>; glmModel: string } {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const claudeModel = anthropicBody.model as string
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]
  const stream = anthropicBody.stream !== false // default true

  // Map model
  let glmModel = defaultModel
  if (claudeModel) {
    if (claudeModel.toLowerCase().startsWith('glm-')) {
      glmModel = claudeModel
    } else {
      // Map Claude model names to GLM
      const lower = claudeModel.toLowerCase()
      if (lower.includes('opus')) glmModel = 'glm-4-plus'
      else if (lower.includes('sonnet')) glmModel = 'glm-4-flash'
      else if (lower.includes('haiku')) glmModel = 'glm-4-flash'
    }
  }

  // Build system prompt
  let system = ''
  if (systemPrompt) {
    system =
      typeof systemPrompt === 'string'
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text!)
              .join('\n')
          : ''
  }

  // Translate messages
  const messages = translateMessages(anthropicMessages)

  // Build GLM body
  const glmBody: Record<string, unknown> = {
    model: glmModel,
    messages,
    stream,
  }

  // Add system as first message if present (OpenAI convention)
  if (system) {
    const msgs = glmBody.messages as Array<Record<string, unknown>>
    // Prepend system message
    msgs.unshift({ role: 'system', content: system })
  }

  // Add tools if present
  if (anthropicTools.length > 0) {
    glmBody.tools = translateTools(anthropicTools)
    glmBody.tool_choice = 'auto'
  }

  // Map Anthropic-specific parameters
  if (anthropicBody.max_tokens && typeof anthropicBody.max_tokens === 'number') {
    glmBody.max_tokens = anthropicBody.max_tokens
  }
  if (anthropicBody.temperature !== undefined) {
    glmBody.temperature = anthropicBody.temperature
  }
  if (anthropicBody.top_p !== undefined) {
    glmBody.top_p = anthropicBody.top_p
  }
  if (anthropicBody.stop_sequences) {
    glmBody.stop = anthropicBody.stop_sequences
  }

  return { glmBody, glmModel }
}
