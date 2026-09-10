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

interface ImageAttachment {
  path: string
  name: string
  ocr_text: string | null
  ocr_status: 'pending' | 'success' | 'failed' | 'not_available' | 'no_text'
  file_size: number
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  isStreaming: boolean
  timestamp: number
}

interface ChatProps {
  onSendMessage: (text: string, attachments?: ImageAttachment[], deepThink?: boolean, feishuOutput?: boolean) => void
  onVoiceChat: () => void
  status: 'idle' | 'thinking' | 'deep_thinking' | 'streaming' | 'error'
  deepThinkProgress?: string
  serverConnected?: boolean
  serverConnecting?: boolean
  messages: Message[]
  isVoiceMode: boolean
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
}) => {
  const [input, setInput] = useState('')
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [isProcessingImage, setIsProcessingImage] = useState(false)
  const [deepThinkMode, setDeepThinkMode] = useState(false)
  const [feishuOutput, setFeishuOutput] = useState(false)
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
    onSendMessage(text, imageAttachments.length > 0 ? imageAttachments : undefined, deepThinkMode, feishuOutput)
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
        <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>硅侣</h1>
        <span style={{ fontSize: '12px', color: '#7a8aa0' }}>
          SiliconMate · 硅基生命数字人伴侣
        </span>
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

        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              maxWidth: '80%',
              padding: '10px 14px',
              borderRadius: '12px',
              lineHeight: '1.6',
              fontSize: '14px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              background: msg.role === 'user' ? '#2a5cff' : '#1c2030',
              color: '#fff',
              borderBottomRightRadius: msg.role === 'user' ? '4px' : undefined,
              borderBottomLeftRadius: msg.role === 'assistant' ? '4px' : undefined,
            }}
          >
            {msg.content}
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
          </div>
        ))}

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
      <div style={{
        display: 'flex',
        padding: '14px 20px',
        borderTop: '1px solid #222',
        gap: '10px',
      }}>
        {/* File upload button — uses tauri-plugin-dialog */}
        <button
          onClick={handleFileSelect}
          title="上传图片"
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

        {/* Voice chat button */}
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

        {/* ChatGPT button: start tunnel + open Safari */}
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

        {/* Deep think toggle */}
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

        {/* Feishu output toggle */}
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

        {/* Microphone button (voice input via Web Speech API) */}
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

        {/* Text input */}
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="说点什么…"
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
            background: '#2a5cff',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 22px',
            fontSize: '14px',
            cursor: (status === 'thinking' || status === 'deep_thinking') ? 'not-allowed' : 'pointer',
            opacity: (status === 'thinking' || status === 'deep_thinking') ? 0.6 : 1,
          }}
        >
          发送
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
