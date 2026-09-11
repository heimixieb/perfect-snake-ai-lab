import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Report from '../src/components/Report';

type HtmlNode = { tag: string; attrs: Record<string, string>; children: Array<HtmlNode | string> };

const decode = (text: string): string => text
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&');

function parse(html: string): HtmlNode {
  const root: HtmlNode = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const tokens = html.match(/<!--[^]*?-->|<\/?[^>]+>|[^<]+/g) ?? [];
  const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    if (!token.startsWith('<')) {
      stack[stack.length - 1].children.push(decode(token));
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const match = token.match(/^<([\w-]+)([^>]*)>/);
    if (!match) continue;
    const attrs: Record<string, string> = {};
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]] = decode(attr[2]);
    const node: HtmlNode = { tag: match[1].toLowerCase(), attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!token.endsWith('/>') && !voidTags.has(node.tag)) stack.push(node);
  }
  return root;
}

const isNode = (value: HtmlNode | string): value is HtmlNode => typeof value !== 'string';
const plain = (node: HtmlNode | string): string => typeof node === 'string'
  ? node
  : node.children.map(plain).join('');

function inline(node: HtmlNode | string): string {
  if (typeof node === 'string') return node.replace(/\s+/g, ' ');
  const body = node.children.map(inline).join('');
  if (node.tag === 'strong') return `**${body.trim()}**`;
  if (node.tag === 'code') return `\`${body.trim()}\``;
  if (node.tag === 'a') return `[${body.trim()}](${node.attrs.href ?? '#'})`;
  if (node.tag === 'br') return '  \n';
  return body;
}

function table(node: HtmlNode): string {
  const rows: string[][] = [];
  const visit = (current: HtmlNode): void => {
    if (current.tag === 'tr') {
      rows.push(current.children
        .filter(isNode)
        .filter((child) => child.tag === 'th' || child.tag === 'td')
        .map((cell) => inline(cell).trim().replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>')));
      return;
    }
    for (const child of current.children) if (isNode(child)) visit(child);
  };
  visit(node);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array<string>(Math.max(0, width - row.length)).fill('')]);
  return `| ${normalized[0].join(' | ')} |\n| ${Array<string>(width).fill('---').join(' | ')} |\n${normalized.slice(1).map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
}

function block(node: HtmlNode | string): string {
  if (typeof node === 'string') return node.trim() ? `${node.trim()}\n\n` : '';
  if (node.tag === 'nav') return '';
  if (node.tag === 'h2') return `## ${inline(node).trim()}\n\n`;
  if (node.tag === 'h3') return `### ${inline(node).trim()}\n\n`;
  if (node.tag === 'p') return `${inline(node).trim()}\n\n`;
  if (node.tag === 'pre') return `\`\`\`text\n${plain(node).trim()}\n\`\`\`\n\n`;
  if (node.tag === 'ul') {
    return `${node.children.filter(isNode).filter((child) => child.tag === 'li').map((child) => `- ${inline(child).trim()}`).join('\n')}\n\n`;
  }
  if (node.tag === 'table') return table(node);
  if (node.tag === 'div' && node.attrs.class?.includes('border p-4 text-sm')) {
    const content = inline(node).trim();
    return `${content.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
  }
  return node.children.map(block).join('');
}

function find(node: HtmlNode, tag: string): HtmlNode | null {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    if (!isNode(child)) continue;
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
}

const html = renderToStaticMarkup(<Report />);
const tree = parse(html);
const article = find(tree, 'article') ?? tree;
const body = block(article)
  .replace(/<B>(.*?)<\/B>/gi, '**$1**')
  .replace(/\n{3,}/g, '\n\n')
  .replace(/[ \t]+\n/g, '\n')
  .trim();

const header = `# Perfect Snake AI Lab 完整研究报告\n\n> 本文由应用内“研究报告”页面自动转写为 Markdown，保留 0–10 节技术内容。最新指标定义与声明边界以 [验证语义](verification.md) 和 [验证快照](benchmarks.md) 为准。\n\n`;
const output = resolve('docs/RESEARCH.md');
writeFileSync(output, `${header}${body}\n`, 'utf8');
console.log(`Research report generated: ${output}`);
