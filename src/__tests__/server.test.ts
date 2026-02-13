import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../server.js';
import { Config } from '../config.js';
import { GateClient } from '../gate-client.js';

const testConfig: Config = {
  agentgate: { url: 'http://localhost:3002' },
  server: { port: 0 },
  rules: [
    { metric: 'error_rate', action: 'require_approval', toolPattern: '*', ttlSeconds: 3600, reason: 'Error rate high' },
  ],
};

function makeClient() {
  return {
    createOverride: vi.fn().mockResolvedValue({ id: 'ovr-123', agentId: 'agent-1', toolPattern: '*', action: 'require_approval', reason: 'test', ttlSeconds: 3600 }),
    removeOverride: vi.fn().mockResolvedValue(undefined),
    listOverrides: vi.fn().mockResolvedValue([]),
  } as unknown as GateClient;
}

const breach = (metric = 'error_rate') => ({ event: 'breach', metric, currentValue: 0.9, threshold: 0.5, agentId: 'agent-1', timestamp: new Date().toISOString() });
const recovery = (metric = 'error_rate') => ({ event: 'recovery', metric, currentValue: 0.3, threshold: 0.5, agentId: 'agent-1', timestamp: new Date().toISOString() });

describe('webhook handler', () => {
  it('rejects invalid payload', async () => {
    const { app } = buildServer(testConfig, makeClient());
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: { bad: true } });
    expect(res.statusCode).toBe(400);
  });

  it('creates override on breach event', async () => {
    const client = makeClient();
    const { app, activeOverrides } = buildServer(testConfig, client);
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: breach() });
    expect(res.statusCode).toBe(201);
    expect(client.createOverride).toHaveBeenCalledOnce();
    expect(activeOverrides.get('agent-1::error_rate')).toBe('ovr-123');
  });

  it('is idempotent — duplicate breach does not create second override', async () => {
    const client = makeClient();
    const { app } = buildServer(testConfig, client);
    await app.inject({ method: 'POST', url: '/webhook', payload: breach() });
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: breach() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('already_active');
    expect(client.createOverride).toHaveBeenCalledTimes(1);
  });

  it('removes override on recovery event', async () => {
    const client = makeClient();
    const { app, activeOverrides } = buildServer(testConfig, client);
    await app.inject({ method: 'POST', url: '/webhook', payload: breach() });
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: recovery() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('override_removed');
    expect(client.removeOverride).toHaveBeenCalledWith('ovr-123');
    expect(activeOverrides.size).toBe(0);
  });

  it('returns ignored for unknown metric', async () => {
    const { app } = buildServer(testConfig, makeClient());
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: breach('unknown_metric') });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ignored');
  });

  it('returns 502 when AgentGate is unreachable on breach', async () => {
    const client = makeClient();
    (client.createOverride as any).mockRejectedValue(new Error('connection refused'));
    const { app } = buildServer(testConfig, client);
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: breach() });
    expect(res.statusCode).toBe(502);
  });

  it('returns 502 when AgentGate is unreachable on recovery', async () => {
    const client = makeClient();
    (client.removeOverride as any).mockRejectedValue(new Error('connection refused'));
    const { app, activeOverrides } = buildServer(testConfig, client);
    activeOverrides.set('agent-1::error_rate', 'ovr-123');
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: recovery() });
    expect(res.statusCode).toBe(502);
  });
});
