/**
 * GLM Fetch Adapter - Integration Test
 *
 * Manual test: Run with `npx tsx src/test.ts`
 * Requires GLM_API_KEY environment variable.
 *
 * Tests:
 * 1. Non-streaming request: simple text prompt
 * 2. Streaming request: simple text prompt with SSE
 * 3. Tool use: request with tool definitions
 */

import { createGlmFetch } from './index.js'

const API_KEY = process.env.GLM_API_KEY || '<YOUR_GLM_API_KEY>'
const BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

async function testNonStreaming() {
  console.log('\n=== Test 1: Non-streaming request ===')

  const glmFetch = createGlmFetch({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    defaultModel: 'glm-4-flash',
    stream: false,
  })

  try {
    const response = await glmFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        stream: false,
        messages: [
          { role: 'user', content: '说一句话证明你是AI，不超过20个字' },
        ],
      }),
    })

    const data = await response.json()
    console.log('Status:', response.status)
    console.log('Response:', JSON.stringify(data, null, 2))

    if (data.type === 'message' && data.content?.[0]?.text) {
      console.log('✅ Non-streaming test PASSED')
    } else if (data.type === 'error') {
      console.log('❌ Non-streaming test FAILED:', data.error?.message)
    } else {
      console.log('⚠️  Non-streaming test UNCLEAR')
    }
  } catch (err) {
    console.log('❌ Non-streaming test ERROR:', err)
  }
}

async function testStreaming() {
  console.log('\n=== Test 2: Streaming request ===')

  const glmFetch = createGlmFetch({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    defaultModel: 'glm-4-flash',
  })

  try {
    const response = await glmFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        stream: true,
        messages: [
          { role: 'user', content: '用一句话描述春天' },
        ],
      }),
    })

    console.log('Status:', response.status)
    console.log('Content-Type:', response.headers.get('content-type'))

    if (!response.body) {
      console.log('❌ No response body')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let eventCount = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          // console.log('Event:', line.slice(7))
        } else if (line.startsWith('data: ')) {
          const dataStr = line.slice(6)
          try {
            const data = JSON.parse(dataStr)
            if (data.type === 'content_block_delta' && data.delta?.text) {
              fullText += data.delta.text
            }
            eventCount++
          } catch { /* skip */ }
        }
      }
    }

    console.log('Total events:', eventCount)
    console.log('Full text:', fullText)
    if (fullText.length > 0) {
      console.log('✅ Streaming test PASSED')
    } else {
      console.log('❌ Streaming test FAILED: no text content')
    }
  } catch (err) {
    console.log('❌ Streaming test ERROR:', err)
  }
}

async function testWithTools() {
  console.log('\n=== Test 3: Tool use request ===')

  const glmFetch = createGlmFetch({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    defaultModel: 'glm-4-flash',
  })

  try {
    const response = await glmFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 200,
        stream: false,
        messages: [
          { role: 'user', content: '北京今天天气怎么样？请调用get_weather工具查询' },
        ],
        tools: [
          {
            name: 'get_weather',
            description: '获取指定城市的天气信息',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string', description: '城市名称' },
              },
              required: ['city'],
            },
          },
        ],
      }),
    })

    const data = await response.json()
    console.log('Response:', JSON.stringify(data, null, 2))

    if (data.content) {
      const hasToolUse = data.content.some((b: any) => b.type === 'tool_use')
      const hasText = data.content.some((b: any) => b.type === 'text')
      if (hasToolUse) {
        console.log('✅ Tool use test PASSED (model called tool)')
      } else if (hasText) {
        console.log('⚠️  Tool use test: model responded with text instead of calling tool (may be normal)')
      }
    } else {
      console.log('❌ Tool use test FAILED: no content')
    }
  } catch (err) {
    console.log('❌ Tool use test ERROR:', err)
  }
}

// Run all tests
async function main() {
  console.log('GLM Fetch Adapter Integration Test')
  console.log('===================================')
  console.log('API Key:', API_KEY.slice(0, 10) + '...')
  console.log('Base URL:', BASE_URL)

  await testNonStreaming()
  await testStreaming()
  await testWithTools()

  console.log('\n=== All tests complete ===')
}

main().catch(console.error)
