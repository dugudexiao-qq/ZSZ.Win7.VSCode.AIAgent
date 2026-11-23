(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.MarkdownLite = api; }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* A deliberately small, dependency-free Markdown renderer for the chat
   * webview. Target runtimes: Node 16.13.2 (VS Code 1.70) and Chromium 100.
   * Security first: every piece of user/model text is HTML-escaped, and link
   * URLs go through a protocol allowlist. No raw HTML is ever passed through.
   */

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Only http/https/mailto links are clickable. Everything else (javascript:,
   * data:, vbscript:, relative paths) renders as plain text, never as href. */
  function safeUrl(value) {
    var raw = String(value === undefined || value === null ? '' : value).trim();
    if (/^(https?:\/\/|mailto:)/i.test(raw)) { return raw; }
    return '';
  }

  /* Inline formatting. Input is raw text; output is escaped HTML. */
  function inline(raw) {
    var codes = [];
    var s = String(raw === undefined || raw === null ? '' : raw);

    // Pull inline code out first so its contents never get formatting applied.
    s = s.replace(/`([^`\n]+)`/g, function (_m, code) {
      codes.push('<code>' + escapeHtml(code) + '</code>');
      return '\u0001' + (codes.length - 1) + '\u0002';
    });

    s = escapeHtml(s);

    // Images are intentionally NOT rendered (CSP default-src 'none'); show alt.
    // Note: s has already been escaped above, so url/label are escaped too.
    // Do NOT escape the safe URL a second time (that would turn & into &amp;amp;).
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_m, alt, url) {
      var safe = safeUrl(url);
      if (safe) {
        return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + (alt || 'image') + '</a>';
      }
      return alt || '';
    });

    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, label, url) {
      var safe = safeUrl(url);
      if (!safe) { return label; }
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });

    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_/g, '$1<em>$2</em>');

    s = s.replace(/\u0001(\d+)\u0002/g, function (_m, i) {
      return codes[Number(i)] || '';
    });
    return s;
  }

  function isHr(line) {
    return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  }

  function isFence(line) {
    return /^\s*```/.test(line);
  }

  function isTableDivider(line) {
    return /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
  }

  function splitRow(line) {
    var t = String(line).trim();
    if (t.charAt(0) === '|') { t = t.slice(1); }
    if (t.charAt(t.length - 1) === '|') { t = t.slice(0, -1); }
    return t.split('|').map(function (c) { return c.trim(); });
  }

  function renderTable(headerLine, dividerLine, rows) {
    var heads = splitRow(headerLine);
    var aligns = splitRow(dividerLine).map(function (c) {
      if (/^:-+:$/.test(c)) { return 'center'; }
      if (/-+:$/.test(c)) { return 'right'; }
      if (/^:-+/.test(c)) { return 'left'; }
      return '';
    });
    function style(i) {
      return aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
    }
    var out = ['<table>'];
    out.push('<thead><tr>');
    heads.forEach(function (h, i) { out.push('<th' + style(i) + '>' + inline(h) + '</th>'); });
    out.push('</tr></thead><tbody>');
    rows.forEach(function (row) {
      var cells = splitRow(row);
      out.push('<tr>');
      heads.forEach(function (_h, i) {
        out.push('<td' + style(i) + '>' + inline(cells[i] === undefined ? '' : cells[i]) + '</td>');
      });
      out.push('</tr>');
    });
    out.push('</tbody></table>');
    return out.join('');
  }

  /* Block-level rendering. An unclosed fence is rendered to the end so the
   * view stays stable while a streamed response is still being generated. */
  function render(src) {
    var lines = String(src === undefined || src === null ? '' : src)
      .replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    var n = lines.length;

    while (i < n) {
      var line = lines[i];

      // Fenced code block (optionally with a language tag).
      if (isFence(line)) {
        var lang = line.replace(/^\s*```/, '').trim().split(/\s+/)[0] || '';
        var codeLines = [];
        i += 1;
        while (i < n && !isFence(lines[i])) { codeLines.push(lines[i]); i += 1; }
        if (i < n) { i += 1; }
        var attr = lang ? ' data-lang="' + escapeHtml(lang) + '"' : '';
        out.push('<pre' + attr + '><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) { i += 1; continue; }

      if (isHr(line)) { out.push('<hr>'); i += 1; continue; }

      // ATX heading.
      var hm = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (hm) {
        var level = hm[1].length;
        out.push('<h' + level + '>' + inline(hm[2]) + '</h' + level + '>');
        i += 1;
        continue;
      }

      // Table: header row followed by a delimiter row.
      if (line.indexOf('|') !== -1 && i + 1 < n && isTableDivider(lines[i + 1])) {
        var rows = [];
        var j = i + 2;
        while (j < n && lines[j].indexOf('|') !== -1 && lines[j].trim()) {
          rows.push(lines[j]); j += 1;
        }
        out.push(renderTable(line, lines[i + 1], rows));
        i = j;
        continue;
      }

      // Blockquote: consume consecutive '>' lines.
      if (/^\s*>/.test(line)) {
        var quoted = [];
        while (i < n && /^\s*>/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + render(quoted.join('\n')) + '</blockquote>');
        continue;
      }

      // Lists (ordered or unordered). Deeper-indented lines are folded into
      // the current item as continuation lines rather than dropped.
      var um = line.match(/^(\s*)([-*+])\s+(.*)$/);
      var om = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
      if (um || om) {
        var ordered = Boolean(om);
        var baseIndent = (um ? um[1] : om[1]).length;
        var tag = ordered ? 'ol' : 'ul';
        var items = [];
        var currentParts = [];
        var first = true;

        while (i < n) {
          var mu = lines[i].match(/^(\s*)([-*+])\s+(.*)$/);
          var mo = lines[i].match(/^(\s*)(\d+)[.)]\s+(.*)$/);
          // A change of list type starts a new list.
          if (ordered ? !mo : !mu) { break; }
          var m = mu || mo;
          if (!m) {
            if (currentParts.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
              currentParts.push(lines[i].trim()); i += 1; continue;
            }
            if (!lines[i].trim() && i + 1 < n && /^\s{2,}/.test(lines[i + 1])) {
              i += 1; continue;
            }
            break;
          }
          var indent = m[1].length;
          if (indent > baseIndent && currentParts.length) {
            currentParts.push(m[m.length - 1]); i += 1; continue;
          }
          if (indent < baseIndent) { break; }
          if (!first && currentParts.length) { items.push(currentParts.map(inline).join('<br>')); }
          currentParts = [m[m.length - 1]];
          first = false;
          i += 1;
        }
        if (currentParts.length) { items.push(currentParts.map(inline).join('<br>')); }
        out.push('<' + tag + '>' + items.map(function (it) {
          return '<li>' + it + '</li>';
        }).join('') + '</' + tag + '>');
        continue;
      }

      // Paragraph: gather consecutive plain lines, join soft breaks with <br>.
      var para = [];
      while (i < n) {
        var pl = lines[i];
        if (!pl.trim() || isFence(pl) || isHr(pl) || /^\s*#{1,6}\s/.test(pl) ||
            /^\s*>/.test(pl) || /^(\s*)([-*+])\s+/.test(pl) ||
            /^(\s*)(\d+)[.)]\s+/.test(pl)) { break; }
        if (pl.indexOf('|') !== -1 && i + 1 < n && isTableDivider(lines[i + 1])) { break; }
        para.push(pl.trim());
        i += 1;
      }
      if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); }
      else { i += 1; }
    }

    return out.join('');
  }

  /* A plain-text fallback that still escapes, used if scripts are disabled. */
  function plain(src) {
    return '<p>' + inline(src).replace(/\n/g, '<br>') + '</p>';
  }

  return { render: render, inline: inline, escapeHtml: escapeHtml, safeUrl: safeUrl, plain: plain };
}));
