#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 22.04/24.04 server (Oracle Cloud, Hostinger VPS, ...). Safe to re-run.
set -euo pipefail

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi

# Ubuntu's firewall (ufw), if enabled: allow SSH and the web ports.
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
fi

# Oracle Cloud's Ubuntu images block everything except SSH with an iptables REJECT rule.
# Open ports 80/443 ahead of it and make the change survive reboots.
if sudo iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  for port in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
      || sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  done
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
  sudo netfilter-persistent save
fi

# Automatic security updates for the OS.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades >/dev/null
echo "Server setup done."
