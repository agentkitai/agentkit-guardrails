#!/usr/bin/env node
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { GateClient } from './gate-client.js';

const configPath = process.argv[2] || 'config.yaml';

async function main() {
  const config = loadConfig(configPath);
  const gateClient = new GateClient(config.agentgate.url, config.agentgate.apiKey);
  const { app, reconcile } = buildServer(config, gateClient);

  // FIX 2: rebuild in-memory override state from AgentGate before serving traffic.
  // Non-fatal: if AgentGate is unreachable at boot, start anyway and let webhooks
  // re-converge (already idempotent on the AgentGate side).
  try {
    await reconcile();
  } catch (err) {
    console.warn('Startup reconciliation failed (continuing):', err);
  }

  await app.listen({ port: config.server.port, host: '0.0.0.0' });
  console.log(`agentkit-guardrails listening on port ${config.server.port}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
