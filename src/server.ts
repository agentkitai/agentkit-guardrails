import Fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Config, Rule } from './config.js';
import { GateClient } from './gate-client.js';

const WebhookPayload = z.object({
  event: z.enum(['breach', 'recovery']),
  metric: z.string(),
  currentValue: z.number(),
  threshold: z.number(),
  agentId: z.string(),
  timestamp: z.string(),
});

export type WebhookEvent = z.infer<typeof WebhookPayload>;

function matchRule(metric: string, rules: Rule[]): Rule | undefined {
  return rules.find((r) => r.metric === metric);
}

function overrideKey(agentId: string, metric: string): string {
  return `${agentId}::${metric}`;
}

export interface GuardrailsServer {
  app: FastifyInstance;
  activeOverrides: Map<string, string>;
  /** Rebuild activeOverrides from AgentGate (source of truth). Call once on startup. */
  reconcile: () => Promise<void>;
}

export function buildServer(config: Config, gateClient?: GateClient): GuardrailsServer {
  const app = Fastify({ logger: false });
  const client = gateClient ?? new GateClient(config.agentgate.url, config.agentgate.apiKey);
  const activeOverrides = new Map<string, string>();
  // ponytail: in-memory ceiling — single-process Map of TTL timers, lost on restart.
  // FIX 2's reconcile() rebuilds activeOverrides from AgentGate on boot, but the local
  // TTL timers below are NOT restored; AgentGate's own ttlSeconds remains the real safety net.
  const expiryTimers = new Map<string, NodeJS.Timeout>();

  function clearOverride(key: string): void {
    const timer = expiryTimers.get(key);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(key);
    activeOverrides.delete(key);
  }

  function trackOverride(key: string, overrideId: string, ttlSeconds: number): void {
    const existing = expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    activeOverrides.set(key, overrideId);
    // FIX 1: local TTL safety net — expire the in-memory entry so a stale override
    // does not block re-creation after AgentGate's own TTL has elapsed.
    const timer = setTimeout(() => clearOverride(key), ttlSeconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    expiryTimers.set(key, timer);
  }

  // FIX 2: rebuild in-memory state from AgentGate so a restart does not orphan/duplicate
  // overrides. AgentGate is the source of truth; we map each live override back to a rule.
  async function reconcile(): Promise<void> {
    const overrides = await client.listOverrides();
    for (const ovr of overrides) {
      const rule = config.rules.find(
        (r) => r.toolPattern === ovr.toolPattern && r.action === ovr.action,
      );
      if (!rule) continue;
      trackOverride(overrideKey(ovr.agentId, rule.metric), ovr.id, ovr.ttlSeconds);
    }
  }

  // FIX 3: shared-secret auth for the control plane. The secret is sourced from
  // GUARDRAILS_WEBHOOK_SECRET; if unset we fail closed (reject every webhook).
  const webhookSecret = config.server.webhookSecret;
  if (!webhookSecret) {
    // eslint-disable-next-line no-console
    console.warn(
      'WARNING: webhookSecret unset (GUARDRAILS_WEBHOOK_SECRET) — /webhook will reject all requests (fail closed).',
    );
  }

  app.post('/webhook', async (request, reply) => {
    if (!webhookSecret || request.headers['x-guardrails-secret'] !== webhookSecret) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const parseResult = WebhookPayload.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid payload', details: parseResult.error.issues });
    }

    const payload = parseResult.data;
    const rule = matchRule(payload.metric, config.rules);

    if (!rule) {
      return reply.status(200).send({ status: 'ignored', reason: 'no matching rule' });
    }

    const key = overrideKey(payload.agentId, payload.metric);

    if (payload.event === 'breach') {
      if (activeOverrides.has(key)) {
        return reply.status(200).send({ status: 'already_active', overrideId: activeOverrides.get(key) });
      }

      try {
        const override = await client.createOverride({
          agentId: payload.agentId,
          toolPattern: rule.toolPattern,
          action: rule.action,
          reason: rule.reason,
          ttlSeconds: rule.ttlSeconds,
        });
        if (!override || !override.id) {
          throw new Error('Invalid response from AgentGate: missing override id');
        }
        trackOverride(key, override.id, rule.ttlSeconds);
        return reply.status(201).send({ status: 'override_created', overrideId: override.id });
      } catch (err) {
        return reply.status(502).send({ error: 'AgentGate unreachable', detail: String(err) });
      }
    }

    if (payload.event === 'recovery') {
      const overrideId = activeOverrides.get(key);
      if (!overrideId) {
        return reply.status(200).send({ status: 'no_active_override' });
      }

      try {
        await client.removeOverride(overrideId);
        clearOverride(key);
        return reply.status(200).send({ status: 'override_removed', overrideId });
      } catch (err) {
        return reply.status(502).send({ error: 'AgentGate unreachable', detail: String(err) });
      }
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return { app, activeOverrides, reconcile };
}
