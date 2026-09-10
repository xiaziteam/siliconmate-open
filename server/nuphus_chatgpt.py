#!/usr/bin/env python3
"""ChatGPT对话编排 — 通过nuphus-mcp (MCP stdio) 控制Chrome CDP实现ChatGPT对话

用法：
  python3 nuphus_chatgpt.py --login          # 自动登录ChatGPT
  python3 nuphus_chatgpt.py --send "你好"     # 发送消息并等待回复
  python3 nuphus_chatgpt.py --status          # 检查登录状态
  python3 nuphus_chatgpt.py --launch-chrome   # 启动Chrome CDP实例
  python3 nuphus_chatgpt.py --health          # 健康检查

核心架构：
  nuphus_chatgpt.py ←(WS)→ siliconmate-bridge.py ←(WS)→ ui/index.html
  nuphus_chatgpt.py ←(MCP stdio)→ nuphus-mcp ←(CDP)→ Chrome (端口9222)

MCP stdio协议：
  每次调用启动新nuphus-mcp子进程，initialize→tools/call→parse result
  环境变量 NUPHUS_MCP_BROWSER_CDP_URL=http://127.0.0.1:9222
"""

import json
import os
import sys
import time
import asyncio
import logging
import argparse
import subprocess
import shutil
import signal
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Optional, Dict, Any, List

# ─── 配置常量 ───
NUPHUS_MCP_BIN = os.path.expanduser("~/bin/nuphus-mcp")
CDP_PORT = 9222
CDP_PROFILE_DIR = "/tmp/chrome-cdp-profile"
CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_COOKIES_DB = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Cookies")
CHROME_BOOKMARKS = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Bookmarks")
CHROME_ACCOUNT_BOOKMARKS = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/AccountBookmarks")
CHATGPT_URL = "https://chatgpt.com/"
COOKIE_SYNC_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookie_sync.py")
CF_COOKIE_NAMES = {'__cf_bm', 'cf_clearance', '__cflb', '_cfuvid', 'cf_chl_rc_ni'}
MAX_POLL_ATTEMPTS = 60  # 60 * 5秒 = 5分钟 (o3-mini thinking可能3-5分钟)
POLL_INTERVAL = 5  # 秒
MSG_TIMEOUT = 300  # 5分钟 (o3-mini thinking可能需要)
MAX_RECONNECT_ATTEMPTS = 3

# ─── 日志配置 ───
logger = logging.getLogger("nuphus_chatgpt")


class NuphusMCPClient:
    """nuphus-mcp MCP stdio通信客户端
    
    每次调用启动新的nuphus-mcp子进程（MCP stdio特性），完成initialize+tools/call后进程退出。
    Chrome CDP连接本身是持久的（端口9222）。
    """
    
    def __init__(self, cdp_url: str = f"http://127.0.0.1:{CDP_PORT}"):
        self.cdp_url = cdp_url
        self.msg_id = 0
        self._process = None
    
    def _next_id(self) -> int:
        self.msg_id += 1
        return self.msg_id
    
    def _build_request(self, method: str, params: dict = None) -> dict:
        return {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": method,
            "params": params or {}
        }
    
    def _parse_response(self, line: str) -> dict:
        """解析MCP JSON-RPC响应"""
        try:
            resp = json.loads(line)
            if "error" in resp:
                raise MCPError(resp["error"].get("message", str(resp["error"])))
            return resp.get("result", {})
        except json.JSONDecodeError as e:
            raise MCPError(f"JSON解析失败: {line[:200]}")
    
    def _call_mcp(self, requests: list) -> list:
        """启动nuphus-mcp子进程，发送请求序列，收集响应
        
        Args:
            requests: MCP JSON-RPC请求列表（按顺序发送）
        
        Returns:
            响应列表（按id排序）
        """
        env = os.environ.copy()
        env["NUPHUS_MCP_BROWSER_CDP_URL"] = self.cdp_url
        
        # 写入stdin的请求数据
        stdin_data = "\n".join(json.dumps(r) for r in requests) + "\n"
        
        logger.debug(f"MCP调用: {[r.get('method') for r in requests]}")
        
        proc = subprocess.Popen(
            [NUPHUS_MCP_BIN],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )
        
        stdout, stderr = proc.communicate(input=stdin_data.encode(), timeout=120)
        
        if proc.returncode != 0 and proc.returncode != -2:
            err_msg = stderr.decode()[:500]
            logger.warning(f"nuphus-mcp退出码 {proc.returncode}: {err_msg}")
        
        # 解析stdout中的每一行JSON-RPC响应
        responses = {}
        for line in stdout.decode().strip().split("\n"):
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                resp = json.loads(line)
                rid = resp.get("id")
                if rid:
                    responses[rid] = resp
            except json.JSONDecodeError:
                continue
        
        # 按请求顺序返回响应
        results = []
        for req in requests:
            rid = req.get("id")
            if rid in responses:
                resp = responses[rid]
                if "error" in resp:
                    raise MCPError(resp["error"].get("message", str(resp["error"])))
                results.append(resp.get("result", {}))
            else:
                raise MCPError(f"未收到id={rid}的响应")
        
        return results
    
    def call_tool(self, tool_name: str, arguments: dict = None) -> Any:
        """调用单个MCP工具
        
        包含initialize + tools/call两个请求
        """
        requests = [
            self._build_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "siliconmate", "version": "3.0"}
            }),
            self._build_request("tools/call", {
                "name": tool_name,
                "arguments": arguments or {}
            })
        ]
        
        results = self._call_mcp(requests)
        if len(results) < 2:
            raise MCPError(f"工具调用 {tool_name} 返回不足2个响应")
        
        # 解析tools/call结果
        tool_result = results[1]
        content = tool_result.get("content", [])
        
        if isinstance(content, list) and len(content) > 0:
            text = content[0].get("text", "")
            # 尝试解析JSON
            try:
                return json.loads(text)
            except (json.JSONDecodeError, TypeError):
                return text
        return tool_result
    
    def call_tool_raw(self, tool_name: str, arguments: dict = None) -> str:
        """调用MCP工具并返回原始文本结果"""
        requests = [
            self._build_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "siliconmate", "version": "3.0"}
            }),
            self._build_request("tools/call", {
                "name": tool_name,
                "arguments": arguments or {}
            })
        ]
        
        results = self._call_mcp(requests)
        if len(results) < 2:
            raise MCPError(f"工具调用 {tool_name} 返回不足2个响应")
        
        tool_result = results[1]
        content = tool_result.get("content", [])
        
        if isinstance(content, list) and len(content) > 0:
            return content[0].get("text", "")
        return str(tool_result)
    
    def check_health(self) -> dict:
        """健康检查：验证nuphus-mcp二进制和Chrome CDP可达性"""
        result = {
            "nuphus_mcp": False,
            "chrome_cdp": False,
            "chrome_installed": False,
        }
        
        # 检查nuphus-mcp二进制
        result["nuphus_mcp"] = os.path.isfile(NUPHUS_MCP_BIN) and os.access(NUPHUS_MCP_BIN, os.X_OK)
        
        # 检查Chrome安装
        result["chrome_installed"] = os.path.isfile(CHROME_PATH)
        
        # 检查CDP端口
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=3)
            if resp.status == 200:
                info = json.loads(resp.read())
                result["chrome_cdp"] = True
                result["chrome_version"] = info.get("Browser", "unknown")
        except Exception:
            pass
        
        return result
    
    # ─── 浏览器工具封装 ───
    
    def browser_navigate(self, url: str) -> str:
        """导航到URL"""
        logger.info(f"导航到 {url}")
        return self.call_tool_raw("browser_navigate", {"url": url})
    
    def browser_snapshot(self, selector: str = None, full: bool = False) -> str:
        """获取页面快照"""
        args = {}
        if selector:
            args["selector"] = selector
        if full:
            args["full"] = True
        return self.call_tool_raw("browser_snapshot", args)
    
    def browser_type(self, selector: str, text: str) -> str:
        """在输入框中输入文本"""
        logger.info(f"输入文本到 {selector}: {text[:50]}...")
        return self.call_tool_raw("browser_type", {"selector": selector, "text": text})
    
    def browser_press(self, key: str) -> str:
        """按键"""
        logger.info(f"按键: {key}")
        return self.call_tool_raw("browser_press", {"key": key})
    
    def browser_evaluate(self, script: str) -> Any:
        """执行JavaScript"""
        return self.call_tool("browser_evaluate", {"script": script})
    
    def browser_extract(self, max_chars: int = 8000) -> str:
        """提取页面文本"""
        return self.call_tool_raw("browser_extract", {"max_chars": max_chars})
    
    def browser_import_cookies(self, domain: str = None) -> str:
        """从Chrome profile导入cookies"""
        args = {}
        if domain:
            args["domain"] = domain
        logger.info(f"导入cookies (domain={domain})")
        return self.call_tool_raw("browser_import_cookies", args)
    
    def browser_cookies_set(self, name: str, value: str, domain: str = None, path: str = None) -> str:
        """设置单个cookie"""
        args = {"name": name, "value": value}
        if domain:
            args["domain"] = domain
        if path:
            args["path"] = path
        return self.call_tool_raw("browser_cookies_set", args)
    
    def browser_cookies_get(self) -> Any:
        """获取当前页面所有cookies"""
        return self.call_tool("browser_cookies_get")
    
    def browser_click(self, selector: str = None, ref: str = None, button: str = "left", snapshot: bool = True) -> str:
        """点击元素"""
        args = {"button": button, "snapshot": snapshot}
        if selector:
            args["selector"] = selector
        if ref:
            args["ref"] = ref
        return self.call_tool_raw("browser_click", args)
    
    def browser_close(self) -> str:
        """关闭浏览器"""
        return self.call_tool_raw("browser_close")


class MCPError(Exception):
    """MCP协议错误"""
    pass


class MCPSession:
    """持久化MCP会话 — 一个nuphus-mcp进程贯穿整个操作周期
    
    解决锁冲突问题：避免每次轮询创建新进程争抢CDP锁。
    用法：
        with MCPSession(cdp_url) as session:
            session.call_tool("browser_navigate", {"url": "..."})
            result = session.call_tool("browser_evaluate", {"script": "1+1"})
    """
    
    def __init__(self, cdp_url: str = f"http://127.0.0.1:{CDP_PORT}"):
        self.cdp_url = cdp_url
        self.msg_id = 0
        self._proc = None
        self._lock = threading.Lock()
        self._initialized = False
    
    def __enter__(self):
        self.open()
        return self
    
    def __exit__(self, *args):
        self.close()
    
    def open(self):
        """启动nuphus-mcp进程并初始化"""
        env = os.environ.copy()
        env["NUPHUS_MCP_BROWSER_CDP_URL"] = self.cdp_url
        
        self._proc = subprocess.Popen(
            [NUPHUS_MCP_BIN],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            bufsize=0  # unbuffered
        )
        
        # 发送initialize请求
        init_req = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "siliconmate-session", "version": "3.0"}
            }
        }
        self._write_request(init_req)
        resp = self._read_response(init_req["id"])
        
        if "error" in resp:
            raise MCPError(f"初始化失败: {resp['error']}")
        
        self._initialized = True
        logger.debug("MCPSession已初始化")
    
    def close(self):
        """关闭nuphus-mcp进程"""
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        self._proc = None
        self._initialized = False
    
    def _next_id(self) -> int:
        self.msg_id += 1
        return self.msg_id
    
    def _write_request(self, request: dict):
        """向nuphus-mcp stdin写入JSON-RPC请求"""
        line = json.dumps(request) + "\n"
        self._proc.stdin.write(line.encode())
        self._proc.stdin.flush()
    
    def _read_response(self, expected_id: int, timeout: float = 30) -> dict:
        """从nuphus-mcp stdout读取指定id的JSON-RPC响应
        
        跳过通知等非预期响应，只返回匹配expected_id的响应。
        """
        deadline = time.time() + timeout
        
        while time.time() < deadline:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            
            # 用select检查stdout是否可读（非阻塞）
            import select
            ready, _, _ = select.select([self._proc.stdout], [], [], min(remaining, 5))
            if not ready:
                continue
            
            line = self._proc.stdout.readline()
            if not line:
                raise MCPError("nuphus-mcp进程已退出")
            
            line = line.decode().strip()
            if not line or not line.startswith("{"):
                continue
            
            try:
                resp = json.loads(line)
            except json.JSONDecodeError:
                continue
            
            rid = resp.get("id")
            if rid == expected_id:
                if "error" in resp:
                    raise MCPError(resp["error"].get("message", str(resp["error"])))
                return resp.get("result", {})
            # 非目标响应，跳过（可能是通知等）
        
        raise MCPError(f"等待id={expected_id}响应超时")
    
    def call_tool(self, tool_name: str, arguments: dict = None) -> Any:
        """调用MCP工具（持久会话版，不创建新进程）"""
        with self._lock:
            req = {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": arguments or {}
                }
            }
            self._write_request(req)
            result = self._read_response(req["id"])
            
            content = result.get("content", [])
            if isinstance(content, list) and len(content) > 0:
                text = content[0].get("text", "")
                # 尝试解析JSON
                try:
                    return json.loads(text)
                except (json.JSONDecodeError, TypeError):
                    return text
            return result
    
    def call_tool_raw(self, tool_name: str, arguments: dict = None) -> str:
        """调用MCP工具并返回原始文本（持久会话版）"""
        with self._lock:
            req = {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": arguments or {}
                }
            }
            self._write_request(req)
            result = self._read_response(req["id"])
            
            content = result.get("content", [])
            if isinstance(content, list) and len(content) > 0:
                return content[0].get("text", "")
            return str(result)
    
    def browser_evaluate(self, script: str) -> Any:
        """执行JavaScript"""
        return self.call_tool("browser_evaluate", {"script": script})
    
    def browser_navigate(self, url: str) -> str:
        """导航到URL"""
        return self.call_tool_raw("browser_navigate", {"url": url})
    
    def browser_type(self, selector: str, text: str) -> str:
        """在输入框中输入文本"""
        return self.call_tool_raw("browser_type", {"selector": selector, "text": text})
    
    def browser_click(self, selector: str = None) -> str:
        """点击元素"""
        args = {"button": "left", "snapshot": False}
        if selector:
            args["selector"] = selector
        return self.call_tool_raw("browser_click", args)
    
    def browser_press(self, key: str) -> str:
        """按键"""
        return self.call_tool_raw("browser_press", {"key": key})


class ChromeCDPManager:
    """Chrome CDP实例管理"""
    
    def __init__(self, port: int = CDP_PORT, profile_dir: str = CDP_PROFILE_DIR):
        self.port = port
        self.profile_dir = profile_dir
        self._chrome_process = None
    
    def is_cdp_running(self) -> bool:
        """检查CDP端口是否可达"""
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=3)
            return resp.status == 200
        except Exception:
            return False
    
    def is_chrome_installed(self) -> bool:
        """检查Chrome是否安装"""
        return os.path.isfile(CHROME_PATH)
    
    def launch_chrome(self) -> Optional[subprocess.Popen]:
        """启动Chrome CDP实例
        
        Returns:
            Chrome子进程，如果已运行返回None
        """
        if self.is_cdp_running():
            logger.info(f"Chrome CDP已在端口 {self.port} 运行")
            return None
        
        if not self.is_chrome_installed():
            raise RuntimeError("Chrome未安装，请先安装Google Chrome")
        
        # 确保profile目录存在
        os.makedirs(os.path.join(self.profile_dir, "Default"), exist_ok=True)
        
        # 复制书签到CDP profile
        self._copy_bookmarks()
        
        cmd = [
            CHROME_PATH,
            f"--remote-debugging-port={self.port}",
            f"--user-data-dir={self.profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            CHATGPT_URL
        ]
        
        logger.info(f"启动Chrome CDP: 端口={self.port}, profile={self.profile_dir}")
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # 等待CDP就绪
        for i in range(30):
            if self.is_cdp_running():
                info = self.get_version()
                logger.info(f"Chrome CDP就绪: {info}")
                self._chrome_process = proc
                return proc
            time.sleep(1)
        
        raise RuntimeError(f"Chrome CDP端口 {self.port} 超时未就绪")
    
    def _copy_bookmarks(self):
        """复制书签到CDP profile"""
        dest_dir = os.path.join(self.profile_dir, "Default")
        
        for src_path in [CHROME_BOOKMARKS, CHROME_ACCOUNT_BOOKMARKS]:
            if os.path.isfile(src_path):
                fname = os.path.basename(src_path)
                dest = os.path.join(dest_dir, fname)
                try:
                    shutil.copy2(src_path, dest)
                    logger.info(f"复制书签: {src_path} → {dest}")
                except Exception as e:
                    logger.warning(f"复制书签失败 {src_path}: {e}")
    
    def get_version(self) -> str:
        """获取Chrome版本信息"""
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=3)
            info = json.loads(resp.read())
            return info.get("Browser", "unknown")
        except Exception:
            return "unknown"
    
    def terminate(self):
        """优雅终止Chrome进程"""
        if self._chrome_process and self._chrome_process.poll() is None:
            logger.info("终止Chrome CDP进程...")
            self._chrome_process.terminate()
            try:
                self._chrome_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._chrome_process.kill()
            
            # 清理临时profile
            try:
                shutil.rmtree(self.profile_dir, ignore_errors=True)
                logger.info(f"清理临时profile: {self.profile_dir}")
            except Exception as e:
                logger.warning(f"清理profile失败: {e}")


class CookieManager:
    """Cookie解密与过滤管理"""
    
    def __init__(self):
        self._cookies = None
    
    def decrypt_cookies(self, domain: str = "chatgpt", exclude_cf: bool = True) -> List[dict]:
        """从系统Chrome解密cookies
        
        Args:
            domain: 域名过滤
            exclude_cf: 是否排除CF cookies
        
        Returns:
            CDP格式cookie列表
        """
        if not os.path.isfile(COOKIE_SYNC_SCRIPT):
            raise RuntimeError(f"cookie_sync.py不存在: {COOKIE_SYNC_SCRIPT}")
        
        # 调用cookie_sync.py解密
        args = [sys.executable, COOKIE_SYNC_SCRIPT, "--domain", domain]
        if not exclude_cf:
            args.append("--no-cf-exclude")
        
        proc = subprocess.run(args, capture_output=True, text=True, timeout=30)
        
        if proc.returncode != 0:
            raise RuntimeError(f"cookie解密失败: {proc.stderr[:200]}")
        
        try:
            cookies = json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"cookie解析失败: {proc.stdout[:200]}")
        
        self._cookies = cookies
        return cookies
    
    def decrypt_to_file(self, output_path: str, domain: str = "chatgpt", exclude_cf: bool = True) -> str:
        """解密cookies并写入文件"""
        args = [sys.executable, COOKIE_SYNC_SCRIPT, "--domain", domain, "--output", output_path]
        if not exclude_cf:
            args.append("--no-cf-exclude")
        
        proc = subprocess.run(args, capture_output=True, text=True, timeout=30)
        
        if proc.returncode != 0:
            raise RuntimeError(f"cookie解密失败: {proc.stderr[:200]}")
        
        return output_path
    
    @staticmethod
    def filter_cf_cookies(cookies: List[dict]) -> List[dict]:
        """过滤CF cookies"""
        return [c for c in cookies if c.get("name") not in CF_COOKIE_NAMES]
    
    def has_chatgpt_session(self, cookies: List[dict] = None) -> bool:
        """检查是否有有效的ChatGPT session cookies"""
        cookie_list = cookies or self._cookies or []
        return any('session-token' in c.get('name', '') for c in cookie_list)
    
    def check_session_validity(self, client: NuphusMCPClient) -> dict:
        """检查cookies是否过期（通过/api/auth/session状态码）"""
        result = client.browser_evaluate("""
            (() => {
                return fetch('/api/auth/session')
                    .then(r => ({status: r.status, ok: r.ok}))
                    .catch(e => ({error: e.message}));
            })()
        """)
        return result if isinstance(result, dict) else {"raw": result}
    
    def verify_cf_exclusion(self, client: NuphusMCPClient) -> dict:
        """反面验证：故意注入CF cookies，确认CF challenge卡住
        
        ⚠️ 此方法仅用于验证CF排除逻辑的正确性，会暂时注入CF cookies
        使用后应立即清除CF cookies
        """
        result = {"cf_challenge_triggered": False, "message": ""}
        
        # 先获取Chrome的cf_clearance
        try:
            all_cookies = self.decrypt_cookies(exclude_cf=False)
            cf_cookies = [c for c in all_cookies if c['name'] in CF_COOKIE_NAMES]
        except RuntimeError as e:
            result["message"] = f"获取CF cookies失败: {e}"
            return result
        
        if not cf_cookies:
            result["message"] = "未找到CF cookies，无法执行反面验证"
            return result
        
        # 注入CF cookies
        for cf_cookie in cf_cookies:
            try:
                client.browser_cookies_set(
                    name=cf_cookie["name"],
                    value=cf_cookie["value"],
                    domain=cf_cookie.get("domain", ".chatgpt.com"),
                    path=cf_cookie.get("path", "/")
                )
            except MCPError as e:
                logger.warning(f"注入CF cookie {cf_cookie['name']} 失败: {e}")
        
        # 导航到chatgpt.com并检查是否被CF拦截
        try:
            client.browser_navigate(CHATGPT_URL)
            import time
            time.sleep(5)
            
            # 检查是否出现CF challenge
            eval_result = client.browser_evaluate("""
                (() => {
                    const body = document.body?.innerText || '';
                    const isCFChallenge = body.includes('Checking your browser') || 
                                          body.includes('Just a moment') ||
                                          body.includes('cf-challenge') ||
                                          document.querySelector('#challenge-running') !== null;
                    return JSON.stringify({isCFChallenge, bodySnippet: body.substring(0, 200)});
                })()
            """)
            
            if isinstance(eval_result, str):
                try:
                    eval_result = json.loads(eval_result)
                except json.JSONDecodeError:
                    pass
            
            if isinstance(eval_result, dict) and eval_result.get("isCFChallenge"):
                result["cf_challenge_triggered"] = True
                result["message"] = "✅ CF challenge被触发 — 证明CF cookies排除逻辑正确"
            else:
                result["message"] = "⚠️ CF challenge未触发 — 可能CDP Chrome指纹匹配了CF cookies"
        except MCPError as e:
            result["message"] = f"验证失败: {e}"
        
        return result


class ChatGPTController:
    """ChatGPT对话控制器 — 编排登录、发送、接收"""
    
    def __init__(self, mcp_client: NuphusMCPClient = None, chrome_manager: ChromeCDPManager = None, cookie_manager: CookieManager = None):
        self.mcp = mcp_client or NuphusMCPClient()
        self.chrome = chrome_manager or ChromeCDPManager()
        self.cookies = cookie_manager or CookieManager()
    
    def auto_login(self) -> dict:
        """自动登录编排：检测Chrome→启动CDP→cookie导入→navigate→验证登录
        
        Returns:
            {"success": bool, "message": str, "chrome_version": str}
        """
        result = {"success": False, "message": "", "chrome_version": ""}
        
        # 1. 检测Chrome安装
        if not self.chrome.is_chrome_installed():
            result["message"] = "❌ Chrome未安装。请先安装Google Chrome: https://www.google.com/chrome/"
            return result
        
        # 2. 启动/检测CDP Chrome
        try:
            proc = self.chrome.launch_chrome()
        except RuntimeError as e:
            result["message"] = f"❌ Chrome启动失败: {e}"
            return result
        
        result["chrome_version"] = self.chrome.get_version()
        
        # 3. 解密cookies
        try:
            chatgpt_cookies = self.cookies.decrypt_cookies(domain="chatgpt", exclude_cf=True)
        except RuntimeError as e:
            result["message"] = f"❌ Cookie解密失败: {e}"
            return result
        
        # 检查是否有效session
        if not self.cookies.has_chatgpt_session(chatgpt_cookies):
            result["message"] = "❌ 未检测到ChatGPT session cookies。请先在Chrome中登录 chatgpt.com"
            return result
        
        # 4. 导航到ChatGPT
        try:
            self.mcp.browser_navigate(CHATGPT_URL)
            time.sleep(3)
        except MCPError as e:
            result["message"] = f"❌ 导航失败: {e}"
            return result
        
        # 5. 导入cookies（排除CF）
        try:
            import_result = self.mcp.browser_import_cookies(domain="chatgpt.com")
            logger.info(f"Cookies导入结果: {import_result[:200]}")
        except MCPError as e:
            # Fallback: 逐个设置cookies
            logger.warning(f"browser_import_cookies失败，尝试逐个设置: {e}")
            self._set_cookies_individually(chatgpt_cookies)
        
        # 6. 刷新页面并等待
        try:
            self.mcp.browser_navigate(CHATGPT_URL)
            time.sleep(5)
        except MCPError as e:
            result["message"] = f"❌ 刷新页面失败: {e}"
            return result
        
        # 7. 验证登录
        login_status = self.check_login()
        if login_status.get("isLoggedIn"):
            # 8. 检查session是否过期
            try:
                session_status = self.cookies.check_session_validity(self.mcp)
                if isinstance(session_status, dict):
                    if session_status.get("status") == 403:
                        result["message"] = "❌ Session已过期，请在Chrome中重新登录 chatgpt.com"
                        return result
                    logger.info(f"Session状态: {session_status}")
            except Exception as e:
                logger.warning(f"Session检查失败: {e}")
            
            result["success"] = True
            result["message"] = f"✅ ChatGPT已登录 ({login_status.get('email', 'unknown')})"
        else:
            result["message"] = f"❌ 登录验证失败: {login_status.get('bodySnippet', 'unknown')}"
        
        return result
    
    def _send_in_one_session(self, message: str, session: 'MCPSession' = None):
        """在单个MCP会话中完成消息输入和发送
        
        如果提供session参数，使用持久会话（避免锁冲突）。
        否则回退到旧的多进程方式。
        """
        if session:
            # 持久会话模式 — 所有操作在同一个nuphus-mcp进程中
            # 清空输入框
            session.call_tool("browser_evaluate", {
                "script": """
                    (() => {
                        const ta = document.querySelector('#prompt-textarea');
                        if (ta) {
                            ta.innerHTML = '';
                            ta.textContent = '';
                            ta.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'deleteContent'}));
                        }
                        return 'cleared';
                    })()
                """
            })
            # 输入消息
            session.call_tool("browser_type", {
                "selector": "#prompt-textarea",
                "text": message
            })
            # 点击发送按钮
            session.call_tool("browser_click", {
                "selector": "[data-testid='send-button']"
            })
            logger.info(f"消息已发送 (持久会话): {message[:50]}...")
        else:
            # 旧模式 — 兼容CLI调用等场景
            requests = [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "siliconmate", "version": "3.0"}
                    }
                },
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "browser_evaluate",
                        "arguments": {
                            "script": """
                                (() => {
                                    const ta = document.querySelector('#prompt-textarea');
                                    if (ta) {
                                        ta.innerHTML = '';
                                        ta.textContent = '';
                                        ta.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'deleteContent'}));
                                    }
                                    return 'cleared';
                                })()
                            """
                        }
                    }
                },
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "browser_type",
                        "arguments": {
                            "selector": "#prompt-textarea",
                            "text": message
                        }
                    }
                },
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "browser_click",
                        "arguments": {
                            "selector": "[data-testid='send-button']"
                        }
                    }
                }
            ]
            self.mcp._call_mcp(requests)
            logger.info(f"消息已发送 (单会话): {message[:50]}...")
    
    def _count_conversation_turns(self) -> int:
        """获取当前会话的conversation-turn数量"""
        try:
            result = self.mcp.browser_evaluate(
                'document.querySelectorAll("[data-testid^=conversation-turn-]").length'
            )
            if isinstance(result, (int, float)):
                return int(result)
            if isinstance(result, str):
                try:
                    return int(result)
                except ValueError:
                    return 0
            return 0
        except MCPError:
            return 0
    
    def _set_cookies_individually(self, cookies: List[dict]):
        """逐个设置cookies（browser_import_cookies的fallback）"""
        for cookie in cookies:
            if cookie.get("name") in CF_COOKIE_NAMES:
                continue
            try:
                self.mcp.browser_cookies_set(
                    name=cookie["name"],
                    value=cookie["value"],
                    domain=cookie.get("domain", ".chatgpt.com"),
                    path=cookie.get("path", "/")
                )
            except MCPError as e:
                logger.warning(f"设置cookie {cookie['name']} 失败: {e}")
    
    def check_login(self) -> dict:
        """检查ChatGPT登录状态"""
        try:
            snapshot = self.mcp.browser_snapshot()
            # 检查快照中是否有"个人资料"按钮或登录指示
            is_logged_in = "个人资料" in snapshot or "profile-button" in snapshot or "Log in" not in snapshot
            
            # 用browser_evaluate做更精确的检测
            eval_result = self.mcp.browser_evaluate("""
                (() => {
                    const profileBtn = document.querySelector('[data-testid="profile-button"]');
                    const emailEl = document.querySelector('img[alt*="@"]');
                    const loginBtn = document.querySelector('button[data-provider]');
                    const bodyText = document.body?.innerText?.substring(0, 500) || '';
                    const hasLogin = !!profileBtn || (bodyText.includes('免费') && !loginBtn);
                    return JSON.stringify({
                        isLoggedIn: hasLogin,
                        email: emailEl?.alt || '',
                        bodySnippet: bodyText.substring(0, 200)
                    });
                })()
            """)
            
            if isinstance(eval_result, str):
                try:
                    return json.loads(eval_result)
                except json.JSONDecodeError:
                    pass
            elif isinstance(eval_result, dict):
                return eval_result
            
            return {"isLoggedIn": is_logged_in, "bodySnippet": snapshot[:200]}
        except MCPError as e:
            return {"isLoggedIn": False, "error": str(e)}
    
    def send_message(self, message: str, timeout: int = MSG_TIMEOUT) -> dict:
        """发送消息到ChatGPT并等待回复
        
        使用单个MCPSession持久会话完成整个send+poll周期，
        避免每次轮询创建新nuphus-mcp进程导致CDP锁冲突。
        
        Returns:
            {"status": "done"|"thinking"|"error"|"timeout", "reply": str}
        """
        result = {"status": "error", "reply": ""}
        
        # 整个send+poll在一个MCPSession中完成
        try:
            with MCPSession(self.mcp.cdp_url) as session:
                # 1. 获取当前会话轮数
                try:
                    turns_result = session.browser_evaluate(
                        'document.querySelectorAll("[data-testid^=conversation-turn-]").length'
                    )
                    if isinstance(turns_result, (int, float)):
                        pre_turns = int(turns_result)
                    elif isinstance(turns_result, str):
                        try:
                            pre_turns = int(turns_result)
                        except ValueError:
                            pre_turns = 0
                    else:
                        pre_turns = 0
                except MCPError:
                    pre_turns = 0
                logger.info(f"发送前会话轮数: {pre_turns}")
                
                # 2. 清空→输入→发送（同一session）
                try:
                    self._send_in_one_session(message, session=session)
                except MCPError as e:
                    result["reply"] = f"❌ 发送消息失败: {e}"
                    return result
                
                result["status"] = "thinking"
                
                # 3. 轮询回复（同一session，不再创建新进程）
                start_time = time.time()
                for attempt in range(MAX_POLL_ATTEMPTS):
                    time.sleep(POLL_INTERVAL)
                    elapsed = int(time.time() - start_time)
                    
                    try:
                        poll_result = self._poll_reply_with_session(session, pre_turns)
                        
                        if poll_result.get("done") and poll_result.get("text"):
                            result["status"] = "done"
                            result["reply"] = poll_result["text"]
                            logger.info(f"收到回复 (耗时 {elapsed}s): {poll_result['text'][:100]}...")
                            return result
                        
                        if poll_result.get("thinking"):
                            logger.debug(f"[{elapsed}s] ChatGPT思考中...")
                            result["status"] = "thinking"
                        
                        if poll_result.get("error"):
                            result["status"] = "error"
                            result["reply"] = f"❌ 回复检测错误: {poll_result['error']}"
                            return result
                        
                    except MCPError as e:
                        logger.warning(f"轮询失败 (尝试 {attempt+1}/{MAX_RECONNECT_ATTEMPTS}): {e}")
                        if attempt < MAX_RECONNECT_ATTEMPTS:
                            time.sleep(2)
                            continue
                        else:
                            result["status"] = "error"
                            result["reply"] = f"❌ CDP连接失败: {e}"
                            return result
                    
                    if elapsed >= timeout:
                        result["status"] = "timeout"
                        result["reply"] = f"⏱ 回复超时 ({timeout}秒)"
                        return result
                
                result["status"] = "timeout"
                result["reply"] = f"⏱ 回复超时 (超过 {MAX_POLL_ATTEMPTS * POLL_INTERVAL}秒)"
                return result
                
        except MCPError as e:
            result["status"] = "error"
            result["reply"] = f"❌ MCP会话失败: {e}"
            return result
        except Exception as e:
            result["status"] = "error"
            result["reply"] = f"❌ 未知错误: {e}"
            return result
    
    def _poll_reply(self, pre_turns: int = 0) -> dict:
        """检测ChatGPT回复状态（旧版，每次创建新nuphus-mcp进程）
        
        Args:
            pre_turns: 发送消息前的conversation-turn数量，用于识别新回复
        
        使用多种策略检测回复：
        1. [data-testid="conversation-turn-N"] 选择器（新UI）
        2. [data-message-author-role="assistant"] 选择器（旧UI）
        3. main文本变化检测（fallback）
        """
        eval_result = self.mcp.browser_evaluate(f"""
            (() => {{
                const main = document.querySelector('main');
                if (!main) return JSON.stringify({{text: '', done: false, thinking: false, error: 'no main'}});
                
                const preTurns = {pre_turns};
                
                // 策略1: 新UI — conversation-turn选择器
                const turns = main.querySelectorAll('[data-testid^="conversation-turn-"]');
                if (turns.length > 0) {{
                    // 找新增加的assistant turn（跳过之前已存在的）
                    // ChatGPT UI: turn-N 奇数=用户, 偶数=助手 (1-based)
                    // 新消息会产生2个新turn: 用户turn + 助手turn
                    const expectedAssistantTurn = preTurns + 2;  // 新的助手turn编号
                    
                    let lastAssistantTurn = null;
                    let lastAssistantTurnIdx = -1;
                    
                    for (let i = turns.length - 1; i >= 0; i--) {{
                        const text = turns[i].innerText || '';
                        // 助手turn包含"ChatGPT 说："或直接是回复文本（没有"你说："）
                        if (!text.startsWith('你说') && !text.includes('你说：\\n') && 
                            (text.includes('ChatGPT') || i % 2 === 1)) {{
                            lastAssistantTurn = turns[i];
                            lastAssistantTurnIdx = i;
                            break;
                        }}
                    }}
                    
                    // 如果turns数量还没超过preTurns，说明新消息还没出现
                    if (turns.length <= preTurns) {{
                        return JSON.stringify({{text: '', done: false, thinking: true, turnCount: turns.length, source: 'conversation-turn'}});
                    }}
                    
                    if (lastAssistantTurn) {{
                        const turnText = lastAssistantTurn.innerText || '';
                        // 检查thinking状态
                        const isThinking = turnText.includes('思考') || turnText.includes('Thinking') || turnText.includes('思考中');
                        // 检查streaming状态
                        const isStreaming = !!lastAssistantTurn.querySelector('[class*="result-streaming"]');
                        
                        // 提取回复文本（去掉"ChatGPT 说："前缀和免责声明）
                        let replyText = turnText;
                        const chatgptIdx = replyText.indexOf('ChatGPT 说：');
                        if (chatgptIdx >= 0) {{
                            replyText = replyText.substring(chatgptIdx + 'ChatGPT 说：'.length).trim();
                        }}
                        const chatgptIdx2 = replyText.indexOf('ChatGPT 说：');
                        if (chatgptIdx2 >= 0) {{
                            replyText = replyText.substring(chatgptIdx2 + 'ChatGPT 说：'.length).trim();
                        }}
                        
                        // 去掉免责声明
                        const disclaimers = ['ChatGPT 也可能会犯错', 'ChatGPT can make mistakes'];
                        for (const d of disclaimers) {{
                            const di = replyText.indexOf(d);
                            if (di > 0) replyText = replyText.substring(0, di).trim();
                        }}
                        
                        if (replyText && !isStreaming && !isThinking) {{
                            return JSON.stringify({{text: replyText, done: true, thinking: false, turnCount: turns.length, source: 'conversation-turn'}});
                        }}
                        
                        return JSON.stringify({{text: replyText, done: false, thinking: isThinking || isStreaming, turnCount: turns.length, source: 'conversation-turn'}});
                    }}
                }}
                
                // 策略2: 旧UI — [data-message-author-role="assistant"]
                const assistant = document.querySelector('[data-message-author-role="assistant"]');
                if (assistant) {{
                    const responseEls = assistant.querySelectorAll('.markdown');
                    const responseText = responseEls.length > 0 
                        ? responseEls[responseEls.length-1].innerText?.trim() 
                        : '';
                    
                    const isThinking = !!assistant.querySelector('[class*="thinking"]');
                    const isStreaming = !!assistant.querySelector('[class*="result-streaming"]');
                    
                    if (responseText && !isStreaming && !isThinking) {{
                        return JSON.stringify({{text: responseText, done: true, thinking: false, source: 'author-role'}});
                    }}
                    
                    return JSON.stringify({{text: responseText, done: false, thinking: isThinking || isStreaming, source: 'author-role'}});
                }}
                
                // 策略3: 通过main文本检测（last resort）
                const mainText = main.innerText || '';
                const thinkingIndicators = ['思考', 'thinking', 'Thought for'];
                const isThinking = thinkingIndicators.some(ind => mainText.toLowerCase().includes(ind.toLowerCase()));
                
                return JSON.stringify({{text: '', done: false, thinking: isThinking, mainTextLen: mainText.length, source: 'fallback'}});
            }})()
        """)
        
        if isinstance(eval_result, str):
            try:
                return json.loads(eval_result)
            except json.JSONDecodeError:
                return {"text": "", "done": False, "thinking": True}
        elif isinstance(eval_result, dict):
            return eval_result
        
        return {"text": "", "done": False, "thinking": True}
    
    def _poll_reply_with_session(self, session: 'MCPSession', pre_turns: int = 0) -> dict:
        """检测ChatGPT回复状态（持久会话版，不创建新进程）
        
        与_poll_reply逻辑完全相同，但使用已有的MCPSession，
        避免每次轮询创建新nuphus-mcp进程导致CDP锁冲突。
        """
        eval_result = session.browser_evaluate(f"""
            (() => {{
                const main = document.querySelector('main');
                if (!main) return JSON.stringify({{text: '', done: false, thinking: false, error: 'no main'}});
                
                const preTurns = {pre_turns};
                
                // 策略1: 新UI — conversation-turn选择器
                const turns = main.querySelectorAll('[data-testid^="conversation-turn-"]');
                if (turns.length > 0) {{
                    let lastAssistantTurn = null;
                    let lastAssistantTurnIdx = -1;
                    
                    for (let i = turns.length - 1; i >= 0; i--) {{
                        const text = turns[i].innerText || '';
                        if (!text.startsWith('你说') && !text.includes('你说：\\n') && 
                            (text.includes('ChatGPT') || i % 2 === 1)) {{
                            lastAssistantTurn = turns[i];
                            lastAssistantTurnIdx = i;
                            break;
                        }}
                    }}
                    
                    if (turns.length <= preTurns) {{
                        return JSON.stringify({{text: '', done: false, thinking: true, turnCount: turns.length, source: 'conversation-turn'}});
                    }}
                    
                    if (lastAssistantTurn) {{
                        const turnText = lastAssistantTurn.innerText || '';
                        const isThinking = turnText.includes('思考') || turnText.includes('Thinking') || turnText.includes('思考中');
                        const isStreaming = !!lastAssistantTurn.querySelector('[class*="result-streaming"]');
                        
                        let replyText = turnText;
                        const chatgptIdx = replyText.indexOf('ChatGPT 说：');
                        if (chatgptIdx >= 0) {{
                            replyText = replyText.substring(chatgptIdx + 'ChatGPT 说：'.length).trim();
                        }}
                        const chatgptIdx2 = replyText.indexOf('ChatGPT 说：');
                        if (chatgptIdx2 >= 0) {{
                            replyText = replyText.substring(chatgptIdx2 + 'ChatGPT 说：'.length).trim();
                        }}
                        
                        const disclaimers = ['ChatGPT 也可能会犯错', 'ChatGPT can make mistakes'];
                        for (const d of disclaimers) {{
                            const di = replyText.indexOf(d);
                            if (di > 0) replyText = replyText.substring(0, di).trim();
                        }}
                        
                        if (replyText && !isStreaming && !isThinking) {{
                            return JSON.stringify({{text: replyText, done: true, thinking: false, turnCount: turns.length, source: 'conversation-turn'}});
                        }}
                        
                        return JSON.stringify({{text: replyText, done: false, thinking: isThinking || isStreaming, turnCount: turns.length, source: 'conversation-turn'}});
                    }}
                }}
                
                // 策略2: 旧UI
                const assistant = document.querySelector('[data-message-author-role="assistant"]');
                if (assistant) {{
                    const responseEls = assistant.querySelectorAll('.markdown');
                    const responseText = responseEls.length > 0 
                        ? responseEls[responseEls.length-1].innerText?.trim() 
                        : '';
                    
                    const isThinking = !!assistant.querySelector('[class*="thinking"]');
                    const isStreaming = !!assistant.querySelector('[class*="result-streaming"]');
                    
                    if (responseText && !isStreaming && !isThinking) {{
                        return JSON.stringify({{text: responseText, done: true, thinking: false, source: 'author-role'}});
                    }}
                    
                    return JSON.stringify({{text: responseText, done: false, thinking: isThinking || isStreaming, source: 'author-role'}});
                }}
                
                // 策略3: fallback
                const mainText = main.innerText || '';
                const thinkingIndicators = ['思考', 'thinking', 'Thought for'];
                const isThinking = thinkingIndicators.some(ind => mainText.toLowerCase().includes(ind.toLowerCase()));
                
                return JSON.stringify({{text: '', done: false, thinking: isThinking, mainTextLen: mainText.length, source: 'fallback'}});
            }})()
        """)
        
        if isinstance(eval_result, str):
            try:
                return json.loads(eval_result)
            except json.JSONDecodeError:
                return {"text": "", "done": False, "thinking": True}
        elif isinstance(eval_result, dict):
            return eval_result
        
        return {"text": "", "done": False, "thinking": True}
    
    def extract_reply(self) -> str:
        """提取ChatGPT最后一条回复文本"""
        try:
            result = self.mcp.browser_evaluate("""
                (() => {
                    const main = document.querySelector('main');
                    if (!main) return '';
                    
                    // 新UI: conversation-turn选择器
                    const turns = main.querySelectorAll('[data-testid^="conversation-turn-"]');
                    if (turns.length > 0) {
                        let lastAssistantTurn = null;
                        for (const turn of turns) {
                            const text = turn.innerText || '';
                            if (text.includes('ChatGPT') && text.includes('说')) {
                                lastAssistantTurn = turn;
                            }
                        }
                        if (lastAssistantTurn) {
                            const turnText = lastAssistantTurn.innerText || '';
                            const lines = turnText.split('\\n');
                            const chatgptIdx = lines.findIndex(l => l.includes('ChatGPT') && l.includes('说'));
                            let replyText = '';
                            if (chatgptIdx >= 0 && chatgptIdx + 1 < lines.length) {
                                replyText = lines.slice(chatgptIdx + 1).join('\\n').trim();
                            }
                            // 去掉免责声明
                            const di1 = replyText.indexOf('ChatGPT 也可能会犯错');
                            if (di1 > 0) replyText = replyText.substring(0, di1).trim();
                            const di2 = replyText.indexOf('ChatGPT can make mistakes');
                            if (di2 > 0) replyText = replyText.substring(0, di2).trim();
                            return replyText || turnText.trim();
                        }
                    }
                    
                    // 旧UI: [data-message-author-role="assistant"]
                    const assistant = document.querySelector('[data-message-author-role="assistant"]');
                    if (!assistant) return '';
                    const markdowns = assistant.querySelectorAll('.markdown');
                    if (markdowns.length === 0) return assistant.innerText?.trim() || '';
                    return markdowns[markdowns.length-1].innerText?.trim() || '';
                })()
            """)
            if isinstance(result, str):
                return result
            return str(result)
        except MCPError as e:
            logger.error(f"提取回复失败: {e}")
            return ""


# ─── WS桥接集成 ───

async def handle_send_message(message: str) -> dict:
    """WS桥接调用的消息处理入口
    
    Returns:
        {"status": "done"|"thinking"|"error"|"timeout", "reply": str}
    """
    controller = ChatGPTController()
    return controller.send_message(message)


# ─── CLI入口 ───

# 全局Chrome管理器（用于优雅终止）
_chrome_manager = None


def _cleanup():
    """atexit处理：优雅终止Chrome进程"""
    global _chrome_manager
    if _chrome_manager:
        _chrome_manager.terminate()


def _signal_handler(signum, frame):
    """信号处理：Ctrl+C等信号时优雅终止"""
    global _chrome_manager
    logger.info(f"收到信号 {signum}，正在清理...")
    if _chrome_manager:
        _chrome_manager.terminate()
    sys.exit(0)


def main():
    global _chrome_manager
    
    parser = argparse.ArgumentParser(description='ChatGPT对话编排 — nuphus-mcp + Chrome CDP')
    parser.add_argument('--login', action='store_true', help='自动登录ChatGPT')
    parser.add_argument('--send', '-s', help='发送消息到ChatGPT')
    parser.add_argument('--status', action='store_true', help='检查ChatGPT登录状态')
    parser.add_argument('--launch-chrome', action='store_true', help='启动Chrome CDP实例')
    parser.add_argument('--health', action='store_true', help='健康检查')
    parser.add_argument('--cookies', action='store_true', help='解密并显示ChatGPT cookies')
    parser.add_argument('--timeout', type=int, default=MSG_TIMEOUT, help='消息超时(秒)')
    parser.add_argument('--verbose', '-v', action='store_true', help='详细日志')
    args = parser.parse_args()
    
    # 配置日志
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
        datefmt='%H:%M:%S'
    )
    
    # 注册清理处理
    import atexit
    atexit.register(_cleanup)
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)
    
    client = NuphusMCPClient()
    
    if args.health:
        health = client.check_health()
        print(json.dumps(health, indent=2, ensure_ascii=False))
        all_ok = all(v for k, v in health.items() if k != "chrome_version")
        sys.exit(0 if all_ok else 1)
    
    if args.launch_chrome:
        chrome = ChromeCDPManager()
        _chrome_manager = chrome
        try:
            proc = chrome.launch_chrome()
            print(f"✅ Chrome CDP就绪 (PID: {proc.pid if proc else 'existing'})")
        except RuntimeError as e:
            print(f"❌ {e}")
            sys.exit(1)
        return
    
    if args.cookies:
        cm = CookieManager()
        try:
            cookies = cm.decrypt_cookies()
            print(json.dumps(cookies, indent=2, ensure_ascii=False))
            print(f"\n📊 共 {len(cookies)} 个cookies (CF已排除)", file=sys.stderr)
        except RuntimeError as e:
            print(f"❌ {e}")
            sys.exit(1)
        return
    
    if args.login:
        controller = ChatGPTController()
        result = controller.auto_login()
        print(result["message"])
        sys.exit(0 if result["success"] else 1)
    
    if args.status:
        controller = ChatGPTController()
        status = controller.check_login()
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return
    
    if args.send:
        controller = ChatGPTController()
        print(f"📤 发送: {args.send}")
        result = controller.send_message(args.send, timeout=args.timeout)
        
        if result["status"] == "done":
            print(f"\n📝 ChatGPT回复:\n{result['reply']}")
        elif result["status"] == "thinking":
            print("⏳ ChatGPT仍在思考中...")
        elif result["status"] == "timeout":
            print(f"⏱ 超时: {result['reply']}")
        else:
            print(f"❌ 错误: {result['reply']}")
        
        sys.exit(0 if result["status"] == "done" else 1)
    
    parser.print_help()


if __name__ == '__main__':
    main()
