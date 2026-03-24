/**
 * DingTalk markdown normalization helpers.
 *
 * DingTalk's markdown renderer is stricter than Discord/Telegram:
 * - Numbered lists often need a blank line before them.
 * - Indented fenced code blocks can render incorrectly.
 */

function ensureListSpacing(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isNumbered = /^\d+\.\s/.test(line.trim());

    if (isNumbered && i > 0) {
      const prev = lines[i - 1];
      const prevIsEmpty = prev.trim() === '';
      const prevIsNumbered = /^\d+\.\s/.test(prev.trim());
      if (!prevIsEmpty && !prevIsNumbered) {
        output.push('');
      }
    }

    output.push(line);
  }

  return output.join('\n');
}

function dedentCodeBlocks(text: string): string {
  const pattern = /^([ \t]*)(```[^\n]*\n.*?\n```)[ \t]*$/gms;

  return text.replace(pattern, (_match, indent: string, block: string) => {
    if (!indent) return block;

    const width = indent.length;
    return block
      .split('\n')
      .map((line) => line.startsWith(indent) ? line.slice(width) : line)
      .join('\n');
  });
}

export function normalizeDingtalkMarkdown(text: string): string {
  return dedentCodeBlocks(ensureListSpacing(text));
}
