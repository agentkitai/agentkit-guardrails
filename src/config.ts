import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const RuleSchema = z.object({
  metric: z.string(),
  action: z.enum(['require_approval', 'deny', 'allow']),
  toolPattern: z.string().default('*'),
  ttlSeconds: z.number().positive().default(3600),
  reason: z.string().default('Guardrail triggered'),
});

const ConfigSchema = z.object({
  agentgate: z.object({
    url: z.string().url(),
    apiKey: z.string().optional(),
  }),
  server: z.object({
    port: z.number().int().positive().default(3010),
  }),
  rules: z.array(RuleSchema).min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Rule = z.infer<typeof RuleSchema>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}
