#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

node content/sync.mjs
python3 build.py
chmod -R u+rwX,go+rX dist assets
echo "built dist/ — deploy with rsync (see README.md)"
