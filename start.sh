#!/usr/bin/env bash
# 一键启动：后端(3000) + 前端(5173)
cd "$(dirname "$0")" || exit 1
exec node start.js "$@"
