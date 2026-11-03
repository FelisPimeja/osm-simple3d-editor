// ==UserScript==
// @name         F4map: Open in Simple3D Editor
// @namespace    https://github.com/felispimeja/osm-simple3d-editor
// @version      1.0.0
// @description  Open the current F4map view in Simple3D Editor.
// @match        https://demo.f4map.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const editor = 'https://felispimeja.github.io/osm-simple3d-editor/';

  // F4map keeps the view in the hash: #lat=..&lon=..&zoom=..(&camera.theta=..)
  function editorUrl() {
    const url = new URL(editor);
    const params = new URLSearchParams(location.hash.slice(1));
    const [zoom, lat, lon] = ['zoom', 'lat', 'lon'].map((key) => Number(params.get(key) ?? NaN));
    if ([zoom, lat, lon].every(Number.isFinite) &&
        zoom >= 0 && zoom <= 24 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      url.hash = `${Math.min(19, zoom)}/${lat}/${lon}`;
    }
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
