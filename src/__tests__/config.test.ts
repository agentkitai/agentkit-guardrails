import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const tmpDir = join(__dirname, '../../.tmp-test');

function writeYaml(name: string, content: string): string {
  mkdirSync(tmpDir, { recursive: true });
  const p = join(tmpDir, name);
  writeFileSync(p, content);
  return p;
}

afterAll(() => { try { rmSync(tmpDir, { recursive: true }); } catch {} });

describe('loadConfig', () => {
  it('parses valid YAML config', () => {
    const p = writeYaml('valid.yaml', `
agentgate:
  url: http://localhost:3002
server:
  port: 3010
rules:
  - metric: error_rate
    action: require_approval
    toolPattern: "*"
    ttlSeconds: 3600
    reason: "Error rate high"
`);
    const config = loadConfig(p);
    expect(config.agentgate.url).toBe('http://localhost:3002');
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].metric).toBe('error_rate');
  });

  it('rejects config with no rules', () => {
    const p = writeYaml('norules.yaml', `
agentgate:
  url: http://localhost:3002
server:
  port: 3010
rules: []
`);
    expect(() => loadConfig(p)).toThrow();
  });

  it('rejects config with invalid url', () => {
    const p = writeYaml('badurl.yaml', `
agentgate:
  url: not-a-url
server:
  port: 3010
rules:
  - metric: x
    action: deny
`);
    expect(() => loadConfig(p)).toThrow();
  });

  it('applies defaults for optional fields', () => {
    const p = writeYaml('defaults.yaml', `
agentgate:
  url: http://localhost:3002
server:
  port: 3010
rules:
  - metric: latency
    action: deny
`);
    const config = loadConfig(p);
    expect(config.rules[0].toolPattern).toBe('*');
    expect(config.rules[0].ttlSeconds).toBe(3600);
    expect(config.rules[0].reason).toBe('Guardrail triggered');
  });
});
