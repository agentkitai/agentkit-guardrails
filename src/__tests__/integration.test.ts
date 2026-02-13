import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../server.js';
import { Config } from '../config.js';
import { GateClient } from '../gate-client.js';

const multiRuleConfig: Config = {
  agentgate: { url: 'http://localhost:3002' },
  server: { port: 0 },
  rules: [
    { metric: 'error_rate', action: 'require_approval', toolPattern: '*', ttlSeconds: 3600, reason: 'Error rate high' },
    { metric: 'latency_p99', action: 'deny', toolPattern: 'external_api.*', ttlSeconds: 1800, reason: 'Latency spike' },
  ],
};

function makeClient() {
  let nextId = 1;
  return {
    createOverride: vi.fn().mockImplementation(async () => ({
      id: `ovr-${nextId++}`,
      agentId: 'a',
      toolPattern: '*',
      action: 'require_approval',
      reason: 'test',
      ttlSeconds: 3600,
    })),
    removeOverride: vi.fn().mockResolvedValue(undefined),
    listOverrides: vi.fn().mockResolvedValue([]),
  } as unknown as GateClient;
}

const webhook = (event: string, metric: string, agentId = 'agent-1') => ({
  event,
  metric,
  currentValue: event === 'breach' ? 0.9 : 0.1,
  threshold: 0.5,
  agentId,
  timestamp: new Date().toISOString(),
});

describe('integration: full breach → recovery → idempotency flow', () => {
  it('handles breach, recovery, and duplicate breach end-to-end', async () => {
    const client = makeClient();
    const { app, activeOverrides } = buildServer(multiRuleConfig, client);

    // 1. Breach → override created
    const r1 = await app.inject({ method: 'POST', url: '/webhook', payload: webhook('breach', 'error_rate') });
    expect(r1.statusCode).toBe(201);
    expect(JSON.parse(r1.body).status).toBe('override_created');
    expect(activeOverrides.size).toBe(1);

    // 2. Recovery → override removed
    const r2 = await app.inject({ method: 'POST', url: '/webhook', payload: webhook('recovery', 'error_rate') });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).status).toBe('override_removed');
    expect(activeOverrides.size).toBe(0);

    // 3. Breach again → new override created (not duplicate since previous was removed)
    const r3 = await app.inject({ method: 'POST', url: '/webhook', payload: webhook('breach', 'error_rate') });
    expect(r3.statusCode).toBe(201);

    // 4. Duplicate breach → idempotent
    const r4 = await app.inject({ method: 'POST', url: '/webhook', payload: webhook('breach', 'error_rate') });
    expect(r4.statusCode).toBe(200);
    expect(JSON.parse(r4.body).status).toBe('already_active');
    expect(client.createOverride).toHaveBeenCalledTimes(2); // only 2 creates total
  });

  it('handles multiple independent rules for different metrics', async () => {
    const client = makeClient();
    const { app, activeOverrides } = buildServer(multiRuleConfig, client);

    // Breach error_rate
    const r1 = await app.inject({ method: 'POST', url: '/webhook', payload: webhook('breach', 'error_rate') });
    expect(r1.statusCode).toBe(201);

    // Breach latency_p99 — independent rule
    const r2 = await app.inject({ method: 'POST', url: '/webhook', payload: webhook('breach', 'latency_p99') });
    expect(r2.statusCode).toBe(201);

    // Both active
    expect(activeOverrides.size).toBe(2);
    expect(client.createOverride).toHaveBeenCalledTimes(2);

    // Verify correct toolPatterns were passed
    const calls = (client.createOverride as any).mock.calls;
    expect(calls[0][0].toolPattern).toBe('*');
    expect(calls[1][0].toolPattern).toBe('external_api.*');

    // Recover one, other stays
    await app.inject({ method: 'POST', url: '/webhook', payload: webhook('recovery', 'error_rate') });
    expect(activeOverrides.size).toBe(1);
    expect(activeOverrides.has('agent-1::latency_p99')).toBe(true);
  });
});

describe('integration: health check', () => {
  it('responds to health check', async () => {
    const { app } = buildServer(multiRuleConfig, makeClient());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});
