/*
 * Party emoji confetti (issue #201).
 *
 * SchizoDev's request, from the screenshot: "each time an AI outputs emojis on
 * the web ui ... especially the party emoji ... there should be confetti and
 * stuff." This is deliberately small and local: no canvas, no dependency, no
 * work while nothing is happening. A reply that contains 🎉 or 🥳 gets one short
 * burst of falling pieces, once per message, and only when the reader has the
 * setting on. prefers-reduced-motion turns it off at the source.
 */
'use strict';

const PARTY_EMOJI = /[\u{1F389}\u{1F973}]/u;   // 🎉 🥳
const partySeen = new Set();

function messageTextForParty(msg) {
  if (!msg) return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ');
}

/* Call after an assistant message has been rendered. The key keeps a re-render
 * of the same message (a tool card arriving, a rebuild) from firing again. */
function maybeCelebrate(msg) {
  if (!msg || SET.partyConfetti === false) return;
  const text = messageTextForParty(msg);
  if (!text || !PARTY_EMOJI.test(text)) return;
  const key = msg.timestamp != null ? `t${msg.timestamp}` : (msg.id ? `i${msg.id}` : text.slice(0, 80));
  if (partySeen.has(key)) return;
  partySeen.add(key);
  celebrate();
}

function celebrate() {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!document.body || document.querySelector('.party-layer')) return;
  const layer = el('div', 'party-layer');
  const colors = ['#ff5d8f', '#ffd166', '#5b9dff', '#57d9a3', '#c77dff', '#ff9f43'];
  for (let i = 0; i < 64; i++) {
    const bit = el('span', 'party-bit');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = `${Math.random() * 0.35}s`;
    bit.style.animationDuration = `${1.6 + Math.random() * 1.1}s`;
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    bit.style.width = `${4 + Math.random() * 6}px`;
    bit.style.height = `${7 + Math.random() * 10}px`;
    layer.appendChild(bit);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 3200);
}
