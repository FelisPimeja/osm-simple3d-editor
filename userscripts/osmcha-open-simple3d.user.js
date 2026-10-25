// ==UserScript==
// @name         OSMCha: Open with Simple3D Editor
// @namespace    https://github.com/felispimeja/osm-simple3d-editor
// @version      1.1.0
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

  function editorUrl(xml) {
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
    return `${editor}#${zoom}/${lat.toFixed(6)}/${lon.toFixed(6)}`;
  }

  function fetchUrl(id) {
    if (cache.has(id)) return cache.get(id);
    const request = new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${api}/changeset/${id}`,
        onload: (response) => resolve(response.status === 200 ? editorUrl(response.responseText) : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
        timeout: 10000,
      });
    });
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
