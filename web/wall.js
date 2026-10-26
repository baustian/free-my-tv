/*
 * The news wall (this fork): up to 9 live news channels from YouTube, on a grid of 4 × 3.
 *
 * The TV decodes one video at a time (a 2020 Samsung, tested: of 9 players, one played), so the chosen channel plays
 * live with its sound in the big window (2 × 2 cells, top left) and the others show their live's latest frame. OK on
 * a small one swaps it with the big one; OK on the big one fills the screen.
 *
 * The frames come from the live's storyboard (the small pictures YouTube's player shows when seeking): a new sheet of
 * 3 × 3 frames about every 30 s, numbered; the newest is the highest number that exists, and its last frame is the
 * latest. Small (159 × 90), but real: the _live.jpg thumbnail is often the channel's cover, not the broadcast.
 * Sharp ones come from CONFIG.wallFrames (tools/wall_frames.py, on the computer), every 15 s, while it answers.
 *
 * YouTube plays an embed only on a page with a web address (from the app's file:// it answers error 153), so the
 * video plays in CONFIG.wallPlayer, a page on GitHub Pages (github.com/baustian/oraculo-player), driven with
 * postMessage. Each channel's live is looked up from its @handle every time (a channel's live gets a new id when it
 * restarts). A channel that doesn't allow embedding opens in YouTube.
 *
 * Channels: wall_channels in config.properties, "Name:@handle" separated by commas. ES5: the TV runs Chromium 69.
 */
(function () {
  'use strict';

  // Cells of 16:9 under a header: the big window is 2 × 2 of them.
  var CW = 452, CH = 254, GAP = 16, X0 = 32, Y0 = 150;
  var SLOTS = [[0, 0, 2], [2, 0, 1], [3, 0, 1], [2, 1, 1], [3, 1, 1], [0, 2, 1], [1, 2, 1], [2, 2, 1], [3, 2, 1]];
  var LOOKUP_EVERY = 10 * 60 * 1000, FRAME_EVERY = 15 * 1000, SHARP_FOR = 60 * 1000;
  var PLAYER = CONFIG.wallPlayer || 'https://baustian.github.io/oraculo-player/';
  // tools/wall_frames.py (on the computer, or a server): sharp frames; the storyboard's when it doesn't answer.
  var SHARP = (CONFIG.wallFrames || '').replace(/\/+$/, '');

  var channels = parseChannels(CONFIG.wallChannels || []);
  var order = [];   // order[slot] = index in channels; slot 0 is the big window
  var root = null, frame = null, head = null, tiles = [];
  var opened = false, focus = 0, full = false, timers = [];
  var hooks = {toast: function () {}, youtube: function () {}};

  function parseChannels(list) {
    var out = [];
    for (var i = 0; i < list.length && out.length < SLOTS.length; i++) {
      var m = /^\s*(.*?)\s*:\s*(@[\w.\-]+)\s*$/.exec(list[i]) || /^\s*()(@[\w.\-]+)\s*$/.exec(list[i]);
      if (!m) continue;
      out.push({name: m[1] || m[2].slice(1), handle: m[2], id: '', live: false, embed: true, title: '', at: 0,
                busy: false, sb: null, sheet: 0, probing: false, sharp: '', sharpAt: 0, sharpBusy: false});
    }
    return out;
  }

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function setClass(e, c, on) {
    var has = (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0;
    if (on && !has) e.className = (e.className + ' ' + c).replace(/^\s+/, '');
    if (!on && has) e.className = (' ' + e.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem('wall.' + key);
      localStorage.setItem('wall.' + key, value);
    } catch (e) {}
    return null;
  }

  function slotOf(c) { return order.indexOf(c); }
  function playing() { return order[0]; }

  // MARK: - Looking up each channel's live

  function decode(s) {
    return s.replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  /** The channel's live now, from youtube.com/@handle/live (the app's requests aren't bound by CORS on the TV). */
  function lookup(ch, done) {
    if (ch.busy) return;
    ch.busy = true;
    var x = new XMLHttpRequest();
    x.open('GET', 'https://www.youtube.com/' + ch.handle + '/live');
    x.timeout = 20000;
    x.onload = x.onerror = x.ontimeout = function () {
      ch.busy = false;
      ch.at = Date.now();
      var t = x.status === 200 ? x.responseText : '';
      var id = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(t);
      var before = ch.id;
      ch.live = !!id && t.indexOf('"isLive":true') >= 0;
      ch.id = id ? id[1] : '';
      ch.embed = t.indexOf('"playableInEmbed":false') < 0;
      var title = /<meta name="title" content="([^"]*)"/.exec(t);
      ch.title = title ? decode(title[1]) : '';
      // "https://i.ytimg.com/sb/<id>/storyboard_live_90_3x3_b4/M$M.jpg?rs=…#159#90#3#3"
      var sb = /"spec":"(https:\/\/i\.ytimg\.com\/sb\/[^"]*storyboard_live[^"]*)"/.exec(t);
      if (sb) {
        var parts = decode(sb[1]).split('#');
        ch.sb = {url: parts[0], cols: +parts[3] || 3, rows: +parts[4] || 3};
      } else ch.sb = null;
      if (ch.id !== before) { ch.sheet = 0; ch.sharp = ''; }
      if (done) done(ch);
      paint(channels.indexOf(ch));
      refresh(ch);
    };
    x.send();
  }

  function lookupAll() {
    for (var i = 0; i < channels.length; i++) lookup(channels[i], channels[i] === channels[playing()] ? replay : null);
  }

  /** After a new lookup of the playing channel: a new id (the live restarted) plays the new one. */
  function replay(ch) {
    if (ch === channels[playing()] && ch.live && ch.embed && ch.id !== frame.playingId) start();
  }

  // MARK: - The latest frame of each live

  function exists(ch, n, done) {
    var x = new XMLHttpRequest();
    x.open('HEAD', ch.sb.url.replace('$M', n));
    x.timeout = 10000;
    x.onload = function () { done(x.status === 200); };
    x.onerror = x.ontimeout = function () { done(false); };
    x.send();
  }

  /** The newest sheet: from the last one known, step forward; the first time, double then halve. */
  function newestSheet(ch, done) {
    if (ch.sheet) {
      var step = function (n) {
        exists(ch, n + 1, function (yes) { if (yes && n + 1 < ch.sheet + 20) step(n + 1); else done(n); });
      };
      step(ch.sheet);
      return;
    }
    var lo = 0, hi = 1;
    var grow = function () {
      exists(ch, hi, function (yes) {
        if (yes && hi < 1e8) { lo = hi; hi *= 2; grow(); } else halve();
      });
    };
    var halve = function () {
      if (hi - lo <= 1) { done(lo); return; }
      var mid = Math.floor((lo + hi) / 2);
      exists(ch, mid, function (yes) { if (yes) lo = mid; else hi = mid; halve(); });
    };
    grow();
  }

  function frameOf(ch) {
    if (!ch.sb || !ch.live || ch.probing) return;
    ch.probing = true;
    var id = ch.id;
    newestSheet(ch, function (n) {
      ch.probing = false;
      if (ch.id !== id) return;
      ch.sheet = n;
      paint(channels.indexOf(ch));
    });
  }

  /** A new frame: the sharp one when wall_frames answers, else the storyboard's. Not for the one playing. */
  function refresh(ch) {
    if (!ch.live || !ch.id || (ch === channels[playing()] && frame && frame.playingId === ch.id)) return;
    if (!SHARP) { frameOf(ch); return; }
    if (ch.sharpBusy) return;
    ch.sharpBusy = true;
    var id = ch.id, url = SHARP + '/frame/' + id + '.jpg?t=' + Date.now(), img = new Image();
    img.onload = function () {
      ch.sharpBusy = false;
      if (ch.id !== id) return;
      ch.sharp = url;
      ch.sharpAt = Date.now();
      paint(channels.indexOf(ch));
    };
    img.onerror = function () {
      // Off, or the first frame isn't ready yet (it is a few seconds after the first ask).
      ch.sharpBusy = false;
      frameOf(ch);
    };
    img.src = url;
  }

  function framesAll() {
    for (var i = 0; i < channels.length; i++) refresh(channels[i]);
  }

  // MARK: - Tiles

  function rect(slot) {
    var s = SLOTS[slot], n = s[2];
    return {x: X0 + s[0] * (CW + GAP), y: Y0 + s[1] * (CH + GAP), w: n * CW + (n - 1) * GAP, h: n * CH + (n - 1) * GAP};
  }

  function build() {
    root.innerHTML = '';
    tiles = [];
    head = el('div', 'head', root);
    el('div', 'tag', head, 'EN VIVO');
    el('div', 'now', head);
    el('div', 'clock', head);
    for (var i = 0; i < channels.length; i++) {
      var t = el('div', 'wt', root);
      el('div', 'pic', t);
      el('div', 'pic', t);
      el('div', 'badge', t);
      var bar = el('div', 'bar', t);
      el('span', 'name', bar, channels[i].name);
      el('span', 'what', bar);
      (function (c) {
        t.onmouseover = function () { if (!full) { focus = slotOf(c); showFocus(); } };
        t.onclick = function () { focus = slotOf(c); ok(); };
      })(i);
      tiles.push(t);
    }
    frame = el('iframe', '', root);
    frame.setAttribute('allow', 'autoplay; encrypted-media');
    frame.setAttribute('tabindex', '-1');
    frame.style.display = 'none';
    frame.playingId = '';
    frame.ready = false;
    frame.onload = function () { frame.ready = true; if (frame.pending) send(frame.pending); frame.pending = null; };
    frame.src = PLAYER;
    el('div', 'hint', root, 'OK: ver este canal · OK en el grande: pantalla completa · Atrás: volver');
  }

  function layout() {
    for (var s = 0; s < order.length; s++) {
      var t = tiles[order[s]], r = rect(s);
      t.style.left = r.x + 'px';
      t.style.top = r.y + 'px';
      t.style.width = r.w + 'px';
      t.style.height = r.h + 'px';
      setClass(t, 'big', s === 0);
    }
    place();
    showFocus();
    paintAll();
  }

  /** A tile's picture, badge and line: the live's latest frame, faded in when it has loaded. */
  function paint(c) {
    var t = tiles[c], ch = channels[c];
    if (!t || !ch) return;
    var badge = t.children[2], what = t.children[3].lastChild, big = slotOf(c) === 0;
    if (big && ch.live && ch.embed) { badge.className = 'badge sound'; badge.textContent = '🔊 EN VIVO'; }
    else if (ch.live && !ch.embed) { badge.className = 'badge yt'; badge.textContent = 'EN VIVO · se abre en YouTube'; }
    else if (ch.live) { badge.className = 'badge live'; badge.textContent = 'EN VIVO'; }
    else { badge.className = 'badge'; badge.textContent = ch.at ? 'Sin transmisión' : 'Buscando…'; }
    what.textContent = ch.live ? shorten(ch.title, ch.name) : '';
    if (big) paintHead();
    if (!ch.live) return;
    var url, size, pos;
    if (ch.sharp && Date.now() - ch.sharpAt < SHARP_FOR) {
      url = ch.sharp;
      size = 'cover';
      pos = 'center';
    } else if (ch.sb && ch.sheet) {
      // The sheet's last frame: the bottom right of cols × rows.
      url = ch.sb.url.replace('$M', ch.sheet);
      size = (ch.sb.cols * 100) + '% ' + (ch.sb.rows * 100) + '%';
      pos = '100% 100%';
    } else {
      url = 'https://i.ytimg.com/vi/' + ch.id + '/hq720_live.jpg?m=' + Math.floor(Date.now() / LOOKUP_EVERY);
      size = 'cover';
      pos = 'center';
    }
    var a = t.children[0], b = t.children[1];
    var front = a.className === 'pic on' ? a : b, back = front === a ? b : a;
    if (front.picUrl === url) return;
    var img = new Image();
    img.onload = function () {
      back.style.backgroundImage = 'url(' + url + ')';
      back.style.backgroundSize = size;
      back.style.backgroundPosition = pos;
      back.picUrl = url;
      back.className = 'pic on';
      front.className = 'pic';
    };
    img.src = url;
  }

  /** "TN EN VIVO - SEGUÍ LA TRANSMISIÓN…" → "SEGUÍ LA TRANSMISIÓN…": without emoji, "en vivo" and the channel's name. */
  function shorten(title, name) {
    var t = title.replace(/[☀-➿]|\uD83C[\uDDE6-\uDDFF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDEFF]/g, '')
      .replace(/\bEN VIVO\b/i, '').replace(/^[\s|·\-:]+|[\s|·\-:]+$/g, '');
    if (name && t.toLowerCase().indexOf(name.toLowerCase()) === 0) t = t.slice(name.length).replace(/^[\s|·\-:]+/, '');
    return t;
  }

  function paintHead() {
    if (!head) return;
    var ch = channels[playing()];
    head.children[1].textContent = ch ? ch.name + (ch.live ? '  ·  ' + shorten(ch.title, ch.name) : '') : '';
    var d = new Date();
    head.children[2].textContent = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  function paintAll() {
    for (var i = 0; i < channels.length; i++) paint(i);
  }

  function showFocus() {
    for (var s = 0; s < order.length; s++) setClass(tiles[order[s]], 'focus', s === focus && !full);
  }

  // MARK: - The player

  function send(msg) {
    if (!frame.ready) { frame.pending = msg; return; }
    frame.contentWindow.postMessage(JSON.stringify(msg), '*');
  }

  /** The video over the big window, or over the whole screen. */
  function place() {
    var ch = channels[playing()], on = !!frame.playingId && ch && ch.id === frame.playingId;
    frame.style.display = on ? '' : 'none';
    setClass(frame, 'full', full);
    var r = full ? {x: 0, y: 0, w: 1920, h: 1080} : rect(0);
    frame.style.left = r.x + 'px';
    frame.style.top = r.y + 'px';
    frame.style.width = r.w + 'px';
    frame.style.height = r.h + 'px';
  }

  /** Plays the big window's channel, with sound. */
  function start() {
    var ch = channels[playing()];
    if (!ch || !ch.live || !ch.embed) { stopVideo(); return; }
    store('order', order.map(function (c) { return channels[c].handle; }).join(','));
    frame.playingId = ch.id;
    send({wall: 'play', id: ch.id, sound: true});
    place();
    paint(playing());
  }

  function stopVideo() {
    if (!frame || !frame.playingId) return;
    frame.playingId = '';
    full = false;
    send({wall: 'stop'});
    place();
  }

  /** Channel at slot s to the big window; the one there goes to slot s. */
  function swap(s) {
    var c = order[s];
    order[s] = order[0];
    order[0] = c;
    focus = 0;
    layout();
    start();
    refresh(channels[order[s]]);   // the one that left the big window: a frame of now
  }

  /** OK: a small tile comes to the big window and plays; the big one goes full screen. */
  function ok() {
    var ch = channels[order[focus]];
    if (!ch) return;
    if (focus === 0) {
      if (ch.live && ch.embed) { full = !full; place(); showFocus(); return; }
    } else if (!ch.at) { hooks.toast('Buscando el vivo de ' + ch.name + '…'); return; }
    if (!ch.live) { hooks.toast(ch.name + ' no está transmitiendo en vivo ahora.'); lookup(ch); return; }
    if (!ch.embed) {
      stopVideo();
      hooks.toast(ch.name + ' no deja verlo fuera de YouTube: se abre en YouTube.');
      hooks.youtube(ch.id);
      return;
    }
    swap(focus);
  }

  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow) return;
    var m;
    try { m = JSON.parse(e.data); } catch (x) { return; }
    var ch = channels[playing()];
    if (!m || m.wall !== 'state' || !ch || m.id !== ch.id) return;
    // Ended (the channel restarted its live with a new id) or not found: look it up again.
    if (m.state === 0 || m.error === 2 || m.error === 100) lookup(ch, replay);
    else if (m.error === 101 || m.error === 150 || m.error === 153) {
      ch.embed = false;
      stopVideo();
      paint(playing());
      hooks.toast(ch.name + ' no deja verlo acá: OK lo abre en YouTube.');
    }
  });

  // MARK: - Opening, closing, keys

  /** The last order (the big window's channel first), as handles; channels added since go at the end. */
  function savedOrder() {
    var saved = (store('order') || '').split(','), out = [], i;
    for (i = 0; i < saved.length; i++) {
      for (var c = 0; c < channels.length; c++) if (channels[c].handle === saved[i] && out.indexOf(c) < 0) out.push(c);
    }
    for (i = 0; i < channels.length; i++) if (out.indexOf(i) < 0) out.push(i);
    return out;
  }

  function open() {
    if (!channels.length) { hooks.toast('No hay canales: wall_channels en config.properties.'); return; }
    if (!root.firstChild) build();
    opened = true;
    full = false;
    focus = 0;
    order = savedOrder();
    setClass(root, 'open', true);
    layout();
    // Fresh lookups every time: the ids from before may be a live that has ended.
    for (var c = 0; c < channels.length; c++) {
      lookup(channels[c], c === order[0] ? function (ch) {
        if (opened && ch === channels[playing()]) start();
      } : null);
    }
    timers.push(setInterval(lookupAll, LOOKUP_EVERY));
    timers.push(setInterval(framesAll, FRAME_EVERY));
    timers.push(setInterval(paintHead, 15000));
  }

  function close() {
    stopVideo();
    opened = false;
    if (root) setClass(root, 'open', false);
    while (timers.length) clearInterval(timers.pop());
  }

  /** The nearest slot in direction (dx, dy) from the focused one, by the tiles' centers. */
  function neighbor(dx, dy) {
    var a = rect(focus), ax = a.x + a.w / 2, ay = a.y + a.h / 2, best = -1, bestD = 1e9;
    for (var s = 0; s < order.length; s++) {
      if (s === focus) continue;
      var b = rect(s), bx = b.x + b.w / 2, by = b.y + b.h / 2;
      var along = dx ? (bx - ax) * dx : (by - ay) * dy, across = dx ? Math.abs(by - ay) : Math.abs(bx - ax);
      if (along <= 0) continue;
      var d = along + 2 * across;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** The remote while the wall is open; true when the key was used. */
  function key(k) {
    var K = TV.keys;
    if (k === K.back || k === 27 || k === 8) {
      if (full) { full = false; place(); showFocus(); } else close();
      return true;
    }
    if (full) {
      // Full screen: ← → the channel before or after (it comes to the big window), ↑ ↓ or OK back to the wall.
      if (k === K.left || k === K.right) {
        // By the list's order (wall_channels), not the slots', which change with every swap.
        var d = k === K.left ? -1 : 1, n = channels.length;
        for (var i = 1; i < n; i++) {
          var c = (playing() + d * i + n * i) % n, ch = channels[c];
          if (ch.live && ch.embed) { swap(slotOf(c)); full = true; place(); showFocus(); break; }
        }
      } else if (k === K.up || k === K.down || k === K.ok) { full = false; place(); showFocus(); }
      return true;
    }
    var dx = k === K.left ? -1 : k === K.right ? 1 : 0, dy = k === K.up ? -1 : k === K.down ? 1 : 0;
    if (dx || dy) {
      var to = neighbor(dx, dy);
      if (to >= 0) { focus = to; showFocus(); }
      return true;
    }
    if (k === K.ok) { ok(); return true; }
    return false;
  }

  window.Wall = {
    init: function (node, h) {
      root = node;
      for (var name in h) if (h.hasOwnProperty(name)) hooks[name] = h[name];
    },
    available: function () { return channels.length > 0; },
    isOpen: function () { return opened; },
    open: open,
    close: close,
    key: key,
    /** For checking it on the TV (Web Inspector). */
    debug: function () { return {focus: focus, order: order, full: full, playingId: frame && frame.playingId, channels: channels}; }
  };
})();
