/*
 * The dashboard above the shelf (this fork): everything at a glance, without scrolling.
 *  - top row: the clock with the next public holiday, the weather (today and 5 days), the dollar in Argentina;
 *  - middle: the calendar (day, week or month; private iCal addresses in config.properties, plus the holidays) and
 *    Google News by section, with an "on this day" line;
 *  - a strip of trending movies and shows (TMDB);
 *  - behind it all, Bing's photos of the day, changing every few minutes.
 * The remote moves between what can take the focus by position (spatial navigation); home.js hands the focus over
 * from the shelf and takes it back when ↓ leaves the dashboard.
 * Plain ES5, as the rest of web/. The text is in Spanish (Argentina): this fork is for one home.
 */
var Dash = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function sym(name, parent, size) {
    var s = el('span', 'sym', parent);
    s.style.webkitMaskImage = 'url(symbols/' + name + '.png)';
    s.style.maskImage = 'url(symbols/' + name + '.png)';
    if (size) { s.style.width = size + 'px'; s.style.height = size + 'px'; }
    return s;
  }

  function hasClass(e, c) { return (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0; }
  function setClass(e, c, on) {
    if (!e) return;
    if (on && !hasClass(e, c)) e.className = (e.className + ' ' + c).replace(/^\s+/, '');
    else if (!on && hasClass(e, c)) e.className = (' ' + e.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }

  function place(node, x, y, w, h) {
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    if (w !== undefined) node.style.width = w + 'px';
    if (h !== undefined) node.style.height = h + 'px';
    return node;
  }

  function store(key, value) { try { localStorage.setItem('dash.' + key, JSON.stringify(value)); } catch (e) {} }
  function stored(key) { try { return JSON.parse(localStorage.getItem('dash.' + key)); } catch (e) { return null; } }

  /** GET as text; done(error, text). */
  function getText(url, done) {
    var x = new XMLHttpRequest(), over = false;
    x.open('GET', url, true);
    x.timeout = 20000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || over) return;
      over = true;
      if (x.status !== 200) { done(new Error('HTTP ' + x.status)); return; }
      done(null, x.responseText);
    };
    x.ontimeout = x.onerror = function () { if (!over) { over = true; done(new Error('no connection')); } };
    x.send();
  }

  function getJson(url, done) {
    getText(url, function (err, text) {
      if (err) { done(err); return; }
      var o;
      try { o = JSON.parse(text); } catch (e) { done(e); return; }
      done(null, o);
    });
  }

  // MARK: - Dates in Spanish

  var DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var DAYS_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
    'noviembre', 'diciembre'];
  var DAY = 86400000;

  function two(n) { return (n < 10 ? '0' : '') + n; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.substring(1); }
  function hm(t) { var d = new Date(t); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function midnight(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function addDays(t, n) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); }
  function sameDay(a, b) { return midnight(a) === midnight(b); }
  /** Monday of t's week. */
  function weekStart(t) { var d = new Date(midnight(t)); return addDays(d.getTime(), -((d.getDay() + 6) % 7)); }
  function longDate(t) { var d = new Date(t); return cap(DAYS[d.getDay()]) + ' ' + d.getDate() + ' de ' + MONTHS[d.getMonth()]; }
  function shortDate(t) { var d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()].substring(0, 3); }

  function ago(t) {
    var m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (m < 1) return 'recién';
    if (m < 60) return 'hace ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    return 'hace ' + Math.floor(h / 24) + ' d';
  }

  /** 1565 → "1.565", 1557.4 → "1.557,40" (Argentina's separators). */
  function number(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var fixed = Math.abs(v).toFixed(digits), parts = fixed.split('.'), int = parts[0], out = '';
    while (int.length > 3) { out = '.' + int.slice(-3) + out; int = int.slice(0, -3); }
    return (v < 0 ? '−' : '') + int + out + (parts[1] ? ',' + parts[1] : '');
  }
  function pesos(v) { return '$' + number(v, v >= 1000 || v === Math.round(v) ? 0 : 2); }

  // MARK: - Data: the dollar (dolarapi.com)

  var DOLLARS = [['oficial', 'Oficial'], ['blue', 'Blue'], ['bolsa', 'MEP'], ['contadoconliqui', 'CCL'],
    ['tarjeta', 'Tarjeta'], ['cripto', 'Cripto'], ['mayorista', 'Mayorista']];
  var dollar = stored('dollar') || {at: 0, list: []};

  function refreshDollar() {
    if (Date.now() - dollar.at < 10 * 60000) return;
    getJson('https://dolarapi.com/v1/dolares', function (err, list) {
      if (err || !list || !list.length) return;
      dollar = {at: Date.now(), list: list};
      store('dollar', dollar);
      renderDollar();
    });
  }

  // MARK: - Data: Google News

  var EDITION = (CONFIG.newsEdition || ('AR:es-419')).split(':');
  var NEWS_Q = '?hl=' + (EDITION[1] || 'es-419') + '&gl=' + EDITION[0] + '&ceid=' + EDITION[0] + ':' + (EDITION[1] || 'es-419');
  var SECTIONS = [['Principales', ''], ['Argentina', 'NATION'], ['Economía', 'BUSINESS'], ['Mundo', 'WORLD'],
    ['Deportes', 'SPORTS'], ['Espectáculos', 'ENTERTAINMENT'], ['Tecnología', 'TECHNOLOGY'], ['Salud', 'HEALTH']];
  var news = stored('news') || {};   // section topic → {at, items: [{title, source, link, at}]}
  var section = 0, fetchingNews = {};

  function newsUrl(topic) {
    return 'https://news.google.com/rss' + (topic ? '/headlines/section/topic/' + topic : '') + NEWS_Q;
  }

  function parseRss(text) {
    var doc = new DOMParser().parseFromString(text, 'text/xml'), items = doc.getElementsByTagName('item'), out = [];
    for (var i = 0; i < items.length && out.length < 30; i++) {
      var it = items[i];
      var title = text1(it, 'title'), source = text1(it, 'source');
      if (source && title.length > source.length + 3 && title.slice(-source.length - 3) === ' - ' + source) {
        title = title.slice(0, -source.length - 3);
      }
      if (!title) continue;
      out.push({title: title, source: source, link: text1(it, 'link'), at: Date.parse(text1(it, 'pubDate')) || 0});
    }
    return out;
  }

  function text1(node, tag) {
    var n = node.getElementsByTagName(tag)[0];
    return n ? (n.textContent || '').replace(/^\s+|\s+$/g, '') : '';
  }

  function refreshNews(i) {
    var topic = SECTIONS[i][1], key = topic || 'TOP', have = news[key];
    if (fetchingNews[key] || (have && Date.now() - have.at < 15 * 60000)) return;
    fetchingNews[key] = true;
    getText(newsUrl(topic), function (err, text) {
      fetchingNews[key] = false;
      if (err) return;
      var items;
      try { items = parseRss(text); } catch (e) { return; }
      if (!items.length) return;
      news[key] = {at: Date.now(), items: items};
      store('news', news);
      if (i === section) renderNews();
    });
  }

  function sectionItems() {
    var n = news[SECTIONS[section][1] || 'TOP'];
    return n ? n.items : [];
  }

  // MARK: - Data: holidays (argentinadatos.com) and "on this day" (Wikipedia)

  var holidays = stored('holidays') || {at: 0, list: []};

  function refreshHolidays() {
    var year = new Date().getFullYear();
    if (Date.now() - holidays.at < 24 * 3600000 && holidays.year === year) return;
    getJson('https://api.argentinadatos.com/v1/feriados/' + year, function (err, a) {
      if (err || !a) return;
      getJson('https://api.argentinadatos.com/v1/feriados/' + (year + 1), function (err2, b) {
        var list = a.concat(!err2 && b ? b : []).map(function (h) {
          var p = (h.fecha || '').split('-');
          return {at: new Date(+p[0], p[1] - 1, +p[2]).getTime(), name: h.nombre, kind: h.tipo};
        });
        holidays = {at: Date.now(), year: year, list: list};
        store('holidays', holidays);
        renderClock();
        renderCalendar();
      });
    });
  }

  function nextHoliday() {
    var today = midnight(Date.now());
    for (var i = 0; i < holidays.list.length; i++) if (holidays.list[i].at >= today) return holidays.list[i];
    return null;
  }

  var onThisDay = stored('onthisday') || {day: '', list: []};

  function refreshOnThisDay() {
    var d = new Date(), key = two(d.getMonth() + 1) + '/' + two(d.getDate());
    if (onThisDay.day === key && onThisDay.list.length) return;
    getJson('https://api.wikimedia.org/feed/v1/wikipedia/es/onthisday/selected/' + key, function (err, o) {
      if (err || !o || !o.selected) return;
      var list = o.selected.map(function (s) { return {year: s.year, text: s.text}; });
      // Argentina first: it's this home's history.
      list.sort(function (a, b) { return (/argentin/i.test(b.text) ? 1 : 0) - (/argentin/i.test(a.text) ? 1 : 0); });
      onThisDay = {day: key, list: list.slice(0, 12)};
      store('onthisday', onThisDay);
      renderNewsFooter();
    });
  }

  // MARK: - Data: background photos (Bing's photo of the day)

  var MARKET = (I18N.base || 'es') + '-' + (Place.country || 'AR');
  var photos = stored('photos') || {at: 0, list: []};
  var photoIndex = Math.floor(Math.random() * 8), photoAt = 0, photoFront = 'phA';

  function refreshPhotos() {
    if (Date.now() - photos.at < 6 * 3600000 && photos.list.length) return;
    var base = 'https://www.bing.com/HPImageArchive.aspx?format=js&mkt=' + MARKET;
    getJson(base + '&idx=0&n=8', function (err, a) {
      getJson(base + '&idx=7&n=8', function (err2, b) {
        var all = [].concat(!err && a && a.images ? a.images : [], !err2 && b && b.images ? b.images : []);
        var seen = {}, list = [];
        for (var i = 0; i < all.length; i++) {
          if (!all[i].urlbase || seen[all[i].urlbase]) continue;
          seen[all[i].urlbase] = true;
          list.push({url: 'https://www.bing.com' + all[i].urlbase + '_1920x1080.jpg', title: all[i].copyright || ''});
        }
        if (!list.length) return;
        photos = {at: Date.now(), list: list};
        store('photos', photos);
        if (!photoAt) nextPhoto();
      });
    });
  }

  /** The next photo, faded in once it has loaded (two layers, one fading over the other). */
  function nextPhoto() {
    if (!photos.list.length) return;
    var p = photos.list[photoIndex++ % photos.list.length], img = new Image();
    photoAt = Date.now();
    img.onload = function () {
      var next = photoFront === 'phA' ? 'phB' : 'phA', node = $(next);
      if (!node) return;
      node.style.backgroundImage = 'url(' + p.url + ')';
      setClass(node, 'on', true);
      setClass($(photoFront), 'on', false);
      photoFront = next;
      var c = $('photocap');
      if (c) c.textContent = p.title;
    };
    img.src = p.url;
  }

  // MARK: - Data: calendars (iCal)

  var CAL_URLS = CONFIG.calendarUrls || [];
  var COLORS = ['#64B5F6', '#F48FB1', '#AED581', '#FFB74D', '#BA68C8', '#4DD0E1'];
  var HOLIDAY_COLOR = '#FFD54F';
  var cals = stored('cals') || {};   // url → {at, name, events}
  var fetchingCal = {};

  function refreshCalendars() {
    for (var i = 0; i < CAL_URLS.length; i++) (function (url) {
      var have = cals[url];
      if (fetchingCal[url] || (have && Date.now() - have.at < 15 * 60000)) return;
      fetchingCal[url] = true;
      getText(url, function (err, text) {
        fetchingCal[url] = false;
        if (err) return;
        var parsed;
        try { parsed = Ical.parse(text); } catch (e) { return; }
        cals[url] = {at: Date.now(), name: parsed.name, events: parsed.events};
        try { localStorage.setItem('dash.cals', JSON.stringify(cals)); } catch (e2) { /* too big to keep: fetched again */ }
        renderCalendar();
      });
    })(CAL_URLS[i]);
  }

  /** Every event between from and to (ms), from all the calendars and the holidays, sorted: [{title, start, end, allDay, color}]. */
  function eventsBetween(from, to) {
    var out = [];
    for (var c = 0; c < CAL_URLS.length; c++) {
      var cal = cals[CAL_URLS[c]];
      if (!cal) continue;
      var list = Ical.expand(cal.events, from, to);
      for (var i = 0; i < list.length; i++) { list[i].color = COLORS[c % COLORS.length]; out.push(list[i]); }
    }
    for (var h = 0; h < holidays.list.length; h++) {
      var x = holidays.list[h];
      if (x.at < to && x.at + DAY > from) out.push({title: x.name, start: x.at, end: x.at + DAY, allDay: true, color: HOLIDAY_COLOR, holiday: true});
    }
    out.sort(function (a, b) { return (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.start - b.start; });
    return out;
  }

  // MARK: - Layout

  var TOP = 36, TOP_H = 184, MID = 240, MID_H = 500, STRIP = 760, STRIP_H = 100;
  var root = null, hooks = {};

  function panel(id, x, y, w, h) {
    var p = $(id);
    if (!p) { p = el('div', 'dp', root); p.id = id; }
    place(p, x, y, w, h);
    p.innerHTML = '';
    return p;
  }

  // MARK: - Focus: what can take it, found again by key after each render

  var focusables = [], focusKey = 'cal:view:1', focused = false;

  function focusable(node, key, run, onFocus) {
    setClass(node, 'df', true);
    for (var i = 0; i < focusables.length; i++) if (focusables[i].key === key) { focusables.splice(i, 1); break; }
    focusables.push({node: node, key: key, run: run, onFocus: onFocus});
    node.onmouseover = function () { if (hooks.pointer) hooks.pointer(); focusKey = key; showFocus(); if (onFocus) onFocus(); };
    node.onclick = function () { node.onmouseover(); if (run) run(); };
    setClass(node, 'focus', focused && focusKey === key);
  }

  /** Drops the focusables of a panel that is about to be drawn again. */
  function forget(prefix) {
    focusables = focusables.filter(function (f) { return f.key.indexOf(prefix) !== 0; });
  }

  function current() {
    for (var i = 0; i < focusables.length; i++) if (focusables[i].key === focusKey) return focusables[i];
    return null;
  }

  function showFocus() {
    for (var i = 0; i < focusables.length; i++) setClass(focusables[i].node, 'focus', focused && focusables[i].key === focusKey);
  }

  function rect(node) {
    var r = node.getBoundingClientRect(), s = r.width && node.offsetWidth ? r.width / node.offsetWidth : 1;
    return {l: r.left / s, t: r.top / s, r: r.right / s, b: r.bottom / s, cx: (r.left + r.right) / 2 / s, cy: (r.top + r.bottom) / 2 / s};
  }

  /** The nearest focusable in a direction: the one ahead with the least distance, sideways counting double. */
  function neighbor(from, dx, dy) {
    var a = rect(from.node), best = null, bestD = 1e9;
    for (var i = 0; i < focusables.length; i++) {
      var f = focusables[i];
      if (f === from || !f.node.offsetParent) continue;
      var b = rect(f.node), ahead, side;
      if (dx > 0) { ahead = b.l - a.r; side = Math.max(0, Math.max(a.t, b.t) - Math.min(a.b, b.b)); }
      else if (dx < 0) { ahead = a.l - b.r; side = Math.max(0, Math.max(a.t, b.t) - Math.min(a.b, b.b)); }
      else if (dy > 0) { ahead = b.t - a.b; side = Math.abs(b.cx - a.cx); }
      else { ahead = a.t - b.b; side = Math.abs(b.cx - a.cx); }
      if (ahead < -8) continue;
      var d = Math.max(0, ahead) + 2 * side;
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  /** From the shelf: the strip (or the lowest row) nearest to x. */
  function enter(x) {
    var best = null, bestD = 1e9, lowest = 0, i, r;
    for (i = 0; i < focusables.length; i++) if (focusables[i].node.offsetParent) lowest = Math.max(lowest, rect(focusables[i].node).b);
    for (i = 0; i < focusables.length; i++) {
      if (!focusables[i].node.offsetParent) continue;
      r = rect(focusables[i].node);
      if (r.b < lowest - 60) continue;
      var d = Math.abs(r.cx - x);
      if (d < bestD) { bestD = d; best = focusables[i]; }
    }
    if (best) focusKey = best.key;
    focused = true;
    showFocus();
    if (best && best.onFocus) best.onFocus();
    return !!best;
  }

  /** false: nothing that way (↓ goes back to the shelf). */
  function move(dx, dy) {
    var from = current();
    if (!from) return enter(960) ? true : false;
    var to = neighbor(from, dx, dy);
    if (!to) return dy < 0 || dx !== 0;   // up and sideways stop at the edge; down leaves
    focusKey = to.key;
    showFocus();
    if (to.onFocus) to.onFocus();
    return true;
  }

  function activate() { var f = current(); if (f && f.run) f.run(); }

  function setFocused(on) { focused = on; showFocus(); }

  function focusX() { var f = current(); return f ? rect(f.node).cx : 960; }

  // MARK: - Clock

  function renderClock() {
    var p = panel('dclock', 60, TOP, 520, TOP_H), now = Date.now();
    el('div', 'time', p, hm(now));
    el('div', 'date', p, longDate(now));
    var h = nextHoliday(), line = el('div', 'hol', p);
    if (h) {
      var days = Math.round((h.at - midnight(now)) / DAY);
      line.textContent = (days === 0 ? 'Hoy es feriado: ' : 'Próximo feriado: ' + DAYS_SHORT[new Date(h.at).getDay()] + ' ' + shortDate(h.at) + ' · ')
          + h.name + (days > 1 ? ' (en ' + days + ' días)' : days === 1 ? ' (mañana)' : '');
    }
  }

  // MARK: - Weather

  function uvWord(uv) { return uv >= 11 ? 'extremo' : uv >= 8 ? 'muy alto' : uv >= 6 ? 'alto' : uv >= 3 ? 'moderado' : 'bajo'; }

  function renderWeather() {
    var p = panel('dweather', 600, TOP, 660, TOP_H), w = Data.weather;
    el('div', 'head', p, Data.city || 'Clima');
    if (!w) { el('div', 'empty', p, 'Sin datos del clima por ahora.'); return; }
    var now = el('div', 'now', p);
    sym(Data.symbol(w.code, w.isDay), now);
    el('span', 'temp', now, Data.degrees(w.temp));
    var range = el('div', 'range', p);
    el('div', '', range, 'Máx ' + Data.degrees(w.max));
    el('div', '', range, 'Mín ' + Data.degrees(w.min));
    el('div', 'cond', p, Data.condition(w.code, w.isDay));
    var info = [];
    if (w.rain !== null && w.rain !== undefined) info.push('Lluvia ' + w.rain + '%');
    if (w.uv !== null && w.uv !== undefined) info.push('UV ' + Math.round(w.uv) + ' (' + uvWord(w.uv) + ')');
    el('div', 'info', p, info.join('  ·  '));
    var sun = el('div', 'info sun', p);
    if (w.sunrise) { sym('sunrise', sun, 20); sun.appendChild(document.createTextNode(' ' + hm(w.sunrise) + '    ')); }
    if (w.sunset) { sym('sunset', sun, 20); sun.appendChild(document.createTextNode(' ' + hm(w.sunset))); }
    var days = el('div', 'days', p);
    for (var i = 0; w.days && i < w.days.length && i < 5; i++) {
      var x = w.days[i], d = place(el('div', 'day', days), i * 58, 0, 58);
      el('div', 't', d, DAYS_SHORT[new Date(x.at).getDay()]);
      sym(Data.symbol(x.code, true), d, 28);
      el('div', 'hi', d, Data.degrees(x.max));
      el('div', 'lo', d, Data.degrees(x.min));
      if (x.rain) el('div', 'rain', d, x.rain + '%');
    }
  }

  // MARK: - Dollar

  function renderDollar() {
    var p = panel('ddollar', 1280, TOP, 580, TOP_H);
    el('div', 'head', p, 'Dólar');
    if (dollar.at) el('div', 'side', p, 'act. ' + hm(dollar.at));
    var cells = [];
    for (var i = 0; i < DOLLARS.length; i++) {
      for (var j = 0; j < dollar.list.length; j++) {
        var d = dollar.list[j];
        if (d.casa === DOLLARS[i][0]) cells.push({name: DOLLARS[i][1], value: pesos(d.venta), sub: d.compra ? 'C ' + pesos(d.compra) : ''});
      }
    }
    var btc = Data.prices[0];
    if (!isNaN(btc)) {
      var ch = Data.changes[0];
      cells.push({name: 'Bitcoin', value: 'US$' + number(btc, 0), sub: isNaN(ch) ? '' : Data.change(ch), tone: ch >= 0 ? 'up' : 'down'});
    }
    if (!cells.length) { el('div', 'empty', p, 'Sin cotizaciones por ahora.'); return; }
    var cw = (580 - 44) / 4;
    for (var c = 0; c < cells.length && c < 8; c++) {
      var cell = place(el('div', 'cell', p), 22 + (c % 4) * cw, 44 + Math.floor(c / 4) * 70, cw - 8, 66);
      el('div', 'n', cell, cells[c].name);
      el('div', 'v', cell, cells[c].value);
      el('div', 's' + (cells[c].tone ? ' ' + cells[c].tone : ''), cell, cells[c].sub);
    }
  }

  // MARK: - Calendar

  var VIEWS = ['Día', 'Semana', 'Mes'];
  var view = 1, offset = 0;   // offset: days, weeks or months from today

  function anchor() {
    var now = Date.now(), d = new Date(now);
    if (view === 0) return addDays(midnight(now), offset);
    if (view === 1) return addDays(weekStart(now), offset * 7);
    return new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime();
  }

  function periodLabel() {
    var a = anchor(), d = new Date(a);
    if (view === 0) return offset === 0 ? 'Hoy' : offset === 1 ? 'Mañana' : offset === -1 ? 'Ayer' : longDate(a);
    if (view === 1) { var e = addDays(a, 6); return 'Semana del ' + new Date(a).getDate() + (new Date(e).getMonth() !== d.getMonth() ? ' ' + MONTHS[d.getMonth()].substring(0, 3) : '') + ' al ' + shortDate(e); }
    return cap(MONTHS[d.getMonth()]) + ' ' + d.getFullYear();
  }

  function renderCalendar() {
    var p = panel('dcal', 60, MID, 820, MID_H);
    forget('cal:');
    el('div', 'head', p, 'Calendario');
    el('div', 'period', p, periodLabel());
    var bar = el('div', 'bar', p), defs = [['‹', 'prev'], [VIEWS[0], 'view:0'], [VIEWS[1], 'view:1'], [VIEWS[2], 'view:2'], ['›', 'next']];
    for (var i = 0; i < defs.length; i++) (function (label, key) {
      var b = el('div', 'pill' + (key === 'view:' + view ? ' on' : '') + (label.length === 1 ? ' arrow' : ''), bar, label);
      focusable(b, 'cal:' + key, function () {
        if (key === 'prev') offset--;
        else if (key === 'next') offset++;
        else if (key === 'view:' + view) offset = 0;
        else { view = +key.slice(5); offset = 0; }
        renderCalendar();
      });
    })(defs[i][0], defs[i][1]);
    var body = place(el('div', 'body', p), 24, 82, 772, 396);
    if (view === 0) renderDay(body);
    else if (view === 1) renderWeek(body);
    else renderMonth(body);
    if (!CAL_URLS.length) {
      el('div', 'note', p, 'Para ver tu agenda: pegá la "dirección secreta en formato iCal" de Google Calendar en config.properties (calendar_urls).');
    }
    showFocus();
  }

  function eventLine(parent, e, withTime) {
    var row = el('div', 'ev' + (e.holiday ? ' holiday' : ''), parent);
    var dot = el('span', 'dot', row);
    dot.style.background = e.color;
    if (withTime) el('span', 'when', row, e.allDay ? 'Todo el día' : hm(e.start));
    el('span', 'what', row, e.title);
    return row;
  }

  function renderDay(body) {
    var a = anchor(), list = eventsBetween(a, addDays(a, 1)), shown = 0, max = 9;
    if (!list.length) el('div', 'none', body, 'Nada agendado.');
    for (var i = 0; i < list.length && shown < max; i++, shown++) eventLine(body, list[i], true);
    if (list.length > max) el('div', 'more', body, '+' + (list.length - max) + ' más');
    // A quiet day: the next one too, under its name.
    if (list.length < 5 && shown < max - 2) {
      var next = eventsBetween(addDays(a, 1), addDays(a, 2));
      el('div', 'sub', body, cap(DAYS[new Date(addDays(a, 1)).getDay()]) + (offset === 0 ? ' (mañana)' : ''));
      if (!next.length) el('div', 'none', body, 'Nada agendado.');
      for (var j = 0; j < next.length && shown < max - 1; j++, shown++) eventLine(body, next[j], true);
    }
  }

  function renderWeek(body) {
    var a = anchor(), cw = 772 / 7, today = midnight(Date.now());
    for (var d = 0; d < 7; d++) {
      var day = addDays(a, d), col = place(el('div', 'col' + (day === today ? ' today' : ''), body), d * cw, 0, cw - 6, 396);
      el('div', 'dh', col, DAYS_SHORT[new Date(day).getDay()] + ' ' + new Date(day).getDate());
      var list = eventsBetween(day, addDays(day, 1)), max = 6;
      for (var i = 0; i < list.length && i < max; i++) {
        var e = list[i], box = el('div', 'wev' + (e.holiday ? ' holiday' : ''), col);
        box.style.borderLeftColor = e.color;
        if (!e.allDay) el('div', 'wt', box, hm(e.start));
        el('div', 'ww', box, e.title);
      }
      if (list.length > max) el('div', 'more', col, '+' + (list.length - max));
    }
  }

  function renderMonth(body) {
    var a = anchor(), first = weekStart(a), month = new Date(a).getMonth(), today = midnight(Date.now());
    var weeks = Math.ceil((Math.round((a - first) / DAY) + new Date(new Date(a).getFullYear(), month + 1, 0).getDate()) / 7);
    var cw = 772 / 7, head = 26, ch = (396 - head) / weeks;
    for (var w = 0; w < 7; w++) place(el('div', 'mh', body, DAYS_SHORT[(w + 1) % 7]), w * cw, 0, cw);
    for (var i = 0; i < weeks * 7; i++) {
      var day = addDays(first, i), d = new Date(day);
      var cell = place(el('div', 'mc' + (d.getMonth() !== month ? ' out' : '') + (day === today ? ' today' : ''), body),
          (i % 7) * cw, head + Math.floor(i / 7) * ch, cw - 4, ch - 4);
      el('div', 'mn', cell, d.getDate());
      var list = eventsBetween(day, addDays(day, 1)), fit = ch > 70 ? 2 : 1;
      for (var k = 0; k < list.length && k < fit; k++) {
        var t = el('div', 'mt' + (list[k].holiday ? ' holiday' : ''), cell, (list[k].allDay ? '' : hm(list[k].start) + ' ') + list[k].title);
        t.style.borderLeftColor = list[k].color;
      }
      if (list.length > fit) el('div', 'mm', cell, '+' + (list.length - fit));
    }
  }

  // MARK: - News

  var ROWS = 6, newsTurnAt = Date.now();

  function renderNews() {
    var p = panel('dnews', 900, MID, 960, MID_H);
    forget('news:');
    el('div', 'head', p, 'Noticias');
    var have = news[SECTIONS[section][1] || 'TOP'];
    if (have) el('div', 'side', p, 'act. ' + ago(have.at));
    var tabs = el('div', 'tabs', p);
    for (var i = 0; i < SECTIONS.length; i++) (function (i) {
      var t = el('div', 'pill' + (i === section ? ' on' : ''), tabs, SECTIONS[i][0]);
      // As in the original's tabs: focusing one shows it.
      focusable(t, 'news:tab:' + i, null, function () { if (section !== i) { section = i; newsTurnAt = Date.now(); renderNews(); refreshNews(i); } });
    })(i);
    var items = sectionItems(), list = place(el('div', 'items', p), 24, 106, 912, ROWS * 54);
    if (!items.length) el('div', 'none', list, 'Cargando noticias…');
    for (var k = 0; k < items.length && k < ROWS; k++) (function (n, k) {
      var row = el('div', 'item', list);
      el('div', 't', row, n.title);
      el('div', 'm', row, (n.source ? n.source + '  ·  ' : '') + (n.at ? ago(n.at) : ''));
      focusable(row, 'news:item:' + k, function () {
        TV.openUrl(n.link, function (ok) { if (!ok && hooks.toast) hooks.toast('No se pudo abrir el navegador.'); });
      });
    })(items[k], k);
    renderNewsFooter();
    showFocus();
  }

  function renderNewsFooter() {
    var p = $('dnews');
    if (!p) return;
    var old = p.querySelector('.footer');
    if (old) p.removeChild(old);
    if (!onThisDay.list.length) return;
    var e = onThisDay.list[Math.floor(Date.now() / 60000) % onThisDay.list.length];
    el('div', 'footer', p, 'Un día como hoy, ' + e.year + ': ' + e.text);
  }

  /** Not being read (the focus elsewhere): the next section every 45 s, so more news goes by. */
  function turnNews() {
    var f = current();
    if (focused && f && f.key.indexOf('news:') === 0) { newsTurnAt = Date.now(); return; }
    if (Date.now() - newsTurnAt < 45000) return;
    newsTurnAt = Date.now();
    section = (section + 1) % SECTIONS.length;
    refreshNews(section);
    renderNews();
  }

  // MARK: - Trending strip

  function renderStrip() {
    var p = panel('dstrip', 60, STRIP, 1800, STRIP_H);
    forget('pick:');
    var label = el('div', 'label', p);
    el('div', 'a', label, 'Tendencias');
    el('div', 'b', label, 'películas y series');
    var list = Data.showcase().slice(0, 6), w = (1800 - 210) / 6;
    if (!list.length) { el('div', 'empty', p, Data.hasKey() ? 'Buscando tendencias…' : 'Sin clave de TMDB: no hay tendencias.'); return; }
    for (var i = 0; i < list.length; i++) (function (x, i) {
      var item = place(el('div', 'pick', p), 200 + i * w, 10, w - 14, 80);
      var img = el('div', 'img', item);
      if (x.backdrop) img.style.backgroundImage = 'url(' + Data.image(x.backdrop, 'w300') + ')';
      el('div', 't', item, x.title);
      el('div', 'm', item, (x.kind === 'tv' ? 'Serie' : 'Película') + (x.where ? ' · ' + x.where : ''));
      focusable(item, 'pick:' + i, function () {
        var app = x.app && Data.appFor(x.app);
        if (app && hooks.launch) hooks.launch(app);
        else if (hooks.toast) hooks.toast(x.where ? x.title + ': está en ' + x.where + '.' : x.title + ': no está en las apps de este televisor.');
      });
    })(list[i], i);
    showFocus();
  }

  // MARK: - All of it

  function render() {
    renderClock();
    renderWeather();
    renderDollar();
    renderCalendar();
    renderNews();
    renderStrip();
  }

  function refresh() {
    refreshDollar();
    // Every section, so moving through the tabs shows them at once (each one only every 15 minutes).
    for (var i = 0; i < SECTIONS.length; i++) refreshNews(i);
    refreshHolidays();
    refreshOnThisDay();
    refreshPhotos();
    refreshCalendars();
  }

  /** Every 30 s from home.js: the clock on the minute is ticked by tick(). */
  function every30s() {
    turnNews();
    renderNewsFooter();
    if (Date.now() - photoAt > (CONFIG.backgroundMinutes || 10) * 60000) nextPhoto();
    refresh();
  }

  function tick() {
    renderClock();
    setTimeout(tick, 60000 - Date.now() % 60000 + 50);
  }

  function init(container, h) {
    root = container;
    hooks = h || {};
    var cap0 = el('div', '', $('sky'));
    cap0.id = 'photocap';
    render();
    tick();
    if (photos.list.length) nextPhoto();
    refresh();
    // The calendar's day turns at midnight.
    setInterval(function () { if (view !== 2 || offset === 0) renderCalendar(); }, 15 * 60000);
  }

  return {
    init: init,
    render: render,
    renderWeather: renderWeather,
    renderStrip: renderStrip,
    renderDollar: renderDollar,
    every30s: every30s,
    enter: enter,
    move: move,
    activate: activate,
    setFocused: setFocused,
    focusX: focusX,
    /** The background photos, for the screensaver: [{url, title}]. */
    photos: function () { return photos.list; }
  };
})();

/*
 * A small iCal (RFC 5545) reader: the VEVENTs of a calendar, and their repeats in a time window. Enough for Google
 * Calendar's feeds: DAILY, WEEKLY, MONTHLY and YEARLY rules with INTERVAL, COUNT, UNTIL, BYDAY (also "2MO", "-1FR"),
 * BYMONTHDAY and BYMONTH; EXDATE; RECURRENCE-ID (a moved or changed repeat). Times with a TZID are taken as the TV's
 * own time zone (right for a calendar kept where the TV is).
 */
var Ical = (function () {
  'use strict';

  var DAY = 86400000;
  var WD = {SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6};

  function unescape(v) {
    return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
  }

  /** "20261025" (a date), "20261025T130000Z" (UTC) or "20261025T100000" (local) → {t, allDay}. */
  function parseDate(v) {
    var m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m) return {t: new Date(+m[1], m[2] - 1, +m[3]).getTime(), allDay: true};
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
    if (!m) return null;
    if (m[7]) return {t: Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false};
    return {t: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), allDay: false};
  }

  /** "PT1H30M", "P1D", "P2W" → ms. */
  function duration(v) {
    var m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || '');
    if (!m) return 0;
    var ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return m[1] ? -ms : ms;
  }

  function parseRule(v) {
    var r = {freq: '', interval: 1, count: 0, until: 0, byday: [], bymonthday: [], bymonth: []};
    var parts = v.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('='), k = kv[0], x = kv[1] || '';
      if (k === 'FREQ') r.freq = x;
      else if (k === 'INTERVAL') r.interval = Math.max(1, +x || 1);
      else if (k === 'COUNT') r.count = +x || 0;
      else if (k === 'UNTIL') { var u = parseDate(x); if (u) r.until = u.allDay ? u.t + DAY - 1 : u.t; }
      else if (k === 'BYDAY') r.byday = x.split(',').map(function (d) {
        var m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d);
        return m ? {n: m[1] ? +m[1] : 0, wd: WD[m[2]]} : null;
      }).filter(function (d) { return d; });
      else if (k === 'BYMONTHDAY') r.bymonthday = x.split(',').map(Number);
      else if (k === 'BYMONTH') r.bymonth = x.split(',').map(Number);
    }
    return r;
  }

  function parse(text) {
    var lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
    var events = [], name = '', ev = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], colon = -1, quoted = false;
      for (var c = 0; c < line.length; c++) {
        var ch = line.charAt(c);
        if (ch === '"') quoted = !quoted;
        else if (ch === ':' && !quoted) { colon = c; break; }
      }
      if (colon < 0) continue;
      var head = line.slice(0, colon), value = line.slice(colon + 1), key = head.split(';')[0].toUpperCase();
      if (key === 'BEGIN' && value === 'VEVENT') { ev = {exdates: []}; continue; }
      if (key === 'END' && value === 'VEVENT') {
        if (ev && ev.start !== undefined && ev.status !== 'CANCELLED') {
          if (ev.end === undefined) ev.end = ev.dur ? ev.start + ev.dur : ev.start + (ev.allDay ? DAY : 0);
          delete ev.dur;
          events.push(ev);
        } else if (ev && ev.status === 'CANCELLED' && ev.recurrenceId) {
          events.push({uid: ev.uid, recurrenceId: ev.recurrenceId, cancelled: true});
        }
        ev = null;
        continue;
      }
      if (!ev) { if (key === 'X-WR-CALNAME') name = unescape(value); continue; }
      var d;
      if (key === 'SUMMARY') ev.title = unescape(value);
      else if (key === 'UID') ev.uid = value;
      else if (key === 'STATUS') ev.status = value.toUpperCase();
      else if (key === 'DTSTART') { d = parseDate(value); if (d) { ev.start = d.t; ev.allDay = d.allDay; } }
      else if (key === 'DTEND') { d = parseDate(value); if (d) ev.end = d.t; }
      else if (key === 'DURATION') ev.dur = duration(value);
      else if (key === 'RRULE') ev.rule = value;
      else if (key === 'RECURRENCE-ID') { d = parseDate(value); if (d) ev.recurrenceId = d.t; }
      else if (key === 'EXDATE') {
        var ds = value.split(',');
        for (var e = 0; e < ds.length; e++) { d = parseDate(ds[e]); if (d) ev.exdates.push(d.t); }
      }
    }
    // Keep what can still show: repeats, and single events from 2 months ago on.
    var since = Date.now() - 62 * DAY;
    events = events.filter(function (x) { return x.rule || x.cancelled || x.recurrenceId || x.end > since; });
    return {name: name, events: events};
  }

  /** The nth (1, 2… or -1, -2…) weekday wd of a month, or 0 when there's none. */
  function nthWeekday(year, month, wd, n) {
    if (n > 0) {
      var first = new Date(year, month, 1), dd = 1 + (wd - first.getDay() + 7) % 7 + (n - 1) * 7;
      return dd <= new Date(year, month + 1, 0).getDate() ? dd : 0;
    }
    var lastDay = new Date(year, month + 1, 0), dl = lastDay.getDate() - (lastDay.getDay() - wd + 7) % 7 + (n + 1) * 7;
    return dl >= 1 ? dl : 0;
  }

  /** The days (as dates at the start's time) a rule gives, in order, until stop() says enough. */
  function occurrences(ev, rule, stop) {
    var s = new Date(ev.start), H = s.getHours(), M = s.getMinutes(), S = s.getSeconds();
    function at(y, mo, d) { return new Date(y, mo, d, H, M, S).getTime(); }
    var guard = 0, i, list, y, mo;
    if (rule.freq === 'DAILY') {
      for (var t = ev.start; guard++ < 5000; t = at(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate() + rule.interval)) {
        if (rule.byday.length && !hasDay(rule.byday, new Date(t).getDay())) continue;
        if (rule.bymonth.length && rule.bymonth.indexOf(new Date(t).getMonth() + 1) < 0) continue;
        if (stop(t)) return;
      }
    } else if (rule.freq === 'WEEKLY') {
      var days = rule.byday.length ? rule.byday.map(function (b) { return b.wd; }) : [s.getDay()];
      var monday = new Date(s.getFullYear(), s.getMonth(), s.getDate() - (s.getDay() + 6) % 7);
      for (var w = 0; guard++ < 3000; w += rule.interval) {
        list = days.map(function (wd) { return at(monday.getFullYear(), monday.getMonth(), monday.getDate() + w * 7 + (wd + 6) % 7); }).sort(num);
        for (i = 0; i < list.length; i++) if (list[i] >= ev.start && stop(list[i])) return;
      }
    } else if (rule.freq === 'MONTHLY') {
      for (var m = 0; guard++ < 1200; m += rule.interval) {
        y = s.getFullYear() + Math.floor((s.getMonth() + m) / 12);
        mo = (s.getMonth() + m) % 12;
        list = monthDays(rule, y, mo, s).map(function (dd) { return at(y, mo, dd); }).sort(num);
        for (i = 0; i < list.length; i++) if (list[i] >= ev.start && stop(list[i])) return;
      }
    } else if (rule.freq === 'YEARLY') {
      for (var yr = 0; guard++ < 200; yr += rule.interval) {
        y = s.getFullYear() + yr;
        var months = rule.bymonth.length ? rule.bymonth.map(function (x) { return x - 1; }) : [s.getMonth()];
        list = [];
        for (var k = 0; k < months.length; k++) {
          var ds = monthDays(rule, y, months[k], s);
          for (var q = 0; q < ds.length; q++) list.push(at(y, months[k], ds[q]));
        }
        list.sort(num);
        for (i = 0; i < list.length; i++) if (list[i] >= ev.start && stop(list[i])) return;
      }
    } else {
      stop(ev.start);
    }
  }

  function num(a, b) { return a - b; }
  function hasDay(byday, wd) { for (var i = 0; i < byday.length; i++) if (byday[i].wd === wd) return true; return false; }

  /** Days of one month a MONTHLY or YEARLY rule takes. */
  function monthDays(rule, y, mo, s) {
    var len = new Date(y, mo + 1, 0).getDate(), out = [], i;
    if (rule.bymonthday.length) {
      for (i = 0; i < rule.bymonthday.length; i++) {
        var d = rule.bymonthday[i] < 0 ? len + 1 + rule.bymonthday[i] : rule.bymonthday[i];
        if (d >= 1 && d <= len) out.push(d);
      }
    } else if (rule.byday.length) {
      for (i = 0; i < rule.byday.length; i++) {
        var b = rule.byday[i];
        if (b.n) { var n = nthWeekday(y, mo, b.wd, b.n); if (n) out.push(n); }
        else for (var dd = 1; dd <= len; dd++) if (new Date(y, mo, dd).getDay() === b.wd) out.push(dd);
      }
    } else if (s.getDate() <= len) {
      out.push(s.getDate());
    }
    return out;
  }

  /** Events (and repeats) that overlap [from, to): [{title, start, end, allDay}]. */
  function expand(events, from, to) {
    var moved = {}, out = [], i;
    for (i = 0; i < events.length; i++) if (events[i].recurrenceId) moved[events[i].uid + '@' + events[i].recurrenceId] = true;
    for (i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.cancelled) continue;
      var dur = ev.end - ev.start;
      if (!ev.rule || ev.recurrenceId) {
        if (ev.start < to && ev.end > from) out.push({title: ev.title || '(sin título)', start: ev.start, end: ev.end, allDay: ev.allDay});
        continue;
      }
      var rule = parseRule(ev.rule), n = 0;
      occurrences(ev, rule, function (t) {
        if (rule.until && t > rule.until) return true;
        if (rule.count && ++n > rule.count) return true;
        if (t >= to) return true;
        if (t + dur > from && ev.exdates.indexOf(t) < 0 && !moved[ev.uid + '@' + t]) {
          out.push({title: ev.title || '(sin título)', start: t, end: t + dur, allDay: ev.allDay});
        }
        return false;
      });
    }
    return out;
  }

  return {parse: parse, expand: expand};
})();
