// modulo.rotas.js — V3.2: rotas do dia puxadas da planilha e sem rotas vazias.
(function(){
  // Sobrescreve qualquer versão anterior do módulo de rotas.
  const S = () => window.VescoState;
  const A = () => window.VescoAPI;
  const CFG = window.VescoConfig || {};
  const selected = window.__vescoRouteSelectionV32 || new Set();
  window.__vescoRouteSelectionV32 = selected;

  let remoteRoutes = [];
  let remoteLoadedAt = 0;
  let remoteLoading = false;

  function txt(v){ return S() && S().txt ? S().txt(v) : (v == null ? '' : String(v).trim()); }
  function norm(v){ return S() && S().norm ? S().norm(v) : txt(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim(); }
  function esc(v){ return S() && S().esc ? S().esc(v) : txt(v).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  function readJSON(key, fallback){
    try { return S().readJSON(key, fallback); } catch(e) {}
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch(e) { return fallback; }
  }

  function writeJSON(key, value){
    try { return S().writeJSON(key, value); } catch(e) {}
    try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
  }

  function storageKeys(){
    return Array.from(new Set([
      CFG.ROUTES_KEY || 'vesco_saiu_rotas_v1',
      CFG.ROUTES_KEY_MODULAR || 'vesco_routes_modular_v2',
      CFG.ROUTES_REMOTE_CACHE_KEY || 'vesco_routes_remote_cache_v2',
      'vesco_routes_modular_v1'
    ]));
  }

  function selectedISO(){
    try { return S().selectedDateISO(); } catch(e) {}
    const el = document.getElementById('topCalendar') || document.querySelector('input[type="date"]');
    if (el && el.value) return parseDateISO(el.value) || el.value;
    return new Date().toISOString().slice(0,10);
  }

  function parseDateISO(v){
    const s = txt(v);
    if (!s) return '';

    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

    const br = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (br) {
      const y = br[3].length === 2 ? '20' + br[3] : br[3];
      return `${y}-${String(br[2]).padStart(2,'0')}-${String(br[1]).padStart(2,'0')}`;
    }

    return '';
  }

  function brDate(iso){
    try { return S().dateBR(iso); } catch(e) {}
    const m = txt(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : txt(iso);
  }

  function parseMaybeJSON(v){
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    if (typeof v === 'object') return [v];

    const s = txt(v);
    if (!s || s === '-' || s === '—' || s === '[]' || s === '{}') return [];

    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch(e) {}

    return s.split(/[,;\n\r\t ]+/g).map(x => x.trim()).filter(Boolean);
  }

  function cleanPedidoId(v){
    if (v == null) return '';

    if (typeof v === 'object') {
      v = v.numero || v.pedido || v.id || v.id_tiny || v.numero_ecommerce || v.ecom || '';
    }

    let s = txt(v).replace(/^#/, '').replace(/^pedido[:\s]*/i, '').trim();

    if (!s || s === '-' || s === '—') return '';
    if (['undefined','null','nan'].includes(s.toLowerCase())) return '';

    s = s.replace(/[^\w.-]/g, '');

    if (!/\d/.test(s)) return '';

    return s;
  }

  function normalizeRoute(raw){
    raw = raw || {};

    let pedidosRaw =
      raw.pedidos_json !== undefined ? raw.pedidos_json :
      raw.pedidos !== undefined ? raw.pedidos :
      raw.orders !== undefined ? raw.orders :
      raw.pedido !== undefined ? raw.pedido :
      raw.pedidosJson !== undefined ? raw.pedidosJson :
      [];

    let paradasRaw =
      raw.paradas_json !== undefined ? raw.paradas_json :
      raw.paradas !== undefined ? raw.paradas :
      raw.stops !== undefined ? raw.stops :
      [];

    const pedidos = Array.from(new Set(parseMaybeJSON(pedidosRaw).map(cleanPedidoId).filter(Boolean)));
    const paradas = parseMaybeJSON(paradasRaw);

    const idRaw = raw.rota_id || raw.id || raw.token || '';
    const criado = raw.criado_em || raw.criadoEm || raw.created_at || raw.data_criacao || '';
    const atualizado = raw.atualizado_em || raw.atualizadoEm || raw.updated_at || '';
    const dataOperacional = raw.data_operacional || raw.operationalDate || raw.data_rota || raw.data || parseDateISO(criado) || parseDateISO(atualizado);

    return {
      id: txt(idRaw) || ('rota-' + (parseDateISO(criado) || Date.now()) + '-' + pedidos.join('-')),
      rota_id: raw.rota_id || raw.id || '',
      token: raw.token || '',
      nome: raw.nome_rota || raw.nome || raw.rota || raw.name || 'Rota',
      motorista: raw.motorista || raw.driver || '',
      origem: raw.origem || raw.origin || 'Rua São Leopoldo 92',
      pedidos,
      paradas: Array.isArray(paradas) ? paradas : [],
      status: raw.status || raw.situacao || 'ativa',
      data_operacional: parseDateISO(dataOperacional) || parseDateISO(criado) || parseDateISO(atualizado) || '',
      criadoEm: criado,
      atualizadoEm: atualizado
    };
  }

  function hasUsefulRoute(raw){
    const r = normalizeRoute(raw);

    if (!r.pedidos || r.pedidos.length === 0) return false;

    const motorista = norm(r.motorista);
    if (!motorista || motorista === '-' || motorista === '—' || motorista === '---' || motorista === 'undefined' || motorista === 'null') return false;

    return true;
  }

  function routeBelongsDay(raw){
    if (!hasUsefulRoute(raw)) return false;

    const r = normalizeRoute(raw);
    const selected = selectedISO();

    const dates = [
      r.data_operacional,
      r.criadoEm,
      r.atualizadoEm,
      raw && raw.criado_em,
      raw && raw.atualizado_em,
      raw && raw.data_operacional
    ].map(parseDateISO).filter(Boolean);

    if (!dates.length) return false;

    return dates.includes(selected);
  }

  function sanitizeList(list, onlyToday = false){
    if (!Array.isArray(list)) return [];

    const out = [];
    const seen = new Set();

    list.forEach(raw => {
      const r = normalizeRoute(raw);
      if (!hasUsefulRoute(r)) return;
      if (onlyToday && !routeBelongsDay(r)) return;

      const id = String(r.id || r.rota_id || r.token || r.pedidos.join('|'));
      if (seen.has(id)) return;
      seen.add(id);
      out.push(r);
    });

    return out;
  }

  function localRoutes(){
    const merged = [];
    const seen = new Set();

    storageKeys().forEach(key => {
      const arr = readJSON(key, []);
      sanitizeList(arr, false).forEach(r => {
        const id = String(r.id || r.rota_id || r.token || r.pedidos.join('|'));
        if (seen.has(id)) return;
        seen.add(id);
        merged.push(r);
      });
    });

    return merged;
  }

  function limparRotasInvalidasLocais(){
    let combined = [];

    storageKeys().forEach(key => {
      const arr = readJSON(key, []);
      if (!Array.isArray(arr)) return;

      const clean = sanitizeList(arr, false);
      writeJSON(key, clean);
      combined = combined.concat(clean);
    });

    const cleanCombined = sanitizeList(combined, false);

    // O legado antigo usa window.saiuRotas. Limpa também para ele não recriar rotas vazias.
    window.saiuRotas = cleanCombined;
    try { localStorage.setItem(CFG.ROUTES_KEY || 'vesco_saiu_rotas_v1', JSON.stringify(cleanCombined)); } catch(e) {}

    return cleanCombined;
  }

  function saveRoutes(list){
    const clean = sanitizeList(list, false);
    window.saiuRotas = clean;
    writeJSON(CFG.ROUTES_KEY || 'vesco_saiu_rotas_v1', clean);
    writeJSON(CFG.ROUTES_KEY_MODULAR || 'vesco_routes_modular_v2', clean);
  }

  function allRoutes(){
    const merged = [];
    const seen = new Set();

    localRoutes().concat(remoteRoutes).forEach(raw => {
      const r = normalizeRoute(raw);
      if (!hasUsefulRoute(r)) return;

      const id = String(r.id || r.rota_id || r.token || r.pedidos.join('|'));
      if (seen.has(id)) return;
      seen.add(id);
      merged.push(r);
    });

    return merged;
  }

  function eligible(){
    try {
      return S().orders()
        .filter(o => !S().isDelivered(o))
        .filter(o => S().isSeparatedOrReady(o))
        .filter(o => !S().isRetirada(o))
        .filter(o => S().hasAddress(o))
        .filter((o, idx, arr) => arr.findIndex(x => S().getKey(x) === S().getKey(o)) === idx);
    } catch(e) {
      return [];
    }
  }

  function ensureManualBox(){
    const list = document.getElementById('saiu-pedidos-list');
    if (!list) return;

    const parent = list.parentElement;
    if (!parent || document.getElementById('vesco-route-manual-box')) return;

    const box = document.createElement('div');
    box.id = 'vesco-route-manual-box';
    box.className = 'vesco-route-manual-box';
    box.innerHTML = `
      <label>Adicionar na rota por número da venda ou E-commerce</label>
      <div class="vesco-route-manual-row">
        <input id="vesco-route-manual-input" placeholder="Digite o nº do pedido, venda ou e-commerce">
        <button type="button" id="vesco-route-manual-add"><i class="fas fa-plus"></i> Adicionar</button>
      </div>
      <small>Use quando o pedido não aparecer na lista, mas você já tem o número da venda ou do e-commerce.</small>
    `;
    parent.insertBefore(box, list);
  }

  function addManual(){
    const input = document.getElementById('vesco-route-manual-input');
    const value = txt(input && input.value);
    if (!value) return;

    const order = S().findOrder(value);
    const id = order ? S().getKey(order) : value;

    if (order && !S().hasAddress(order)) {
      alert('Esse pedido não possui endereço válido. Ele deve ir para Retiradas/Sem rota.');
      return;
    }

    selected.add(id);
    if (input) input.value = '';
    render();
  }

  function row(o){
    const id = S().getKey(o);
    const checked = selected.has(id) ? 'checked' : '';

    return `
      <label class="vesco-route-order ${checked ? 'selected' : ''}">
        <input type="checkbox" value="${esc(id)}" ${checked}>
        <div class="min-w-0">
          <div class="font-black">#${esc(S().getNumber(o) || id)} <span>${esc(o.cliente_nome || o.destinatario || o.cliente || '')}</span></div>
          <small>${esc(S().getAddress(o))}</small>
          <div><span class="vesco-chip">Entrega • ${brDate(S().getOrderDate(o))}</span></div>
        </div>
        <button type="button" class="vesco-locate-small" onclick="VescoMapas && VescoMapas.focusOrder('${esc(id)}')">Localizar</button>
      </label>
    `;
  }

  function renderAvailable(){
    ensureManualBox();

    const el = document.getElementById('saiu-pedidos-list');
    if (!el) return;

    const list = eligible();

    el.innerHTML = list.length
      ? list.map(row).join('')
      : `<div class="vesco-empty">Nenhum pedido com endereço disponível para rota.</div>`;
  }

  function renderSelected(){
    const el = document.getElementById('saiu-rota-selected');
    if (!el) return;

    const ids = Array.from(selected);

    if (!ids.length) {
      el.innerHTML = `<div class="vesco-empty compact">Nenhum pedido selecionado.</div>`;
      return;
    }

    el.innerHTML = ids.map(id => {
      const o = S().findOrder(id);
      return `
        <div class="vesco-selected-route-row">
          <span>#${esc(o ? S().getNumber(o) : id)} ${o ? `<small>${esc(o.cliente_nome || o.destinatario || '')}</small>` : '<small>Manual</small>'}</span>
          <button type="button" data-remove-route="${esc(id)}">×</button>
        </div>
      `;
    }).join('');
  }

  function routeHtml(r){
    return `
      <div class="vesco-route-card" data-route-id="${esc(r.id)}">
        <div class="flex justify-between gap-3">
          <div>
            <div class="font-black"><i class="fas fa-route text-blue-600"></i> ${esc(r.nome || 'Rota')}</div>
            <div class="text-xs text-slate-500 mt-1">Motorista: ${esc(r.motorista)} • ${r.pedidos.length} pedido(s)</div>
            <div class="text-xs text-slate-500">Origem: ${esc(r.origem || '—')}</div>
            <div class="text-[10px] text-slate-400">Data: ${brDate(r.data_operacional || r.criadoEm || selectedISO())}${r.token ? ` • Token: ${esc(r.token)}` : ''}</div>
          </div>
          <div class="flex gap-2">
            <button class="vesco-btn blue" data-start-route="${esc(r.id)}">Iniciar</button>
            <button class="vesco-btn green" data-finish-route="${esc(r.id)}">Concluir</button>
            <button class="vesco-btn danger" data-delete-route="${esc(r.id)}">Remover</button>
          </div>
        </div>
        <div class="text-xs mt-2"><b>Pedidos:</b> ${r.pedidos.map(p => '#'+esc(p)).join(', ')}</div>
      </div>
    `;
  }

  function killInvalidLegacyCards(){
    const el = document.getElementById('saiu-rotas-list');
    if (!el) return;

    Array.from(el.children).forEach(card => {
      const t = norm(card.innerText || '');
      if (
        t.includes('0 pedido') ||
        t.includes('pedidos: —') ||
        t.includes('pedidos: -') ||
        t.includes('motorista: —') ||
        t.includes('motorista: -')
      ) {
        card.remove();
      }
    });
  }

  function renderCreated(){
    const el = document.getElementById('saiu-rotas-list');
    if (!el) return;

    limparRotasInvalidasLocais();

    const list = allRoutes().filter(routeBelongsDay);

    if (!list.length) {
      el.innerHTML = `<div class="vesco-empty">Nenhuma rota criada ou ativa para ${brDate(selectedISO())}.</div>`;
      return;
    }

    el.innerHTML = list.map(routeHtml).join('');
    killInvalidLegacyCards();
  }

  function findArrayDeep(obj){
    if (Array.isArray(obj)) return obj;
    if (!obj || typeof obj !== 'object') return null;

    const preferred = ['rotas', 'data', 'rows', 'items', 'RotaMotorista', 'rotasMotorista'];

    for (const k of preferred) {
      if (Array.isArray(obj[k])) return obj[k];
      if (obj[k] && typeof obj[k] === 'object') {
        const x = findArrayDeep(obj[k]);
        if (x) return x;
      }
    }

    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const x = findArrayDeep(obj[k]);
      if (x) return x;
    }

    return null;
  }

  async function loadRemoteRoutes(force = false){
    if (remoteLoading) return remoteRoutes;
    if (!force && Date.now() - remoteLoadedAt < 45000) return remoteRoutes;

    remoteLoading = true;

    const actions = [
      'listarRotasMotorista',
      'rotasMotorista',
      'getRotasMotorista',
      'listRotaMotorista',
      'rotas',
      'listarRotas',
      'getRotas',
      'listRotas'
    ];

    let found = [];

    for (const action of actions) {
      try {
        const res = await A().callERP({
          action,
          data: brDate(selectedISO()),
          dataISO: selectedISO(),
          date: selectedISO()
        });

        const arr = res && res.response ? findArrayDeep(res.response) : null;

        if (Array.isArray(arr) && arr.length) {
          const clean = sanitizeList(arr, true);
          if (clean.length) {
            found = clean;
            break;
          }
        }
      } catch(e) {}
    }

    remoteRoutes = found;
    remoteLoadedAt = Date.now();
    remoteLoading = false;

    try {
      writeJSON(CFG.ROUTES_REMOTE_CACHE_KEY || 'vesco_routes_remote_cache_v2', remoteRoutes);
    } catch(e) {}

    renderCreated();

    return remoteRoutes;
  }

  function bindButton(){
    const btn = document.getElementById('btnCriarRota');

    if (btn && !btn.__vescoRotasBoundV32) {
      btn.__vescoRotasBoundV32 = true;
      btn.textContent = 'Montar rota selecionada';
      btn.onclick = createRoute;
      btn.addEventListener('click', createRoute, true);
    }

    const add = document.getElementById('vesco-route-manual-add');

    if (add && !add.__vescoManualBoundV32) {
      add.__vescoManualBoundV32 = true;
      add.addEventListener('click', addManual, true);
    }

    const input = document.getElementById('vesco-route-manual-input');

    if (input && !input.__vescoManualEnterV32) {
      input.__vescoManualEnterV32 = true;
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addManual();
        }
      });
    }
  }

  function render(){
    limparRotasInvalidasLocais();
    renderAvailable();
    renderSelected();
    renderCreated();
    bindButton();
    setTimeout(() => loadRemoteRoutes(false), 120);
  }

  async function createRoute(e){
    if (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    const ids = Array.from(selected);

    if (!ids.length) return alert('Selecione ao menos um pedido para montar a rota.');

    const motorista = txt(document.getElementById('rotaMotorista')?.value);
    if (!motorista) return alert('Informe o motorista.');

    const nome = txt(document.getElementById('rotaNome')?.value) || `Rota ${new Date().toLocaleString('pt-BR')}`;
    const origem = txt(document.getElementById('vesco-rota-origem-v6')?.value || document.getElementById('rotaOrigem')?.value || 'Rua São Leopoldo 92');

    const valid = ids
      .map(id => S().findOrder(id))
      .filter(o => o && S().hasAddress(o))
      .map(o => S().getNumber(o) || S().getKey(o));

    if (!valid.length) return alert('Nenhum pedido selecionado tem endereço válido.');

    const r = {
      id: 'rota-' + Date.now(),
      token: Math.random().toString(36).slice(2, 10).toUpperCase(),
      nome,
      motorista,
      origem,
      pedidos: Array.from(new Set(valid)),
      status: 'ativa',
      data_operacional: selectedISO(),
      criadoEm: new Date().toISOString()
    };

    const all = allRoutes().filter(x => String(x.id) !== String(r.id));
    all.push(r);
    saveRoutes(all);

    selected.clear();
    render();

    A().callERP({
      action: 'criarRotaMotorista',
      rota_id: r.id,
      token: r.token,
      nome_rota: r.nome,
      nome: r.nome,
      motorista: r.motorista,
      origem: r.origem,
      pedidos: JSON.stringify(r.pedidos),
      pedidos_json: JSON.stringify(r.pedidos),
      paradas: JSON.stringify(r.paradas || []),
      paradas_json: JSON.stringify(r.paradas || []),
      status: r.status,
      criado_em: r.criadoEm,
      data_operacional: r.data_operacional
    }).then(() => loadRemoteRoutes(true)).catch(() => {});

    for (const p of r.pedidos) {
      A().updateStatus(p, 'Despachado', `Saiu para entrega — Rota: ${r.nome} Motorista: ${r.motorista} Origem: ${r.origem}`);
    }

    try { if (typeof showToast === 'function') showToast(`Rota criada com ${r.pedidos.length} pedido(s).`, 'success'); } catch(e) {}
  }

  function handleChange(e){
    const cb = e.target && e.target.closest && e.target.closest('#saiu-pedidos-list input[type="checkbox"]');
    if (!cb) return;

    if (cb.checked) selected.add(cb.value);
    else selected.delete(cb.value);

    renderSelected();
    renderAvailable();
    bindButton();
  }

  function handleClick(e){
    const remove = e.target && e.target.closest && e.target.closest('[data-remove-route]');
    const del = e.target && e.target.closest && e.target.closest('[data-delete-route]');
    const start = e.target && e.target.closest && e.target.closest('[data-start-route]');
    const finish = e.target && e.target.closest && e.target.closest('[data-finish-route]');

    if (remove) {
      selected.delete(remove.dataset.removeRoute);
      render();
      return;
    }

    if (del || start || finish) {
      const id =
        (del && del.dataset.deleteRoute) ||
        (start && start.dataset.startRoute) ||
        (finish && finish.dataset.finishRoute);

      const list = localRoutes();
      const idx = list.findIndex(r => String(r.id) === String(id));

      if (idx >= 0) {
        if (del) list.splice(idx, 1);
        if (start) list[idx].status = 'despachada';
        if (finish) {
          list[idx].status = 'concluida';
          list[idx].concluidaEm = new Date().toISOString();
        }

        saveRoutes(list);
        renderCreated();
      }
    }
  }

  function wrapSwitch(){
    if (window.__vescoRotasSwitchWrappedV32 || typeof window.switchTab !== 'function') return;

    window.__vescoRotasSwitchWrappedV32 = true;

    const old = window.switchTab;

    window.switchTab = function(which){
      const res = old.apply(this, arguments);

      if (which === 'saiu' || which === 'rotas') {
        setTimeout(() => {
          render();
          loadRemoteRoutes(true);
        }, 150);
      }

      return res;
    };

    try { switchTab = window.switchTab; } catch(e) {}
  }

  function isRouteTabActive(){
    const active = norm(document.querySelector('.tab-btn.active,button.active,a.active')?.textContent || '');
    return active.includes('pronto') || active.includes('rota');
  }

  function init(){
    limparRotasInvalidasLocais();

    document.addEventListener('change', handleChange, true);
    document.addEventListener('click', handleClick, true);

    wrapSwitch();

    // Sobrescreve o render antigo do app.js.
    window.renderRotas = render;
    window.renderRotasCriadas = renderCreated;

    try { renderRotas = window.renderRotas; } catch(e) {}

    window.addEventListener('vesco:rendered', () => setTimeout(render, 200));
    window.addEventListener('vesco:loaded', () => setTimeout(render, 700));

    setTimeout(() => {
      render();
      loadRemoteRoutes(true);
    }, 600);

    setInterval(() => {
      if (isRouteTabActive()) {
        limparRotasInvalidasLocais();
        renderCreated();
        killInvalidLegacyCards();
      }
    }, 900);
  }

  window.VescoRotasModular = {
    init,
    render,
    renderCreated,
    createRoute,
    selected,
    eligible,
    routes: allRoutes,
    localRoutes,
    loadRemoteRoutes,
    remoteRoutes: () => remoteRoutes,
    limparRotasInvalidasLocais,
    sanitizeList,
    routeBelongsDay,
    debug(){
      return {
        selectedDate: selectedISO(),
        local: localRoutes(),
        remote: remoteRoutes,
        displayed: allRoutes().filter(routeBelongsDay),
        storageKeys: storageKeys(),
        saiuRotas: window.saiuRotas || []
      };
    }
  };

  init();

  console.log('modulo.rotas V3.2 ativo — rotas da planilha por data, sem rotas vazias.');
})();
