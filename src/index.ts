import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { GateClient } from './gate-client.js';

const configPath = process.argv[2] || 'config.yaml';

async function main() {
  const config = loadConfig(configPath);
  const gateClient = new GateClient(config.agentgate.url, config.agentgate.apiKey);
  const server = buildServer(config, gateClient);

  await server.listen({ port: config.server.port, host: '0.0.0.0' });
  console.log(`agentkit-guardrails listening on port ${config.server.port}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
