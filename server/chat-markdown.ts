export async function generateChatMarkdown(_convId: string): Promise<boolean> {
  return false;
}

export async function removeChatMarkdown(_convId: string): Promise<void> {
}

export async function syncAllChatMarkdown(): Promise<{ generated: number; skipped: number; removed: number }> {
  return { generated: 0, skipped: 0, removed: 0 };
}
