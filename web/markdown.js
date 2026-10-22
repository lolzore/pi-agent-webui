/*
 * Compact markdown renderer: fenced code, headings, lists, quotes, bold/italic/inline-code/links.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* A small eye, drawn rather than typed: it inherits the button's colour and
 * stays crisp at any zoom. */
/* A small copy glyph, same idea as the eye. */
const CODE_COPY_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5.2" y="5.2" width="8" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.8 3.4H4a1.4 1.4 0 0 0-1.4 1.4v6.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

const CODE_EYE_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3.2c3.1 0 5.4 2.6 6.2 4.1.2.4.2.9 0 1.3-.8 1.5-3.1 4.1-6.2 4.1S2.6 10.1 1.8 8.6a1.6 1.6 0 0 1 0-1.3C2.6 5.8 4.9 3.2 8 3.2Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>';

function renderMarkdown(src) {
  const parts = [];
  const segments = String(src ?? '').split(/```/);
  segments.forEach((seg, i) => {
    if (i % 2 === 1) { // fenced code block (first line may be a language tag)
      const nl = seg.indexOf('\n');
      const lang = (nl >= 0 ? seg.slice(0, nl) : '').trim().toLowerCase();
      const body = nl >= 0 ? seg.slice(nl + 1) : seg;
      /* Issue #175: an html or svg block can be *looked at*. The eye opens a
       * preview of what the code renders (a page, or the picture itself), and
       * while the agent is still writing it the preview follows along.
       *
       * The language tag is not enough: the same picture arrives fenced as svg,
       * as xml, or with no tag at all, and an html document may come as xml.
       * What the body *starts with* decides, so the eye is there whenever the
       * code really is a page or an svg. */
      const body0 = body.replace(/\n$/, '');
      const isSvg = lang === 'svg' || /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(body0);
      const isHtml = lang === 'html' || lang === 'htm' || lang === 'xml'
        || /^\s*(<!doctype html|<html[\s>])/i.test(body0);
      const viewable = isSvg || isHtml;
      const kind = isSvg ? 'svg' : 'html';
      const eye = viewable
        ? `<button class="code-eye" type="button" title="Preview ${isSvg ? 'this SVG' : 'this page'}" aria-label="Preview">${CODE_EYE_SVG}</button>`
        : '';
      // every block can be copied, viewable or not (next to the eye when there is one)
      const copy = `<button class="code-copy" type="button" title="Copy this code" aria-label="Copy">${CODE_COPY_SVG}</button>`;
      parts.push(`<div class="codebox${viewable ? ' viewable' : ''}"${viewable ? ` data-lang="${kind}"` : ''}>${copy}${eye}<button class="code-toggle" title="Collapse/expand code">&minus;</button><pre>${escapeHtml(body0)}</pre></div>`);
      return;
    }
    const lines = seg.split('\n');
    let html = '', para = [], list = null, quote = [];
    /* Each line is rendered inline on its own, and the <br> is inserted
     * afterwards. Joining the raw lines with '<br>' and passing the result to
     * inlineMd() escaped the tag, so a two-line paragraph showed a literal
     * "<br>" in the transcript instead of a line break. */
    const inlineLines = (lines) => lines.map((line) => inlineMd(line)).join('<br>');
    const flushPara = () => {
      if (para.length) { html += `<p>${inlineLines(para)}</p>`; para = []; }
    };
    const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((li) => `<li>${inlineMd(li)}</li>`).join('')}</${list.tag}>`; list = null; } };
    const flushQuote = () => { if (quote.length) { html += `<blockquote>${inlineLines(quote)}</blockquote>`; quote = []; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };
    /* Tables (issue #60).
     *
     * A GitHub-style table is a row of cells, then a delimiter row of dashes with
     * optional colons for alignment, then the body rows. None of that was handled, so
     * the pipes arrived in the transcript as literal text - a whole table as one <p>
     * per line, which is what the screenshot on that issue shows. The delimiter row is
     * required, which is what tells a table apart from a line of text that happens to
     * contain a pipe.
     *
     * The loop needed an index for this: a table's header is the line BEFORE the one
     * being read, and its body is the lines after, so it cannot be decided from one
     * line at a time. */
    const splitRow = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const isDelimRow = (s) => s.includes('|') && /^[\s|:-]+$/.test(s) && /-/.test(s);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trimEnd();
      let m;
      if (t.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1]) && splitRow(t).length === splitRow(lines[i + 1]).length) {
        flushAll();
        const head = splitRow(t);
        const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
        const cell = (v, a, tag) => `<${tag}${a ? ` style="text-align:${a}"` : ''}>${inlineMd(v)}</${tag}>`;
        html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
          head.map((v, k) => cell(v, align[k], 'th')).join('') + '</tr></thead><tbody>';
        let j = i + 2;
        for (; j < lines.length; j++) {
          const r = lines[j].trimEnd();
          if (!r.trim() || !r.includes('|')) break;
          const cells = splitRow(r);
          // pad or trim so a short row cannot break the table's shape
          html += '<tr>' + head.map((_, k) => cell(cells[k] == null ? '' : cells[k], align[k], 'td')).join('') + '</tr>';
        }
        html += '</tbody></table></div>';
        i = j - 1;                       // the loop's own ++ moves past the last row
      }
      else if ((m = t.match(/^(#{1,3})\s+(.*)/))) { flushAll(); html += `<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`; }
      else if ((m = t.match(/^[-*]\s+(.*)/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); }
      else if ((m = t.match(/^\d+[.)]\s+(.*)/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); }
      else if ((m = t.match(/^>\s?(.*)/))) { flushPara(); flushList(); quote.push(m[1]); }
      else if (t === '') { flushAll(); }
      // not escaped here: inlineMd() escapes, and escaping twice shows &amp;lt;
      else { flushList(); flushQuote(); para.push(t); }
    }
    flushAll();
    parts.push(html);
  });
  return parts.join('');

  function inlineMd(s) {
    /* Everything inline goes through here, and it escapes first.
     *
     * Only the paragraph path escaped its text before calling this, so a list
     * item, a heading, a quote or a table cell went in raw - and a message
     * containing real HTML (a <base>, an <iframe>, an <img onerror>) put that
     * element straight into the page. One message in this session carried
     * `<base href="about:srcdoc">` in a bullet: it became a real <base>, every
     * relative URL on the page stopped resolving, and the liveness heartbeat
     * closed the socket and re-rendered the whole chat every 25 seconds. */
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, (_, c) => `<code class="inline">${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(?<!["'=])(\bhttps?:\/\/[^\s<]+)(?!["'])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
}

/* Plain text for TTS / clipboard: drop code blocks and markdown noise. */
function stripMarkdown(src) {
  return String(src ?? '')
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* The context counter.
 *
 * This went round twice. First it held a reserved width in CSS, so the numbers
 * changing would not move its neighbours - and the reservation was wider than
 * almost every real value, which left a visible hole between the counter and the
 * token counter. Then the text itself was padded to a fixed width, which moved
 * the hole *inside* the counter: three stray spaces sitting between the number
 * and the `/` and another lot before `ctx`, which looked like a mistake.
 *
 * So it is left alone: no reservation, no padding, the numbers as they are. It
 * is set in tabular figures, so the digits keep their columns as they change,
 * and a number only changes length when it crosses a unit - `999.9K` to
 * `1.00M` - which happens once in a while rather than several times a second.
 * A counter that is quietly the right length is worth more than one that is
 * guaranteed the same length and looks spaced out. */
function ctxLabel(used, room) {
  return `[${used}/${room}ctx]`;
}

function formatTok(n) {
  if (n == null || isNaN(n)) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}
