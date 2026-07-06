// modulo.mapas.js — Mapa, zoom, expandir e foco preciso nos pedidos/Flex.
(function(){
  if (window.VescoMapas) return;

  const S = () => window.VescoState;

  function getMapEl(id){
    if (!id) {
      const active = S().norm(document.querySelector('.tab-btn.active, button.active, a.active')?.textContent || '');
      if (active.includes('flex')) return document.getElementById('map-flex') || document.getElementById('mapFlex');
      if (active.includes('rota')) return document.getElementById('map-rotas');
      return document.getElementById('map') || document.querySelector('.leaflet-container');
    }
    return document.getElementById(String(id).replace(/^#/, '')) || document.querySelector(id);
  }

  function mapEntries(){
    const out = [];
    [['map', window.map, 'map'], ['mapFlex', window.mapFlex, 'map-flex'], ['mapRotas', window.mapRotas || window.routeMap || window.mapRota, 'map-rotas']]
      .forEach(x => { if (x[1]) out.push(x); });

    Object.keys(window).forEach(k => {
      const m = window[k];
      if (/^map/i.test(k) && m && typeof m.invalidateSize === 'function' && typeof m.setView === 'function' && !out.some(x => x[1] === m)) {
        out.push([k, m, '']);
      }
    });
    return out;
  }

  function mapByEl(el){
    if (!el) return null;
    for (const [name, mapObj, id] of mapEntries()) {
      try { if (mapObj.getContainer && mapObj.getContainer() === el) return mapObj; } catch(e) {}
      if (id && el.id === id) return mapObj;
    }
    return null;
  }

  function enable(mapObj){
    if (!mapObj) return;
    try { mapObj.scrollWheelZoom && mapObj.scrollWheelZoom.enable(); } catch(e) {}
    try { mapObj.touchZoom && mapObj.touchZoom.enable(); } catch(e) {}
    try { mapObj.doubleClickZoom && mapObj.doubleClickZoom.enable(); } catch(e) {}
    try { mapObj.boxZoom && mapObj.boxZoom.enable(); } catch(e) {}
    try { mapObj.keyboard && mapObj.keyboard.enable(); } catch(e) {}
    try { mapObj.dragging && mapObj.dragging.enable(); } catch(e) {}

    try {
      const c = mapObj.getContainer && mapObj.getContainer();
      if (c && !c.__vescoMapWheelV2) {
        c.__vescoMapWheelV2 = true;
        c.addEventListener('wheel', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          try { ev.deltaY < 0 ? mapObj.zoomIn(1) : mapObj.zoomOut(1); } catch(e) {}
        }, { passive:false });
      }
    } catch(e) {}

    try { mapObj.invalidateSize(true); } catch(e) {}
    setTimeout(() => { try { mapObj.invalidateSize(true); } catch(e) {} }, 350);
  }

  function enableAll(){ mapEntries().forEach(([_, m]) => enable(m)); }

  function toggleMapExpand(id){
    const el = getMapEl(id);
    if (!el) return false;

    const expanded = el.classList.toggle('vesco-map-expanded');
    document.body.classList.toggle('vesco-map-expanded-body', expanded);

    let close = document.getElementById('vesco-map-close');
    if (expanded) {
      if (!close) {
        close = document.createElement('button');
        close.id = 'vesco-map-close';
        close.textContent = 'Fechar mapa';
        close.onclick = () => {
          document.querySelectorAll('.vesco-map-expanded').forEach(x => x.classList.remove('vesco-map-expanded'));
          document.body.classList.remove('vesco-map-expanded-body');
          close.remove();
          enableAll();
        };
        document.body.appendChild(close);
      }
    } else if (close) {
      close.remove();
    }

    enable(mapByEl(el));
    setTimeout(() => enable(mapByEl(el)), 500);
    return expanded;
  }

  function changeMapHeight(idOrDelta, maybeDelta){
    let id = idOrDelta, delta = maybeDelta;
    if (typeof idOrDelta === 'number') { delta = idOrDelta; id = null; }
    const el = getMapEl(id);
    if (!el) return false;
    const current = parseInt(getComputedStyle(el).height, 10) || 420;
    const next = Math.max(280, Math.min(950, current + Number(delta || 0)));
    el.style.height = next + 'px';
    el.style.minHeight = next + 'px';
    enable(mapByEl(el));
    return next;
  }

  function getCoords(o){
    try { if (typeof window.getCoords === 'function') return window.getCoords(o); } catch(e) {}
    const lat = parseFloat(String(o && (o.lat ?? o.latitude ?? '')).replace(',', '.'));
    const lon = parseFloat(String(o && (o.lon ?? o.lng ?? o.longitude ?? '')).replace(',', '.'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    return null;
  }

  function findMarker(id, type){
    const order = S().findOrder(id);
    const keys = new Set([id].filter(Boolean));
    if (order) S().keys(order).forEach(k => keys.add(k));

    const stores = type === 'flex'
      ? [window.activeFlexMarkers, window.vescoV49FlexMarkers, window.vescoV50FlexMarkers]
      : [window.activeMainMarkers, window.vescoV49MainMarkers, window.vescoV50MainMarkers];

    for (const store of stores) {
      if (!store) continue;
      for (const k of keys) {
        if (store[k]) return store[k];
        const nk = S().digits(k);
        if (nk && store[nk]) return store[nk];
      }
    }
    return null;
  }

  function focus(id, type){
    const isFlex = type === 'flex';
    const order = isFlex
      ? S().flexOrders().find(o => S().keys(o).includes(String(id)) || S().keys(o).includes(S().digits(id)))
      : S().findOrder(id);

    const mapObj = isFlex ? window.mapFlex : window.map;
    if (!mapObj || typeof L === 'undefined') return false;

    try { if (typeof switchTab === 'function') switchTab(isFlex ? 'envios_flex' : 'logistica'); } catch(e) {}

    const marker = findMarker(id, isFlex ? 'flex' : 'main');
    if (marker && marker.getLatLng) {
      setTimeout(() => {
        try {
          mapObj.setView(marker.getLatLng(), 17);
          marker.openPopup && marker.openPopup();
          enable(mapObj);
        } catch(e) {}
      }, 180);
      return true;
    }

    if (!order) return false;
    const coords = getCoords(order);
    if (!coords) return false;

    setTimeout(() => {
      try {
        mapObj.setView([coords.lat, coords.lon], 17);
        enable(mapObj);
      } catch(e) {}
    }, 180);
    return true;
  }

  function focusOrder(id){ return focus(id, 'main'); }
  function focusFlex(id){ return focus(id, 'flex'); }

  function init(){
    window.toggleMapExpand = toggleMapExpand;
    window.changeMapHeight = changeMapHeight;
    window.expandMap = toggleMapExpand;
    window.toggleExpandMap = toggleMapExpand;
    window.focusOrderOnMap = focusOrder;
    window.focusFlexOnMap = focusFlex;

    enableAll();
    window.addEventListener('resize', () => setTimeout(enableAll, 250));
    window.addEventListener('vesco:rendered', () => setTimeout(enableAll, 250));
    window.addEventListener('vesco:loaded', () => setTimeout(enableAll, 350));
    document.addEventListener('click', () => setTimeout(enableAll, 250), true);
    setInterval(enableAll, 3500);
  }

  window.VescoMapas = { init, enableAll, toggleMapExpand, changeMapHeight, focusOrder, focusFlex, getCoords, mapEntries };
  init();
  console.log('modulo.mapas V2 ativo');
})();
