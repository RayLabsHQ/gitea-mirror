#!/bin/bash
# Setup script for running gitea-mirror inside a Proxmox LXC container
# This installs Bun and sets up a systemd service

set -e

# Ensure script is run as root
if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root" >&2
  exit 1
fi

# Install basic dependencies
apt update
apt install -y curl git sqlite3

# Install Bun if not present
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL=${BUN_INSTALL:-"$HOME/.bun"}
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Install project dependencies and build
bun install
bun run build

# Create systemd service
cat >/etc/systemd/system/gitea-mirror.service <<SERVICE
[Unit]
Description=Gitea Mirror
After=network.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
ExecStart=$(command -v bun) dist/server/entry.mjs
Restart=always
User=root
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=4321
Environment=DATABASE_URL=file:data/gitea-mirror.db

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable gitea-mirror.service
systemctl start gitea-mirror.service

echo "Gitea Mirror service started. Access it on port 4321." 

