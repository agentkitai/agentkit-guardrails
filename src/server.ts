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
}

export function buildServer(config: Config, gateClient?: GateClient): GuardrailsServer {
  const app = Fastify({ logger: false });
  const client = gateClient ?? new GateClient(config.agentgate.url, config.agentgate.apiKey);
  const activeOverrides = new Map<string, string>();

  app.post('/webhook', async (request, reply) => {
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
        activeOverrides.set(key, override.id);
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
        activeOverrides.delete(key);
        return reply.status(200).send({ status: 'override_removed', overrideId });
      } catch (err) {
        return reply.status(502).send({ error: 'AgentGate unreachable', detail: String(err) });
      }
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return { app, activeOverrides };
}
