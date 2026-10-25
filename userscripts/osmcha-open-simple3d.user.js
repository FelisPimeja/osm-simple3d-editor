// ==UserScript==
// @name         OSMCha: Open with Simple3D Editor
// @namespace    https://github.com/felispimeja/osm-simple3d-editor
// @version      1.2.0
// @description  Open the location of an OSMCha changeset in Simple3D Editor (OpenStreetMap and OpenHistoricalMap).
// @match        https://osmcha.org/*
// @match        https://osmcha.openhistoricalmap.org/*
// @grant        GM_xmlhttpRequest
// @connect      api.openstreetmap.org
// @connect      www.openhistoricalmap.org
// ==/UserScript==

(function () {
  'use strict';

  // OSMCha of OpenHistoricalMap — changesets from the OHM API, the editor opens with OHM as the server
  const ohm = location.hostname === 'osmcha.openhistoricalmap.org';
  const api = ohm ? 'https://www.openhistoricalmap.org/api/0.6' : 'https://api.openstreetmap.org/api/0.6';
  const editor = `https://felispimeja.github.io/osm-simple3d-editor/${ohm ? '?server=ohm' : ''}`;
  const cache = new Map();

  function changesetId() {
    return location.pathname.match(/^\/changesets\/(\d+)(?:\/|$)/)?.[1];
  }

  // Date of an OHM value: 1850, 1850-03, 1850-03-12, ~1850, 1850s, -0500 → decimal year (start of the period)
  function decimalDate(value) {
    const r = value?.trim().replace(/^~/, '').match(/^(-?\d{1,4})(?:-(\d\d))?(?:-(\d\d))?/);
    if (!r) return undefined;
    const month = r[2] ? Number(r[2]) : 1, day = r[3] ? Number(r[3]) : 1;
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return Number(r[1]) + ((month - 1) * 30.4 + day - 1) / 366;
  }

  /**
   * OHM: a date when most of the changed features exist (start_date inclusive, end_date exclusive, as in the
   * editor's date filter), so that the editor shows them. The original start_date value of that moment is
   * returned (keeps its precision: year, month or day); null — the changed features carry no dates.
   * Buildings (building, building:part) count first: the editor shows them; other features — only without them.
   */
  function featureDate(osmChange) {
    const doc = new DOMParser().parseFromString(osmChange, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const all = [];
    for (const el of doc.querySelectorAll('create > *, modify > *')) {
      const tag = (key) => el.querySelector(`:scope > tag[k="${key}"]`)?.getAttribute('v');
      const startValue = tag('start_date'), endValue = tag('end_date');
      const start = decimalDate(startValue), end = decimalDate(endValue);
      if (start === undefined && end === undefined) continue;
      if (start !== undefined && end !== undefined && end <= start) continue;
      const building = !!el.querySelector(':scope > tag[k="building"], :scope > tag[k="building:part"]');
      all.push({ building, start, end, startValue: startValue?.trim().replace(/^~/, '').match(/^-?\d{1,4}(?:-\d\d){0,2}/)[0] });
    }
    if (!all.length) return null;
    const spans = all.some((s) => s.building) ? all.filter((s) => s.building) : all;
    // Candidate moments: every start, and just before every end (for features with an end_date only)
    const candidates = [];
    for (const s of spans) {
      if (s.start !== undefined) candidates.push({ t: s.start, value: s.startValue });
      else candidates.push({ t: s.end - 1, value: String(Math.floor(s.end - 1)) });
    }
    let best = null;
    for (const c of candidates) {
      const n = spans.filter((s) => (s.start === undefined || s.start <= c.t) && (s.end === undefined || s.end > c.t)).length;
      // More features shown; on a tie — the later moment (closer to the present-day look of the place)
      if (!best || n > best.n || (n === best.n && c.t > best.t)) best = { ...c, n };
    }
    return best.value;
  }

  function editorUrl(xml, date) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const box = doc.querySelector('changeset');
    if (!box || doc.querySelector('parsererror')) return null;
    if (['min_lat', 'min_lon', 'max_lat', 'max_lon'].some((key) => !box.hasAttribute(key))) return null;
    const [minLat, minLon, maxLat, maxLon] =
      ['min_lat', 'min_lon', 'max_lat', 'max_lon'].map((key) => Number(box.getAttribute(key)));
    if (![minLat, minLon, maxLat, maxLon].every(Number.isFinite) ||
        minLat > maxLat || minLon > maxLon ||
        minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return null;

    const lat = (minLat + maxLat) / 2;
    const lon = (minLon + maxLon) / 2;
    // Approximate a padded 800×600 map viewport in Web Mercator pixels.
    const mercatorY = (latitude) => {
      const radians = Math.max(-85, Math.min(85, latitude)) * Math.PI / 180;
      return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
    };
    const spanX = (maxLon - minLon) / 360;
    const spanY = Math.abs(mercatorY(minLat) - mercatorY(maxLat));
    const zoom = Math.max(0, Math.min(19, Math.floor(Math.min(
      Math.log2(640 / (256 * Math.max(spanX, 1e-9))),
      Math.log2(480 / (256 * Math.max(spanY, 1e-9))),
    ))));
    const query = date ? `${editor.includes('?') ? '&' : '?'}date=${encodeURIComponent(date)}` : '';
    return `${editor}${query}#${zoom}/${lat.toFixed(6)}/${lon.toFixed(6)}`;
  }

  function get(url, timeout) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (response) => resolve(response.status === 200 ? response.responseText : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
        timeout,
      });
    });
  }

  function fetchUrl(id) {
    if (cache.has(id)) return cache.get(id);
    const request = Promise.all([
      get(`${api}/changeset/${id}`, 10000),
      // OHM: the changed features, for their start_date/end_date
      ohm ? get(`${api}/changeset/${id}/download`, 30000) : null,
    ]).then(([meta, changes]) => (meta ? editorUrl(meta, changes ? featureDate(changes) : null) : null));
    cache.set(id, request);
    return request;
  }

  function updateMenu() {
    const id = changesetId();
    if (!id) return;
    const achavi = [...document.querySelectorAll('a')].find((link) =>
      link.textContent.trim() === 'Achavi' && link.closest('li.dropdown-content-item'));
    if (!achavi) return;
    const list = achavi.closest('li').parentElement;
    if (list.querySelector('[data-simple3d-open]')) return;

    const item = achavi.closest('li').cloneNode(true);
    const link = item.querySelector('a');
    link.dataset.simple3dOpen = id;
    link.textContent = 'Simple3D Editor (loading…)';
    link.removeAttribute('href');
    achavi.closest('li').after(item);

    fetchUrl(id).then((url) => {
      if (!item.isConnected || changesetId() !== id) return;
      if (!url) {
        link.textContent = 'Simple3D Editor (location unavailable)';
        return;
      }
      link.href = url;
      link.textContent = 'Simple3D Editor';
    });
  }

  new MutationObserver(updateMenu).observe(document.documentElement, { childList: true, subtree: true });
  updateMenu();
})();
