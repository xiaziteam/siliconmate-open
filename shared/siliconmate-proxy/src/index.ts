#!/usr/bin/env node

/**
 * SiliconMate MCP Proxy Server
 *
 * A standard MCP server (stdio transport) that bridges client Agent
 * to server Agent via WebSocket.
 *
 * When started, it:
 * 1. Connects to the server free-code Server via WebSocket
 * 2. Registers 6 MCP tools for the client Agent to call
 * 3. Forwards tool calls to the server and returns responses
 *
 * Usage in free-code mcp-servers.json:
 * ```json
 * {
 *   "siliconmate-server": {
 *     "command": "node",
 *     "args": ["/path/to/siliconmate-proxy/dist/index.mjs"],
 *     "env": {
 *       "SILICONMATE_SERVER_URL": "http://VPS:8080",
 *       "SILICONMATE_AUTH_TOKEN": "your-token"
 *     }
 *   }
 * }
 * ```
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TOOLS, handleToolCall } from './tools.js'
import WebSocket from 'ws'

// ── Configuration from environment ──────────────────────────────────

const SERVER_URL = process.env.SILICONMATE_SERVER_URL || 'http://localhost:8080'
const AUTH_TOKEN = process.env.SILICONMATE_AUTH_TOKEN || ''

// ── WebSocket connection to server ──────────────────────────────────

interface ServerConnection {
  ws: WebSocket | null
  sessionId: string | null
  wsUrl: string | null
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
}

const serverConn: ServerConnection = {
  ws: null,
  sessionId: null,
  wsUrl: null,
  status: 'disconnected',
}

/**
 * Create a session on the server free-code Server
 */
async function createServerSession(): Promise<{ sessionId: string; wsUrl: string }> {
  const response = await fetch(`${SERVER_URL}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`)
  }

  const data = await response.json() as { session_id: string; ws_url: string }
  return {
    sessionId: data.session_id,
    wsUrl: data.ws_url,
  }
}

/**
 * Connect to server via WebSocket
 */
async function connectToServer(): Promise<void> {
  if (serverConn.status === 'connected') return

  serverConn.status = 'connecting'

  try {
    // Create session first
    const { sessionId, wsUrl } = await createServerSession()
    serverConn.sessionId = sessionId
    serverConn.wsUrl = wsUrl

    // Connect WebSocket
    const ws = new WebSocket(wsUrl, {
      headers: AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {},
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        serverConn.status = 'connected'
        serverConn.ws = ws
        resolve()
      })
      ws.on('error', (err) => {
        serverConn.status = 'error'
        reject(err)
      })
      // Timeout
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000)
    })

    ws.on('close', () => {
      serverConn.status = 'disconnected'
      serverConn.ws = null
    })
  } catch (err) {
    serverConn.status = 'error'
    throw err
  }
}

/**
 * Send a message to the server and wait for the response
 */
async function sendToServer(prompt: string, context?: string): Promise<string> {
  if (serverConn.status !== 'connected') {
    await connectToServer()
  }

  return new Promise<string>((resolve, reject) => {
    if (!serverConn.ws) {
      reject(new Error('Not connected to server'))
      return
    }

    let response = ''
    const timeout = setTimeout(() => {
      reject(new Error('Server response timeout'))
    }, 120000) // 2 minute timeout for deep thinking

    serverConn.ws.on('message', (data: WebSocket.Data) => {
      const msg = data.toString()
      try {
        const parsed = JSON.parse(msg)

        // Handle different message types from free-code Server
        if (parsed.type === 'streamlined_text' && parsed.text) {
          response += parsed.text
        } else if (parsed.type === 'result' && parsed.content) {
          response += parsed.content
        } else if (parsed.type === 'error') {
          clearTimeout(timeout)
          reject(new Error(parsed.message || 'Server error'))
        }
      } catch {
        // Plain text response
        response += msg
      }
    })

    serverConn.ws.on('close', () => {
      clearTimeout(timeout)
      if (response) {
        resolve(response)
      } else {
        reject(new Error('Server disconnected'))
      }
    })

    // Send message
    serverConn.ws.send(JSON.stringify({
      type: 'user_message',
      content: context ? `${prompt}\n\nContext:\n${context}` : prompt,
    }))

    // Wait for done signal
    // In real implementation, we'd wait for a specific "done" event
    // For now, resolve after collecting response for a while
    setTimeout(() => {
      clearTimeout(timeout)
      resolve(response || '(no response from server)')
    }, 60000) // Give 60 seconds for response
  })
}

// ── MCP Server setup ────────────────────────────────────────────────

const server = new Server(
  {
    name: 'siliconmate-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}))

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    const result = await handleToolCall(name, args || {}, sendToServer)
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result),
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    }
  }
})

// ── Start server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Try to connect to server in background
  try {
    await connectToServer()
    console.error('[siliconmate-proxy] Connected to server at', SERVER_URL)
  } catch (err) {
    console.error('[siliconmate-proxy] Warning: Could not connect to server:', err instanceof Error ? err.message : err)
    console.error('[siliconmate-proxy] Will attempt connection on first tool call')
  }

  console.error('[siliconmate-proxy] MCP Proxy Server started (stdio)')
}

main().catch((err) => {
  console.error('[siliconmate-proxy] Fatal error:', err)
  process.exit(1)
})
