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
  SmcpTarget,
  SmcpGroupTarget,
} from './conversation'
import { smcpInit, startPolling, stopPolling, sendMessage as smcpSendMessage, sendGroupMessage, uploadFile, SmcpMessage } from './smcp'

interface ImageAttachment {
  path: string
  name: string
  ocr_text: string | null
  ocr_status: 'pending' | 'success' | 'failed' | 'not_available' | 'no_text'
  file_size: number
  data?: string // base64 for SMCP transfer
  type?: string // mime type for SMCP transfer
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
  const [smcpReady, setSmcpReady] = useState(false)
  const [mySiliconId, setMySiliconId] = useState<string>('')
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

  // Android通知点击跳转 — 监听smcp-notification-chat事件
  useEffect(() => {
    const handler = (e: Event) => {
      const { fromUser } = (e as CustomEvent).detail
      if (!fromUser) return
      // 找到对应对话并切换
      const targetConv = conversations.find(c =>
        c.smcpTarget?.userId === fromUser || c.smcpTarget?.agentId?.includes(fromUser.slice(0, 8))
      )
      if (targetConv) {
        setActiveConvId(targetConv.id)
      }
      console.log('[硅侣] 通知跳转到对话:', fromUser)
    }
    window.addEventListener('smcp-notification-chat', handler)
    return () => window.removeEventListener('smcp-notification-chat', handler)
  }, [conversations])

  // Async server connection polling — non-blocking, fail-open
  // Moved out of handleLoginSuccess to avoid blocking UI render
  useEffect(() => {
    if (view !== 'chat' || !invoke || serverConnected) return

    let cancelled = false
    const tryConnect = async () => {
      if (cancelled) return
      setServerConnecting(true)
      try {
        const result = await invoke('connect_server') as string
        if (!cancelled) {
          console.log('[硅侣] 服务端已连接:', result)
          setServerConnected(true)
          setServerConnecting(false)
        }
      } catch (e: any) {
        if (!cancelled) {
          console.warn('[硅侣] 服务端连接失败(深度思考不可用):', String(e))
          setServerConnected(false)
          setServerConnecting(false)
        }
      }
    }

    // First attempt immediately
    tryConnect()
    // Then poll every 10 seconds until connected
    const interval = setInterval(() => {
      if (!serverConnected && !cancelled) {
        tryConnect()
      }
    }, 10000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [view, invoke, serverConnected])

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

  const handleLoginSuccess = async (sid: string, session?: { access_token: string; cookies: any; expires: string }, isActivated?: boolean, plan?: string, siliconId?: string) => {
    setSessionId(sid)
    if (session) setChatgptSession(session)
    setActivated(isActivated ?? false)
    setActivationPlan(plan ?? null)
    if (siliconId) setMySiliconId(siliconId)

    // P0 FIX: 先渲染UI，connect_server由useEffect异步轮询(fail-open，不阻塞)
    setView('chat')

    // SMCP: 注册Agent + 启动消息轮询(异步，不阻塞)
    smcpInit(sid).then(smcpOk => {
      if (smcpOk) {
        setSmcpReady(true)
        startPolling((msg: SmcpMessage) => {
          handleSmcpIncomingMessage(msg)
        })
      }
    }).catch(e => {
      console.warn('[硅侣] SMCP初始化失败:', e)
    })
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

  const updateConversation = useCallback((id: string, updater: (c: Conversation) => Conversation) => {
    setConversations(prev => prev.map(c => c.id === id ? updater(c) : c))
  }, [])

  /** SMCP: 打开/创建与某好友的对话 */
  const handleOpenSmcpChat = useCallback((target: { userId: string; agentId: string; role: string; myAgentId: string }) => {
    // 查找是否已有该好友的对话
    const existing = conversations.find(c =>
      c.smcpTarget && c.smcpTarget.userId === target.userId
    )
    if (existing) {
      setActiveConvId(existing.id)
      return
    }
    // 创建新SMCP对话
    const smcpTarget: SmcpTarget = {
      userId: target.userId,
      agentId: target.agentId,
      role: target.role,
      myAgentId: target.myAgentId,
    }
    const conv = createConversation(undefined, smcpTarget)
    setConversations(prev => [conv, ...prev])
    setActiveConvId(conv.id)
  }, [conversations])

  /** SMCP: 点击群聊打开群对话 */
  const handleOpenGroupChat = useCallback((groupId: string, groupName: string) => {
    const existing = conversations.find(c =>
      c.smcpGroupTarget && c.smcpGroupTarget.groupId === groupId
    )
    if (existing) {
      setActiveConvId(existing.id)
      return
    }
    const smcpGroupTarget: SmcpGroupTarget = { groupId, groupName }
    const conv = createConversation(undefined, undefined, smcpGroupTarget)
    setConversations(prev => [conv, ...prev])
    setActiveConvId(conv.id)
  }, [conversations])

  /** SMCP: 收到中继消息，放入对应对话 */
  const handleSmcpIncomingMessage = useCallback((msg: SmcpMessage) => {
    const fromAgentId = msg.from_agent || ''
    const groupId = msg.params?.group_id
    const text = msg.params?.text || msg.params?.content || msg.params?.message || ''
    const fileId = msg.params?.file_id
    const fileName = msg.params?.filename || fileId

    // 构建显示内容
    let displayText = ''
    if (fileId) {
      const fileUrl = `https://example.com/v1/smcp/file/download/${fileId}`
      displayText = groupId
        ? `👥 📎 [${fileName}](${fileUrl})` + (text ? `\n👥 ${text}` : '')
        : `🦐 📎 [${fileName}](${fileUrl})` + (text ? `\n🦐 ${text}` : '')
    } else {
      displayText = groupId ? `👥 ${text}` : `🦐 ${text}`
    }

    // Android推送通知
    const NB = (window as any).NativeBridge
    const notifTitle = groupId ? '👥 群聊消息' : '🦐 虾群消息'
    const notifBody = fileId ? `📎 ${fileName}` + (text ? ` - ${text.slice(0, 60)}` : '') : text.slice(0, 100)
    if (NB?.showNotification) {
      try { NB.showNotification(notifTitle, notifBody) } catch (e) { console.warn('[SMCP] showNotification error:', e) }
    }

    const botMsg: Message = {
      id: `smcp_${msg.msg_id}`,
      role: 'assistant',
      content: displayText,
      isStreaming: false,
      timestamp: Date.now(),
    }

    // 用函数式更新避免闭包过期 — 始终拿到最新conversations
    setConversations(prev => {
      const currentConvId = activeConvId  // 闭包捕获当前活跃对话ID
      // 群聊消息：找对应群对话
      if (groupId) {
        const groupConv = prev.find(c =>
          c.smcpGroupTarget && c.smcpGroupTarget.groupId === groupId
        )
        if (groupConv) {
          const isNotActive = groupConv.id !== currentConvId
          return prev.map(c => {
            if (c.id !== groupConv.id) return c
            const updated = addMessage(c, botMsg)
            if (isNotActive) updated.unreadCount = (updated.unreadCount || 0) + 1
            return updated
          })
        } else {
          // 新群对话
          const groupTarget: SmcpGroupTarget = { groupId, groupName: groupId }
          const conv = createConversation(undefined, undefined, groupTarget)
          const updatedConv = addMessage(conv, botMsg)
          updatedConv.unreadCount = 1
          return [updatedConv, ...prev]
        }
      }
      // 私聊消息
      const targetConv = prev.find(c =>
        c.smcpTarget && c.smcpTarget.agentId === fromAgentId
      )
      if (targetConv) {
        const isNotActive = targetConv.id !== currentConvId
        return prev.map(c => {
          if (c.id !== targetConv.id) return c
          const updated = addMessage(c, botMsg)
          if (isNotActive) updated.unreadCount = (updated.unreadCount || 0) + 1
          return updated
        })
      } else {
        const smcpTarget: SmcpTarget = {
          userId: '',
          agentId: fromAgentId,
          role: fromAgentId,
          myAgentId: '',
        }
        const conv = createConversation(undefined, smcpTarget)
        const updatedConv = addMessage(conv, botMsg)
        return [updatedConv, ...prev]
      }
    })
  }, [])

  const handleNewConversation = useCallback(() => {
    const conv = createConversation()
    setConversations(prev => [conv, ...prev])
    setActiveConvId(conv.id)
  }, [])

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConvId(id)
    // 切换对话时清零未读数
    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, unreadCount: 0 } : c
    ))
  }, [])

  const handleDeleteConversation = useCallback((id: string) => {
    setConversations(prev => deleteConversation(prev, id))
    if (activeConvId === id) {
      setActiveConvId(null)
    }
  }, [activeConvId])

  const handleSendMessage = useCallback(async (text: string, attachments?: ImageAttachment[], deepThink?: boolean, feishuOutput?: boolean, mentions?: string[]) => {
    if (!text.trim() && (!attachments || attachments.length === 0)) return

    let convId = activeConvId
    if (!convId) {
      const conv = createConversation(text.trim())
      convId = conv.id
      setConversations(prev => [conv, ...prev])
      setActiveConvId(convId)
    }

    // 检查是否SMCP对话
    const currentConv = conversations.find(c => c.id === convId)
    const smcpTarget = currentConv?.smcpTarget
    const smcpGroupTarget = currentConv?.smcpGroupTarget

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

    // --- SMCP群聊: 走群消息API ---
    if (smcpGroupTarget) {
      setStatus('thinking')
      try {
        // 如果有附件，先读文件转base64再上传
        let fileParams: any = {}
        if (attachments && attachments.length > 0) {
          const att = attachments[0]
          let base64Data = att.data
          if (!base64Data && att.path) {
            try {
              const inv = (window as any).__TAURI__?.invoke
              if (inv) {
                const readResult = await inv('read_file_base64', { path: att.path })
                base64Data = readResult
              }
            } catch (e) { console.warn('[SMCP] read file base64 failed:', e) }
          }
          if (base64Data) {
            const uploadResult = await uploadFile(att.name, base64Data, att.type || 'image/png')
            if (uploadResult.ok && uploadResult.file_id) {
              fileParams = { file_id: uploadResult.file_id, filename: uploadResult.filename, file_size: uploadResult.size }
            }
          }
        }
        const result = await sendGroupMessage(smcpGroupTarget.groupId, { content: text, ...fileParams, ...(mentions && mentions.length > 0 ? { mentions } : {}) })
        if (result?.error) {
          const errMsg: Message = {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ 发送失败: ${result.error}`,
            isStreaming: false,
            timestamp: Date.now(),
          }
          updateConversation(convId, c => addMessage(c, errMsg))
        }
        setStatus('idle')
        return
      } catch (e) {
        setStatus('idle')
        return
      }
    }

    // --- SMCP对话: 走消息中继 ---
    if (smcpTarget) {
      setStatus('thinking')
      try {
        // 如果有附件，先读文件转base64再上传
        let fileParams: any = {}
        if (attachments && attachments.length > 0) {
          const att = attachments[0]
          let base64Data = att.data
          if (!base64Data && att.path) {
            try {
              const inv = (window as any).__TAURI__?.invoke
              if (inv) {
                const readResult = await inv('read_file_base64', { path: att.path })
                base64Data = readResult
              }
            } catch (e) { console.warn('[SMCP] read file base64 failed:', e) }
          }
          if (base64Data) {
            const uploadResult = await uploadFile(att.name, base64Data, att.type || 'image/png')
            if (uploadResult.ok && uploadResult.file_id) {
              fileParams = { file_id: uploadResult.file_id, filename: uploadResult.filename, file_size: uploadResult.size }
            }
          }
        }
        const result = await smcpSendMessage(
          smcpTarget.agentId,
          smcpTarget.userId,
          text,
          fileParams
        )
        if (result?.error) {
          const errMsg: Message = {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ 发送失败: ${result.error}`,
            isStreaming: false,
            timestamp: Date.now(),
          }
          updateConversation(convId, c => addMessage(c, errMsg))
        }
        // 消息已发出，对方回复由poll轮询回来
        setStatus('idle')
      } catch (e: any) {
        const errMsg: Message = {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ 发送失败: ${String(e)}`,
          isStreaming: false,
          timestamp: Date.now(),
        }
        updateConversation(convId, c => addMessage(c, errMsg))
        setStatus('error')
      }
      return
    }

    // --- 本地AI对话: 原有逻辑 ---

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
        onOpenSmcpChat={handleOpenSmcpChat}
        onOpenGroupChat={handleOpenGroupChat}
        accountId={sessionId}
        mySiliconId={mySiliconId}
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
          smcpTarget={activeConversation?.smcpTarget}
          smcpGroupTarget={activeConversation?.smcpGroupTarget}
        />
      </div>
    </div>
  )
}
