// ==UserScript==
// @name         F4map: Open in Simple3D Editor
// @namespace    https://github.com/felispimeja/osm-simple3d-editor
// @version      1.1.0
// @description  Open the current F4map view in Simple3D Editor.
// @match        https://demo.f4map.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const editor = 'https://felispimeja.github.io/osm-simple3d-editor/';

  // F4map's perspective camera shows the ground about 0.75 zoom levels farther away than MapLibre at the same zoom
  // (measured with its scale bar in 2D mode).
  const zoomOffset = 0.75;

  // F4map keeps the view in the hash: #lat=..&lon=..&zoom=..&camera.theta=..&camera.phi=..&3d=false
  // theta — tilt from vertical in degrees (0–80, default 45), phi — heading in degrees (clockwise compass
  // rotation, default 0); defaults are left out of the hash.
  function editorUrl() {
    const url = new URL(editor);
    const params = new URLSearchParams(location.hash.slice(1));
    const [zoom, lat, lon] = ['zoom', 'lat', 'lon'].map((key) => Number(params.get(key) ?? NaN));
    if (![zoom, lat, lon].every(Number.isFinite) ||
        zoom < 0 || zoom > 24 || Math.abs(lat) > 90 || Math.abs(lon) > 180) return url.href;
    const flat = params.get('3d') === 'false';
    const theta = Number(params.get('camera.theta') ?? 45);
    const phi = Number(params.get('camera.phi') ?? 0);
    const pitch = flat || !Number.isFinite(theta) ? 0 : Math.max(0, Math.min(85, theta));
    // MapLibre's bearing turns the map the other way round
    const bearing = Number.isFinite(phi) ? ((-phi % 360) + 540) % 360 - 180 : 0;
    const round = (value) => Math.round(value * 100) / 100;
    url.hash = [round(Math.max(0, zoom - zoomOffset)), lat, lon, round(bearing), round(pitch)].join('/');
    return url.href;
  }

  function addButton() {
    if (document.querySelector('a[data-simple3d-open]') || !document.body) return;
    const link = document.createElement('a');
    link.dataset.simple3dOpen = '';
    link.textContent = 'Simple3D Editor';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.href = editorUrl();
    Object.assign(link.style, {
      position: 'fixed', left: '10px', bottom: '28px', zIndex: '1000',
      padding: '6px 10px', borderRadius: '4px', background: '#fff', color: '#333',
      font: '13px/1.2 sans-serif', textDecoration: 'none', boxShadow: '0 1px 4px rgba(0,0,0,.3)',
    });
    // The hash changes via replaceState while the map moves, so refresh on use.
    link.addEventListener('mousedown', () => { link.href = editorUrl(); });
    link.addEventListener('click', () => { link.href = editorUrl(); });
    document.body.append(link);
  }

  addButton();
  new MutationObserver(addButton).observe(document.documentElement, { childList: true });
})();
