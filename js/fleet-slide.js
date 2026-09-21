// ============================================================================
// fleet-slide.js — sliding transitions for the Vehicles / Stacks / Payloads tabs.
//   • The old pair of panes slides out, the new pair slides in (direction follows
//     the tab order), with a small stagger and the list rows rising in one by one.
//   • A glowing "thumb" glides behind the active tab (springy easing).
// It wraps rockets-ui.js's setActiveView() — no changes to that file needed.
// Load it AFTER rockets-ui.js. Tweak the timings below.
// ============================================================================
(function () {
  var OUT_MS = 200;                       // how long the old panes take to leave (keep in sync with --sl-out in the CSS)
  var ORDER = ['fleet', 'stacks', 'payloads'];
  var PANES = {
    fleet: ['fleetPane', 'editorPane'],
    stacks: ['stackPane', 'stackEditorPane'],
    payloads: ['payloadPane', 'payloadEditorPane']
  };
  var original = window.setActiveView;
  var tabs = document.getElementById('viewTabs');
  if (typeof original !== 'function' || !tabs) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- sliding thumb behind the active tab -----------------------------------
  var thumb = document.createElement('span');
  thumb.className = 'tab-thumb';
  tabs.insertBefore(thumb, tabs.firstChild);
  function moveThumb(btn, instant) {
    btn = btn || tabs.querySelector('.view-tab.active');
    if (!btn) return;
    if (instant) thumb.style.transition = 'none';
    thumb.style.width = btn.offsetWidth + 'px';
    thumb.style.height = btn.offsetHeight + 'px';
    thumb.style.transform = 'translate(' + btn.offsetLeft + 'px,' + btn.offsetTop + 'px)';
    if (instant) { void thumb.offsetWidth; thumb.style.transition = ''; }
  }
  moveThumb(null, true);
  window.addEventListener('resize', function () { moveThumb(null, true); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { moveThumb(null, true); });
  window.addEventListener('load', function () { moveThumb(null, true); });

  // ---- pane transitions --------------------------------------------------------
  function panesOf(view) { return (PANES[view] || []).map(function (id) { return document.getElementById(id); }).filter(Boolean); }
  function clear(list) { list.forEach(function (p) { p.classList.remove('sl-out-l', 'sl-out-r', 'sl-in-l', 'sl-in-r', 'sl-entering'); }); }
  function currentView() { return typeof activeView !== 'undefined' ? activeView : 'fleet'; }

  var busy = false, pending = null;
  window.setActiveView = function (view) {
    var from = currentView();
    if (reduce || view === from || ORDER.indexOf(view) < 0) { original(view); moveThumb(null, true); return; }
    if (busy) { pending = view; return; }
    busy = true;

    var dir = ORDER.indexOf(view) > ORDER.indexOf(from) ? 1 : -1;          // 1 = forward (content moves left)
    var btn = tabs.querySelector('.view-tab[data-view="' + view + '"]');
    tabs.querySelectorAll('.view-tab').forEach(function (t) { t.classList.toggle('active', t === btn); });
    moveThumb(btn);

    var oldP = panesOf(from);
    oldP.forEach(function (p, i) { p.style.setProperty('--d', (i * 40) + 'ms'); p.classList.add(dir > 0 ? 'sl-out-l' : 'sl-out-r'); });

    setTimeout(function () {
      clear(oldP);
      original(view);                                                       // swaps display, re-renders lists
      var newP = panesOf(view);
      newP.forEach(function (p, i) {
        p.style.setProperty('--d', (i * 90) + 'ms');
        p.classList.add('sl-entering', dir > 0 ? 'sl-in-r' : 'sl-in-l');
      });
      setTimeout(function () {
        clear(newP); busy = false;
        if (pending) { var v = pending; pending = null; window.setActiveView(v); }
      }, 620);
    }, OUT_MS + 40);
  };
})();
