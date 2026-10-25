/*
 * The news wall (this fork): 3 × 3 live news channels from YouTube.
 *
 * The TV decodes one video at a time (a 2020 Samsung, tested: of 9 players, one played), so the chosen channel plays
 * live with its sound in its tile and the others show their live's latest picture (YouTube makes a new one about
 * every 5 minutes). OK on another tile moves the video and the sound there; OK on the playing one fills the screen.
 *
 * YouTube plays an embed only on a page with a web address (from the app's file:// it answers error 153), so the
 * video plays in CONFIG.wallPlayer, a page on GitHub Pages (github.com/baustian/oraculo-player), driven with
 * postMessage. Each channel's live is looked up from its @handle every time (a channel's live gets a new id when it
 * restarts), and the player keeps to the live point. A channel that doesn't allow embedding opens in YouTube.
 *
 * Channels: wall_channels in config.properties, "Name:@handle" separated by commas. ES5: the TV runs Chromium 69.
 */
(function () {
  'use strict';

  var W = 576, H = 324, GAP = 16, X0 = 80, Y0 = 24;
  var LOOKUP_EVERY = 10 * 60 * 1000, PICTURE_EVERY = 60 * 1000;
  var PLAYER = CONFIG.wallPlayer || 'https://baustian.github.io/oraculo-player/';

  var channels = parseChannels(CONFIG.wallChannels || []);
  var root = null, frame = null, hint = null, tiles = [];
  var opened = false, focus = 0, playing = -1, full = false, timers = [];
  var hooks = {toast: function () {}, youtube: function () {}};

  function parseChannels(list) {
    var out = [];
    for (var i = 0; i < list.length && out.length < 9; i++) {
      var m = /^\s*(.*?)\s*:\s*(@[\w.\-]+)\s*$/.exec(list[i]) || /^\s*()(@[\w.\-]+)\s*$/.exec(list[i]);
      if (!m) continue;
      out.push({name: m[1] || m[2].slice(1), handle: m[2], id: '', live: false, embed: true, title: '', at: 0, busy: false});
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
      ch.live = !!id && t.indexOf('"isLive":true') >= 0;
      ch.id = id ? id[1] : '';
      ch.embed = t.indexOf('"playableInEmbed":false') < 0;
      var title = /<meta name="title" content="([^"]*)"/.exec(t);
      ch.title = title ? decode(title[1]) : '';
      if (done) done(ch);
      paint(channels.indexOf(ch));
    };
    x.send();
  }

  function lookupAll() {
    for (var i = 0; i < channels.length; i++) lookup(channels[i], i === playing ? replay : null);
  }

  /** After a new lookup of the playing channel: a new id (the live restarted) plays the new one. */
  function replay(ch) {
    var i = channels.indexOf(ch);
    if (i === playing && ch.live && ch.embed && ch.id !== frame.playingId) start(i);
  }

  // MARK: - Tiles

  function build() {
    root.innerHTML = '';
    tiles = [];
    for (var i = 0; i < channels.length; i++) {
      var t = el('div', 'wt', root);
      t.style.left = (X0 + (i % 3) * (W + GAP)) + 'px';
      t.style.top = (Y0 + Math.floor(i / 3) * (H + GAP)) + 'px';
      el('img', '', t);
      el('img', '', t);
      el('div', 'badge', t);
      var bar = el('div', 'bar', t);
      el('span', 'name', bar, channels[i].name);
      el('span', 'what', bar);
      (function (i) {
        t.onmouseover = function () { if (!full) { focus = i; showFocus(); } };
        t.onclick = function () { focus = i; ok(); };
      })(i);
      tiles.push(t);
      paint(i);
    }
    frame = el('iframe', '', root);
    frame.setAttribute('allow', 'autoplay; encrypted-media');
    frame.setAttribute('tabindex', '-1');
    frame.style.display = 'none';
    frame.playingId = '';
    frame.ready = false;
    frame.onload = function () { frame.ready = true; if (frame.pending) send(frame.pending); frame.pending = null; };
    frame.src = PLAYER;
    hint = el('div', 'hint', root, 'OK: ver con sonido · OK otra vez: pantalla completa · Atrás: volver');
    showFocus();
  }

  /** A tile's picture, badge and line: its live's latest picture, faded in when it has loaded. */
  function paint(i) {
    var t = tiles[i], ch = channels[i];
    if (!t || !ch) return;
    var badge = t.children[2], what = t.children[3].lastChild;
    if (i === playing) { badge.className = 'badge sound'; badge.textContent = '🔊 EN VIVO'; }
    else if (ch.live && !ch.embed) { badge.className = 'badge yt'; badge.textContent = 'EN VIVO · se abre en YouTube'; }
    else if (ch.live) { badge.className = 'badge live'; badge.textContent = 'EN VIVO'; }
    else { badge.className = 'badge'; badge.textContent = ch.at ? 'Sin transmisión' : 'Buscando…'; }
    what.textContent = ch.live ? shorten(ch.title) : '';
    if (!ch.live) return;
    var front = t.children[0].className === 'on' ? t.children[0] : t.children[1];
    var back = front === t.children[0] ? t.children[1] : t.children[0];
    var url = 'https://i.ytimg.com/vi/' + ch.id + '/hq720_live.jpg?m=' + Math.floor(Date.now() / PICTURE_EVERY);
    if (front.getAttribute('src') === url) return;
    back.onload = function () { back.className = 'on'; front.className = ''; };
    back.src = url;
  }

  /** "TN EN VIVO - SEGUÍ LA TRANSMISIÓN…": without the channel's own name and the "en vivo". */
  function shorten(title) {
    return title.replace(/[☀-➿]|\uD83C[\uDDE6-\uDDFF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDEFF]/g, '')
      .replace(/\bEN VIVO\b/i, '').replace(/^[\s|·\-:]+|[\s|·\-:]+$/g, '');
  }

  function paintAll() {
    for (var i = 0; i < channels.length; i++) paint(i);
  }

  function showFocus() {
    for (var i = 0; i < tiles.length; i++) setClass(tiles[i], 'focus', i === focus && !full);
  }

  // MARK: - The player

  function send(msg) {
    if (!frame.ready) { frame.pending = msg; return; }
    frame.contentWindow.postMessage(JSON.stringify(msg), '*');
  }

  function place() {
    if (playing < 0) { frame.style.display = 'none'; return; }
    var t = tiles[playing];
    frame.style.display = '';
    setClass(frame, 'full', full);
    frame.style.left = full ? '0' : t.style.left;
    frame.style.top = full ? '0' : t.style.top;
    frame.style.width = (full ? 1920 : W) + 'px';
    frame.style.height = (full ? 1080 : H) + 'px';
    hint.style.display = full ? 'none' : '';
    for (var i = 0; i < tiles.length; i++) setClass(tiles[i], 'playing', i === playing);
  }

  /** Plays channel i in its tile, with sound; the one before goes back to its picture. */
  function start(i) {
    var ch = channels[i], before = playing;
    playing = i;
    store('last', ch.handle);
    frame.playingId = ch.id;
    send({wall: 'play', id: ch.id, sound: true});
    place();
    if (before >= 0) paint(before);
    paint(i);
  }

  function stop() {
    if (playing < 0) return;
    var before = playing;
    playing = -1;
    full = false;
    frame.playingId = '';
    send({wall: 'stop'});
    place();
    paint(before);
  }

  /** OK on a tile: there the video and the sound, or full screen when it already plays there. */
  function ok() {
    var ch = channels[focus];
    if (!ch) return;
    if (focus === playing) { full = !full; place(); showFocus(); return; }
    if (!ch.at) { hooks.toast('Buscando el vivo de ' + ch.name + '…'); return; }
    if (!ch.live) { hooks.toast(ch.name + ' no está transmitiendo en vivo ahora.'); lookup(ch); return; }
    if (!ch.embed) {
      stop();
      hooks.toast(ch.name + ' no deja verlo fuera de YouTube: se abre en YouTube.');
      hooks.youtube(ch.id);
      return;
    }
    start(focus);
  }

  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow) return;
    var m;
    try { m = JSON.parse(e.data); } catch (x) { return; }
    if (!m || m.wall !== 'state' || playing < 0) return;
    var ch = channels[playing];
    if (m.id !== ch.id) return;
    // Ended (the channel restarted its live with a new id) or an error: look it up again.
    if (m.state === 0 || m.error === 2 || m.error === 100) lookup(ch, replay);
    else if (m.error === 101 || m.error === 150 || m.error === 153) {
      ch.embed = false;
      stop();
      paint(channels.indexOf(ch));
      hooks.toast(ch.name + ' no deja verlo acá: OK lo abre en YouTube.');
    }
  });

  // MARK: - Opening, closing, keys

  function open() {
    if (!channels.length) { hooks.toast('No hay canales: wall_channels en config.properties.'); return; }
    if (!root.firstChild) build();
    opened = true;
    full = false;
    setClass(root, 'open', true);
    var last = store('last'), first = 0;
    for (var i = 0; i < channels.length; i++) if (channels[i].handle === last) first = i;
    focus = first;
    showFocus();
    // Fresh lookups every time: the ids from before may be a live that has ended.
    for (var k = 0; k < channels.length; k++) {
      lookup(channels[k], k === first ? function (ch) {
        if (opened && playing < 0 && ch.live && ch.embed) start(channels.indexOf(ch));
      } : null);
    }
    timers.push(setInterval(lookupAll, LOOKUP_EVERY));
    timers.push(setInterval(paintAll, PICTURE_EVERY));
  }

  function close() {
    stop();
    opened = false;
    setClass(root, 'open', false);
    while (timers.length) clearInterval(timers.pop());
  }

  /** The remote while the wall is open; true when the key was used. */
  function key(k) {
    if (k === TV.keys.back || k === 27 || k === 8) {
      if (full) { full = false; place(); showFocus(); } else close();
      return true;
    }
    if (full) {
      // Full screen: ← → the channel before or after, ↑ ↓ or OK back to the wall.
      if (k === TV.keys.left || k === TV.keys.right) {
        var d = k === TV.keys.left ? -1 : 1, n = channels.length;
        for (var s = 1; s < n; s++) {
          var j = (playing + d * s + n) % n;
          if (channels[j].live && channels[j].embed) { focus = j; start(j); break; }
        }
      } else if (k === TV.keys.up || k === TV.keys.down || k === TV.keys.ok) { full = false; place(); showFocus(); }
      return true;
    }
    var col = focus % 3, row = Math.floor(focus / 3), rows = Math.ceil(channels.length / 3);
    if (k === TV.keys.left && col > 0) focus--;
    else if (k === TV.keys.right && col < 2 && focus + 1 < channels.length) focus++;
    else if (k === TV.keys.up && row > 0) focus -= 3;
    else if (k === TV.keys.down && row < rows - 1) focus = Math.min(channels.length - 1, focus + 3);
    else if (k === TV.keys.ok) ok();
    else if (k !== TV.keys.left && k !== TV.keys.right && k !== TV.keys.up && k !== TV.keys.down) return false;
    showFocus();
    return true;
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
    debug: function () { return {focus: focus, playing: playing, full: full, channels: channels}; }
  };
})();
