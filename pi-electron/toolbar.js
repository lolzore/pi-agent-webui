'use strict';
const tabs = document.getElementById('tabs');
let feeds = [];

function paint(state) {
  tabs.replaceChildren();
  for (const f of state.feeds || []) {
    const b = document.createElement('button');
    b.textContent = f.label;
    b.dataset.key = f.key;
    if (f.key === state.active) {
      b.classList.add('on');
      b.style.borderColor = f.accent;
    }
    b.onclick = async () => paint(await window.piShorts.setFeed(f.key));
    tabs.appendChild(b);
  }
}

document.getElementById('reload').onclick = () => window.piShorts.reload();
document.getElementById('app').onclick = () => window.piShorts.openApp();
document.getElementById('browser').onclick = () => window.piShorts.openExternal();
document.getElementById('close').onclick = async () => { await window.piShorts.close(); };

/* Drag the left edge: the pane width is measured from the pointer to the right
 * edge of this view, which is the right edge of the window. */
const drag = document.getElementById('drag');
drag.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const right = window.screenX + window.innerWidth;
  const move = (ev) => window.piShorts.resize(right - ev.screenX);
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

window.piShorts.state().then(paint);
