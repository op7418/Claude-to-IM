/**
 * SSE Utilities — helpers for formatting Server-Sent Event strings.
 *
 * Used by LLMProvider implementations to produce the SSE stream format
 * consumed by the bridge conversation engine.
 */

export function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}
