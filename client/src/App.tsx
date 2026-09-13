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
import { smcpInit, startPolling, stopPolling, sendMessage as smcpSendMessage, sendGroupMessage, uploadFile, SmcpMessage, taskExecute, TaskResult, listCapabilities, CapabilityInfo, taskCheckTimeouts, taskRemovePendingRemote, taskResultSend, permissionSet } from './smcp'

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
  // 移动端自适应：窄屏(<=480px)时侧栏变为抽屉式
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 480)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [activated, setActivated] = useState(false)
  const [activationPlan, setActivationPlan] = useState<string | null>(null)
  const [deepThinkProgress, setDeepThinkProgress] = useState<string>('')
  const [serverConnected, setServerConnected] = useState(false)
  const [serverConnecting, setServerConnecting] = useState(false)
  const [smcpReady, setSmcpReady] = useState(false)
  const [mySiliconId, setMySiliconId] = useState<string>('')
  const [taskApprovalRequest, setTaskApprovalRequest] = useState<{
    task_id: string
    from_agent: string
    capability: string
    params: any
  } | null>(null)
  const invoke = (window as any).__TAURI__?.core?.invoke
  const listen = (window as any).__TAURI__?.event?.listen

  const activeConversation = conversations.find(c => c.id === activeConvId) || null
  const activeMessages: Message[] = activeConversation?.messages || []

  // Persist conversations on change
  useEffect(() => {
    saveConversations(conversations)
  }, [conversations])

  // 移动端自适应：监听窗口宽度变化
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth <= 480
      setIsMobile(mobile)
      if (!mobile) setMobileDrawerOpen(false)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

  // Listen for task-approval-request events (from remote task received by smcp_poll)
  useEffect(() => {
    if (!listen) return
    let unlisten: (() => void) | null = null
    listen('task-approval-request', (event: any) => {
      const data = event.payload
      if (data?.task_id && data?.capability) {
        setTaskApprovalRequest({
          task_id: data.task_id,
          from_agent: data.from_agent || '',
          capability: data.capability,
          params: data.params || {},
        })
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
        // 启动远程task超时检查（每5分钟检查一次）
        if (invoke) {
          const timeoutInterval = setInterval(async () => {
            try {
              const expired = await invoke('task_check_timeouts') as string[]
              if (expired && expired.length > 0) {
                console.log('[TaskEngine] 超时任务已清理:', expired)
              }
            } catch (e) {
              console.warn('[TaskEngine] 超时检查失败:', e)
            }
          }, 5 * 60 * 1000) // 5分钟
          // Store for cleanup (note: in production, would need proper cleanup)
          ;(window as any).__taskTimeoutChecker = timeoutInterval
        }
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

  /** 处理远程任务审批：允许/始终允许/拒绝 */
  const handleTaskApproval = useCallback(async (action: 'allow' | 'always' | 'reject') => {
    if (!taskApprovalRequest || !invoke) return
    const { task_id, from_agent, capability, params } = taskApprovalRequest

    // 移除挂起的远程task（无论结果如何）
    await taskRemovePendingRemote(task_id)

    if (action === 'reject') {
      // 回传拒绝结果
      await taskResultSend(from_agent, '', task_id, 'rejected', {}, [], 'none', 0, '用户拒绝执行')
      setTaskApprovalRequest(null)
      return
    }

    // 始终允许 → 更新权限策略
    if (action === 'always') {
      await permissionSet(from_agent, capability, 'allow')
    }

    // 执行任务
    setTaskApprovalRequest(null)
    try {
      const result = await taskExecute(capability, params)

      // 截图转base64（如果执行了screenshot）
      let screenshots: string[] = result.screenshots || []
      if (capability === 'screenshot' && result.status === 'success') {
        if (result.data?.path) {
          try {
            const b64 = await invoke('read_file_base64', { path: result.data.path }) as string
            screenshots = [b64]
          } catch (e) {
            console.warn('[TaskApproval] screenshot base64 read failed:', e)
          }
        }
      }

      // 回传结果
      await taskResultSend(
        from_agent, '',
        task_id, result.status, result.data,
        screenshots, result.execution_tier, result.duration_ms,
        result.error_message || '',
      )
    } catch (e: any) {
      // 执行失败，回传错误
      await taskResultSend(from_agent, '', task_id, 'error', {}, [], 'none', 0, String(e))
    }
  }, [taskApprovalRequest, invoke])

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
    const msgType = msg.type || msg.msg_type || 'notify'

    // Task/Result消息：特殊处理
    if (msgType === 'task') {
      // 收到远程任务请求 → 触发审批流程
      const capability = msg.params?.capability || ''
      const taskId = msg.params?.task_id || ''
      const from = msg.params?.from || msg.from_agent || ''
      setTaskApprovalRequest({
        task_id: taskId,
        from_agent: from,
        capability,
        params: msg.params?.params || {},
      })
      return // 不进入聊天UI
    }

    if (msgType === 'result') {
      // 收到远程任务结果 → 放入对应对话
      const taskId = msg.params?.task_id || ''
      const status = msg.params?.status || 'unknown'
      const data = msg.params?.data || {}
      const tier = msg.params?.execution_tier || 'unknown'
      const durationMs = msg.params?.duration_ms || 0
      const fromAgent = msg.from_agent || ''
      const screenshots = msg.params?.screenshots || []

      let resultContent = ''
      if (status === 'success') {
        resultContent = `✅ 远程任务完成 (${tier}层, ${durationMs < 1000 ? durationMs + 'ms' : (durationMs / 1000).toFixed(1) + '秒'})`
        if (data?.stdout) resultContent += `\n${data.stdout}`
        if (data?.text) resultContent += `\n${data.text}`
        if (data?.path) resultContent += `\n截图: ${data.path}`
      } else if (status === 'rejected') {
        resultContent = `🚫 远程任务被拒绝`
      } else if (status === 'timeout') {
        resultContent = `⏰ 远程任务审批超时`
      } else {
        resultContent = `❌ 远程任务失败: ${msg.params?.error_message || '未知错误'}`
      }

      const resultMsg: Message = {
        id: `result_${taskId}_${Date.now()}`,
        role: 'assistant',
        content: resultContent,
        isStreaming: false,
        timestamp: Date.now(),
        is_task_result: true,
        execution_tier: tier,
        task_status: status,
        screenshots,
        duration_ms: durationMs,
        error_message: msg.params?.error_message || undefined,
      }

      // 找到对应好友对话放入结果
      setConversations(prev => {
        const targetConv = prev.find(c =>
          c.smcpTarget && c.smcpTarget.agentId === fromAgent
        )
        if (targetConv) {
          return prev.map(c =>
            c.id === targetConv.id ? addMessage(c, resultMsg) : c
          )
        } else {
          // 创建新对话放结果
          const smcpTarget: SmcpTarget = {
            userId: '',
            agentId: fromAgent,
            role: fromAgent,
            myAgentId: '',
          }
          const conv = createConversation(undefined, smcpTarget)
          const updatedConv = addMessage(conv, resultMsg)
          return [updatedConv, ...prev]
        }
      })
      return
    }

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

  const handleSendMessage = useCallback(async (text: string, attachments?: ImageAttachment[], deepThink?: boolean, feishuOutput?: boolean, mentions?: string[], taskCapability?: string, taskParams?: any) => {
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

    // 检查是否是Agent指令（task_capability由chat.tsx检测后传入）
    if (taskCapability && invoke) {
      setStatus('thinking')

      // "你能做什么"指令特殊处理
      if (taskCapability === 'list_capabilities') {
        try {
          const caps = await invoke('task_list_capabilities') as CapabilityInfo[]
          const grouped = {
            native: caps.filter(c => c.tier === 'native' && c.available),
            nuphus: caps.filter(c => c.tier === 'nuphus' && c.available),
            fallback: caps.filter(c => c.tier === 'fallback' && c.available),
          }
          let response = '🦐 我的本机能力：\n\n'
          if (grouped.native.length > 0) {
            response += '⚡ 原生直通（秒级响应）：\n'
            grouped.native.forEach(c => { response += `  • ${c.name} — ${c.description}\n` })
            response += '\n'
          }
          if (grouped.nuphus.length > 0) {
            response += '🤖 Nuphus引擎（需模型）：\n'
            grouped.nuphus.forEach(c => { response += `  • ${c.name} — ${c.description}\n` })
            response += '\n'
          }
          if (grouped.fallback.length > 0) {
            response += '⚠️ 降级命令（Nuphus不可用时）：\n'
            grouped.fallback.forEach(c => { response += `  • ${c.name} — ${c.description}\n` })
          }
          const botMsg: Message = {
            id: `bot_${Date.now()}`,
            role: 'assistant',
            content: response,
            isStreaming: false,
            timestamp: Date.now(),
            is_task_result: true,
            execution_tier: 'native',
            task_status: 'success',
          }
          updateConversation(convId!, c => addMessage(c, botMsg))
        } catch (e: any) {
          const errMsg: Message = {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ 查询能力失败: ${String(e)}`,
            isStreaming: false,
            timestamp: Date.now(),
          }
          updateConversation(convId!, c => addMessage(c, errMsg))
        }
        setStatus('idle')
        return
      }

      // 执行task
      try {
        const result = await invoke('task_execute', {
          capability: taskCapability,
          params: taskParams || {},
        }) as TaskResult

        let content = ''
        if (result.status === 'success') {
          if (taskCapability === 'screenshot') content = '已截屏'
          else if (taskCapability === 'app.open') content = `已打开 ${taskParams?.app_name || '应用'}`
          else if (taskCapability === 'file.read') content = result.data?.content || '文件已读取'
          else if (taskCapability === 'shell.exec') content = result.data?.stdout || '命令已执行'
          else if (taskCapability === 'ocr') content = result.data?.text || 'OCR完成'
          else content = '执行成功'
        } else {
          content = result.error_message || '执行失败'
        }

        const botMsg: Message = {
          id: `bot_${Date.now()}`,
          role: 'assistant',
          content,
          isStreaming: false,
          timestamp: Date.now(),
          is_task_result: true,
          execution_tier: result.execution_tier,
          task_status: result.status,
          screenshots: result.screenshots,
          duration_ms: result.duration_ms,
          error_message: result.error_message || undefined,
        }
        updateConversation(convId!, c => addMessage(c, botMsg))
        setStatus('idle')
      } catch (e: any) {
        const errMsg: Message = {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ 执行失败: ${String(e)}`,
          isStreaming: false,
          timestamp: Date.now(),
          is_task_result: true,
          execution_tier: 'none',
          task_status: 'error',
        }
        updateConversation(convId!, c => addMessage(c, errMsg))
        setStatus('error')
      }
      return
    }

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
        } else if (routeResult?.TaskRoute) {
          // Task路由：执行Agent能力
          const capability = routeResult.TaskRoute.capability || ''
          setStatus('thinking')
          try {
            // 构建task params
            let taskParams: any = {}
            if (capability === 'app.open') {
              const appName = text.replace(/打开|开启|启动/gi, '').trim()
              taskParams = { app_name: appName }
            } else if (capability === 'shell.exec') {
              const cmdMatch = text.match(/(?:执行|运行|跑一下)\s*(.+)/)
              taskParams = { command: cmdMatch ? cmdMatch[1].trim() : text }
            } else if (capability === 'file.read') {
              const pathMatch = text.match(/读(?:取)?文件?\s*(.+)/)
              taskParams = { path: pathMatch ? pathMatch[1].trim() : '' }
            }

            const result = await invoke('task_execute', {
              capability,
              params: taskParams,
            }) as TaskResult

            if (result.status === 'success') {
              if (capability === 'screenshot') response = '已截屏'
              else if (capability === 'app.open') response = `已打开 ${taskParams.app_name || '应用'}`
              else if (capability === 'file.read') response = result.data?.content || '文件已读取'
              else if (capability === 'shell.exec') response = result.data?.stdout || '命令已执行'
              else response = '执行成功'
            } else {
              response = result.error_message || '执行失败'
            }

            // Add as task result message with tier info
            const taskBotMsg: Message = {
              id: `bot_${Date.now()}`,
              role: 'assistant',
              content: response,
              isStreaming: false,
              timestamp: Date.now(),
              is_task_result: true,
              execution_tier: result.execution_tier,
              task_status: result.status,
              screenshots: result.screenshots,
              duration_ms: result.duration_ms,
              error_message: result.error_message || undefined,
            }
            updateConversation(convId!, c => addMessage(c, taskBotMsg))
            setStatus('idle')
            return // skip the generic bot message below
          } catch (e: any) {
            response = `⚠️ 执行失败: ${String(e)}`
          }
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
      {/* 桌面端：侧栏内联 */}
      {!isMobile && (
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
      )}
      {/* 移动端：抽屉式侧栏（点遮罩/选中会话自动关闭） */}
      {isMobile && mobileDrawerOpen && (
        <>
          <div
            onClick={() => setMobileDrawerOpen(false)}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.6)', zIndex: 9998,
            }}
          />
          <div style={{
            position: 'fixed', top: 0, left: 0, bottom: 0,
            width: '240px', zIndex: 9999,
            boxShadow: '4px 0 24px rgba(0,0,0,0.55)',
          }}>
            <Sidebar
              conversations={conversations}
              activeId={activeConvId}
              onSelect={(id) => { handleSelectConversation(id); setMobileDrawerOpen(false) }}
              onNew={() => { handleNewConversation(); setMobileDrawerOpen(false) }}
              onDelete={handleDeleteConversation}
              collapsed={false}
              onToggleCollapse={() => setMobileDrawerOpen(false)}
              activated={activated}
              plan={activationPlan}
              onActivate={handleActivate}
              onOpenSmcpChat={(t) => { handleOpenSmcpChat(t); setMobileDrawerOpen(false) }}
              onOpenGroupChat={(g, n) => { handleOpenGroupChat(g, n); setMobileDrawerOpen(false) }}
              accountId={sessionId}
              mySiliconId={mySiliconId}
            />
          </div>
        </>
      )}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0 }}>
        {/* 移动端汉堡按钮呼出抽屉 */}
        {isMobile && (
          <button
            onClick={() => setMobileDrawerOpen(true)}
            title="菜单"
            style={{
              position: 'absolute', top: '8px', left: '8px', zIndex: 100,
              width: '34px', height: '34px', borderRadius: '8px',
              background: 'rgba(42,42,58,0.92)', color: '#e6e6e6',
              border: 'none', fontSize: '16px', cursor: 'pointer',
            }}
          >
            ≡
          </button>
        )}
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
          myUserId={sessionId}
        />
      </div>
      {/* 远程任务审批弹窗 */}
      {taskApprovalRequest && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
        }}>
          <div style={{
            background: '#1e1e2e',
            borderRadius: '12px',
            padding: '24px',
            minWidth: '360px',
            maxWidth: '480px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            border: '1px solid #333',
          }}>
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#fff', marginBottom: '12px' }}>
              🔔 远程任务请求
            </div>
            <div style={{ fontSize: '14px', color: '#ccc', marginBottom: '8px' }}>
              来自 <span style={{ color: '#4fc3f7', fontWeight: 600 }}>{taskApprovalRequest.from_agent}</span> 的请求
            </div>
            <div style={{
              background: '#2a2a3a',
              borderRadius: '8px',
              padding: '12px',
              marginBottom: '16px',
            }}>
              <div style={{ fontSize: '13px', color: '#aaa', marginBottom: '4px' }}>请求操作</div>
              <div style={{ fontSize: '15px', color: '#fff', fontWeight: 500 }}>
                {taskApprovalRequest.capability === 'screenshot' ? '📸 截取屏幕' :
                 taskApprovalRequest.capability === 'app.open' ? `📱 打开应用 ${taskApprovalRequest.params?.app_name || ''}` :
                 taskApprovalRequest.capability === 'file.read' ? `📄 读取文件 ${taskApprovalRequest.params?.path || ''}` :
                 taskApprovalRequest.capability === 'shell.exec' ? `💻 执行命令 ${taskApprovalRequest.params?.command || ''}` :
                 taskApprovalRequest.capability === 'ocr' ? '🔍 OCR识别' :
                 `🔧 ${taskApprovalRequest.capability}`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => handleTaskApproval('reject')}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: '1px solid #555',
                  background: '#333',
                  color: '#e74c3c',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                拒绝
              </button>
              <button
                onClick={() => handleTaskApproval('allow')}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#2a5cff',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                本次允许
              </button>
              <button
                onClick={() => handleTaskApproval('always')}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#4CAF50',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                始终允许
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
