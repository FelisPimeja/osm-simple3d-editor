// ==UserScript==
// @name         OpenStreetMap: Open in Simple3D Editor
// @namespace    https://github.com/felispimeja/osm-simple3d-editor
// @version      1.0.0
// @description  Open the current map or object in Simple3D Editor from the top navigation.
// @match        https://www.openstreetmap.org/*
// @match        https://openstreetmap.org/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const editor = 'https://felispimeja.github.io/osm-simple3d-editor/';

  function editorUrl() {
    const url = new URL(editor);
    const object = location.pathname.match(/^\/(way|relation)\/(\d+)(?:\/|$)/);
    if (object) {
      // Let the editor locate the object, even if the OSM map has been panned away.
      url.searchParams.set('edit', object[1][0] + object[2]);
      return url.href;
    }

    // OSM updates the hash as the map moves, including on node info pages.
    const map = location.hash.match(/(?:^#|&)map=(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)(?:&|$)/);
    if (map) {
      const [zoom, lat, lon] = map.slice(1).map(Number);
      if (zoom >= 0 && zoom <= 24 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        url.hash = `${Math.min(19, zoom)}/${lat}/${lon}`;
      }
    }
    return url.href;
  }

  function updateMenu() {
    // Match the route rather than translated link text; ignore the sidebar's About link.
    const about = document.querySelector('header a[href="/about"], nav a[href="/about"]');
    if (!about) return;
    const item = about.closest('li');
    if (!item) return;
    let link = item.parentElement.querySelector('a[data-simple3d-open]');
    if (!link) {
      const entry = document.createElement('li');
      entry.className = item.className;
      entry.classList.remove('active');
      link = document.createElement('a');
      link.className = about.className;
      link.classList.remove('active');
      link.dataset.simple3dOpen = '';
      link.textContent = 'Simple3D Editor';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      // Refresh synchronously too, in case navigation just changed via pushState.
      link.addEventListener('click', () => { link.href = editorUrl(); });
      link.addEventListener('auxclick', () => { link.href = editorUrl(); });
      entry.append(link);
      item.after(entry);
    }
    const href = editorUrl();
    if (link.href !== href) link.href = href;
  }

  // OSM navigates between map and object pages without a full page reload.
  // Its map links also change when replaceState updates the current viewport.
  new MutationObserver(updateMenu).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
  });
  window.addEventListener('hashchange', updateMenu);
  window.addEventListener('popstate', updateMenu);
  updateMenu();
})();
