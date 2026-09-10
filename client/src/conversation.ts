/**
 * 硅侣3.0 — IM会话管理
 *
 * 多会话管理 + localStorage持久化
 * - Conversation: 单个对话(含消息列表+标题+时间戳)
 * - ConversationStore: 所有对话的CRUD + 持久化
 */

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  isStreaming: boolean
  timestamp: number
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY = 'siliconmate_conversations'

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function generateTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim()
  if (trimmed.length <= 20) return trimmed
  return trimmed.slice(0, 20) + '…'
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
  } catch {
    // storage full or unavailable — silently ignore
  }
}

export function createConversation(firstMessage?: string): Conversation {
  const now = Date.now()
  return {
    id: generateId(),
    title: firstMessage ? generateTitle(firstMessage) : '新对话',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function addMessage(conversation: Conversation, msg: Message): Conversation {
  const updated: Conversation = {
    ...conversation,
    messages: [...conversation.messages, msg],
    updatedAt: Date.now(),
  }
  if (conversation.messages.length === 0 && msg.role === 'user') {
    updated.title = generateTitle(msg.content)
  }
  return updated
}

export function updateLastAssistantMessage(conversation: Conversation, content: string, isStreaming: boolean): Conversation {
  const msgs = [...conversation.messages]
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      msgs[i] = { ...msgs[i], content, isStreaming }
      break
    }
  }
  return { ...conversation, messages: msgs, updatedAt: Date.now() }
}

export function deleteConversation(conversations: Conversation[], id: string): Conversation[] {
  return conversations.filter(c => c.id !== id)
}
