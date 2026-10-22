/*
 * Shared page helpers, split out of app.js as the first phase of breaking up
 * the two monolith files (issue #54).
 *
 * Loaded before app.js. These are the pieces every other part of the page uses
 * and that depend on nothing else in it - the two DOM shortcuts, the HTML
 * escaper, and three small formatters. The names stay global on purpose: the
 * rest of the page did not have to change, so this split is behaviour-neutral.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function timeStr(ts) {
  try { return new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
