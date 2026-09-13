#!/bin/bash
# 自签证书生成(部署机执行一次; 生产换CA证书时替换certs/下文件即可)
set -e
cd "$(dirname "$0")"
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=account-service.xiaziteam" \
  -addext "subjectAltName=IP:<VPS_IP>,DNS:account-service.xiaziteam"
chmod 600 certs/key.pem
echo "certs OK:" && openssl x509 -in certs/cert.pem -noout -subject -dates
