package com.xiaziteam.siliconmate

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.graphics.Rect
import android.os.Bundle

/**
 * 无障碍服务 — Agent版操控核心
 * 
 * 提供屏幕操控能力：点击、滑动、输入文字、截图坐标定位
 * 必须由用户在系统设置中手动开启无障碍权限
 */
class AgentAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "AgentA11y"
        var instance: AgentAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        instance = this
        Log.i(TAG, "AgentAccessibilityService connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 不需要监听事件，只提供操控能力
    }

    override fun onInterrupt() {
        instance = null
        Log.w(TAG, "AgentAccessibilityService interrupted")
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    // --- 操控API ---

    /** 点击屏幕坐标 (x, y) */
    fun tap(x: Int, y: Int, duration: Long = 50): Boolean {
        val path = Path().apply {
            moveTo(x.toFloat(), y.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    /** 滑动 (x1,y1) → (x2,y2) */
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long = 300): Boolean {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    /** 长按 */
    fun longPress(x: Int, y: Int, duration: Long = 500): Boolean {
        val path = Path().apply {
            moveTo(x.toFloat(), y.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    /** 在当前焦点的EditText中输入文字 */
    fun inputText(text: String): Boolean {
        val rootNode = rootInActiveWindow ?: return false
        val editNodes = rootNode.findAccessibilityNodeInfosByViewId("")
        
        // 找到可编辑的节点
        val editableNode = findEditableNode(rootNode)
        if (editableNode != null) {
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            val result = editableNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            Log.d(TAG, "inputText: set text on node, result=$result")
            return result
        }

        // 备用：使用剪贴板粘贴
        Log.w(TAG, "inputText: no editable node found, trying clipboard")
        return false
    }

    /** 按键：返回、Home、Recent */
    fun pressKey(action: Int): Boolean {
        return performGlobalAction(action)
    }

    /** 获取当前界面的UI树摘要 */
    fun getUITree(maxDepth: Int = 5): String {
        val rootNode = rootInActiveWindow ?: return "{\"error\":\"no window\"}"
        return serializeNode(rootNode, 0, maxDepth)
    }

    /** 获取当前Activity名 */
    fun getCurrentActivity(): String {
        val rootNode = rootInActiveWindow ?: return "unknown"
        return rootNode.packageName?.toString() ?: "unknown"
    }

    // --- 内部辅助 ---

    private fun findEditableNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                findEditableNode(child)?.let { return it }
            }
        }
        return null
    }

    private fun serializeNode(node: AccessibilityNodeInfo, depth: Int, maxDepth: Int): String {
        if (depth > maxDepth) return "{}"
        val rect = Rect()
        node.getBoundsInScreen(rect)
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"cls\":\"${node.className}\"")
        node.text?.let { sb.append(",\"text\":\"${escapeJson(it.toString())}\"") }
        node.contentDescription?.let { sb.append(",\"desc\":\"${escapeJson(it.toString())}\"") }
        sb.append(",\"bounds\":[${rect.left},${rect.top},${rect.right},${rect.bottom}]")
        sb.append(",\"clickable\":${node.isClickable}")
        sb.append(",\"editable\":${node.isEditable}")
        node.viewIdResourceName?.let { sb.append(",\"id\":\"${it}\"") }
        if (node.childCount > 0 && depth < maxDepth) {
            sb.append(",\"children\":[")
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { child ->
                    if (i > 0) sb.append(",")
                    sb.append(serializeNode(child, depth + 1, maxDepth))
                }
            }
            sb.append("]")
        }
        sb.append("}")
        return sb.toString()
    }

    private fun escapeJson(s: String): String {
        return s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
    }
}
