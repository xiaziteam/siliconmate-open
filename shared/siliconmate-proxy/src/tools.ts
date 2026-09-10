/**
 * SiliconMate MCP Proxy - Tool Definitions
 *
 * 6 MCP tools that bridge client Agent to server Agent:
 * - server_chat: Send a message to the server Agent
 * - server_deep_think: Trigger AgentChat deep thinking on the server
 * - server_office_read: Read an Office document on the server
 * - server_office_create: Create an Office document on the server
 * - server_file_upload: Upload a file to the server workspace
 * - server_file_download: Download a file from the server workspace
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js'

// ── Tool definitions ────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: 'server_chat',
    description: '向服务端Agent发送消息，获取回复。用于需要服务端处理能力的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '要发送给服务端Agent的消息内容',
        },
        context: {
          type: 'string',
          description: '附加上下文信息（可选）',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'server_deep_think',
    description: '触发服务端AgentChat深度思考。AgentChat提供多AI协作能力：OneWeb（降级链）、WebSubAgent（6步管道）、IndependentTasks（并行分发+合成）。适合复杂问题、深度分析、多源综合。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '需要深度思考的问题',
        },
        skill: {
          type: 'string',
          enum: ['oneweb', 'websubagent', 'independenttasks'],
          description: '使用的AgentChat skill（默认websubagent）',
        },
        context: {
          type: 'string',
          description: '附加上下文（可选）',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'server_office_read',
    description: '使用服务端OfficeCLI读取Office文档（.docx/.xlsx/.pptx）。返回文档内容和分析结果。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '服务端workspace中的文件路径（先通过server_file_upload上传）',
        },
        query: {
          type: 'string',
          description: '对文档的查询问题（可选，如不提供则返回文档摘要）',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'server_office_create',
    description: '使用服务端OfficeCLI创建Office文档（.docx/.xlsx/.pptx）。创建后可通过server_file_download下载。',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: ['docx', 'xlsx', 'pptx'],
          description: '文档类型',
        },
        content: {
          type: 'string',
          description: '文档内容（JSON格式或自然语言描述）',
        },
        filename: {
          type: 'string',
          description: '输出文件名（可选，默认根据模板类型生成）',
        },
      },
      required: ['template', 'content'],
    },
  },
  {
    name: 'server_file_upload',
    description: '上传本地文件到服务端workspace，供OfficeCLI等工具处理。返回服务端文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        local_path: {
          type: 'string',
          description: '本地文件路径',
        },
        remote_name: {
          type: 'string',
          description: '服务端保存的文件名（可选，默认用原文件名）',
        },
      },
      required: ['local_path'],
    },
  },
  {
    name: 'server_file_download',
    description: '从服务端workspace下载文件到本地。用于获取OfficeCLI创建的文档等。',
    inputSchema: {
      type: 'object',
      properties: {
        remote_path: {
          type: 'string',
          description: '服务端文件路径',
        },
        local_path: {
          type: 'string',
          description: '本地保存路径（可选，默认保存到~/Downloads/）',
        },
      },
      required: ['remote_path'],
    },
  },
]

// ── Tool call handler ───────────────────────────────────────────────

type SendToServerFn = (prompt: string, context?: string) => Promise<string>

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  sendToServer: SendToServerFn,
): Promise<string> {
  switch (name) {
    case 'server_chat': {
      const prompt = args.prompt as string
      const context = args.context as string | undefined
      return await sendToServer(prompt, context)
    }

    case 'server_deep_think': {
      const prompt = args.prompt as string
      const skill = (args.skill as string) || 'websubagent'
      const context = args.context as string | undefined

      // Construct AgentChat-specific prompt
      const agentChatPrompt = `请使用AgentChat-${skill === 'oneweb' ? 'OneWeb' : skill === 'websubagent' ? 'WebSubAgent' : 'IndependentTasks'} skill来深度思考以下问题：\n\n${prompt}`
      return await sendToServer(agentChatPrompt, context)
    }

    case 'server_office_read': {
      const filePath = args.file_path as string
      const query = args.query as string | undefined
      const officePrompt = query
        ? `请使用OfficeCLI读取文件 ${filePath}，并回答：${query}`
        : `请使用OfficeCLI读取文件 ${filePath}，返回文档摘要`
      return await sendToServer(officePrompt)
    }

    case 'server_office_create': {
      const template = args.template as string
      const content = args.content as string
      const filename = args.filename as string | undefined
      const createPrompt = `请使用OfficeCLI创建${template.toUpperCase()}文档${filename ? ` ${filename}` : ''}，内容如下：\n${content}`
      return await sendToServer(createPrompt)
    }

    case 'server_file_upload': {
      const localPath = args.local_path as string
      const remoteName = args.remote_name as string | undefined

      // In real implementation, this would SCP/curl the file to the server
      // For now, instruct the server agent to expect the file
      const uploadPrompt = `请准备接收上传文件：${remoteName || localPath.split('/').pop() || 'file'}，本地路径：${localPath}`
      return await sendToServer(uploadPrompt)
    }

    case 'server_file_download': {
      const remotePath = args.remote_path as string
      const localPath = args.local_path as string | undefined

      const downloadPrompt = `请提供文件 ${remotePath} 的下载路径${localPath ? `，保存到本地：${localPath}` : ''}`
      return await sendToServer(downloadPrompt)
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
