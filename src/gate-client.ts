export interface OverrideRequest {
  agentId: string;
  toolPattern: string;
  action: string;
  reason: string;
  ttlSeconds: number;
}

export interface Override extends OverrideRequest {
  id: string;
}

export class GateClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async createOverride(override: OverrideRequest): Promise<Override> {
    const res = await fetch(`${this.baseUrl}/api/overrides`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(override),
    });
    if (!res.ok) throw new Error(`AgentGate POST /api/overrides failed: ${res.status}`);
    return res.json() as Promise<Override>;
  }

  async removeOverride(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/overrides/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`AgentGate DELETE /api/overrides/${id} failed: ${res.status}`);
  }

  async listOverrides(): Promise<Override[]> {
    const res = await fetch(`${this.baseUrl}/api/overrides`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`AgentGate GET /api/overrides failed: ${res.status}`);
    return res.json() as Promise<Override[]>;
  }
}
