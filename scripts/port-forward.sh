#!/usr/bin/env bash
# Exposes MCP and Mailpit on localhost only.
source "$(dirname "$0")/lib.sh"
$K port-forward --address 127.0.0.1 svc/mcp 8081:8081 &
$K port-forward --address 127.0.0.1 svc/mailpit 8025:8025 &
wait
