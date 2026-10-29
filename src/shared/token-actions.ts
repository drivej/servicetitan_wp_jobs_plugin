export const TOKEN_ACTIONS = {
  job_scan: { label: 'Job Scanner', cost: 1 },
  ai_generation: { label: 'Generate Copy', cost: 1 },
  build: { label: 'Build', cost: 1 },
  update: { label: 'Update', cost: 1 },
  publish: { label: 'Publish', cost: 0 },
  trash: { label: 'Trash', cost: 0 },
  unlink: { label: 'Remove draft', cost: 0 },
} as const;

export type TokenAction = keyof typeof TOKEN_ACTIONS;
export const tokenCost = (action: TokenAction): number => TOKEN_ACTIONS[action].cost;
