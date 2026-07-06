// modulo.flex.js — Complemento estável para mapa Flex, sem geocode no navegador e sem poluição no status.
(function(){
  if (window.VescoFlexModular) return;

  const S = () => window.VescoState;

  function getCoords(o){
    if (window.VescoMapas && typeof window.VescoMapas.getCoords === 'function') return window.VescoMapas.getCoords(o);
    try { if (typeof getCoords === 'function') return getCoords(o); } catch(e) {}
    return null;
  }

  function countLatLon(){
    const list = S().flexOrders();
    return {
      total: list.length,
      com: list.filter(o => !!getCoords(o)).length,
      sem: list.filter(o => !getCoords(o)).length
    };
  }

  function renderSummary(){
    const s = countLatLon();
    const sum = document.getElementById('sum-flex-total');
    if (sum) sum.textContent = String(s.total);

    let warn = document.getElementById('flex-geocode-warning');
    const view = document.getElementById('view-envios_flex');
    if (!view) return;

    if (s.sem > 0) {
      if (!warn) {
        warn = document.createElement('div');
        warn.id = 'flex-geocode-warning';
        warn.className = 'vesco-flex-warning';
        view.prepend(warn);
      }
      warn.textContent = `${s.sem} pedido(s) Flex ainda sem lat/lon. Rode corrigirGeocodeFlexAgora no Apps Script para aparecerem no mapa.`;
    } else if (warn) warn.remove();
  }

  function fit(){
    if (!window.mapFlex || typeof L === 'undefined') return;
    try {
      const points = S().flexOrders().map(getCoords).filter(Boolean).map(c => [c.lat, c.lon]);
      if (!points.length) return;
      if (points.length === 1) window.mapFlex.setView(points[0], 15);
      else window.mapFlex.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 14 });
      if (window.VescoMapas) window.VescoMapas.enableAll();
    } catch(e) {}
  }

  function cleanStatus(){
    const tbody = document.getElementById('table-envios-flex-corpo');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (!cells.length) return;

      const first = cells[0];
      let key = row.dataset.vescoFlexKey || '';
      if (!key) {
        const m = (row.innerText || '').match(/#\s*([0-9A-Za-z._-]+)/) || (row.innerText || '').match(/\b(\d{5,})\b/);
        if (m) key = m[1];
      }
      if (key) row.dataset.vescoFlexKey = key;

      if (key && !first.querySelector('.vesco-flex-locate-row')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vesco-flex-locate-row';
        btn.innerHTML = '<i class="fas fa-crosshairs"></i> Mapa';
        btn.onclick = ev => {
          ev.preventDefault();
          ev.stopPropagation();
          if (window.VescoMapas) window.VescoMapas.focusFlex(key);
        };
        first.appendChild(btn);
      }

      row.addEventListener('dblclick', () => {
        if (key && window.VescoMapas) window.VescoMapas.focusFlex(key);
      }, { once:false });

      const statusCell = cells[cells.length - 1];
      if (!statusCell || statusCell.dataset.vescoFlexCleaned === '1') return;

      const button = statusCell.querySelector('button');
      if (button) {
        statusCell.innerHTML = '';
        statusCell.appendChild(button);
      } else {
        const txt = S().norm(statusCell.textContent);
        if ((txt.match(/mercado envios flex/g) || []).length > 1) {
          statusCell.textContent = 'Mercado Envios Flex';
        }
      }

      statusCell.dataset.vescoFlexCleaned = '1';
    });
  }

  function focusFlex(id){
    if (window.VescoMapas) return window.VescoMapas.focusFlex(id);
    return false;
  }

  function apply(){
    renderSummary();
    cleanStatus();
  }

  function init(){
    window.focusFlexOnMap = focusFlex;
    window.addEventListener('vesco:rendered', () => setTimeout(apply, 300));
    window.addEventListener('vesco:loaded', () => setTimeout(apply, 700));
    document.addEventListener('click', () => setTimeout(cleanStatus, 150), true);
    setInterval(cleanStatus, 1800);
    setTimeout(apply, 1000);
  }

  window.VescoFlexModular = { init, renderSummary, fit, countLatLon, cleanStatus, focusFlex };
  init();
  console.log('modulo.flex V2 ativo');
})();
