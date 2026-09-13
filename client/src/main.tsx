/**
 * 硅侣3.0 — 入口
 * 
 * 平台适配: macOS用Tauri invoke, Android用NativeBridge
 * 在Android上注入__TAURI__适配层，让前端代码无需修改
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'

// Android NativeBridge适配: 注入__TAURI__.core.invoke
if (!(window as any).__TAURI__ && (window as any).NativeBridge) {
  const NB = (window as any).NativeBridge
  const accountStore: { accountId: string; siliconId: string; apiKey: string } = { accountId: '', siliconId: '', apiKey: '' }

  ;(window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any = {}) => {
        // 适配Tauri命令到NativeBridge方法
        switch (cmd) {
          // Account
          case 'l1_login': {
            const r = JSON.parse(NB.login(args.accountName, args.password))
            if (r.ok && r.data) {
              accountStore.accountId = r.data.account_id
              accountStore.siliconId = r.data.silicon_id || ''
              accountStore.apiKey = r.data.api_key || ''
              NB.setUserId(r.data.account_id)
            }
            return r.data
          }
          case 'register': {
            const r = JSON.parse(NB.register(args.accountName, args.password))
            if (r.ok && r.data) {
              accountStore.accountId = r.data.account_id
              accountStore.siliconId = r.data.silicon_id || ''
              NB.setUserId(r.data.account_id)
            }
            return r.data
          }
          case 'guest_enter': return {}
          case 'finish_enter': return {}
          case 'apply_session': return { session_id: accountStore.accountId }
          case 'account_activate': {
            const r = JSON.parse(NB.activate(args.code))
            return r.data
          }
          case 'heartbeat': return 'alive'
          case 'connect_server': return 'ok'
          case 'check_agent_health': return true

          // Agent
          case 'send_message': return '硅侣回复: 收到 (Android本地模式)'
          case 'route_message': return { ClientAgent: {} }
          case 'start_tunnel': return 'ok'
          case 'process_image': {
            // On Android, try OCR via NativeBridge first
            if (NB.ocrExtractText) {
              try {
                const r = JSON.parse(NB.ocrExtractText(args.imagePath))
                const data = r?.data || r
                return {
                  path: args.imagePath,
                  name: args.imagePath.split('/').pop() || 'image',
                  ocr_text: data?.text || null,
                  ocr_status: data?.text ? 'success' : (data?.error ? 'failed' : 'no_text'),
                  file_size: 0,
                }
              } catch (e) {
                return { path: args.imagePath, name: 'image', ocr_text: null, ocr_status: 'failed', file_size: 0 }
              }
            }
            return { path: '', name: '', ocr_text: null, ocr_status: 'not_available', file_size: 0 }
          }
          case 'open_chatgpt_safari': return 'ChatGPT模式暂不可用'

          // SMCP
          case 'smcp_register': {
            try {
              const resp = await fetch('https://example.com/v1/smcp/agent/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ user_id: args.userId, agent_id: args.agentId, role: args.role, device: args.device, capabilities: args.capabilities || ['im', 'tunnel', 'notify'] }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { ok: true }
            }
          }
          case 'smcp_agent_list': {
            try {
              const resp = await fetch('https://example.com/v1/smcp/agent/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ user_id: accountStore.accountId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { agents: [] }
            }
          }
          case 'smcp_message_send': {
            const r = JSON.parse(NB.smcpSendMessage(args.fromAgent, args.toAgent, args.toUser, args.msgType, args.method, JSON.stringify(args.params)))
            return r?.data || r
          }
          case 'smcp_message_poll': {
            try {
              const resp = await fetch('https://example.com/v1/smcp/message/poll', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ agent_id: args.agentId, limit: args.limit || 50 }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { messages: [] }
            }
          }
          case 'smcp_friend_request': {
            if (args.toSiliconId) {
              const r = JSON.parse(NB.smcpFriendRequestBySiliconId(args.toSiliconId, args.message, JSON.stringify(args.permissions || {})))
              return r?.data || r
            }
            const r = JSON.parse(NB.smcpFriendRequest(args.toUserId || '', args.message, JSON.stringify(args.permissions || {})))
            return r?.data || r
          }
          case 'smcp_friend_accept': {
            const r = JSON.parse(NB.smcpFriendAccept(args.requestId, JSON.stringify(args.permissions || {})))
            return r?.data || r
          }
          case 'smcp_friend_list': {
            const r = JSON.parse(NB.smcpFriendList())
            return r?.data || r
          }
          case 'smcp_friend_set_permissions': {
            const r = JSON.parse(NB.smcpSetPermissions(args.friendUserId, JSON.stringify(args.permissions || {})))
            return r?.data || r
          }
          case 'smcp_friend_remove': {
            const r = JSON.parse(NB.smcpFriendRemove(args.friendUserId))
            return r?.data || r
          }
          case 'smcp_friend_requests': {
            const r = NB.smcpPendingRequests()
            const parsed = JSON.parse(r)
            // API returns {ok, data:{pending_requests:[...]}} but frontend expects {requests:[...]}
            if (parsed?.data?.pending_requests) {
              return { requests: parsed.data.pending_requests }
            }
            return parsed?.data || parsed
          }
          case 'smcp_ping': {
            try {
              const resp = await fetch('https://example.com/v1/smcp/ping', {
                method: 'GET',
                headers: { 'X-Account-Id': accountStore.accountId },
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { ok: false }
            }
          }
          case 'smcp_lookup': {
            const r = JSON.parse(NB.smcpLookup(args.siliconId))
            return r?.data || r
          }
          case 'smcp_message_unread': {
            try {
              const resp = await fetch('https://example.com/v1/smcp/message/unread', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({}),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { count: 0 }
            }
          }
          case 'smcp_message_read': {
            try {
              const resp = await fetch('https://example.com/v1/smcp/message/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ msg_ids: args.msgIds || [] }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { updated: 0 }
            }
          }
          // ===== 群聊 =====
          case 'smcp_group_create': {
            if (NB.smcpGroupCreate) {
              try {
                const r = JSON.parse(NB.smcpGroupCreate(args.name, JSON.stringify(args.memberIds || [])))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            // Fallback to fetch for macOS
            try {
              const resp = await fetch('https://example.com/v1/smcp/group/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ name: args.name, member_ids: args.memberIds || [] }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_list': {
            if (NB.smcpGroupList) {
              try {
                const r = JSON.parse(NB.smcpGroupList())
                return r?.data || r
              } catch (e) { return { groups: [] } }
            }
            try {
              const resp = await fetch('https://example.com/v1/smcp/group/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({}),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { groups: [] } }
          }
          case 'smcp_group_info': {
            if (NB.smcpGroupInfo) {
              try {
                const r = JSON.parse(NB.smcpGroupInfo(args.groupId))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://example.com/v1/smcp/group/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ group_id: args.groupId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_invite': {
            try {
              const resp = await fetch('https://example.com/v1/smcp/group/invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ group_id: args.groupId, user_id: args.userId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_leave': {
            if (NB.smcpGroupLeave) {
              try {
                const r = JSON.parse(NB.smcpGroupLeave(args.groupId))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://example.com/v1/smcp/group/leave', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ group_id: args.groupId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_message_send': {
            if (NB.smcpGroupMessageSend) {
              try {
                const r = JSON.parse(NB.smcpGroupMessageSend(args.groupId, args.type || 'notify', args.method || 'im.send', JSON.stringify(args.params || {})))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://example.com/v1/smcp/group/message/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({
                  from_agent: args.fromAgent,
                  group_id: args.groupId,
                  type: args.type || 'notify',
                  method: args.method || 'im.send',
                  params: args.params || {},
                }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_file_upload': {
            if (NB.smcpFileUpload) {
              try {
                const r = JSON.parse(NB.smcpFileUpload(args.filename, args.data, args.contentType || 'application/octet-stream'))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://example.com/v1/smcp/file/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({
                  filename: args.filename,
                  data: args.data,
                  content_type: args.contentType || 'application/octet-stream',
                }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_file_upload_by_path': {
            if (NB.smcpFileUploadByPath) {
              try {
                const r = JSON.parse(NB.smcpFileUploadByPath(args.filePath))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            return { ok: false, error: 'Not available on this platform' }
          }
          case 'download_and_open_file': {
            if (NB.downloadAndOpenFile) {
              try {
                const r = JSON.parse(NB.downloadAndOpenFile(args.fileUrl, args.fileName || ''))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            // macOS: open URL in browser
            try {
              window.open(args.fileUrl, '_blank')
              return { ok: true }
            } catch (e) { return { ok: false, error: String(e) } }
          }
          // ===== OCR + 文件选择 =====
          case 'ocr_extract_text': {
            if (NB.ocrExtractText) {
              try {
                const r = JSON.parse(NB.ocrExtractText(args.imagePath))
                return r?.data || r
              } catch (e) { return { ok: false, text: '', error: String(e) } }
            }
            // macOS fallback: invoke Rust OCR
            return null
          }
          case 'pick_file': {
            if (NB.pickFile) {
              try {
                const r = NB.pickFile()
                const parsed = typeof r === 'string' ? JSON.parse(r) : r
                return parsed?.data || parsed
              } catch (e) { return { ok: false, error: String(e) } }
            }
            return null
          }
          default:
            console.warn('[NativeBridge] unhandled command:', cmd)
            return null
        }
      },
    },
    event: {
      listen: async () => () => {},
    },
  }
  console.log('[NativeBridge] __TAURI__适配层已注入')

  // Android通知点击回调
  ;(window as any).__siliconmate_native = {
    onNotificationChatOpen: (fromUser: string) => {
      console.log('[NativeBridge] notification chat open:', fromUser)
      // 触发自定义事件让App.tsx处理
      window.dispatchEvent(new CustomEvent('smcp-notification-chat', { detail: { fromUser } }))
    },
    onOcrResult: (text: string) => {
      console.log('[NativeBridge] OCR result:', text?.substring(0, 50))
      window.dispatchEvent(new CustomEvent('ocr-result', { detail: { text } }))
    },
    onOcrError: (error: string) => {
      console.log('[NativeBridge] OCR error:', error)
      window.dispatchEvent(new CustomEvent('ocr-error', { detail: { error } }))
    },
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
