#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-stream}"
BUCKET="swiipe-test-media"
KEY="${2:-original/sample.jpg}"

case "$TARGET" in
  stream) PORT=9000; SERVICE="lambda-stream" ;;
  buffer) PORT=9001; SERVICE="lambda-buffer" ;;
  buffer-concurrent) PORT=9002; SERVICE="lambda-buffer-concurrent" ;;
  *) echo "Usage: $0 [stream|buffer|buffer-concurrent] [s3-key]"; exit 1 ;;
esac

CONTAINER=$(docker compose ps -q "$SERVICE")
if [ -z "$CONTAINER" ]; then
  echo "Service $SERVICE is not running. Run 'docker compose up -d --build' first."
  exit 1
fi

EVENT='{"Records":[{"s3":{"bucket":{"name":"'"$BUCKET"'"},"object":{"key":"'"$KEY"'","size":102400}}}]}'

echo "Invoking $TARGET Lambda (port $PORT) with key=$KEY..."
RESPONSE=$(curl -s -XPOST "http://localhost:${PORT}/2015-03-31/functions/function/invocations" -d "$EVENT")
echo "Response: $RESPONSE"

echo ""
echo "Container stats snapshot (docker's own view, for cross-check):"
docker stats --no-stream "$CONTAINER"

echo ""
echo "METRICS log line (from memProfiler):"
docker logs "$CONTAINER" 2>&1 | grep METRICS | tail -n 1
