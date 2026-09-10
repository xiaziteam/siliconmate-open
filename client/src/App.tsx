/**
 * 硅侣3.0 — App Entry
 *
 * 集成：登录 → IM多会话 → 场景路由
 * - 多会话管理(ConversationStore + Sidebar)
 * - 登录成功后启动客户端Agent
 * - 用户输入→agent_manager.send_message()→output_filter过滤→chat.tsx显示
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Login } from './login'
import { Chat } from './chat'
import { VoiceChat } from './voice'
import { Sidebar } from './sidebar'
import {
  Conversation,
  Message,
  loadConversations,
  saveConversations,
  createConversation,
  addMessage,
  updateLastAssistantMessage,
  deleteConversation,
} from './conversation'

interface ImageAttachment {
  path: string
  name: string
  ocr_text: string | null
  ocr_status: 'pending' | 'success' | 'failed' | 'not_available' | 'no_text'
  file_size: number
}

type AppView = 'login' | 'chat' | 'voice'

const IS_DEV = import.meta.env.DEV

export const App: React.FC = () => {
  const [view, setView] = useState<AppView>(IS_DEV ? 'chat' : 'login')
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'thinking' | 'deep_thinking' | 'streaming' | 'error'>('idle')
  const [sessionId, setSessionId] = useState<string>('')
  const [chatgptSession, setChatgptSession] = useState<{ access_token: string; cookies: any; expires: string } | null>(null)
  const [isVoiceMode, setIsVoiceMode] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [activated, setActivated] = useState(false)
  const [activationPlan, setActivationPlan] = useState<string | null>(null)
  const [deepThinkProgress, setDeepThinkProgress] = useState<string>('')
  const [serverConnected, setServerConnected] = useState(false)
  const [serverConnecting, setServerConnecting] = useState(false)
  const invoke = (window as any).__TAURI__?.core?.invoke
  const listen = (window as any).__TAURI__?.event?.listen

  const activeConversation = conversations.find(c => c.id === activeConvId) || null
  const activeMessages: Message[] = activeConversation?.messages || []

  // Persist conversations on change
  useEffect(() => {
    saveConversations(conversations)
  }, [conversations])

  // Start heartbeat on login
  useEffect(() => {
    if (sessionId && invoke) {
      const interval = setInterval(async () => {
        try {
          const st = await invoke('heartbeat', { sessionId })
          if (st !== 'alive') {
            console.warn('Session stale, re-fetching...')
            await invoke('apply_session')
          }
        } catch (e) {
          console.error('Heartbeat failed:', e)
        }
      }, 30000)
      return () => clearInterval(interval)
    }
  }, [sessionId, invoke])

  // Check agent health when entering chat
  useEffect(() => {
    if (view === 'chat' && invoke) {
      invoke('check_agent_health').then((ok: boolean) => {
        if (!ok) {
          console.warn('[硅侣] zhipu-bridge不可用，请确认 :15731 运行中')
        }
      }).catch(console.error)
    }
  }, [view, invoke])

  // Listen for deep-think-progress events (streaming progress from AgentChat)
  useEffect(() => {
    if (!listen) return
    let unlisten: (() => void) | null = null
    listen('deep-think-progress', (event: any) => {
      const data = event.payload
      if (data?.phase === 'thinking' && data?.message) {
        setDeepThinkProgress(data.message)
      } else if (data?.phase === 'done') {
        setDeepThinkProgress('')
      } else if (data?.phase === 'started') {
        setDeepThinkProgress('深度思考启动中…')
      } else if (data?.phase === 'error') {
        setDeepThinkProgress('')
      }
    }).then((fn: () => void) => { unlisten = fn })
    return () => { if (unlisten) unlisten() }
  }, [listen])

  const handleLoginSuccess = async (sid: string, session?: { access_token: string; cookies: any; expires: string }, isActivated?: boolean, plan?: string) => {
    setSessionId(sid)
    if (session) setChatgptSession(session)
    setActivated(isActivated ?? false)
    setActivationPlan(plan ?? null)

    // Auto-connect to VPS2 server (awaited with timeout)
    if (invoke) {
      setServerConnecting(true)
      try {
        const result = await Promise.race([
          invoke('connect_server') as Promise<string>,
          new Promise<string>((_, reject) => setTimeout(() => reject('连接超时'), 15000)),
        ])
        console.log('[硅侣] 服务端已连接:', result)
        setServerConnected(true)
      } catch (e: any) {
        console.warn('[硅侣] 服务端连接失败(深度思考不可用):', String(e))
        setServerConnected(false)
      }
      setServerConnecting(false)
    }

    setView('chat')
  }

  const handleGuestEnter = () => {
    setActivated(false)
    setActivationPlan(null)
    setView('chat')
  }

  const handleActivate = useCallback((plan: string) => {
    setActivated(true)
    setActivationPlan(plan)
  }, [])

  const handleNewConversation = useCallback(() => {
    const conv = createConversation()
    setConversations(prev => [conv, ...prev])
    setActiveConvId(conv.id)
  }, [])

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConvId(id)
  }, [])

  const handleDeleteConversation = useCallback((id: string) => {
    setConversations(prev => deleteConversation(prev, id))
    if (activeConvId === id) {
      setActiveConvId(null)
    }
  }, [activeConvId])

  const updateConversation = useCallback((id: string, updater: (c: Conversation) => Conversation) => {
    setConversations(prev => prev.map(c => c.id === id ? updater(c) : c))
  }, [])

  const handleSendMessage = useCallback(async (text: string, attachments?: ImageAttachment[], deepThink?: boolean, feishuOutput?: boolean) => {
    if (!text.trim() && (!attachments || attachments.length === 0)) return

    let convId = activeConvId
    if (!convId) {
      const conv = createConversation(text.trim())
      convId = conv.id
      setConversations(prev => [conv, ...prev])
      setActiveConvId(convId)
    }

    let displayContent = text
    if (attachments && attachments.length > 0) {
      const fileNames = attachments.map(a => a.name).join(', ')
      if (text.trim()) {
        displayContent = `📷 ${fileNames}\n${text}`
      } else {
        displayContent = `📷 ${fileNames}`
      }
    }

    const userMsg: Message = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: displayContent,
      isStreaming: false,
      timestamp: Date.now(),
    }
    updateConversation(convId, c => addMessage(c, userMsg))

    let ocrContext: string | undefined
    if (attachments && attachments.length > 0) {
      const ocrParts: string[] = []
      for (const att of attachments) {
        if (att.ocr_status === 'success' && att.ocr_text) {
          ocrParts.push(`[用户上传了图片: ${att.name}]\n[图片文字识别结果]:\n${att.ocr_text}`)
        } else {
          ocrParts.push(`[用户上传了图片: ${att.name}，但文字识别未成功，请根据文件名和类型分析]`)
        }
      }
      ocrContext = ocrParts.join('\n\n')
    }

    setStatus('thinking')

    if (invoke) {
      try {
        const routeResult = await invoke('route_message', {
          message: text || '请分析上传的图片',
          attachments: attachments?.map(f => f.name) || [],
          sceneState: {
            voice_chat_active: false,
            deep_think_requested: deepThink || false,
            visual_analysis_requested: false,
            feishu_output_requested: feishuOutput || false,
          },
          serverAvailable: serverConnected,
        }) as any

        let response: string

        if (routeResult?.FeishuOutput) {
          const agent = routeResult.FeishuOutput.agent || 'glm_daily'
          if (agent === 'agentchat') {
            setStatus('deep_thinking')
            response = await invoke('call_server_deep_think', { prompt: text, skill: 'oneweb' }) as string
          } else if (agent === 'office_cli') {
            setStatus('deep_thinking')
            response = await invoke('call_server_office', {
              filePath: attachments?.[0]?.path || '',
              operation: 'document import',
            }) as string
          } else {
            response = await invoke('send_message', {
              message: text,
              ocrContext: ocrContext || null,
            }) as string
          }
          try {
            await invoke('feishu_create_doc', { title: '硅侣输出', content: response })
            response += '\n\n✅ 已输出到飞书文档'
          } catch (fe: any) {
            response += `\n\n⚠️ 飞书输出失败: ${String(fe)}`
          }
        } else if (routeResult?.ServerAgent) {
          const tool = routeResult.ServerAgent.tool
          if (tool === 'server_deep_think') {
            setStatus('deep_thinking')
            response = await invoke('call_server_deep_think', { prompt: text, skill: null }) as string
          } else if (tool === 'server_office_read') {
            setStatus('deep_thinking')
            response = await invoke('call_server_office', {
              filePath: attachments?.[0]?.path || '',
              operation: 'document import',
            }) as string
          } else {
            setStatus('deep_thinking')
            response = await invoke('call_server_agent', { prompt: text }) as string
          }
        } else if (routeResult?.ClientAgentWithDegradation) {
          const reason = routeResult.ClientAgentWithDegradation.reason || ''
          response = await invoke('send_message', {
            message: text,
            ocrContext: ocrContext || null,
          }) as string
          response = `⚠️ ${reason}\n\n${response}`
        } else if (routeResult?.ObscuraBridge) {
          response = '语音聊天模式已激活'
        } else if (routeResult?.ShrimpAgent) {
          const agentId = routeResult.ShrimpAgent.agent_id || 'goutou'
          const task = routeResult.ShrimpAgent.task || text
          try {
            const hubResp = await fetch('http://127.0.0.1:4196/jsonrpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'dispatch',
                params: { target_agent: agentId, task, sender: 'siliconmate' },
                id: 1,
              }),
            })
            if (hubResp.ok) {
              const hubData = await hubResp.json()
              response = hubData?.result?.response || `已派发给${agentId}，等待回复…`
            } else {
              response = `⚠️ 虾群Hub不可用(${hubResp.status})，任务: ${task}`
            }
          } catch {
            response = `⚠️ 虾群Hub未连接，请确认A2A Hub(:4196)运行中。任务: ${task}`
          }
        } else {
          const messageToSend = text || '请分析上传的图片内容'
          response = await invoke('send_message', {
            message: messageToSend,
            ocrContext: ocrContext || null,
          }) as string
        }

        const botMsg: Message = {
          id: `bot_${Date.now()}`,
          role: 'assistant',
          content: response || '(无回复)',
          isStreaming: false,
          timestamp: Date.now(),
        }
        updateConversation(convId, c => addMessage(c, botMsg))
        setStatus('idle')
      } catch (e: any) {
        console.error('Send message error:', e)
        const errMsg: Message = {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ 错误: ${String(e)}`,
          isStreaming: false,
          timestamp: Date.now(),
        }
        updateConversation(convId, c => addMessage(c, errMsg))
        setStatus('error')
      }
    } else {
      setStatus('streaming')
      const botMsg: Message = {
        id: `bot_${Date.now()}`,
        role: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: Date.now(),
      }
      updateConversation(convId, c => addMessage(c, botMsg))

      const demoText = '这是硅侣3.0的演示回复。在Tauri2环境中，此消息将由GLM-4-Flash生成。'
      let i = 0
      const cid = convId
      const interval = setInterval(() => {
        if (i < demoText.length) {
          updateConversation(cid, c => updateLastAssistantMessage(c, demoText.slice(0, i + 1), i < demoText.length - 1))
          i++
        } else {
          clearInterval(interval)
          setStatus('idle')
        }
      }, 50)
    }
  }, [invoke, activeConvId, updateConversation])

  const handleVoiceChat = useCallback(() => {
    setIsVoiceMode(prev => !prev)
    if (!isVoiceMode) {
      setView('voice')
    }
  }, [isVoiceMode])

  const handleVoiceBack = useCallback(() => {
    setIsVoiceMode(false)
    setView('chat')
  }, [])

  if (view === 'login') {
    return (
      <Login
        onLoginSuccess={handleLoginSuccess}
        onGuestEnter={handleGuestEnter}
      />
    )
  }

  if (view === 'voice') {
    return (
      <VoiceChat
        onBack={handleVoiceBack}
        sessionId={sessionId}
        chatgptSession={chatgptSession || undefined}
      />
    )
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Sidebar
        conversations={conversations}
        activeId={activeConvId}
        onSelect={handleSelectConversation}
        onNew={handleNewConversation}
        onDelete={handleDeleteConversation}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
        activated={activated}
        plan={activationPlan}
        onActivate={handleActivate}
      />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Chat
          onSendMessage={handleSendMessage}
          onVoiceChat={handleVoiceChat}
          status={status}
          deepThinkProgress={deepThinkProgress}
          serverConnected={serverConnected}
          serverConnecting={serverConnecting}
          messages={activeMessages}
          isVoiceMode={isVoiceMode}
        />
      </div>
    </div>
  )
}
