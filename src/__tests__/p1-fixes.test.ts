import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../server.js';
import { Config } from '../config.js';
import { GateClient } from '../gate-client.js';

const SECRET = 'test-secret';
const AUTH = { 'x-guardrails-secret': SECRET };

const config = (ttlSeconds = 5, webhookSecret: string | undefined = SECRET): Config => ({
  agentgate: { url: 'http://localhost:3002' },
  server: { port: 0, webhookSecret },
  rules: [
    { metric: 'error_rate', action: 'require_approval', toolPattern: '*', ttlSeconds, reason: 'Error rate high' },
  ],
});

function makeClient(overrides: any[] = []) {
  let nextId = 1;
  return {
    createOverride: vi.fn().mockImplementation(async () => ({
      id: `ovr-${nextId++}`,
      agentId: 'agent-1',
      toolPattern: '*',
      action: 'require_approval',
      reason: 'test',
      ttlSeconds: 5,
    })),
    removeOverride: vi.fn().mockResolvedValue(undefined),
    listOverrides: vi.fn().mockResolvedValue(overrides),
  } as unknown as GateClient;
}

const breach = () => ({ event: 'breach', metric: 'error_rate', currentValue: 0.9, threshold: 0.5, agentId: 'agent-1', timestamp: new Date().toISOString() });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FIX 1: local TTL safety net. Uses a tiny real TTL (fractional seconds) instead of fake
// timers, because Fastify's app.inject deadlocks under vitest fake timers.
describe('FIX 1: local TTL expiry of activeOverrides entry', () => {
  it('deletes the in-memory entry after ttlSeconds, allowing re-creation', async () => {
    const client = makeClient();
    const { app, activeOverrides } = buildServer(config(0.05), client); // 50ms TTL

    const r1 = await app.inject({ method: 'POST', url: '/webhook', headers: AUTH, payload: breach() });
    expect(r1.statusCode).toBe(201);
    expect(activeOverrides.has('agent-1::error_rate')).toBe(true);

    // after TTL: local entry expired even though no recovery event arrived
    await wait(120);
    expect(activeOverrides.has('agent-1::error_rate')).toBe(false);

    // a fresh breach now creates a new override instead of being blocked as stale
    const r2 = await app.inject({ method: 'POST', url: '/webhook', headers: AUTH, payload: breach() });
    expect(r2.statusCode).toBe(201);
    expect(client.createOverride).toHaveBeenCalledTimes(2);
  });

  it('recovery clears the timer so a stale timer cannot delete a later entry', async () => {
    const client = makeClient();
    // long TTL so the timer never fires within the test; we only assert it was cleared.
    const { app, activeOverrides } = buildServer(config(60), client);

    await app.inject({ method: 'POST', url: '/webhook', headers: AUTH, payload: breach() });
    await app.inject({ method: 'POST', url: '/webhook', headers: AUTH, payload: { ...breach(), event: 'recovery' } });
    expect(activeOverrides.size).toBe(0);

    // re-create after recovery; the entry must stick around (the cleared original timer
    // must not fire and delete it).
    const r = await app.inject({ method: 'POST', url: '/webhook', headers: AUTH, payload: breach() });
    expect(r.statusCode).toBe(201);
    await wait(60);
    expect(activeOverrides.has('agent-1::error_rate')).toBe(true);
  });
});

// FIX 2: restart reconciliation
describe('FIX 2: reconcile rebuilds activeOverrides from AgentGate', () => {
  it('maps live overrides back onto rule keys on startup', async () => {
    const live = [{ id: 'ovr-existing', agentId: 'agent-7', toolPattern: '*', action: 'require_approval', reason: 'x', ttlSeconds: 5 }];
    const client = makeClient(live);
    const { reconcile, activeOverrides } = buildServer(config(5), client);

    await reconcile();

    expect(client.listOverrides).toHaveBeenCalledOnce();
    expect(activeOverrides.get('agent-7::error_rate')).toBe('ovr-existing');
  });

  it('ignores overrides that match no configured rule', async () => {
    const live = [{ id: 'ovr-stray', agentId: 'agent-7', toolPattern: 'other.*', action: 'deny', reason: 'x', ttlSeconds: 5 }];
    const { reconcile, activeOverrides } = buildServer(config(5), makeClient(live));
    await reconcile();
    expect(activeOverrides.size).toBe(0);
  });
});

// FIX 3: webhook auth
describe('FIX 3: shared-secret auth on /webhook', () => {
  it('accepts a request with the valid secret header', async () => {
    const { app } = buildServer(config(5), makeClient());
    const res = await app.inject({ method: 'POST', url: '/webhook', headers: AUTH, payload: breach() });
    expect(res.statusCode).toBe(201);
  });

  it('rejects with 401 when the secret header is missing', async () => {
    const { app } = buildServer(config(5), makeClient());
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: breach() });
    expect(res.statusCode).toBe(401);
  });

  it('rejects with 401 when the secret header is wrong', async () => {
    const { app } = buildServer(config(5), makeClient());
    const res = await app.inject({ method: 'POST', url: '/webhook', headers: { 'x-guardrails-secret': 'nope' }, payload: breach() });
    expect(res.statusCode).toBe(401);
  });

  it('fails closed (401) when no secret is configured', async () => {
    const { app } = buildServer(config(5, undefined), makeClient());
    const res = await app.inject({ method: 'POST', url: '/webhook', headers: { 'x-guardrails-secret': 'anything' }, payload: breach() });
    expect(res.statusCode).toBe(401);
  });
});
