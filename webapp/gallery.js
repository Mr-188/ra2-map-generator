// 优秀地图画廊 -- the catalogue half of 参数集.
//
// The file it reads (gallery.txt) is one line per map:
//
//   参数集 | 作者 | 日期 | 标题 | 一句话描述
//
// and ONLY the first field is required.  Everything else on a card -- environment,
// players, symmetry, ore, size, time, theatre, map type, whether the terrain seed
// was changed, and which build made it -- is DECODED from the code
// (webapp/sharebits.js), which is why the gallery needs no manual tagging: the
// parameters ARE the tags and they cannot go stale while the code still decodes.
// Adding a map to the gallery is adding one line.
//
// Clicking a card opens the generator with the code in the fragment
// (./index.html#p=<code>), which is the path the generator already implements: it
// restores the controls, tells the player whether the code came from another build,
// and generates with their own game files.  Nothing is uploaded, and this page ships
// no images at all.

import { decodeParams, enginePrefix } from './sharebits.js';

const el = (id) => document.getElementById(id);
const LABEL = {
  land: ['群岛', '大岛屿', '大岛屿群', '内陆'],
  time: ['早晨', '下午', '黄昏', '夜晚'],
  theater: ['温带', '雪地'],
  ore: ['低矿', '中矿', '高矿', '极高'],
  // The 180° entries use the generator's OWN wording, 分界 included: the same parameter
  // must not be named two different ways in one flow (you click a card, land on the
  // generator, and its banner describes what you just clicked).  "分界：" is what says the
  // diagonal is the dividing LINE rather than an axis, so it is not decoration.  The one
  // deliberate exception is 0: the <select> says 无 (fine after its 对称 field label) while
  // both the chip and the banner say 无对称 (see describeParams in app.js).
  symmetry: { 0: '无对称', 1: '左右轴对称', 3: '上下轴对称',
              2: '180°（分界：右上-左下）', 4: '180°（分界：左上-右下）' },
};

// The size the code stores is a slider index; show the double the engine gets.
const fmtSize = (v) => String(Number(Number(v).toFixed(2)));

let entries = [];        // { code, title, note, by, added, p (decoded), engine }
let ownEngine = 0;
let ownVersion = '';
// The order is deliberately MEANINGLESS: gallery.txt is a set, and every page load
// shuffles it, so the list is always the same content in a new order.  Two things
// follow from that, and both are on purpose:
//   * the file has no notion of position -- adding an entry is adding a line, and
//     nobody has to decide where it goes;
//   * the shuffle happens ONCE per load (keys are drawn here), not once per render.
//     A filter change re-sorts the same keys, so the cards you were just looking at
//     stay put -- reshuffling under a click would be disorienting.  「换一批」 is the
//     explicit way to ask for a new order.
let sortMode = 'random';
let orderKey = new Map();       // code -> random key, fixed for this page load
function reshuffle() {
  for (const e of entries) orderKey.set(e.code, Math.random());
}
// How many cards the grid holds at once.  The list grows a batch at a time: as the
// sentinel below the grid comes near the viewport the next batch is appended, and the
// button is there for anyone without IntersectionObserver (or who would rather click).
// Tune this one number; nothing else depends on it.
const PAGE = 24;
let shown = PAGE;

// What a card shows about the run: only things a player picks or recognises.  Two
// decoded fields are deliberately NOT shown (user decision, 2026-10-21):
//   * 多人 .yrm / 单人 .map - the file layout is not something a browsing player
//     chooses between; every gallery entry is a map either way;
//   * "换过地形种子" - it reports that a debug-ish field is non-zero, which says
//     nothing about the map.  The seed still travels in the 参数集, so the card
//     stays reproducible.
// Nothing here is a filter, so dropping a chip hides no map.
function chipsOf(p) {
  return [
    { text: LABEL.land[p.land], strong: true },
    { text: `${p.players} 人`, strong: true },
    { text: LABEL.symmetry[p.symmetry] || `对称 ${p.symmetry}`, strong: p.symmetry !== 0 },
    { text: p.width > 0 ? `${p.width} × ${p.height}` : `尺寸 ${fmtSize(p.size)}`, strong: true },
    { text: LABEL.time[p.time] },
    { text: LABEL.theater[p.theater] },
    { text: LABEL.ore[p.ore] },
  ];
}

function entryVersionTag(e) {
  // Only meaningful when this page knows its own engine (a packaged site has
  // version.json).  A source checkout says nothing rather than guessing.
  // Wording is for players: no engine ids, no hashes.
  if (!ownEngine) return null;
  if (!e.p.engine) return { text: '没写版本', dim: true, title: '这一条没说明它是哪个版本做的' };
  if (e.p.engine === ownEngine) return null;
  return { text: '另一个版本', dim: false,
           title: '这一条是另一个版本做的；点进去会告诉你可以切到那一版' };
}

function card(e) {
  const heading = e.title || derivedTitle(e.p);
  const article = document.createElement('article');
  article.className = 'card';

  const hit = document.createElement('a');
  hit.className = 'hit';
  hit.href = `./index.html#p=${e.code}`;
  hit.setAttribute('aria-label', `用参数集 ${e.code} 生成：${heading}`);

  const h = document.createElement('h2');
  h.className = 'title';
  h.textContent = heading;
  hit.appendChild(h);

  const code = document.createElement('code');
  code.className = 'code';
  code.textContent = e.code;
  hit.appendChild(code);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const c of chipsOf(e.p)) {
    const span = document.createElement('span');
    span.className = c.strong ? 'chip strong' : 'chip';
    span.textContent = c.text;
    chips.appendChild(span);
  }
  hit.appendChild(chips);

  if (e.note) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = e.note;
    hit.appendChild(note);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const left = document.createElement('span');
  left.textContent = [e.by || '', e.added || ''].filter(Boolean).join(' · ');
  meta.appendChild(left);
  const tag = entryVersionTag(e);
  if (tag) {
    const t = document.createElement('span');
    t.className = tag.dim ? 'tag dim' : 'tag';
    t.textContent = tag.text;
    t.title = tag.title;
    meta.appendChild(t);
  }
  hit.appendChild(meta);

  article.appendChild(hit);

  // Deliberately a SIBLING of the link (a button inside an <a> is invalid markup,
  // and the click would fight the navigation).
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = '复制';
  copy.title = '只复制参数集，不离开这一页';
  copy.addEventListener('click', () => copyCode(e.code, copy));
  article.appendChild(copy);

  return article;
}

async function copyCode(text, button) {
  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) ok = copyViaSelection(text);
  button.textContent = ok ? '已复制' : '按 Ctrl+C';
  button.classList.toggle('ok', ok);
  setTimeout(() => { button.textContent = '复制'; button.classList.remove('ok'); }, 1600);
}

// The same fallback the generator page uses: execCommand is deprecated but it is
// the only option when the Clipboard API is unavailable (a plain-http LAN address).
function copyViaSelection(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function fillSelect(node, options, allLabel) {
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel;
  node.appendChild(all);
  for (const [value, label] of options) {
    const o = document.createElement('option');
    o.value = String(value);
    o.textContent = label;
    node.appendChild(o);
  }
}

function currentFilters() {
  return { land: el('f-land').value, players: el('f-players').value,
           sym: el('f-sym').value, q: el('f-q').value.trim().toLowerCase() };
}

// The tile that closes the grid: the same door as the header, placed where a player
// who has just read a dozen descriptions actually is.  It leads to the generator
// WITHOUT a code -- rolling your own is the other reason to be here.
//
// The line under it is the sublap to the 投稿 channel, and it sits OUTSIDE the link on
// purpose: the tile's click target must mean one thing (open the generator), and the
// visitor who just thought "mine is better than these" is exactly who submits.
function ownMapTile() {
  const article = document.createElement('article');
  article.className = 'card tile';
  const hit = document.createElement('a');
  hit.className = 'hit';
  hit.href = './index.html';
  hit.setAttribute('aria-label', '打开生成器，自己摇一张');
  const t = document.createElement('p');
  t.className = 'tile-t';
  t.textContent = '自己摇一张 →';
  const s = document.createElement('p');
  s.className = 'tile-s';
  s.textContent = '不看现成的：打开生成器，所有参数都能随机';
  hit.appendChild(t);
  hit.appendChild(s);
  const tip = document.createElement('p');
  tip.className = 'tile-tip';
  tip.textContent = '摇到好图？加群 1002834147 投稿（附参数集）';
  article.appendChild(hit);
  article.appendChild(tip);
  return article;
}

function render() {
  const f = currentFilters();
  let list = entries.filter((e) => {
    if (f.land !== '' && String(e.p.land) !== f.land) return false;
    if (f.players !== '' && String(e.p.players) !== f.players) return false;
    if (f.sym !== '' && String(e.p.symmetry) !== f.sym) return false;
    if (f.q) {
      const hay = `${e.title} ${e.note || ''} ${e.code} ${e.by || ''}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
  // 随机 is the default and it is a real order, not "whatever the file said": the keys
  // were drawn once for this page load (see orderKey), so filtering keeps every card in
  // the position it had.  The two date sorts are there for when someone IS looking for
  // something specific.
  if (sortMode === 'new') {
    list = list.slice().sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')));
  } else if (sortMode === 'old') {
    list = list.slice().sort((a, b) => String(a.added || '').localeCompare(String(b.added || '')));
  } else {
    list = list.slice().sort((a, b) => (orderKey.get(a.code) || 0) - (orderKey.get(b.code) || 0));
  }

  const batch = list.slice(0, shown);
  const grid = el('grid');
  grid.textContent = '';
  for (const e of batch) grid.appendChild(card(e));
  // Always last, and always there -- including when a filter matched nothing, which
  // is exactly when "or roll your own" is the useful thing to offer.
  grid.appendChild(ownMapTile());

  const rest = list.length - batch.length;
  const more = el('more');
  more.hidden = rest <= 0;
  if (rest > 0) more.textContent = `加载更多（还有 ${rest} 条）`;
  const empty = el('empty');
  empty.hidden = list.length > 0;
  if (!empty.hidden) {
    // Two different situations, and the message has to say which one: a filter that
    // matches nothing (the player can undo that) versus a gallery with no entries at all
    // (the state a fresh site ships in -- and the one where the useful thing to say is
    // "the first one can be yours").
    empty.textContent = entries.length === 0
      ? '画廊还没有收录地图 —— 下一张可以是你做的：自己摇一张，把参数集发到页脚的 QQ 群。'
      : '没有符合筛选条件的条目。';
  }
  el('count').textContent = `${list.length} / ${entries.length} 条`;
  watchMore(rest > 0);
}

// Auto-load when the button comes near the viewport.  Disconnected whenever there is
// nothing left, so scrolling after the last batch cannot keep rebuilding the grid.
let moreObserver = null;
function watchMore(active) {
  const more = el('more');
  if (!('IntersectionObserver' in window)) return;      // the button still works
  if (moreObserver) { moreObserver.disconnect(); moreObserver = null; }
  if (!active) return;
  moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { rootMargin: '600px 0px' });
  moreObserver.observe(more);
}

function loadMore() {
  shown += PAGE;
  render();
}

// One line -> one entry.  `|` separated, and everything from the 5th field on is the
// note, so a note may itself contain a `|`.  Missing trailing fields are fine: a line
// with only a code is a complete entry.
function parseLine(line) {
  const parts = line.split('|').map((s) => s.trim());
  const code = parts[0] || '';
  if (!code) return null;
  return { code, by: parts[1] || '', added: parts[2] || '', title: parts[3] || '',
           note: parts.slice(4).join(' | ') };
}

function parseGallery(text) {
  const entries = [];
  const bad = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let e = null;
    try {
      e = parseLine(line);
      if (e) decodeParams(e.code);        // reject here, so the card count is honest
    } catch (err) {
      bad.push({ line, why: (err && err.message) || String(err) });
      e = null;
    }
    if (e) entries.push(e);
  }
  return { entries, bad };
}

// A card always has a heading: with no title, the parameters say what it is.
function derivedTitle(p) {
  return [LABEL.land[p.land], `${p.players} 人`,
          LABEL.symmetry[p.symmetry] || `对称 ${p.symmetry}`,
          p.width > 0 ? `${p.width} × ${p.height}` : `尺寸 ${fmtSize(p.size)}`].join(' · ');
}

async function load() {
  let text = null;
  try {
    const r = await fetch('./gallery.txt', { cache: 'no-cache' });
    if (r.ok) text = await r.text();
  } catch { text = null; }
  if (text === null) {
    el('empty').hidden = false;
    el('empty').textContent = '画廊列表暂时读不到，刷新一下试试。';
    console.warn('gallery: gallery.txt 读不到（一行一条：参数集 | 作者 | 日期 | 标题 | 描述）');
    return;
  }

  const parsed = parseGallery(text);
  if (parsed.bad.length) {
    // Visible, not silently dropped -- but in the visitor's words.  The details (the
    // line and why it failed) go to the console, where the person maintaining the
    // list will look, not to a player who cannot act on them.
    const s = el('sample');
    s.hidden = false;
    s.textContent = `有 ${parsed.bad.length} 条地图暂时读不出来，已经跳过。`;
    for (const b of parsed.bad) console.warn('gallery: 解不出来的一行:', b.line, '—', b.why);
  }

  // This page's own engine, so a card can say "this one came from another build".
  // Absent in a source checkout -- then no card claims anything about versions.
  try {
    const r = await fetch('./version.json', { cache: 'no-cache' });
    if (r.ok) {
      const info = await r.json();
      ownVersion = info.version || '';
      ownEngine = enginePrefix(info.engine);
    }
  } catch { /* no version.json: stay quiet, see entryVersionTag */ }

  // Decode once, here: the filters, the sort and the cards all read the decoded
  // parameters, and a line that decodes is a line that can be clicked.
  entries = parsed.entries.map((e) => ({ ...e, p: decodeParams(e.code) }));
  reshuffle();          // once per page load: this is what makes 随机 the default order

  fillSelect(el('f-land'), LABEL.land.map((l, i) => [i, l]), '全部');
  fillSelect(el('f-players'), [2, 3, 4, 5, 6, 7, 8].map((n) => [n, `${n} 人`]), '全部');
  fillSelect(el('f-sym'), [0, 1, 3, 2, 4].map((k) => [k, LABEL.symmetry[k]]), '全部');

  // Changing what is listed starts the batches over: a filter that matches 40 cards
  // should show the first 24 of them, not "as many as the last filter had scrolled to".
  const rerender = () => { shown = PAGE; render(); };
  for (const id of ['f-land', 'f-players', 'f-sym', 'f-q']) {
    el(id).addEventListener('input', rerender);
    el(id).addEventListener('change', rerender);
  }
  el('f-sort').addEventListener('change', () => { sortMode = el('f-sort').value; rerender(); });
  // 换一批: a new shuffle WITHOUT a refresh, which also keeps the current filter (the
  // reason it exists at all -- refreshing to get a new order would throw that away).
  el('f-again').addEventListener('click', () => {
    reshuffle();
    if (sortMode !== 'random') { sortMode = 'random'; el('f-sort').value = 'random'; }
    rerender();
  });
  el('more').addEventListener('click', loadMore);
  el('f-reset').addEventListener('click', () => {
    el('f-land').value = ''; el('f-players').value = ''; el('f-sym').value = '';
    el('f-q').value = ''; el('f-sort').value = 'random'; sortMode = 'random';
    reshuffle();
    rerender();
  });

  render();
}

load();
