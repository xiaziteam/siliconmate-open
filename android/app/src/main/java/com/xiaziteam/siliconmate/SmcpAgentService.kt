package com.xiaziteam.siliconmate

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * SMCP Agent Service — 消息收发 + 定时轮询
 * 
 * 重构自旧的AgentService(操控API) → 现在是消息总线节点
 * 
 * 功能:
 * - Agent注册/上线
 * - 定时轮询中继服务器拿消息
 * - 收到消息后通过WebView JS接口推送给前端
 * - 前端通过NativeBridge发送消息
 */
class SmcpAgentService : Service() {

    companion object {
        private const val TAG = "SmcpAgent"
        private const val NOTIF_CHANNEL_ID = "smcp_agent"
        private const val NOTIF_ID = 3
        private const val RELAY_BASE = "https://<YOUR_SERVER_HOST>/v1/smcp"
        private const val POLL_INTERVAL_SEC = 3L

        var isRunning = false
            private set
        var userId: String = ""
        var agentId: String = ""
            private set
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()
    private val JSON_MT = "application/json".toMediaType()
    private var scheduler: ScheduledExecutorService? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notif = android.app.Notification.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("硅侣Agent")
            .setContentText("消息服务运行中")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notif)
        isRunning = true
        startPolling()
        Log.i(TAG, "SmcpAgentService created, polling started")
    }

    override fun onDestroy() {
        stopPolling()
        // 通知下线
        if (userId.isNotEmpty()) {
            try {
                val json = JSONObject().apply {
                    put("user_id", userId)
                    put("agent_id", agentId)
                }
                val req = Request.Builder()
                    .url("$RELAY_BASE/agent/unregister")
                    .header("X-Account-Id", userId)
                    .post(json.toString().toRequestBody(JSON_MT))
                    .build()
                httpClient.newCall(req).execute()
            } catch (_: Exception) {}
        }
        isRunning = false
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.let {
            userId = it.getStringExtra("user_id") ?: ""
            agentId = it.getStringExtra("agent_id") ?: ""
        }
        // 注册到中继
        if (userId.isNotEmpty()) {
            registerAgent()
        }
        return START_STICKY
    }

    // --- Agent注册 ---

    private fun registerAgent() {
        try {
            val json = JSONObject().apply {
                put("user_id", userId)
                put("agent_id", agentId)
                put("role", "mobile")
                put("device", "android")
                put("capabilities", JSONArray().apply {
                    put("im"); put("tunnel"); put("notify")
                })
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/agent/register")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            if (resp.isSuccessful) {
                Log.i(TAG, "Agent registered: $agentId")
            } else {
                Log.w(TAG, "Agent register failed: ${resp.code}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Agent register error", e)
        }
    }

    // --- 消息轮询 ---

    private fun startPolling() {
        scheduler = Executors.newSingleThreadScheduledExecutor()
        scheduler?.scheduleAtFixedRate({
            if (userId.isEmpty() || agentId.isEmpty()) return@scheduleAtFixedRate
            try {
                // Poll direct messages
                val json = JSONObject().apply {
                    put("agent_id", agentId)
                    put("limit", 50)
                }
                val req = Request.Builder()
                    .url("$RELAY_BASE/message/poll")
                    .header("X-Account-Id", userId)
                    .post(json.toString().toRequestBody(JSON_MT))
                    .build()
                val resp = httpClient.newCall(req).execute()
                val body = resp.body?.string() ?: return@scheduleAtFixedRate
                val result = JSONObject(body)
                if (result.optBoolean("ok", false)) {
                    val messages = result.optJSONObject("data")?.optJSONArray("messages")
                    if (messages != null && messages.length() > 0) {
                        Log.i(TAG, "Received ${messages.length()} direct messages")
                        pushMessagesToFrontend(messages)
                    }
                }

                // Poll group messages
                try {
                    val groupListResult = getGroupListInternal()
                    if (groupListResult != null) {
                        val groups = groupListResult.optJSONArray("groups")
                        if (groups != null) {
                            for (i in 0 until groups.length()) {
                                val group = groups.getJSONObject(i)
                                val groupId = group.optString("group_id", "")
                                if (groupId.isEmpty()) continue
                                val groupMsgJson = JSONObject().apply {
                                    put("group_id", groupId)
                                    put("limit", 20)
                                }
                                val groupMsgReq = Request.Builder()
                                    .url("$RELAY_BASE/group/message/poll")
                                    .header("X-Account-Id", userId)
                                    .post(groupMsgJson.toString().toRequestBody(JSON_MT))
                                    .build()
                                val groupMsgResp = httpClient.newCall(groupMsgReq).execute()
                                val groupMsgBody = groupMsgResp.body?.string()
                                if (groupMsgBody != null) {
                                    val groupMsgResult = JSONObject(groupMsgBody)
                                    if (groupMsgResult.optBoolean("ok", false)) {
                                        val groupMessages = groupMsgResult.optJSONObject("data")?.optJSONArray("messages")
                                        if (groupMessages != null && groupMessages.length() > 0) {
                                            Log.i(TAG, "Received ${groupMessages.length()} group messages for $groupId")
                                            // Inject group_id into each message for frontend routing
                                            for (j in 0 until groupMessages.length()) {
                                                val msg = groupMessages.getJSONObject(j)
                                                val params = msg.optJSONObject("params")
                                                if (params == null) {
                                                    msg.put("params", JSONObject().apply { put("group_id", groupId) })
                                                } else {
                                                    params.put("group_id", groupId)
                                                }
                                            }
                                            pushMessagesToFrontend(groupMessages)
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "Group poll error: ${e.message}")
                }
            } catch (e: Exception) {
                Log.d(TAG, "Poll error: ${e.message}")
            }
        }, POLL_INTERVAL_SEC, POLL_INTERVAL_SEC, TimeUnit.SECONDS)
    }

    /** 内部获取群列表(用于轮询群消息) */
    private fun getGroupListInternal(): JSONObject? {
        return try {
            val req = Request.Builder()
                .url("$RELAY_BASE/group/list")
                .header("X-Account-Id", userId)
                .post("{}".toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            val body = resp.body?.string() ?: return null
            val result = JSONObject(body)
            if (result.optBoolean("ok", false)) {
                result.optJSONObject("data")
            } else null
        } catch (e: Exception) {
            null
        }
    }

    private fun stopPolling() {
        scheduler?.shutdownNow()
        scheduler = null
    }

    // --- 推送消息到前端 ---

    private fun pushMessagesToFrontend(messages: JSONArray) {
        // 通过MainActivity的WebView推送给React前端
        MainActivity.instance?.pushSmcpMessages(messages.toString()) ?: run {
            Log.w(TAG, "MainActivity not available, messages queued")
        }
        // 发送Android通知
        if (!MainActivity.isInForeground()) {
            for (i in 0 until messages.length()) {
                val msg = messages.optJSONObject(i) ?: continue
                val fromUser = msg.optString("from_user", "")
                val method = msg.optString("method", "")
                val params = msg.optJSONObject("params")
                val text = params?.optString("text") ?: params?.optString("content") ?: params?.optString("message") ?: ""
                if (method == "chat" || method == "im.send") {
                    showMessageNotification(fromUser, text, msg.optString("from_agent", ""))
                }
            }
        }
    }

    private fun showMessageNotification(fromUser: String, text: String, fromAgent: String) {
        val nm = getSystemService(NotificationManager::class.java)
        val notifId = (System.currentTimeMillis() % 100000).toInt()

        // 点击通知跳转到MainActivity
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("smcp_from_user", fromUser)
            putExtra("smcp_from_agent", fromAgent)
            data = android.net.Uri.parse("siliconmate://chat?from_user=$fromUser")
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = android.app.Notification.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("新消息 - $fromUser")
            .setContentText(if (text.length > 50) text.substring(0, 50) + "…" else text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        nm.notify(notifId, notif)
    }

    // --- 发送消息（供NativeBridge调用）---

    fun sendMessage(fromAgent: String, toAgent: String, toUser: String,
                    msgType: String, method: String, paramsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("from_agent", fromAgent)
                put("to_agent", toAgent)
                put("to_user", toUser)
                put("type", msgType)
                put("method", method)
                put("params", JSONObject(paramsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/message/send")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false,"error":"empty response"}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    // --- 好友操作 ---

    fun friendRequest(toUserId: String, message: String, permsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("to_user_id", toUserId)
                put("message", message)
                put("permissions", JSONObject(permsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/request")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendAccept(requestId: String, permsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("request_id", requestId)
                put("permissions", JSONObject(permsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/accept")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendList(): String {
        return try {
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/list")
                .header("X-Account-Id", userId)
                .post("{}".toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendSetPermissions(friendUserId: String, permsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("user_id", friendUserId)
                put("permissions", JSONObject(permsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/setPermissions")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendRemove(friendUserId: String): String {
        return try {
            val json = JSONObject().apply {
                put("user_id", friendUserId)
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/remove")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID,
                "SMCP消息服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Agent消息收发服务"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }
}
