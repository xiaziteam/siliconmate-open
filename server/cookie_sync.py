#!/usr/bin/env python3
"""从系统Chrome解密ChatGPT cookies，输出为CDP格式JSON

用法：
  python3 cookie_sync.py [--output FILE] [--domain chatgpt.com]

原理：
  1. 从macOS Keychain获取Chrome Safe Storage密钥
  2. PBKDF2派生AES-128-CBC密钥
  3. 解密Chrome SQLite cookies数据库
  4. 去除32字节垃圾前缀（固定IV副作用）
  5. 输出CDP Network.setCookie格式

注意：
  - 仅macOS + Chrome v10加密格式
  - Chrome运行时需复制数据库避免锁
  - 32字节前缀是固定IV "0x20"*16 导致前2个AES块解密错误
"""

import json
import hashlib
import sqlite3
import subprocess
import sys
import os
import tempfile
import shutil

# Cookie解密器
class ChromeCookieDecryptor:
    def __init__(self):
        self.password = self._get_safe_storage_password()
        self.derived_key = hashlib.pbkdf2_hmac(
            'sha1',
            self.password.encode('utf-8'),
            b'saltysalt',
            1003,
            dklen=16
        )
        self.key_hex = self.derived_key.hex()
        self.iv_hex = "20202020202020202020202020202020"  # 16 * 0x20

    def _get_safe_storage_password(self):
        """从macOS Keychain获取Chrome Safe Storage密码"""
        result = subprocess.run(
            ["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            raise RuntimeError(f"无法获取Chrome Safe Storage: {result.stderr}")
        return result.stdout.strip()

    def decrypt(self, encrypted_value):
        """解密单个cookie值（v10格式）"""
        if not encrypted_value or len(encrypted_value) < 4:
            return ""
        
        version = encrypted_value[:3].decode('ascii', errors='replace')
        if version != 'v10':
            return f"[unsupported: {version}]"
        
        # 写入临时文件
        with tempfile.NamedTemporaryFile(delete=False, suffix='.bin') as f:
            f.write(encrypted_value[3:])
            tmp_path = f.name
        
        try:
            result = subprocess.run(
                ["openssl", "enc", "-aes-128-cbc", "-d",
                 "-in", tmp_path,
                 "-K", self.key_hex,
                 "-iv", self.iv_hex,
                 "-nopad"],
                capture_output=True
            )
            
            if result.returncode != 0:
                return "[decrypt failed]"
            
            decrypted = result.stdout
            
            # 去除PKCS7 padding
            if decrypted:
                pad_len = decrypted[-1]
                if 0 < pad_len <= 16 and all(b == pad_len for b in decrypted[-pad_len:]):
                    decrypted = decrypted[:-pad_len]
            
            # 跳过32字节垃圾前缀（固定IV导致前2个AES块无效）
            if len(decrypted) > 32:
                try:
                    text = decrypted[32:].decode('utf-8', errors='strict')
                    if text and text[0].isprintable():
                        return text
                except:
                    pass
            
            # Fallback: 找第一个可打印字符
            try:
                text = decrypted.decode('utf-8', errors='replace')
            except:
                return ""
            
            start = 0
            for i, ch in enumerate(text):
                if ch.isprintable() and ord(ch) >= 32 and ord(ch) < 0xFFFD:
                    start = i
                    break
            return text[start:]
        finally:
            os.unlink(tmp_path)


def get_chrome_cookies(domain_filter="chatgpt"):
    """从系统Chrome获取指定域名的cookies"""
    # 复制数据库避免锁
    src = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Cookies")
    tmp_db = tempfile.mktemp(suffix='.db')
    shutil.copy2(src, tmp_db)
    
    try:
        conn = sqlite3.connect(tmp_db)
        rows = conn.execute("""
            SELECT name, host_key, path, is_httponly, is_secure, samesite, encrypted_value
            FROM cookies
            WHERE host_key LIKE ?
            ORDER BY name
        """, (f'%{domain_filter}%',)).fetchall()
        conn.close()
    finally:
        os.unlink(tmp_db)
    
    decryptor = ChromeCookieDecryptor()
    cookies = []
    
    for name, host, path, httponly, secure, samesite, enc_val in rows:
        value = decryptor.decrypt(enc_val)
        if not value or value.startswith('['):
            continue
        
        cookie_entry = {
            "name": name,
            "value": value,
            "domain": host,
            "path": path,
            "secure": bool(secure),
            "httpOnly": bool(httponly),
        }
        samesite_map = {0: "None", 1: "Lax", 2: "Strict", 3: "None"}
        cookie_entry["sameSite"] = samesite_map.get(samesite, "None")
        cookies.append(cookie_entry)
    
    return cookies


def main():
    import argparse
    parser = argparse.ArgumentParser(description='从系统Chrome解密ChatGPT cookies')
    parser.add_argument('--output', '-o', default=None, help='输出文件路径')
    parser.add_argument('--domain', '-d', default='chatgpt', help='域名过滤 (默认: chatgpt)')
    parser.add_argument('--cf-exclude', action='store_true', default=True, help='排除CF相关cookies (默认: 是)')
    parser.add_argument('--no-cf-exclude', action='store_false', dest='cf_exclude', help='不排除CF cookies (用于反面验证)')
    args = parser.parse_args()
    
    cookies = get_chrome_cookies(args.domain)
    
    # 排除CF cookies（让CDP浏览器自己生成新的，避免指纹不匹配）
    if args.cf_exclude:
        cf_names = {'__cf_bm', 'cf_clearance', '__cflb', '_cfuvid', 'cf_chl_rc_ni'}
        cookies = [c for c in cookies if c['name'] not in cf_names]
        excluded_count = sum(1 for c in cookies if c['name'] in cf_names)  # This will be 0 since already filtered
        
        # 统计排除的数量
        all_cookies = get_chrome_cookies(args.domain)
        total_excluded = sum(1 for c in all_cookies if c['name'] in cf_names)
        if total_excluded > 0:
            print(f"🔒 排除了 {total_excluded} 个CF cookies: {', '.join(c['name'] for c in all_cookies if c['name'] in cf_names)}", file=sys.stderr)
    
    output = json.dumps(cookies, indent=2, ensure_ascii=False)
    
    if args.output:
        with open(args.output, 'w') as f:
            f.write(output)
        print(f"✅ 写入 {len(cookies)} 个cookies到 {args.output}")
    else:
        print(output)
    
    # 统计
    session_cookies = [c for c in cookies if 'session-token' in c['name']]
    print(f"\n📊 统计: {len(cookies)} cookies, {len(session_cookies)} session tokens", file=sys.stderr)


if __name__ == '__main__':
    main()
