import React, { useState } from 'react'
import { Conversation } from './conversation'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
  activated: boolean
  plan: string | null
  onActivate: (plan: string) => void
}

export const Sidebar: React.FC<SidebarProps> = ({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  collapsed,
  onToggleCollapse,
  activated,
  plan,
  onActivate,
}) => {
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showActivateModal, setShowActivateModal] = useState(false)
  const [activateCode, setActivateCode] = useState('')
  const [activateMsg, setActivateMsg] = useState('')
  const [activateLoading, setActivateLoading] = useState(false)

  const invoke = (window as any).__TAURI__?.core?.invoke

  const handleActivateSubmit = async () => {
    if (!activateCode.trim()) { setActivateMsg('请输入激活码'); return }
    setActivateLoading(true)
    setActivateMsg('激活中...')
    try {
      const resp = await invoke('account_activate', { code: activateCode.trim() })
      if (resp.tunnel) {
        try { await invoke('start_tunnel', { config: resp.tunnel }) } catch {}
      }
      setActivateMsg('')
      setShowActivateModal(false)
      setActivateCode('')
      onActivate(resp.plan)
    } catch (e: any) {
      const msg = String(e)
      if (msg.includes('未登录')) {
        setActivateMsg('请先注册或登录账号后再激活')
      } else {
        setActivateMsg(msg)
      }
    } finally {
      setActivateLoading(false)
    }
  }

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  if (collapsed) {
    return (
      <div style={{
        width: '48px',
        background: '#0a0c10',
        borderRight: '1px solid #222',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: '12px',
        gap: '8px',
        flexShrink: 0,
      }}>
        <button
          onClick={onToggleCollapse}
          title="展开侧边栏"
          style={{
            background: '#2a2a3a', color: '#e6e6e6', border: 'none',
            borderRadius: '8px', width: '36px', height: '36px', cursor: 'pointer', fontSize: '16px',
          }}
        >
          ≡
        </button>
        <button
          onClick={onNew}
          title="新建对话"
          style={{
            background: '#2a5cff', color: '#fff', border: 'none',
            borderRadius: '8px', width: '36px', height: '36px', cursor: 'pointer', fontSize: '18px',
          }}
        >
          +
        </button>
        <div title={activated ? '已激活' : '未激活'} style={{
          fontSize: '14px', color: activated ? '#2ecc71' : '#e74c3c', marginTop: '4px',
        }}>
          {activated ? '🟢' : '🔴'}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      width: '240px',
      background: '#0a0c10',
      borderRight: '1px solid #222',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      position: 'relative',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid #222',
      }}>
        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e6e6e6' }}>对话</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={onToggleCollapse}
            title="折叠侧边栏"
            style={{
              background: '#2a2a3a', color: '#aaa', border: 'none',
              borderRadius: '6px', width: '28px', height: '28px', cursor: 'pointer', fontSize: '14px',
            }}
          >
            ◀
          </button>
          <button
            onClick={onNew}
            title="新建对话"
            style={{
              background: '#2a5cff', color: '#fff', border: 'none',
              borderRadius: '6px', width: '28px', height: '28px', cursor: 'pointer', fontSize: '16px',
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Activation status */}
      <div style={{
        padding: '8px 14px',
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        {activated ? (
          <span style={{ fontSize: '12px', color: '#2ecc71' }}>
            🟢 已激活 · {plan || 'basic'}
          </span>
        ) : (
          <>
            <span style={{ fontSize: '12px', color: '#e74c3c' }}>
              🔴 未激活 · 仅本地对话
            </span>
            <button
              onClick={() => setShowActivateModal(true)}
              style={{
                background: '#2a5cff', color: '#fff', border: 'none',
                borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '11px',
              }}
            >
              激活
            </button>
          </>
        )}
      </div>

      {/* Conversation list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '6px',
      }}>
        {sorted.length === 0 && (
          <div style={{
            color: '#555', fontSize: '12px', textAlign: 'center', padding: '20px 0',
          }}>
            暂无对话
          </div>
        )}
        {sorted.map(conv => {
          const isActive = conv.id === activeId
          const isDeleting = conv.id === deleteConfirmId
          const lastMsg = conv.messages[conv.messages.length - 1]
          const preview = lastMsg
            ? (lastMsg.content.length > 30 ? lastMsg.content.slice(0, 30) + '…' : lastMsg.content)
            : '空对话'

          return (
            <div
              key={conv.id}
              onClick={() => { onSelect(conv.id); setDeleteConfirmId(null) }}
              style={{
                padding: '8px 10px',
                borderRadius: '8px',
                marginBottom: '2px',
                cursor: 'pointer',
                background: isActive ? '#1a2a4a' : 'transparent',
                borderLeft: isActive ? '3px solid #2a5cff' : '3px solid transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLDivElement).style.background = '#141820'
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span style={{
                  fontSize: '13px',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? '#e6e6e6' : '#bbb',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}>
                  {conv.title}
                </span>
                {isActive && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      if (isDeleting) {
                        onDelete(conv.id)
                        setDeleteConfirmId(null)
                      } else {
                        setDeleteConfirmId(conv.id)
                        setTimeout(() => setDeleteConfirmId(null), 3000)
                      }
                    }}
                    style={{
                      background: isDeleting ? '#e74c3c' : 'transparent',
                      color: isDeleting ? '#fff' : '#555',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '1px 5px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      marginLeft: '4px',
                    }}
                  >
                    {isDeleting ? '确认?' : '×'}
                  </button>
                )}
              </div>
              <div style={{
                fontSize: '11px',
                color: '#666',
                marginTop: '2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {preview}
              </div>
            </div>
          )
        })}
      </div>

      {/* Activate modal */}
      {showActivateModal && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
        }}>
          <div style={{
            background: '#1a1d25',
            borderRadius: '12px',
            padding: '24px',
            width: '200px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
          }}>
            <p style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: '#e6e6e6', textAlign: 'center' }}>
              输入激活码
            </p>
            <input
              type="text"
              placeholder="GL-XXX-XXXX"
              value={activateCode}
              onChange={e => setActivateCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleActivateSubmit()}
              style={{
                width: '100%',
                background: '#0f1115',
                border: '1px solid #333',
                borderRadius: '8px',
                padding: '8px 12px',
                color: '#e6e6e6',
                fontSize: '13px',
                outline: 'none',
                marginBottom: '12px',
                boxSizing: 'border-box',
                letterSpacing: '1px',
              }}
            />
            <button
              onClick={handleActivateSubmit}
              disabled={activateLoading}
              style={{
                width: '100%',
                background: '#2a5cff',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                padding: '8px',
                fontSize: '14px',
                cursor: activateLoading ? 'not-allowed' : 'pointer',
                marginBottom: '8px',
                opacity: activateLoading ? 0.6 : 1,
              }}
            >
              {activateLoading ? '激活中...' : '激活'}
            </button>
            <button
              onClick={() => { setShowActivateModal(false); setActivateMsg(''); setActivateCode('') }}
              style={{
                width: '100%',
                background: 'transparent',
                color: '#7a8aa0',
                border: '1px solid #333',
                borderRadius: '8px',
                padding: '6px',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              取消
            </button>
            {activateMsg && (
              <p style={{
                marginTop: '8px',
                fontSize: '12px',
                textAlign: 'center',
                color: activateMsg.includes('成功') ? '#2ecc71' : '#e74c3c',
              }}>
                {activateMsg}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
