import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GateClient } from '../gate-client.js';

const originalFetch = globalThis.fetch;

describe('GateClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('createOverride sends POST and returns result', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 'ovr-1', agentId: 'a1', toolPattern: '*', action: 'deny', reason: 'test', ttlSeconds: 60 }) });
    const client = new GateClient('http://localhost:3002', 'key123');
    const result = await client.createOverride({ agentId: 'a1', toolPattern: '*', action: 'deny', reason: 'test', ttlSeconds: 60 });
    expect(result.id).toBe('ovr-1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3002/api/overrides', expect.objectContaining({ method: 'POST' }));
    // Check auth header
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer key123');
  });

  it('removeOverride sends DELETE', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const client = new GateClient('http://localhost:3002');
    await client.removeOverride('ovr-1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3002/api/overrides/ovr-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const client = new GateClient('http://localhost:3002');
    await expect(client.listOverrides()).rejects.toThrow('500');
  });
});
