/**
 * 硅侣2.0 — 极简交互窗口
 *
 * 设计原则:
 * - 只显示用户输入和AI最终结论
 * - 严禁显示工具调用、模型名称、中间步骤
 * - 流式显示AI回复
 * - 附件上传按钮（回形针）
 * - 语音聊天切换按钮
 * - 状态提示（"硅侣正在思考…"）
 */

import React, { useState, useRef, useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { formatTime, formatFileSize, getGroupInfo } from './smcp'

interface ImageAttachment {
  path: string
  name: string
  ocr_text: string | null
  ocr_status: 'pending' | 'success' | 'failed' | 'not_available' | 'no_text'
  file_size: number
  data?: string // base64 for SMCP transfer
  type?: string // mime type for SMCP transfer
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  isStreaming: boolean
  timestamp: number
}

interface ChatProps {
  onSendMessage: (text: string, attachments?: ImageAttachment[], deepThink?: boolean, feishuOutput?: boolean, mentions?: string[]) => void
  onVoiceChat: () => void
  status: 'idle' | 'thinking' | 'deep_thinking' | 'streaming' | 'error'
  deepThinkProgress?: string
  serverConnected?: boolean
  serverConnecting?: boolean
  messages: Message[]
  isVoiceMode: boolean
  /** 如果是SMCP对话，传对方信息 */
  smcpTarget?: { userId: string; agentId: string; role: string } | null
  /** 如果是SMCP群聊，传群信息 */
  smcpGroupTarget?: { groupId: string; groupName: string; memberCount?: number; members?: { userId: string; role: string; accountName?: string; siliconId?: string }[] } | null
}

/** 高亮搜索关键词 */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query || !text.toLowerCase().includes(query.toLowerCase())) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  const before = text.slice(0, idx)
  const match = text.slice(idx, idx + query.length)
  const after = text.slice(idx + query.length)
  return <>
    {before}<span style={{ background: '#f39c12', color: '#000', borderRadius: '2px', padding: '0 2px' }}>{match}</span>{highlightText(after, query)}
  </>
}

export const Chat: React.FC<ChatProps> = ({
  onSendMessage,
  onVoiceChat,
  status,
  deepThinkProgress,
  serverConnected,
  serverConnecting,
  messages,
  isVoiceMode,
  smcpTarget,
  smcpGroupTarget,
}) => {
  const isSmcp = !!(smcpTarget || smcpGroupTarget)
  const [input, setInput] = useState('')
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [isProcessingImage, setIsProcessingImage] = useState(false)
  const [deepThinkMode, setDeepThinkMode] = useState(false)
  const [feishuOutput, setFeishuOutput] = useState(false)
  const [showGroupMembers, setShowGroupMembers] = useState(false)
  const [groupMembers, setGroupMembers] = useState<{ userId: string; role: string; accountName?: string; siliconId?: string }[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showMention, setShowMention] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const invoke = (window as any).__TAURI__?.core?.invoke

  // Microphone availability check via Web Speech API
  const [isRecording, setIsRecording] = useState(false)

  const handleMicInput = () => {
    // macOS系统听写：Fn两下 或 系统偏好→键盘→听写 开启
    // 聚焦输入框后用户按Fn两下即可语音输入
    inputRef.current?.focus()
    // Visual feedback - pulse the input
    setIsRecording(true)
    setTimeout(() => setIsRecording(false), 1500)
  }

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    const text = input.trim()
    if (!text && imageAttachments.length === 0) return
    // 提取@提及的成员名
    const mentions = text.match(/@(\S+)/g)?.map(m => m.slice(1)) || []
    onSendMessage(text, imageAttachments.length > 0 ? imageAttachments : undefined, deepThinkMode, feishuOutput, mentions.length > 0 ? mentions : undefined)
    setInput('')
    setImageAttachments([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileSelect = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: '图片文件',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']
        }]
      })

      if (!selected) return

      const filePath = typeof selected === 'string' ? selected : String(selected)
      if (!filePath) return

      setIsProcessingImage(true)

      if (invoke) {
        try {
          const result = await invoke('process_image', { imagePath: filePath }) as ImageAttachment
          setImageAttachments(prev => [...prev, result])
        } catch (e) {
          console.error('process_image error:', e)
          const fileName = filePath.split('/').pop() || 'unknown'
          setImageAttachments(prev => [...prev, {
            path: filePath,
            name: fileName,
            ocr_text: null,
            ocr_status: 'failed',
            file_size: 0,
          }])
        }
      }

      setIsProcessingImage(false)
    } catch (e) {
      console.error('File dialog error:', e)
      setIsProcessingImage(false)
    }
  }

  const handleRemoveAttachment = (index: number) => {
    setImageAttachments(prev => prev.filter((_, i) => i !== index))
  }

  // Status text
  const statusText = (() => {
    switch (status) {
      case 'thinking': return '硅侣正在思考…'
      case 'deep_thinking': return deepThinkProgress ? `🧠 ${deepThinkProgress}` : '硅侣正在深度思考…'
      case 'streaming': return ''
      case 'error': return '出错了，请重试'
      default: return ''
    }
  })()

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: '#0f1115',
      color: '#e6e6e6',
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    }}>
      {/* Header */}
      <header style={{
        padding: '14px 20px',
        background: 'linear-gradient(90deg, #1a2a4a, #0f1115)',
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}>
        <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
          {smcpGroupTarget ? `👥 ${smcpGroupTarget.groupName}` : smcpTarget ? `🦐 ${smcpTarget.role}` : '硅侣'}
        </h1>
        <span style={{ fontSize: '12px', color: '#7a8aa0' }}>
          {smcpGroupTarget
            ? `${smcpGroupTarget.memberCount || groupMembers.length || 0}人 · SMCP`
            : isSmcp
            ? 'SMCP · 虾群通讯'
            : 'SiliconMate · 硅基生命数字人伴侣'}
        </span>
        {/* 群成员按钮 */}
        {smcpGroupTarget && (
          <button
            onClick={async () => {
              if (!showGroupMembers) {
                const info = await getGroupInfo(smcpGroupTarget.groupId)
                if (info.ok && info.members) {
                  setGroupMembers(info.members.map(m => ({
                    userId: m.user_id,
                    role: m.role,
                    accountName: m.account_name,
                    siliconId: m.silicon_id,
                  })))
                }
              }
              setShowGroupMembers(!showGroupMembers)
            }}
            style={{
              marginLeft: '8px',
              background: '#2a2a3a',
              color: '#ccc',
              border: '1px solid #333',
              borderRadius: '6px',
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            {showGroupMembers ? '收起' : '📋 成员'}
          </button>
        )}
        {/* 搜索按钮 */}
        <button
          onClick={() => { setShowSearch(!showSearch); setSearchQuery('') }}
          style={{
            marginLeft: '8px',
            background: showSearch ? '#2a5cff' : '#2a2a3a',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: '6px',
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          🔍
        </button>
        {isVoiceMode && (
          <span style={{
            fontSize: '12px',
            color: '#2ecc71',
            marginLeft: 'auto',
          }}>
            🎤 语音聊天模式
          </span>
        )}
        {/* Server connection status indicator */}
        <span style={{
          fontSize: '11px',
          color: serverConnecting ? '#f39c12' : serverConnected ? '#2ecc71' : '#e74c3c',
          marginLeft: isVoiceMode ? '8px' : 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}>
          <span style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: serverConnecting ? '#f39c12' : serverConnected ? '#2ecc71' : '#e74c3c',
            display: 'inline-block',
          }} />
          {serverConnecting ? '连接中…' : serverConnected ? '服务端已连接' : '服务端未连接(深度思考不可用)'}
        </span>
      </header>

      {/* 群成员面板 */}
      {smcpGroupTarget && showGroupMembers && (
        <div style={{
          padding: '8px 20px',
          background: '#141820',
          borderBottom: '1px solid #222',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          maxHeight: '120px',
          overflowY: 'auto',
        }}>
          {groupMembers.length === 0 && (
            <span style={{ fontSize: '11px', color: '#555' }}>加载中…</span>
          )}
          {groupMembers.map(m => (
            <div key={m.userId} style={{
              background: '#1c2030',
              border: '1px solid #2a2a3a',
              borderRadius: '8px',
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
            }}>
              <span style={{ color: m.role === 'owner' ? '#f39c12' : '#2a5cff', fontWeight: 600 }}>
                {m.role === 'owner' ? '👑' : '👤'}
              </span>
              <span style={{ color: '#e6e6e6' }}>{m.accountName || m.userId.slice(0, 8)}</span>
              {m.siliconId && (
                <span style={{ color: '#555', fontSize: '9px' }}>({m.siliconId})</span>
              )}
            </div>
           ))}
         </div>
       )}

      {/* 消息搜索面板 */}
      {showSearch && (
        <div style={{
          padding: '6px 20px',
          background: '#141820',
          borderBottom: '1px solid #222',
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
        }}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索消息内容…"
            autoFocus
            style={{
              flex: 1,
              background: '#0f1115',
              border: '1px solid #333',
              borderRadius: '6px',
              padding: '4px 8px',
              color: '#e6e6e6',
              fontSize: '12px',
              outline: 'none',
            }}
          />
          <span style={{ fontSize: '11px', color: '#555' }}>
            {searchQuery ? `${messages.filter(m => m.content.toLowerCase().includes(searchQuery.toLowerCase())).length} 条匹配` : ''}
          </span>
        </div>
      )}

       {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {messages.length === 0 && (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#7a8aa0',
            fontSize: '16px',
          }}>
            说点什么… 🦐
          </div>
        )}

        {messages.map((msg, idx) => {
          const isUser = msg.role === 'user'
          // Search filter
          const isSearchMatch = !searchQuery || msg.content.toLowerCase().includes(searchQuery.toLowerCase())
          const isSearchDim = showSearch && searchQuery && !isSearchMatch
          // Check if this is the last message in the same minute for timestamp grouping
          const msgMinute = new Date(msg.timestamp).getMinutes()
          const msgHour = new Date(msg.timestamp).getHours()
          const nextMsg = messages[idx + 1]
          const isLastInMinute = !nextMsg ||
            new Date(nextMsg.timestamp).getMinutes() !== msgMinute ||
            new Date(nextMsg.timestamp).getHours() !== msgHour ||
            nextMsg.role !== msg.role

          // Detect file message pattern
          const fileMatch = msg.content.match(/📎\s*\[([^\]]+)\]\(([^)]+)\)/)
          const isFileMsg = !!fileMatch

          // Detect group sender name (pattern: 👥 senderName: content or 🦐 prefix)
          const groupSenderMatch = isSmcp && !isUser && msg.content.match(/^(👥|🦐)\s*([^\s:：]+)[：:]\s*([\s\S]*)$/)

          return (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                maxWidth: '100%',
              }}
            >
              {/* Group sender name */}
              {groupSenderMatch && (
                <span style={{
                  fontSize: '14px',
                  color: '#aaa',
                  marginBottom: '2px',
                  marginLeft: '4px',
                }}>
                  {groupSenderMatch[2]}
                </span>
              )}
              <div
                style={{
                  maxWidth: '70%',
                  padding: '10px 14px',
                  borderRadius: '10px',
                  lineHeight: '1.6',
                  fontSize: '14px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: isUser ? '#2a5cff' : '#2a2a3a',
                  color: '#fff',
                  borderBottomRightRadius: isUser ? '4px' : undefined,
                  borderBottomLeftRadius: !isUser ? '4px' : undefined,
                  opacity: isSearchDim ? 0.3 : 1,
                }}
              >
                {isFileMsg ? (
                  <div
                    onClick={() => {
                      if (fileMatch) {
                        const fileName = fileMatch[1]
                        const fileUrl = fileMatch[2]
  const invoke = (window as any).__TAURI__?.core?.invoke
                        if (invoke) {
                          invoke('download_and_open_file', { fileUrl, fileName }).catch(console.error)
                        } else {
                          window.open(fileUrl, '_blank')
                        }
                      }
                    }}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
                  >
                    <span style={{ fontSize: '18px' }}>📎</span>
                    <div>
                      <div style={{ fontSize: '14px', color: '#fff' }}>{fileMatch?.[1] || '文件'}</div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
                        {msg.content.match(/(\d+[BKMGT]B)/)?.[1] || '点击下载'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {highlightText(msg.content, searchQuery)}
                    {msg.isStreaming && (
                      <span style={{
                        display: 'inline-block',
                        width: '2px',
                        height: '14px',
                        background: '#7a8aa0',
                        marginLeft: '2px',
                        animation: 'blink 1s infinite',
                      }} />
                    )}
                  </>
                )}
              </div>
              {/* Timestamp */}
              {isLastInMinute && (
                <span style={{
                  fontSize: '12px',
                  color: '#888',
                  marginTop: '2px',
                  marginRight: isUser ? '4px' : undefined,
                  marginLeft: !isUser ? '4px' : undefined,
                }}>
                  {formatTime(msg.timestamp)}
                </span>
              )}
            </div>
          )
        })}

        {/* Status indicator */}
        {statusText && (
          <div style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            borderRadius: '8px',
            background: '#1c2030',
            color: status === 'deep_thinking' ? '#9b59b6' : '#7a8aa0',
            fontSize: '13px',
            fontStyle: 'italic',
          }}>
            {statusText}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Image attachment chips */}
      {(imageAttachments.length > 0 || isProcessingImage) && (
        <div style={{
          padding: '8px 20px',
          borderTop: '1px solid #222',
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
        }}>
          {isProcessingImage && (
            <span style={{
              background: '#1c2030',
              border: '1px solid #444',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '12px',
              color: '#aaa',
            }}>
              📷 正在识别图片...
            </span>
          )}
          {imageAttachments.map((att, i) => (
            <span key={i} style={{
              background: '#1c2030',
              border: '1px solid #333',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}>
              📷 {att.name}
              {att.ocr_status === 'success' && (
                <span style={{ color: '#2ecc71', fontSize: '10px' }}>✓ OCR</span>
              )}
              {att.ocr_status === 'failed' && (
                <span style={{ color: '#e74c3c', fontSize: '10px' }}>OCR失败</span>
              )}
              {att.ocr_status === 'no_text' && (
                <span style={{ color: '#f39c12', fontSize: '10px' }}>无文字</span>
              )}
              {att.ocr_status === 'not_available' && (
                <span style={{ color: '#f39c12', fontSize: '10px' }}>OCR未安装</span>
              )}
              {att.ocr_status === 'pending' && (
                <span style={{ color: '#7a8aa0', fontSize: '10px' }}>处理中</span>
              )}
              <button
                onClick={() => handleRemoveAttachment(i)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#7a8aa0',
                  cursor: 'pointer',
                  padding: '0 2px',
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input bar */}
      {/* @提及弹出面板 */}
      {showMention && smcpGroupTarget && (
        <div style={{
          position: 'absolute',
          bottom: '70px',
          left: '20px',
          background: '#1c2030',
          border: '1px solid #333',
          borderRadius: '10px',
          padding: '6px 0',
          maxHeight: '200px',
          overflowY: 'auto',
          zIndex: 100,
          minWidth: '180px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <div style={{ padding: '4px 12px', fontSize: '11px', color: '#666' }}>选择要@的成员</div>
          {groupMembers
            .filter(m => {
              const name = m.accountName || m.siliconId || m.userId
              return !mentionFilter || name.toLowerCase().includes(mentionFilter.toLowerCase())
            })
            .map(m => {
              const name = m.accountName || m.siliconId || m.userId
              return (
                <div
                  key={m.userId}
                  onClick={() => {
                    // 替换@后面的文字为选中的名字
                    const lastAtIndex = input.lastIndexOf('@')
                    if (lastAtIndex >= 0) {
                      setInput(input.slice(0, lastAtIndex) + `@${name} `)
                    } else {
                      setInput(input + `@${name} `)
                    }
                    setShowMention(false)
                    setMentionFilter('')
                    inputRef.current?.focus()
                  }}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    color: '#e6e6e6',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#252840'}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                >
                  <span style={{ fontSize: '10px', color: '#666' }}>{m.role === 'owner' ? '👑' : '👤'}</span>
                  <span>{name}</span>
                  {m.siliconId && <span style={{ fontSize: '10px', color: '#555' }}>{m.siliconId}</span>}
                </div>
              )
            })
          }
          {groupMembers.filter(m => {
            const name = m.accountName || m.siliconId || m.userId
            return !mentionFilter || name.toLowerCase().includes(mentionFilter.toLowerCase())
          }).length === 0 && (
            <div style={{ padding: '6px 12px', color: '#666', fontSize: '12px' }}>无匹配成员</div>
          )}
        </div>
      )}

      <div style={{
        display: 'flex',
        padding: '14px 20px',
        borderTop: '1px solid #222',
        gap: '10px',
      }}>
        {/* SMCP标识 */}
        {isSmcp && (
          <span style={{
            background: '#1a2a1a',
            border: '1px solid #2a4a2a',
            borderRadius: '10px',
            padding: '0 12px',
            color: '#4a8',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
          }}>
            🦐 SMCP
          </span>
        )}

        {/* File upload button — for both local and SMCP chats */}
        <button
          onClick={handleFileSelect}
          title="上传文件/图片"
          disabled={isProcessingImage}
          style={{
            background: '#2a2a3a',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 16px',
            cursor: isProcessingImage ? 'wait' : 'pointer',
            fontSize: '16px',
            opacity: isProcessingImage ? 0.6 : 1,
          }}
        >
          📎
        </button>

        {/* Voice chat button — only for local chat */}
        {!isSmcp && (
        <button
          onClick={onVoiceChat}
          title={isVoiceMode ? '返回日常对话' : '语音聊天'}
          style={{
            background: isVoiceMode ? '#2ecc71' : '#2a2a3a',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 16px',
            cursor: 'pointer',
            fontSize: '16px',
          }}
        >
          🗣️
        </button>
        )}

        {/* ChatGPT button — only for local chat */}
        {!isSmcp && (
        <button
          onClick={async () => {
            const invoke = (window as any).__TAURI__?.core?.invoke
            if (!invoke) return
            try {
              const result = await invoke('open_chatgpt_safari') as string
              console.log('[chatgpt]', result)
            } catch (e: any) {
              console.error('chatgpt error:', e)
              alert('打开ChatGPT失败: ' + String(e))
            }
          }}
          title="打开ChatGPT (需翻墙或激活码自动隧道)"
          style={{
            background: '#10a37f',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 12px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          ChatGPT
        </button>
        )}

        {/* Deep think toggle — only for local chat */}
        {!isSmcp && (
        <button
          onClick={() => {
            if (!serverConnected && !serverConnecting) {
              alert('服务端未连接，深度思考不可用。请检查网络后重新登录。')
              return
            }
            setDeepThinkMode(!deepThinkMode)
          }}
          title={!serverConnected ? '深度思考不可用(服务端未连接)' : deepThinkMode ? '关闭深度思考' : '开启深度思考(AgentChat多模型协作)'}
          disabled={serverConnecting}
          style={{
            background: !serverConnected ? '#1a1a2a' : deepThinkMode ? '#9b59b6' : '#2a2a3a',
            color: !serverConnected ? '#555' : '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 12px',
            cursor: !serverConnected || serverConnecting ? 'not-allowed' : 'pointer',
            fontSize: '13px',
            fontWeight: deepThinkMode ? 600 : 400,
            opacity: serverConnecting ? 0.5 : 1,
          }}
        >
          {serverConnecting ? '⏳ 连接中' : !serverConnected ? '🧠 ✗' : deepThinkMode ? '🧠 深度' : '🧠'}
        </button>
        )}

        {/* Feishu output toggle — only for local chat */}
        {!isSmcp && (
        <button
          onClick={() => setFeishuOutput(!feishuOutput)}
          title={feishuOutput ? '关闭飞书输出' : '输出到飞书文档/消息'}
          style={{
            background: feishuOutput ? '#2ecc71' : '#2a2a3a',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 12px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: feishuOutput ? 600 : 400,
          }}
        >
          {feishuOutput ? '飞书✓' : '飞书'}
        </button>
        )}

        {/* Microphone button — only for local chat */}
        {!isSmcp && (
        <button
          onClick={handleMicInput}
          title={isRecording ? '停止语音输入' : '语音输入'}
          style={{
            background: isRecording ? '#e74c3c' : '#2a2a3a',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 16px',
            cursor: 'pointer',
            fontSize: '16px',
            opacity: 1,
            animation: isRecording ? 'pulse 1.5s ease-in-out infinite' : 'none',
          }}
        >
          🎤
        </button>
        )}

        {/* Text input */}
        <input
          ref={inputRef}
          value={input}
          onChange={e => {
            const val = e.target.value
            setInput(val)
            // @提及触发：群聊中输入@时弹出成员列表
            if (smcpGroupTarget) {
              const lastAtIndex = val.lastIndexOf('@')
              if (lastAtIndex >= 0 && (lastAtIndex === 0 || val[lastAtIndex - 1] === ' ')) {
                const filter = val.slice(lastAtIndex + 1)
                if (!filter.includes(' ')) {
                  setMentionFilter(filter)
                  setShowMention(true)
                  return
                }
              }
              setShowMention(false)
            }
          }}
          onKeyDown={e => {
            if (showMention && e.key === 'Escape') {
              setShowMention(false)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={smcpGroupTarget ? `给 ${smcpGroupTarget.groupName} 发消息…` : smcpTarget ? `给 ${smcpTarget.role} 发消息…` : '说点什么…'}
          autoFocus
          style={{
            flex: 1,
            background: '#1c2030',
            border: '1px solid #333',
            borderRadius: '10px',
            padding: '10px 14px',
            color: '#e6e6e6',
            fontSize: '14px',
            outline: 'none',
          }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={status === 'thinking' || status === 'deep_thinking'}
          style={{
            background: isSmcp ? '#2a6a3a' : '#2a5cff',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 22px',
            fontSize: '14px',
            cursor: (status === 'thinking' || status === 'deep_thinking') ? 'not-allowed' : 'pointer',
            opacity: (status === 'thinking' || status === 'deep_thinking') ? 0.6 : 1,
          }}
        >
          {isSmcp ? '🦐 发送' : '发送'}
        </button>
      </div>

      {/* Blinking cursor animation + pulse animation */}
      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7); }
          70% { box-shadow: 0 0 0 10px rgba(231, 76, 60, 0); }
          100% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0); }
        }
      `}</style>
    </div>
  )
}
