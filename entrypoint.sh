#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun run dist/main.js auth
else
  # Default command - use persisted token from /root/.local/share/copilot-api/
  exec bun run dist/main.js start "$@"
fi