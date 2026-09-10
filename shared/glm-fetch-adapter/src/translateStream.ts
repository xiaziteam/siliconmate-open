/**
 * GLM Stream Response Translation
 *
 * Translates OpenAI Chat Completions SSE stream and non-streaming responses
 * from GLM API to Anthropic Messages API format.
 *
 * Key translations (streaming):
 * - OpenAI SSE delta.content → Anthropic content_block_start/delta/stop (text)
 * - OpenAI SSE delta.tool_calls → Anthropic content_block_start/delta/stop (tool_use)
 * - finish_reason:stop → stop_reason:end_turn
 * - finish_reason:tool_calls → stop_reason:tool_use
 * - finish_reason:length → stop_reason:max_tokens
 *
 * Key translations (non-streaming):
 * - choices[0].message.content → Anthropic message with text content block
 * - choices[0].message.tool_calls → Anthropic message with tool_use content blocks
 */

// ── SSE helper ──────────────────────────────────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

// ── Streaming translation ───────────────────────────────────────────

/**
 * Translates GLM/OpenAI streaming response to Anthropic format.
 * Converts OpenAI Chat Completions SSE events into Anthropic-compatible streaming events.
 *
 * @param glmResponse - The streaming response from GLM API
 * @param glmModel - The GLM model used for the request
 * @returns Transformed Response object with Anthropic-format stream
 */
export async function translateGlmStreamToAnthropic(
  glmResponse: Response,
  glmModel: string,
): Promise<Response> {
  const messageId = `msg_glm_${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let outputTokens = 0
      let inputTokens = 0

      // Emit Anthropic message_start
      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_start',
            JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: glmModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }),
          ),
        ),
      )

      // Emit ping
      controller.enqueue(
        encoder.encode(
          formatSSE('ping', JSON.stringify({ type: 'ping' })),
        ),
      )

      // Track state for content blocks
      let currentTextBlockStarted = false
      let currentToolCallIndex = -1
      const toolCallStates: Map<number, { id: string; name: string; args: string }> = new Map()
      let hadToolCalls = false

      try {
        const reader = glmResponse.body?.getReader()
        if (!reader) {
          emitTextBlock(controller, encoder, contentBlockIndex, 'Error: No response body')
          finishStream(controller, encoder, outputTokens, inputTokens, false)
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            // Skip SSE event type lines
            if (trimmed.startsWith('event: ')) continue

            // Only process data lines
            if (!trimmed.startsWith('data: ')) continue
            const dataStr = trimmed.slice(6)
            if (dataStr === '[DONE]') continue

            let chunk: Record<string, unknown>
            try {
              chunk = JSON.parse(dataStr)
            } catch {
              continue
            }

            // Extract usage if present
            if (chunk.usage) {
              const usage = chunk.usage as Record<string, number>
              inputTokens = usage.prompt_tokens || inputTokens
              outputTokens = usage.completion_tokens || outputTokens
            }

            const choices = chunk.choices as Array<Record<string, unknown>> | undefined
            if (!choices || choices.length === 0) continue

            const choice = choices[0]
            const delta = choice.delta as Record<string, unknown> | undefined
            const finishReason = choice.finish_reason as string | null

            if (!delta) continue

            // ── Text content deltas ──────────────────────────────
            if (delta.content !== null && delta.content !== undefined && typeof delta.content === 'string') {
              const text = delta.content as string
              if (text.length > 0) {
                if (!currentTextBlockStarted) {
                  // Start new text content block
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_start', JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: { type: 'text', text: '' },
                      })),
                    ),
                  )
                  currentTextBlockStarted = true
                }
                controller.enqueue(
                  encoder.encode(
                    formatSSE('content_block_delta', JSON.stringify({
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: { type: 'text_delta', text },
                    })),
                  ),
                )
                outputTokens += 1
              }
            }

            // ── Tool call deltas ─────────────────────────────────
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                const tcIndex = (tc.index as number) || 0
                const tcId = (tc.id as string) || `toolu_${Date.now()}_${tcIndex}`
                const tcFunction = tc.function as Record<string, unknown> | undefined

                // Initialize tool call state if new
                if (!toolCallStates.has(tcIndex)) {
                  // Close text block if open
                  if (currentTextBlockStarted) {
                    controller.enqueue(
                      encoder.encode(
                        formatSSE('content_block_stop', JSON.stringify({
                          type: 'content_block_stop',
                          index: contentBlockIndex,
                        })),
                      ),
                    )
                    contentBlockIndex++
                    currentTextBlockStarted = false
                  }

                  // Start tool_use content block
                  const name = (tcFunction?.name as string) || ''
                  toolCallStates.set(tcIndex, { id: tcId, name, args: '' })
                  currentToolCallIndex = tcIndex
                  hadToolCalls = true

                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_start', JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: {
                          type: 'tool_use',
                          id: tcId,
                          name,
                          input: {},
                        },
                      })),
                    ),
                  )
                }

                // Handle argument deltas
                const argsDelta = tcFunction?.arguments as string | undefined
                if (argsDelta) {
                  const state = toolCallStates.get(tcIndex)!
                  state.args += argsDelta
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_delta', JSON.stringify({
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: argsDelta,
                        },
                      })),
                    ),
                  )
                }
              }
            }

            // ── Finish reason ────────────────────────────────────
            if (finishReason) {
              // Close text block if open
              if (currentTextBlockStarted) {
                controller.enqueue(
                  encoder.encode(
                    formatSSE('content_block_stop', JSON.stringify({
                      type: 'content_block_stop',
                      index: contentBlockIndex,
                    })),
                  ),
                )
                contentBlockIndex++
                currentTextBlockStarted = false
              }
              // Close tool call blocks
              if (toolCallStates.size > 0) {
                for (const [idx, state] of toolCallStates) {
                  // Only close if we haven't moved past this block already
                  if (idx >= currentToolCallIndex || toolCallStates.size === 1) {
                    controller.enqueue(
                      encoder.encode(
                        formatSSE('content_block_stop', JSON.stringify({
                          type: 'content_block_stop',
                          index: contentBlockIndex,
                        })),
                      ),
                    )
                    contentBlockIndex++
                  }
                }
                toolCallStates.clear()
              }
            }
          }
        }
      } catch (err) {
        // Error during streaming
        if (!currentTextBlockStarted) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_start', JSON.stringify({
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              })),
            ),
          )
          currentTextBlockStarted = true
        }
        controller.enqueue(
          encoder.encode(
            formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: `\n\n[Error: ${String(err)}]` },
            })),
          ),
        )
      }

      // Close any remaining open blocks
      if (currentTextBlockStarted) {
        controller.enqueue(
          encoder.encode(
            formatSSE('content_block_stop', JSON.stringify({
              type: 'content_block_stop',
              index: contentBlockIndex,
            })),
          ),
        )
      }

      finishStream(controller, encoder, outputTokens, inputTokens, hadToolCalls)
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

// ── Non-streaming translation ───────────────────────────────────────

/**
 * Translates a non-streaming GLM/OpenAI response to Anthropic format.
 */
export async function translateGlmResponseToAnthropic(
  glmResponse: Response,
  glmModel: string,
): Promise<Response> {
  const glmBody = await glmResponse.json() as Record<string, unknown>
  const choices = glmBody.choices as Array<Record<string, unknown>> | undefined
  const usage = glmBody.usage as Record<string, number> | undefined

  const messageId = `msg_glm_${Date.now()}`
  const content: Array<Record<string, unknown>> = []
  let stopReason = 'end_turn'

  if (choices && choices.length > 0) {
    const choice = choices[0]
    const message = choice.message as Record<string, unknown>
    const finishReason = choice.finish_reason as string

    // Text content
    if (message?.content && typeof message.content === 'string') {
      content.push({ type: 'text', text: message.content })
    }

    // Tool calls
    if (message?.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
        const func = tc.function as Record<string, unknown>
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse((func?.arguments as string) || '{}')
        } catch { /* keep empty */ }
        content.push({
          type: 'tool_use',
          id: tc.id || `toolu_${Date.now()}`,
          name: func?.name || '',
          input,
        })
      }
      stopReason = 'tool_use'
    }

    // Map finish reason
    if (finishReason === 'length') stopReason = 'max_tokens'
    else if (finishReason === 'tool_calls' || finishReason === 'function_call') stopReason = 'tool_use'
  }

  const anthropicResponse = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    model: glmModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  }

  return new Response(JSON.stringify(anthropicResponse), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Helpers ─────────────────────────────────────────────────────────

function emitTextBlock(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  index: number,
  text: string,
) {
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_delta', JSON.stringify({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index,
      })),
    ),
  )
}

function finishStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  outputTokens: number,
  inputTokens: number,
  hadToolCalls: boolean,
) {
  const stopReason = hadToolCalls ? 'tool_use' : 'end_turn'

  controller.enqueue(
    encoder.encode(
      formatSSE(
        'message_delta',
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }),
      ),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE(
        'message_stop',
        JSON.stringify({
          type: 'message_stop',
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
      ),
    ),
  )
  controller.close()
}
