/* Safe, dependency-free Markdown renderer for the read-only Hub board. */
(function (global) {
  'use strict';

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function safeUrl(value, image) {
    const url = String(value || '').trim();
    if (image) {
      return /^(https?:\/\/|data:image\/(?:png|jpeg|jpg|gif|webp);base64,|\/)/i.test(url) ? url : '';
    }
    return /^(https?:\/\/|#|\/)/i.test(url) ? url : '';
  }

  function inlineMarkdown(text) {
    let s = escapeHtml(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_match, code) => {
      codes.push(`<code>${code}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, url) => {
      const safe = safeUrl(url, true);
      return safe ? `<img src="${safe}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">` : match;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, url) => {
      const safe = safeUrl(url, false);
      return safe ? `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>` : match;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_match, index) => codes[Number(index)] ?? '');
  }

  function splitRow(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map((cell) => cell.trim());
  }

  function isTable(lines, index) {
    if (!lines[index]?.includes('|') || !lines[index + 1]) return false;
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
  }

  function renderMarkdown(source) {
    const normalized = String(source).replace(/\r\n?/g, '\n');
    const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
    const body = frontmatter ? normalized.slice(frontmatter[0].length) : normalized;
    const lines = body.split('\n');
    const out = [];
    let i = 0;
    if (frontmatter) {
      out.push(`<details class="md-frontmatter"><summary>frontmatter</summary><pre>${escapeHtml(frontmatter[1])}</pre></details>`);
    }

    const isFence = (line) => /^```/.test(line);
    const isHeading = (line) => /^#{1,6}\s+/.test(line);
    const isQuote = (line) => /^\s*>/.test(line);
    const isHr = (line) => /^\s*(---+|\*\*\*+|___+)\s*$/.test(line);
    const isList = (line) => /^\s*([-*+]|\d+\.)\s+/.test(line);
    const isBlockStart = (line, index) =>
      isFence(line) || isHeading(line) || isQuote(line) || isHr(line) || isList(line) || isTable(lines, index);

    function parseList(start) {
      const first = lines[start].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      const base = first[1].length;
      const ordered = /\d+\./.test(first[2]);
      const tag = ordered ? 'ol' : 'ul';
      let html = `<${tag}>`;
      i = start;
      while (i < lines.length) {
        const match = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!match) break;
        const indent = match[1].length;
        if (indent !== base) break;
        if (/\d+\./.test(match[2]) !== ordered) break;
        let content = match[3];
        let prefix = '';
        const task = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          prefix = `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> `;
          content = task[2];
        }
        i += 1;
        let nested = '';
        if (i < lines.length) {
          const next = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+/);
          if (next && next[1].length > base) nested = parseList(i);
        }
        html += `<li>${prefix}${inlineMarkdown(content)}${nested}</li>`;
      }
      return `${html}</${tag}>`;
    }

    function parseTable(start) {
      const header = splitRow(lines[start]);
      const aligns = splitRow(lines[start + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return left ? 'left' : '';
      });
      i = start + 2;
      let html = '<div class="md-table"><table><thead><tr>';
      header.forEach((cell, index) => {
        html += `<th${aligns[index] ? ` class="md-align-${aligns[index]}"` : ''}>${inlineMarkdown(cell)}</th>`;
      });
      html += '</tr></thead><tbody>';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitRow(lines[i]);
        if (!cells.length) break;
        html += '<tr>';
        cells.forEach((cell, index) => {
          html += `<td${aligns[index] ? ` class="md-align-${aligns[index]}"` : ''}>${inlineMarkdown(cell)}</td>`;
        });
        html += '</tr>';
        i += 1;
      }
      return `${html}</tbody></table></div>`;
    }

    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        i += 1;
        continue;
      }

      if (isFence(line)) {
        const language = line.slice(3).trim().replace(/[^\w-]/g, '');
        i += 1;
        const code = [];
        while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i += 1;
        out.push(`<pre><code${language ? ` class="language-${language}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (isHr(line)) {
        out.push('<hr>');
        i += 1;
        continue;
      }

      if (isQuote(line)) {
        const quote = [];
        while (i < lines.length && isQuote(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
        continue;
      }

      if (isTable(lines, i)) {
        out.push(parseTable(i));
        continue;
      }

      if (isList(line)) {
        out.push(parseList(i));
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i], i)) {
        paragraph.push(lines[i++]);
      }
      if (paragraph.length) {
        out.push(`<p>${inlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
      }
    }
    return out.join('\n');
  }

  global.renderMarkdown = renderMarkdown;
})(typeof window !== 'undefined' ? window : globalThis);
