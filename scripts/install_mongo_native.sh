#!/usr/bin/env bash
# Ubuntu 24.04 GitHub-hosted runner; official MongoDB repository, no Docker.
set -euo pipefail
[[ "$(. /etc/os-release; echo "$VERSION_CODENAME")" == 'noble' ]] || {
  echo 'Only ubuntu-24.04/noble is supported.' >&2; exit 2;
}
sudo apt-get update -qq
sudo apt-get install -y -qq curl gnupg ca-certificates
curl --proto '=https' --tlsv1.2 -fsSL https://pgp.mongodb.com/server-8.0.asc \
  | sudo gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse' \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq mongodb-org-server mongodb-mongosh mongodb-database-tools
mongod --version | sed -n '1p'
mongodump --version | sed -n '1p'
