/* In-page quality audit. Returns {category: [finding, ...]}.
 *
 * Each check exists because something shipped broken and nobody saw it. The
 * comment on each says which.
 */
(opts) => {
  const out = {};
  const add = (cat, msg) => { (out[cat] ||= []).push(msg); };

  const vw = document.documentElement.clientWidth;
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = (el) => {
    const h = el.querySelector('h1, h2, h3');
    return h ? text(h).slice(0, 40) : (el.className || el.tagName).toString().slice(0, 40);
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const panels = [...document.querySelectorAll('.panel')].filter(visible);

  /* ── overflow ───────────────────────────────────────────────────────────
     The page body scrolling sideways is never intentional. Wide tables and
     charts are allowed to scroll inside their own container. */
  if (document.documentElement.scrollWidth > vw + 1) {
    add('horizontal overflow', `page scrolls sideways (${document.documentElement.scrollWidth}px in ${vw}px)`);
  }
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      const scrollable = el.closest(
        '[style*="overflow"], .tbl-wrap, .table-wrap, .cal-wrap, .chart, .scroll, .scroller');
      if (!scrollable) {
        add('element off the right edge',
            `<${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 30)}"> right=${Math.round(r.right)}`);
        break;   // one per page is enough to act on
      }
    }
  }

  /* ── clipped text ───────────────────────────────────────────────────────
     A label the box is too small for silently loses its end. */
  for (const el of document.querySelectorAll('h1,h2,h3,.stat,.metric,.value,td,th,button,.lbl')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    if (s.overflow === 'visible' || el.scrollWidth <= el.clientWidth + 2) continue;
    if (s.textOverflow === 'ellipsis') continue;   // deliberate truncation
    add('text clipped', `${el.tagName.toLowerCase()} "${text(el).slice(0, 34)}" ${el.scrollWidth}>${el.clientWidth}px`);
  }

  /* ── dead panels ────────────────────────────────────────────────────────
     A panel that renders a heading and nothing else looks like a failure
     whether or not it is one. */
  for (const p of panels) {
    const body = p.querySelector('.panel-body, .body') || p;
    const hasContent = body.querySelector('svg, table, canvas, li, input, .stat, .metric, .sess, .empty, .note, p, .fixture, .meter');
    if (!hasContent && text(body).length < 12) {
      add('empty panel', `"${label(p)}" has a heading and no content`);
    }
    if (p.querySelector('.sk, .skeleton') && !hasContent) {
      add('stuck loading', `"${label(p)}" still showing a skeleton`);
    }
  }

  /* ── placeholder leakage ────────────────────────────────────────────────
     "Target for next week — —". A dash with no sentence is not an empty
     state, it is an unrendered one. */
  for (const p of panels) {
    const t = text(p);
    const stripped = t.replace(/[—–-]/g, '').trim();
    if (t.length && stripped.length < Math.min(20, t.length * 0.4)) {
      add('placeholder only', `"${label(p)}" is mostly dashes: "${t.slice(0, 50)}"`);
    }
    if (/\b(undefined|NaN|null|Infinity|\[object)/.test(t)) {
      add('broken value', `"${label(p)}": ${t.match(/.{0,24}(undefined|NaN|null|Infinity|\[object).{0,16}/)[0]}`);
    }
  }

  /* ── timeframes ─────────────────────────────────────────────────────────
     Ten of twenty-nine charts once stated no period at all. */
  const TIMEY = /\b(week|weeks|month|months|year|years|day|days|all[- ]time|lifetime|season|to date|trailing|since|per week|per month|\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
  for (const p of panels) {
    if (!p.querySelector('svg .plot, svg[role="img"], table')) continue;
    const head = p.querySelector('.panel-head, header') || p;
    if (!TIMEY.test(text(head))) {
      add('no timeframe stated', `"${label(p)}"`);
    }
  }

  /* ── tap targets ────────────────────────────────────────────────────────
     Gym floor, one thumb. */
  if (opts.viewport === 'phone') {
    const seen = new Set();
    for (const el of document.querySelectorAll('button, a[href], input, select, [role="button"]')) {
      if (!visible(el)) continue;
      // A visually-hidden control is operated through its label; measuring the
      // 1x1 input is measuring the wrong box.
      if (el.closest('.sr') || el.classList.contains('sr')) continue;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) continue;
      const r = el.getBoundingClientRect();
      const key = `${el.tagName}:${text(el).slice(0, 16)}`;
      if (seen.has(key)) continue;
      if (Math.min(r.width, r.height) < opts.minTap) {
        seen.add(key);
        add('tap target too small',
            `"${text(el).slice(0, 22) || el.tagName}" ${Math.round(r.width)}x${Math.round(r.height)}px`);
      }
    }
  }

  /* ── contrast ───────────────────────────────────────────────────────────
     Measured on rendered pairs, not on tokens, so it catches ink that only
     fails against one particular surface. */
  /* Chrome serialises color-mix() as `color(srgb 0.97 0.97 0.96 / 0.84)` —
     0-1 channels, not 0-255. Reading those as bytes made white-on-white
     measure 1.06:1 and produced a hundred phantom failures. Returns
     [r, g, b, a] in 0-255 with alpha kept for compositing. */
  const parse = (c) => {
    if (!c) return null;
    const srgb = c.match(/color\(\s*srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.%]+))?/i);
    if (srgb) {
      const a = srgb[4] == null ? 1
        : (srgb[4].endsWith('%') ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]));
      return [+srgb[1] * 255, +srgb[2] * 255, +srgb[3] * 255, a];
    }
    const n = (c.match(/[\d.eE+-]+/g) || []).map(Number);
    if (n.length < 3) return null;
    return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
  };

  /* Lay a partly transparent colour over what is behind it. Without this an
     0.84-alpha ink is measured as if it were opaque. */
  const over = (fg, bg) => {
    const a = fg[3] == null ? 1 : fg[3];
    return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    /* Collect layers outward to the first opaque one, then composite them
       back to front. Taking the innermost translucent layer as if it were
       opaque made a 12%-blue row read as solid blue, so white text on it
       measured 3.64:1 when it is really ~15:1. */
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const p = parse(getComputedStyle(n).backgroundColor);
      if (!p || p[3] === 0) continue;
      layers.push(p);
      if (p[3] >= 1) break;
    }
    if (!layers.length) return [255, 255, 255];
    let base = layers[layers.length - 1].slice(0, 3);
    for (let i = layers.length - 2; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const seenPairs = new Set();
  for (const el of document.querySelectorAll('p, span, td, th, .sub, .note, .lbl, .value, li, button')) {
    if (!visible(el) || !text(el)) continue;
    if (el.querySelector('*')) continue;              // leaf nodes only
    const s = getComputedStyle(el);
    const rawFg = parse(s.color);
    const bg = bgOf(el);
    if (!rawFg || !bg) continue;
    const fg = over(rawFg, bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(s.fontSize);
    const large = px >= 24 || (px >= 18.66 && +s.fontWeight >= 700);
    const floor = large ? opts.minContrastLarge : opts.minContrast;
    if (ratio < floor) {
      const key = `${s.color}|${px}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      add('low contrast',
          `${ratio.toFixed(2)}:1 (needs ${floor}) ${Math.round(px)}px "${text(el).slice(0, 26)}"`);
    }
  }

  /* ── headings ───────────────────────────────────────────────────────────
     A section rule and the panel under it both saying LEAGUES. */
  const heads = [...document.querySelectorAll('h2, h3')].filter(visible).map(text);
  const counts = {};
  for (const h of heads) counts[h] = (counts[h] || 0) + 1;
  for (const [h, n] of Object.entries(counts)) {
    if (n > 1 && h.length > 2) add('duplicate heading', `"${h}" appears ${n} times`);
  }

  /* ── labels that contradict the numbers beside them ─────────────────────
     Every rule above this one checks how the page *renders*. None of them can
     tell whether what it renders is true, which is how a table shipped with
     two adjacent rows tagged "down week" — one of them committed to 42.7 km,
     the largest figure in its column — while the audit reported no findings.
     The tag was read from the wrong source; nothing on screen was misaligned,
     so nothing here objected.

     This checks the one thing a reader checks instantly: a row that calls
     itself a step down should not carry a bigger number than the row above it.
     Cheap, specific, and it fails loudly on exactly the class of bug that
     slipped through. */
  const DOWN = /\b(down week|deload|step down|lower)\b/i;
  for (const table of document.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tbody tr')].filter(visible);
    let prev = null;
    let prevLabel = '';
    for (const tr of rows) {
      /* The first numeric cell in the row is the figure the row is about. */
      const cell = [...tr.querySelectorAll('td, th')]
        .map((c) => text(c))
        .find((v) => /^[−–-]?[\d.,]+$/.test(v.replace(/\s/g, '')));
      const value = cell == null ? null
        : Number(cell.replace(/[−–]/g, '-').replace(/[, ]/g, ''));
      const rowText = text(tr);
      /* Leaf elements, not the row's concatenated text. `textContent` runs
         adjacent elements together — the state cell reads "still aheaddown
         week" — so a `\b`-anchored match against the whole row silently never
         fires. That is the second time this concatenation has quietly disabled
         a check in this file; test the element that carries the label. */
      const isDown = [...tr.querySelectorAll('td *, th *')]
        .some((e) => !e.children.length && DOWN.test(text(e)));
      if (value != null && Number.isFinite(value)) {
        if (isDown && prev != null && value > prev) {
          add('label contradicts the number',
            `"${rowText.slice(0, 46)}" is marked a down week at ${value}, `
            + `above the ${prev} in "${prevLabel.slice(0, 28)}" before it`);
        }
        prev = value;
        prevLabel = rowText;
      }
    }
  }

  /* ── words run together across element boundaries ───────────────────────
     Two adjacent inline elements with no whitespace text node between them
     concatenate: "still ahead" + "down week" reads as "still aheaddown week"
     to everything that reads text rather than pixels — copy and paste, a
     screen reader, a table export, and any check in this file that matches on
     word boundaries. A CSS margin makes it look separated without making it
     separated, which is why it survived three passes and several screenshots.

     This has silently disabled two other rules here (`\blifetime\b` against
     "LifetimeLevel", `\bdown week\b` against "still aheaddown week"), so it is
     worth catching directly rather than as a symptom. */
  const WORD_END = /[\p{L}\p{N}]$/u;
  const WORD_START = /^[\p{L}\p{N}]/u;
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    /* Empty elements are skipped rather than treated as separators. A styled
       spacer — `<span class="dot">` with a background and no text — separates
       two labels on screen while joining them in `textContent`, which is
       exactly the case this rule exists for and exactly the case it missed. */
    const kids = [...el.childNodes].filter(
      (n) => n.nodeType !== 1 || (n.textContent || '').length > 0,
    );
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i];
      const bNode = kids[i + 1];
      if (a.nodeType !== 1 || bNode.nodeType !== 1) continue;
      /* SVG is exempt: its text is positioned by x/y attributes, so two
         `<text>` nodes never form a text run no matter what the DOM order
         says. Every chart also ships a table view, which is where its content
         is read as text. */
      if (a.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      const ca = getComputedStyle(a);
      const cb = getComputedStyle(bNode);
      /* Only inline boxes butt up against each other in a text run. */
      if (!ca.display.startsWith('inline') || !cb.display.startsWith('inline')) continue;
      /* Raw `textContent`, never the trimmed helper. `text()` strips the
         whitespace this check exists to find: `<b>Soccer</b><span> is 66%…`
         has a real leading space, and trimming it first reported seven hundred
         perfectly good sentences as run together. Test what the browser will
         actually lay out. */
      const ra = a.textContent || '';
      const rb = bNode.textContent || '';
      if (!ra || !rb) continue;
      if (WORD_END.test(ra) && WORD_START.test(rb)) {
        const ta = text(a);
        const tb = text(bNode);
        add('words run together',
          `"${ta.slice(-18)}" + "${tb.slice(0, 18)}" reads as `
          + `"${(ta.slice(-10) + tb.slice(0, 10))}" — no space between the elements`);
      }
    }
  }

  /* ── a colour class that does not paint ───────────────────────────────
     A week cell carried `tone-strong` and rendered grey for a release: a
     later rule on the cell set `--tone` itself and won the cascade, so the
     class, the data and the DOM all said green and the screen did not. The
     user read it as "no colour, can't tell good from bad". Every element
     with a tone class must resolve `--tone` to that tone's own value. */
  {
    const root = getComputedStyle(document.documentElement);
    const want = {};
    for (const t of ['strong', 'solid', 'mixed', 'thin', 'poor']) {
      want[t] = root.getPropertyValue(`--tone-${t}`).trim().toLowerCase();
    }
    let n = 0;
    for (const el of document.querySelectorAll('[class*="tone-"]')) {
      if (!visible(el)) continue;
      const m = /(?:^|\s)tone-(strong|solid|mixed|thin|poor)(?:\s|$)/.exec(el.className.toString());
      if (!m || !want[m[1]]) continue;
      const got = getComputedStyle(el).getPropertyValue('--tone').trim().toLowerCase();
      if (got && got !== want[m[1]] && !got.startsWith('var(')) {
        add('tone class not painting',
          `<${el.tagName.toLowerCase()} class="${el.className.toString().slice(0, 40)}"> is tone-${m[1]} `
          + `but --tone resolves to ${got} (expected ${want[m[1]]})`);
        if (++n >= 3) break;
      }
    }
  }

  return out;
}
