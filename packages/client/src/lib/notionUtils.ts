/**
 * notionUtils — client-side utilities for working with Notion API data.
 *
 * notionBlocksToMarkdown: converts the Notion block-children API response
 * into a GitHub-Flavored Markdown string suitable for rendering through
 * ReactMarkdown + remark-gfm.
 *
 * richTextToMd: converts a Notion rich_text array into inline markdown,
 * handling bold, italic, code, strikethrough, and links.
 *
 * getPageTitle: extracts the human-readable title from a Notion page's
 * properties (handles 'title' property and 'Name' fallback).
 *
 * getPageIcon: returns an emoji or null from a Notion page/database icon.
 */

import type { NotionBlock, NotionRichText, NotionPage, NotionDatabase, NotionSearchResult } from '@/lib/api';

// ── Rich text → markdown ──────────────────────────────────────────────────────

export function richTextToMd(richText: NotionRichText[] | undefined): string {
  if (!richText || richText.length === 0) return '';
  return richText.map((rt) => {
    let text = rt.plain_text;
    if (!text) return '';

    const ann = rt.annotations;
    // Apply annotations inside-out: code wraps first, then bold/italic
    if (ann?.code) {
      text = `\`${text}\``;
    } else {
      if (ann?.bold && ann?.italic) text = `***${text}***`;
      else if (ann?.bold)           text = `**${text}**`;
      else if (ann?.italic)         text = `*${text}*`;
      if (ann?.strikethrough)       text = `~~${text}~~`;
    }

    // Link (check both rich_text.text.link and rich_text.href)
    const url = rt.text?.link?.url ?? rt.href;
    if (url) text = `[${text}](${url})`;

    return text;
  }).join('');
}

// ── Blocks → markdown ─────────────────────────────────────────────────────────

export function notionBlocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  let numberedListCounter = 0;

  for (const block of blocks) {
    const type = block.type;

    // Track numbered list continuity
    if (type !== 'numbered_list_item') {
      numberedListCounter = 0;
    }

    switch (type) {
      case 'paragraph': {
        const text = richTextToMd(block.paragraph?.rich_text);
        lines.push(text || '');
        lines.push('');
        break;
      }

      case 'heading_1': {
        const text = richTextToMd(block.heading_1?.rich_text);
        lines.push(`# ${text}`);
        lines.push('');
        break;
      }

      case 'heading_2': {
        const text = richTextToMd(block.heading_2?.rich_text);
        lines.push(`## ${text}`);
        lines.push('');
        break;
      }

      case 'heading_3': {
        const text = richTextToMd(block.heading_3?.rich_text);
        lines.push(`### ${text}`);
        lines.push('');
        break;
      }

      case 'bulleted_list_item': {
        const text = richTextToMd(block.bulleted_list_item?.rich_text);
        lines.push(`- ${text}`);
        break;
      }

      case 'numbered_list_item': {
        numberedListCounter++;
        const text = richTextToMd(block.numbered_list_item?.rich_text);
        lines.push(`${numberedListCounter}. ${text}`);
        break;
      }

      case 'to_do': {
        const checked = block.to_do?.checked ? 'x' : ' ';
        const text = richTextToMd(block.to_do?.rich_text);
        lines.push(`- [${checked}] ${text}`);
        break;
      }

      case 'toggle': {
        // Render toggle header as bold, children not fetched inline (too deep)
        const text = richTextToMd(block.toggle?.rich_text);
        lines.push(`**${text}**`);
        lines.push('');
        break;
      }

      case 'code': {
        const lang = block.code?.language ?? '';
        const text = richTextToMd(block.code?.rich_text);
        const caption = block.code?.caption ? richTextToMd(block.code.caption) : '';
        lines.push('```' + lang);
        lines.push(text);
        lines.push('```');
        if (caption) lines.push(`*${caption}*`);
        lines.push('');
        break;
      }

      case 'quote': {
        const text = richTextToMd(block.quote?.rich_text);
        // Multi-line quotes
        text.split('\n').forEach((l) => lines.push(`> ${l}`));
        lines.push('');
        break;
      }

      case 'callout': {
        const icon = block.callout?.icon?.emoji ?? '';
        const text = richTextToMd(block.callout?.rich_text);
        const prefix = icon ? `${icon} ` : '';
        text.split('\n').forEach((l, i) => lines.push(i === 0 ? `> ${prefix}${l}` : `> ${l}`));
        lines.push('');
        break;
      }

      case 'divider': {
        lines.push('---');
        lines.push('');
        break;
      }

      case 'image': {
        const url = block.image?.type === 'external'
          ? block.image.external?.url
          : block.image?.file?.url;
        const caption = block.image?.caption ? richTextToMd(block.image.caption) : 'image';
        if (url) lines.push(`![${caption}](${url})`);
        lines.push('');
        break;
      }

      case 'embed':
      case 'bookmark':
      case 'link_preview': {
        const url = (block as { [key: string]: { url?: string } })[type]?.url;
        if (url) lines.push(`[${url}](${url})`);
        lines.push('');
        break;
      }

      case 'equation': {
        lines.push(`\`${block.equation?.expression ?? ''}\``);
        lines.push('');
        break;
      }

      case 'child_page': {
        const title = block.child_page?.title ?? 'Untitled';
        // Render as an italic note; actual navigation is done via the tree
        lines.push(`*📄 Sub-page: ${title}*`);
        lines.push('');
        break;
      }

      case 'child_database': {
        const title = block.child_database?.title ?? 'Untitled';
        lines.push(`*🗃️ Database: ${title}*`);
        lines.push('');
        break;
      }

      case 'table': {
        // Table headers rendered as a separator row; actual cells come as
        // table_row children which are handled separately if loaded.
        lines.push('*(Table — expand sub-pages to view rows)*');
        lines.push('');
        break;
      }

      case 'table_row': {
        // Should only appear when fetching table children directly
        const cells = block.table_row?.cells ?? [];
        const row = '| ' + cells.map((c) => richTextToMd(c)).join(' | ') + ' |';
        lines.push(row);
        break;
      }

      case 'column_list':
      case 'column': {
        // Columns require nested child fetching — just add whitespace
        break;
      }

      case 'synced_block':
      case 'template':
      case 'link_to_page': {
        // These require additional API calls — skip gracefully
        break;
      }

      default: {
        // Unknown block type — render plain text if possible via best-effort
        const anyBlock = block as Record<string, { rich_text?: NotionRichText[] }>;
        const richText = anyBlock[type]?.rich_text;
        if (richText) {
          const text = richTextToMd(richText);
          if (text) { lines.push(text); lines.push(''); }
        }
        break;
      }
    }
  }

  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

// ── Page metadata helpers ─────────────────────────────────────────────────────

/** Extract the human-readable title from a Notion page's properties. */
export function getPageTitle(page: NotionPage): string {
  // Notion always has a 'title' type property; the key is usually 'title' or 'Name'
  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'title' && prop.title && prop.title.length > 0) {
      return prop.title.map((rt) => rt.plain_text).join('') || 'Untitled';
    }
  }
  return 'Untitled';
}

/** Extract emoji icon from a Notion page or database, or null if none. */
export function getPageIcon(item: NotionPage | NotionDatabase): string | null {
  if (!item.icon) return null;
  if (item.icon.type === 'emoji' && item.icon.emoji) return item.icon.emoji;
  return null;
}

/** Get the title of any Notion search result (page or database). */
export function getResultTitle(result: NotionSearchResult): string {
  if (result.object === 'page') {
    return getPageTitle(result as NotionPage);
  }
  // Database
  const db = result as NotionDatabase;
  return db.title.map((rt) => rt.plain_text).join('') || 'Untitled Database';
}

/** Get the icon of any Notion search result. */
export function getResultIcon(result: NotionSearchResult): string | null {
  return getPageIcon(result as NotionPage);
}

/** Returns true if this search result has children (for lazy expansion). */
export function resultHasChildren(result: NotionSearchResult): boolean {
  if (result.object === 'database') return true; // databases always have query-able entries
  const page = result as NotionPage;
  return page.has_children === true;
}
