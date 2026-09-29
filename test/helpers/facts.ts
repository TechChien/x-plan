import type { Evidence } from "../../src/extract/schema.ts";

export const ev = (file: string, line: number, quote: string): Evidence => ({ file, lineStart: line, lineEnd: line, quote });

export const actor = (id: string, name: string, evidence: Evidence[]) => ({ id, name, description: name, responsibilities: [], evidence });

export const feature = (id: string, name: string, evidence: Evidence[], actorIds: string[] = []) => ({
  id,
  name,
  description: name,
  actorIds,
  inputs: [],
  outputs: [],
  dependsOn: [],
  evidence,
});

export const rule = (id: string, text: string, evidence: Evidence[], featureIds: string[] = []) => ({ id, rule: text, featureIds, conditions: [], evidence });
