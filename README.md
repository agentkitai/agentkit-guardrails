# agentkit-guardrails

Reactive policy enforcement for AI agents. Watches metrics from **AgentLens** and automatically tightens **AgentGate** policies when thresholds are breached.

## Architecture

```
┌────────────┐   webhook    ┌──────────────────────┐  Override API  ┌────────────┐
│  AgentLens │ ──────────►  │ agentkit-guardrails   │ ─────────────► │  AgentGate │
│  (metrics) │  breach/     │ (this service)        │  create/remove │  (policy)  │
│            │  recovery    │                       │   overrides    │            │
└────────────┘              └──────────────────────┘                └────────────┘
```

**Flow:**
1. AgentLens monitors agent metrics (error rate, latency, token usage, etc.)
2. When a threshold is breached, AgentLens sends a webhook to this service
3. This service creates a policy override in AgentGate (e.g., require approval for all tools)
4. When the metric recovers, AgentLens sends a recovery webhook
5. This service removes the override, restoring normal permissions

## Quick Start

### 1. Install

```bash
npm install agentkit-guardrails
```

### 2. Configure

Create `config.yaml`:

```yaml
agentgate:
  url: http://localhost:3002
  apiKey: your-api-key          # optional

server:
  port: 3010                    # default: 3010

rules:
  - metric: error_rate
    action: require_approval    # require_approval | deny | allow
    toolPattern: "*"            # glob pattern for tools to restrict
    ttlSeconds: 3600            # override expires after 1 hour
    reason: "Error rate exceeded threshold"

  - metric: latency_p99
    action: deny
    toolPattern: "external_api.*"
    ttlSeconds: 1800
    reason: "Latency spike detected"
```

### 3. Configure AgentLens Thresholds

In AgentLens, set up threshold monitors that send webhooks to this service:

```yaml
# AgentLens threshold config
thresholds:
  - metric: error_rate
    breach: 0.5
    recovery: 0.3
    webhook: http://localhost:3010/webhook
```

### 4. Run

```bash
npx agentkit-guardrails config.yaml
```

## Configuration Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `agentgate.url` | string (URL) | ✅ | — | AgentGate API base URL |
| `agentgate.apiKey` | string | ❌ | — | Bearer token for AgentGate API |
| `server.port` | number | ❌ | `3010` | Port for the webhook server |
| `rules[].metric` | string | ✅ | — | Metric name to match from webhooks |
| `rules[].action` | enum | ✅ | — | `require_approval`, `deny`, or `allow` |
| `rules[].toolPattern` | string | ❌ | `*` | Glob pattern for tools to restrict |
| `rules[].ttlSeconds` | number | ❌ | `3600` | Override auto-expires after this many seconds |
| `rules[].reason` | string | ❌ | `Guardrail triggered` | Human-readable reason stored with override |

## Webhook Payload

AgentLens sends POST requests to `/webhook` with this JSON body:

```json
{
  "event": "breach",
  "metric": "error_rate",
  "currentValue": 0.85,
  "threshold": 0.5,
  "agentId": "agent-123",
  "timestamp": "2026-02-13T09:00:00Z"
}
```

`event` is either `"breach"` or `"recovery"`.

## How Overrides Work

- **Creation:** On breach, an override is created in AgentGate restricting the matching tools for the specific agent.
- **TTL:** Overrides auto-expire after `ttlSeconds` even without recovery (safety net).
- **Recovery:** On recovery, the override is explicitly removed.
- **Idempotency:** Duplicate breach events for the same agent+metric are ignored — no second override is created.
- **Independence:** Each agent+metric pair is tracked independently. A breach on `error_rate` doesn't affect `latency_p99`.

## Health Check

```
GET /health → { "status": "ok" }
```

## Docker Compose Example

See `docker-compose.yml` for a complete 3-service setup.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `502 AgentGate unreachable` | Check that AgentGate is running and `agentgate.url` is correct |
| Webhook returns `ignored` | The metric name doesn't match any rule in your config |
| Override not removed on recovery | Check AgentLens is sending recovery events; override may have TTL-expired already |
| Duplicate overrides | This shouldn't happen — the service is idempotent. Check logs for errors |
| Port already in use | Change `server.port` in config.yaml |

## License

ISC
