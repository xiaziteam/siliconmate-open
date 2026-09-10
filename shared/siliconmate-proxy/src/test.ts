/**
 * SiliconMate MCP Proxy - Integration Test
 *
 * Tests the MCP Proxy Server by:
 * 1. Starting the proxy server
 * 2. Verifying tool listing
 * 3. Testing tool calls (requires server Agent running)
 *
 * Run: node dist/test.mjs
 *
 * Note: Tool call tests require the server free-code Server to be running.
 * Tool listing tests work offline.
 */

// Simple test: verify tools are properly defined
import { TOOLS, handleToolCall } from './tools.js'

console.log('=== MCP Proxy Integration Test ===\n')

// Test 1: Tool definitions
console.log('--- Test 1: Tool Definitions ---')
console.log(`Total tools: ${TOOLS.length}`)
for (const tool of TOOLS) {
  console.log(`  ✓ ${tool.name}: ${tool.description?.slice(0, 40)}...`)
  const required = (tool.inputSchema as any)?.required || []
  console.log(`    Required params: ${required.join(', ')}`)
}

if (TOOLS.length === 6) {
  console.log('✅ Tool count test PASSED (6 tools)')
} else {
  console.log(`❌ Tool count test FAILED (expected 6, got ${TOOLS.length})`)
}

// Test 2: Tool names match spec
const expectedTools = [
  'server_chat',
  'server_deep_think',
  'server_office_read',
  'server_office_create',
  'server_file_upload',
  'server_file_download',
]
const actualNames = TOOLS.map(t => t.name).sort()
const expectedNames = expectedTools.sort()

if (JSON.stringify(actualNames) === JSON.stringify(expectedNames)) {
  console.log('✅ Tool names test PASSED')
} else {
  console.log('❌ Tool names test FAILED')
  console.log('Expected:', expectedNames)
  console.log('Actual:', actualNames)
}

// Test 3: Mock tool calls (without real server)
console.log('\n--- Test 3: Mock Tool Calls ---')

// Create a mock sendToServer function
async function mockSendToServer(prompt: string, context?: string): Promise<string> {
  return `[Mock Response] Prompt: ${prompt.slice(0, 50)}...${context ? ` Context: ${context.slice(0, 30)}...` : ''}`
}

try {
  // Test server_chat
  const chatResult = await handleToolCall('server_chat', { prompt: 'Hello' }, mockSendToServer)
  console.log(`  server_chat: ${chatResult.slice(0, 50)}...`)

  // Test server_deep_think
  const thinkResult = await handleToolCall('server_deep_think', { prompt: 'Analyze this', skill: 'websubagent' }, mockSendToServer)
  console.log(`  server_deep_think: ${thinkResult.slice(0, 50)}...`)

  // Test server_office_read
  const readResult = await handleToolCall('server_office_read', { file_path: '/workspace/test.xlsx', query: '分析趋势' }, mockSendToServer)
  console.log(`  server_office_read: ${readResult.slice(0, 50)}...`)

  // Test server_office_create
  const createResult = await handleToolCall('server_office_create', { template: 'pptx', content: 'Q4 Report' }, mockSendToServer)
  console.log(`  server_office_create: ${createResult.slice(0, 50)}...`)

  // Test server_file_upload
  const uploadResult = await handleToolCall('server_file_upload', { local_path: '/tmp/test.xlsx' }, mockSendToServer)
  console.log(`  server_file_upload: ${uploadResult.slice(0, 50)}...`)

  // Test server_file_download
  const downloadResult = await handleToolCall('server_file_download', { remote_path: '/workspace/output.pptx' }, mockSendToServer)
  console.log(`  server_file_download: ${downloadResult.slice(0, 50)}...`)

  console.log('✅ Mock tool calls test PASSED')
} catch (err) {
  console.log('❌ Mock tool calls test FAILED:', err)
}

// Test 4: Error handling
console.log('\n--- Test 4: Error Handling ---')
try {
  await handleToolCall('unknown_tool', {}, mockSendToServer)
  console.log('❌ Should have thrown error for unknown tool')
} catch (err) {
  if (err instanceof Error && err.message.includes('Unknown tool')) {
    console.log('✅ Error handling test PASSED')
  } else {
    console.log('❌ Error handling test FAILED: wrong error')
  }
}

console.log('\n=== All offline tests complete ===')
console.log('Note: Live server tests require free-code Server running on VPS.')
