#!/usr/bin/env python3
"""
硅侣2.0 — Playwright Chromium启动脚本

在VPS2上启动轻量Playwright Chromium，提供CDP :9222接口
供AgentChat使用。

使用方法:
  python3 start-chrome-debug.py

验证:
  curl http://127.0.0.1:9222/json
"""

import subprocess
import os
import sys
import time
import glob

CDP_PORT = 9222

def find_chrome():
    """查找Playwright安装的Chromium"""
    # Try Playwright cache first
    home = os.path.expanduser("~")
    patterns = [
        f"{home}/.cache/ms-playwright/chromium-*/chrome-linux/chrome",
        f"{home}/.cache/ms-playwright/chromium-*/chrome-linux/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
    ]
    
    for pattern in patterns:
        matches = glob.glob(pattern)
        if matches:
            return matches[0]
    
    return None

def is_cdp_ready():
    """检查CDP是否就绪"""
    import urllib.request
    try:
        resp = urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json", timeout=2)
        return resp.status == 200
    except:
        return False

def main():
    # Check if already running
    if is_cdp_ready():
        print(f"Chrome CDP already running on :{CDP_PORT}")
        return

    chrome_path = find_chrome()
    if not chrome_path:
        print("Chrome not found. Installing Playwright Chromium...")
        subprocess.run([sys.executable, "-m", "pip", "install", "playwright"], check=False)
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=False)
        chrome_path = find_chrome()
    
    if not chrome_path:
        print("ERROR: Chrome still not found after install attempt")
        sys.exit(1)

    print(f"Starting Chrome: {chrome_path}")
    print(f"CDP port: {CDP_PORT}")

    proc = subprocess.Popen([
        chrome_path,
        f"--remote-debugging-port={CDP_PORT}",
        "--no-sandbox",
        "--headless",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--no-first-run",
        "--disable-features=TranslateUI",
        "about:blank"
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Wait for CDP to be ready
    for i in range(30):
        if is_cdp_ready():
            print(f"Chrome CDP ready on :{CDP_PORT} (pid={proc.pid})")
            return
        time.sleep(0.5)
    
    print(f"WARNING: Chrome started but CDP not ready after 15s (pid={proc.pid})")

if __name__ == "__main__":
    main()
