ARG BASE_IMAGE=redislabs/client-resp-proxy:latest

FROM ${BASE_IMAGE}

# Install Redis
RUN apk add --no-cache redis

# Override environment variables for standalone mode
ENV LISTEN_HOST="0.0.0.0"
ENV TARGET_HOST="127.0.0.1"
ENV TARGET_PORT="4000"
ENV REDIS_PORT="4000"
ENV API_PORT="3000"

# Expose Redis and API ports
EXPOSE 4000 3000

# Copy startup script
COPY start.sh .

RUN chmod +x /app/start.sh

ENTRYPOINT ["/app/start.sh"]
