export function generateId(prefix?: string): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return prefix ? prefix + id : id;
}

export function generateToolCallId(prefix: string = "tc"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
