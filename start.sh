#!/bin/sh
# Start Redis server in background
redis-server --port ${REDIS_PORT} --bind 127.0.0.1 &

# Wait for Redis to be ready
timeout=10
while [ $timeout -gt 0 ]; do
  if redis-cli -p ${REDIS_PORT} PING >/dev/null 2>&1; then
    echo "Redis is ready on port ${REDIS_PORT}"
    break
  fi
  timeout=$((timeout - 1))
  sleep 1
done

# Start the proxy
exec ./resp-proxy
