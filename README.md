# Redis RESP Proxy

[![Test](https://github.com/redis-developer/cae-resp-proxy/actions/workflows/test.yml/badge.svg)](https://github.com/redis-developer/cae-resp-proxy/actions/workflows/test.yml)
[![Docker Version](https://img.shields.io/docker/v/redislabs/client-resp-proxy
)](https://hub.docker.com/r/redislabs/client-resp-proxy)
[![Docker Pulls](https://img.shields.io/docker/pulls/redislabs/client-resp-proxy)](https://hub.docker.com/r/redislabs/client-resp-proxy)

A Redis protocol proxy with HTTP API for response injection.

## Quickstart

Transparently proxy Redis connections while injecting custom RESP responses via REST API.

```
+-------------+    RESP     +-------------+    RESP     +-------------+
| Client App  |<----------->| RESP Proxy  |<----------->| Redis Server|
+-------------+             +-------------+             +-------------+
                                   ^
                                   |
                              HTTP REST API
                            (inject responses)
```

### 30-Second Setup

```bash
# Start proxy container  ( the rest api will be running port 3000 by default)
docker run -d \
  -p 6379:6379 -p 3000:3000 \
  -e TARGET_HOST=your-redis-host \
  -e TARGET_PORT=6380 \
  redislabs/client-resp-proxy
```

### Inject Custom RESP3 Push Notification

RESP3 Push notification: `>4\r\n$6\r\nMOVING\r\n:1\r\n:2\r\n$6\r\nhost:3\r\n`

**cURL Example:**
```bash
curl -X POST "http://localhost:3000/send-to-all-clients?encoding=raw" \
  --data-binary ">4\r\n\$6\r\nMOVING\r\n:1\r\n:2\r\n\$6\r\nhost:3\r\n"
```

**TypeScript Example:**
```typescript
const response = await fetch('http://localhost:3000/send-to-all-clients?encoding=raw', {
  method: 'POST',
  body: '>4\r\n$6\r\nMOVING\r\n:1\r\n:2\r\n$6\r\nhost:3\r\n'
});

const result = await response.json();
console.log(result.results.length > 0 ? 'Injected' : 'Failed');
```

**Go Example:**
```go
package main

import (
    "io"
    "net/http"
    "strings"
)

func main() {
    payload := strings.NewReader(">4\r\n$6\r\nMOVING\r\n:1\r\n:2\r\n$6\r\nhost:3\r\n")
    resp, _ := http.Post("http://localhost:3000/send-to-all-clients?encoding=raw", "", payload)
    defer resp.Body.Close()
    
    body, _ := io.ReadAll(resp.Body)
    if strings.Contains(string(body), `"results"`) {
        println("Injected")
    }
}
```

**Java Example:**
```java
import java.net.http.*;
import java.net.URI;

public class RespProxyClient {
    public static void main(String[] args) throws Exception {
        var client = HttpClient.newHttpClient();
        var request = HttpRequest.newBuilder()
            .uri(URI.create("http://localhost:3000/send-to-all-clients?encoding=raw"))
            .POST(HttpRequest.BodyPublishers.ofString(
                ">4\r\n$6\r\nMOVING\r\n:1\r\n:2\r\n$6\r\nhost:3\r\n"))
            .build();

        var response = client.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.body().contains("\"results\"")) {
            System.out.println("Injected");
        }
    }
}
```

**Python Example:**
```python
import json
import urllib.request

data = b">4\r\n$6\r\nMOVING\r\n:1\r\n:2\r\n$6\r\nhost:3\r\n"
req = urllib.request.Request("http://localhost:3000/send-to-all-clients?encoding=raw", data)

with urllib.request.urlopen(req) as response:
    result = json.loads(response.read())
    print("Injected" if len(result["results"]) > 0 else "Failed")
```

Key Endpoints: `POST /send-to-client/{id}`, `POST /send-to-all-clients`, `GET /connections`, `GET /stats`

---

## Features

- **Redis Transparent Protocol Proxy**: Forwards Redis connections from clients to target Redis servers
- **HTTP API**: RESTful API for managing connections and sending arbitrary responses to clients
- **Connection Management**: Track active connections, view statistics, and close connections
- **Data Encoding Support**: Send data in base64 or raw binary format
- **Docker Support**: Containerized deployment with environment variable configuration
- **Real-time Stats**: Monitor active connections and proxy statistics

## Quick Start

### Prerequisites
- Docker or [Bun](https://bun.sh/) runtime
- Running Redis server (target)

### Basic Usage

#### Docker (Recommended)

**Two image variants available:**

1. **Base Image** (`redislabs/client-resp-proxy:latest`) - Proxy only, requires external Redis
2. **Standalone Image** (`redislabs/client-resp-proxy:standalone`) - Proxy + embedded Redis in one container

##### Using Base Image (with external Redis)

```bash
# Pull from Docker Hub
docker pull redislabs/client-resp-proxy:latest

# Run with Docker - connects to Redis on host
docker run -d \
  -p 6379:6379 -p 3000:3000 \
  -e TARGET_HOST=host.docker.internal \
  -e TARGET_PORT=6380 \
  redislabs/client-resp-proxy
```

##### Using Standalone Image (embedded Redis)

Perfect for development, demos, or mocked clusters:

```bash
# Pull standalone image
docker pull redislabs/client-resp-proxy:standalone

# Run with embedded Redis
docker run -d \
  -p 6379:6379 -p 3000:3000 \
  redislabs/client-resp-proxy:standalone
```

##### Mocked Cluster Mode (Standalone Image)

Run a mocked multi-node Redis cluster in a single container:

```bash
docker run -d \
  -p 6379:6379 -p 6380:6380 -p 6381:6381 -p 3000:3000 \
  -e LISTEN_PORT="6379,6380,6381" \
  -e DEFAULT_INTERCEPTORS="cluster,logger" \
  -e ENABLE_LOGGING=true \
  redislabs/client-resp-proxy:standalone
```

##### Building Images Locally

```bash
# Build base image
docker build -t cae-resp-proxy:latest -f Dockerfile .

# Build standalone image (extends base)
docker build -t cae-resp-proxy:standalone -f standalone.Dockerfile .
```

### Local Development

```bash
# Install dependencies
bun install

# Start the proxy with CLI arguments
bun run proxy --listenPort=6379 --targetHost=localhost --targetPort=6380

# Or use the dev mode with hot reload
bun run dev --listenPort=6379 --targetHost=localhost --targetPort=6380
```

#### Environment Variables
You can use env variables instead of cli arguments.

```bash
# Set required environment variables
export LISTEN_PORT=6379
export TARGET_HOST=localhost
export TARGET_PORT=6380

# Optional variables
export LISTEN_HOST=127.0.0.1
export TIMEOUT=30000
export ENABLE_LOGGING=true
export API_PORT=3000

# Start the proxy
bun run proxy
```

## Configuration

### Required Parameters

| Parameter | CLI Flag | Environment Variable | Description |
|-----------|----------|---------------------|-------------|
| Target Host | `--targetHost` | `TARGET_HOST` | Redis server hostname/IP |
| Target Port | `--targetPort` | `TARGET_PORT` | Redis server port |

### Optional Parameters

| Parameter | CLI Flag | Environment Variable | Default | Description |
|-----------|----------|---------------------|---------|-------------|
| Listen Port | `--listenPort` | `LISTEN_PORT` | `6379` | Port(s) for Redis clients (comma-separated for multiple) |
| Listen Host | `--listenHost` | `LISTEN_HOST` | `127.0.0.1` | Host interface to bind to |
| Timeout | `--timeout` | `TIMEOUT` | - | Connection timeout (ms) |
| Enable Logging | `--enableLogging` | `ENABLE_LOGGING` | `false` | Verbose logging |
| API Port | `--apiPort` | `API_PORT` | `3000` | HTTP API port |
| Default Interceptors | - | `DEFAULT_INTERCEPTORS` | - | Comma-separated interceptors (e.g., "cluster,logger") |
| Redis Port | - | `REDIS_PORT` | `4000` | Port for embedded Redis (standalone image only) |


## HTTP API Reference

The proxy provides a REST API for managing connections and sending arbitrary responses.


### Endpoints


#### Get Statistics
```http
GET /stats
```
Returns detailed proxy statistics including active connections, total connections, and connection details.

**Response:**
```json
{
  "activeConnections": 2,
  "totalConnections": 5,
  "connections": [
    {
      "id": "conn_123",
      "clientAddress": "127.0.0.1:54321",
      "connectedAt": "2024-01-01T10:00:00Z"
    }
  ]
}
```

#### Get Active Connections
```http
GET /connections
```
Returns list of active connection IDs.

**Response:**
```json
{
  "connectionIds": ["conn_123", "conn_456"]
}
```

#### Send Data to Specific Client
```http
POST /send-to-client/{connectionId}?encoding={base64|raw}
```
Send Redis protocol data to a specific client connection.

**Parameters:**
- `connectionId` (path): Target connection ID
- `encoding` (query): Data encoding format (`base64` or `raw`, default: `base64`)

**Body:** Raw data or base64-encoded data

**Example:**
```bash
# Send PING command (base64 encoded)
curl -X POST "http://localhost:3000/send-to-client/conn_123?encoding=base64" \
  -d "KjENCiQ0DQpQSU5HDQo="

# Send raw binary data
curl -X POST "http://localhost:3000/send-to-client/conn_123?encoding=raw" \
  --data-binary "*1\r\n$4\r\nPING\r\n"
```

**Response:**
```json
{
  "success": true,
  "connectionId": "conn_123"
}
```

#### Send Data to Multiple Clients
```http
POST /send-to-clients?connectionIds={id1,id2}&encoding={base64|raw}
```
Send data to multiple specific client connections.

**Parameters:**
- `connectionIds` (query): Comma-separated list of connection IDs
- `encoding` (query): Data encoding format (`base64` or `raw`, default: `base64`)

**Example:**
```bash
curl -X POST "http://localhost:3000/send-to-clients?connectionIds=conn_123,conn_456&encoding=base64" \
  -d "KjENCiQ0DQpQSU5HDQo="
```

#### Send Data to All Clients
```http
POST /send-to-all-clients?encoding={base64|raw}
```
Broadcast data to all active client connections.

**Example:**
```bash
curl -X POST "http://localhost:3000/send-to-all-clients?encoding=base64" \
  -d "KjENCiQ0DQpQSU5HDQo="
```

#### Close Connection
```http
DELETE /connections/{connectionId}
```
Forcefully close a specific client connection.

**Response:**
```json
{
  "success": true,
  "connectionId": "conn_123"
}
```

#### Add Interceptor
```http
POST /interceptors
```
Add a custom interceptor to match commands and return custom responses.

**Example:**
```bash
curl -X POST "http://localhost:3000/interceptors" \
  -H "Content-Type: application/json" \
  -d '{"name":"ping-interceptor","match":"*1\r\n$4\r\nPING\r\n","response":"+CUSTOM PONG\r\n","encoding":"raw"}'
```

**Response:**
```json
{
  "success": true,
  "name": "ping-interceptor"
}
```

#### Create Scenario
```http
POST /scenarios
```
Set up automated response sequence for testing.

**Example:**
```bash
curl -X POST "http://localhost:3000/scenarios" \
  -H "Content-Type: application/json" \
  -d '{"responses":["+OK\r\n",":42\r\n"],"encoding":"raw"}'
```

**Response:**
```json
{
  "success": true,
  "totalResponses": 2
}
```

#### Get Nodes
```http
GET /nodes
```
List all proxy node IDs.

**Example:**
```bash
curl http://localhost:3000/nodes
```

**Response:**
```json
{
  "ids": ["localhost:6379:6379", "localhost:6379:6380"]
}
```

#### Add Node
```http
POST /nodes
```
Add a new proxy node dynamically.

**Example:**
```bash
curl -X POST "http://localhost:3000/nodes" \
  -H "Content-Type: application/json" \
  -d '{"listenPort":6380,"targetHost":"localhost","targetPort":6379}'
```

**Response:**
```json
{
  "success": true,
  "cfg": {
    "listenPort": 6380,
    "targetHost": "localhost",
    "targetPort": 6379
  }
}
```

#### Delete Node
```http
DELETE /nodes/{nodeId}
```
Remove a proxy node.

**Example:**
```bash
curl -X DELETE "http://localhost:3000/nodes/localhost:6379:6380"
```

**Response:**
```json
{
  "success": true
}
```

## Use Cases

### Testing Redis Applications
Intercept and inspect Redis commands during development and testing.

### Response Injection
Send custom Redis responses to specific clients for testing scenarios.

### Protocol Analysis
Analyze Redis protocol communication patterns.

