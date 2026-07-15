import { markdownToIR, type MarkdownLinkSpan } from './ir.js';

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) {
    return true;
  }
  return /^\|.+\|\s*$/.test(trimmed);
}

function normalizeLooseTables(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const normalized: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() !== '') {
      normalized.push(line);
      continue;
    }

    const previous = normalized[normalized.length - 1] ?? '';
    let nextNonEmpty = '';
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]?.trim()) {
        nextNonEmpty = lines[j] ?? '';
        break;
      }
    }

    if (isTableRow(previous) && isTableRow(nextNonEmpty)) {
      continue;
    }

    normalized.push(line);
  }

  return normalized.join('\n');
}

function normalizeVisibleUrl(value: string): string {
  return value
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function labelAlreadyShowsHref(label: string, href: string): boolean {
  const normalizedLabel = normalizeVisibleUrl(label);
  const normalizedHref = normalizeVisibleUrl(href);
  if (!normalizedLabel || !normalizedHref) {
    return false;
  }
  return normalizedLabel === normalizedHref || normalizedLabel.includes(normalizedHref);
}

function formatVisibleLink(label: string, href: string): string {
  if (labelAlreadyShowsHref(label, href)) {
    return '';
  }
  return label.includes('\n') ? `\n链接: ${href}` : ` (${href})`;
}

function injectVisibleLinks(text: string, links: MarkdownLinkSpan[]): string {
  if (!text || links.length === 0) {
    return text;
  }

  const sorted = [...links].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return a.end - b.end;
  });

  let output = '';
  let cursor = 0;

  for (const link of sorted) {
    const start = Math.max(0, Math.min(link.start, text.length));
    const end = Math.max(start, Math.min(link.end, text.length));
    if (end <= cursor) {
      continue;
    }

    output += text.slice(cursor, start);
    const label = text.slice(start, end);
    output += label;

    const href = link.href.trim();
    if (href) {
      output += formatVisibleLink(label, href);
    }

    cursor = end;
  }

  output += text.slice(cursor);
  return output;
}

function normalizeWeixinText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\u2500-\u257f\u2014-]{3,}$/gm, '------')
    .trim();
}

export function markdownToWeixinText(markdown: string): string {
  const ir = markdownToIR(normalizeLooseTables(markdown), {
    enableTables: true,
    tableStyle: 'bullets',
    blockquotePrefix: '引用: ',
  });

  const withVisibleLinks = injectVisibleLinks(ir.text, ir.links);
  return normalizeWeixinText(withVisibleLinks);
}
