// modulo.logistica.js — V3.2: Logística só com pedidos a entregar e sem coluna Limite Alarme.
(function(){
  // Sobrescreve com segurança a versão anterior do módulo.
  const S = () => window.VescoState;
  const A = () => window.VescoAPI;

  function txt(v){ return S() && S().txt ? S().txt(v) : (v == null ? '' : String(v).trim()); }
  function norm(v){ return S() && S().norm ? S().norm(v) : txt(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim(); }
  function esc(v){ return S() && S().esc ? S().esc(v) : txt(v).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  function selectedISO(){
    try { return S().selectedDateISO(); } catch(e) {}
    const el = document.getElementById('topCalendar') || document.querySelector('input[type="date"]');
    if (el && el.value) return el.value;
    return new Date().toISOString().slice(0, 10);
  }

  function dateBR(v){
    try { return S().dateBR(v); } catch(e) {}
    const s = txt(v);
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    return s || '—';
  }

  function parseDateISO(v){
    try { return S().parseDateISO(v); } catch(e) {}
    const s = txt(v);
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const br = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (br) {
      const y = br[3].length === 2 ? '20' + br[3] : br[3];
      return `${y}-${String(br[2]).padStart(2,'0')}-${String(br[1]).padStart(2,'0')}`;
    }
    return '';
  }

  function orderDate(o){
    const candidates = [
      o && o.data_prevista,
      o && o.data_previsao,
      o && o.previsao,
      o && o.data_pedido,
      o && o.data,
      o && o.created_at,
      o && o.criado_em
    ].map(txt).filter(Boolean);

    return candidates[0] || '';
  }

  function belongsDate(o){
    // Se o legado tiver regra própria, respeita. Caso contrário, usa a data do pedido.
    try {
      if (typeof shouldShowLogisticForOperationalDate === 'function') {
        return !!shouldShowLogisticForOperationalDate(o);
      }
    } catch(e) {}

    const iso = parseDateISO(orderDate(o));
    if (!iso) return true; // não some pedido sem data confiável, mas não inventa coluna de alarme.
    return iso === selectedISO();
  }

  function isFlex(o){
    const f = norm([
      o && o.nomeformafenvio,
      o && o.nome_forma_envio,
      o && o.forma_envio,
      o && o.forma_envio_nome,
      o && o.transportadora,
      o && o.tipo_entrega
    ].map(txt).filter(Boolean).join(' | '));

    return f.includes('mercado envios flex') || f.includes('flex');
  }

  function isReallyDelivered(o){
    if (!o) return false;

    // status_logistica entregue = sai da logística.
    try { if (S().isDelivered(o)) return true; } catch(e) {}

    const s = norm(o.status_logistica || o.status || o.situacao || o.situacao_nome || '');

    if (s.includes('pendente de entrega')) return false;
    if (s === 'entregue' || s === 'finalizado' || s === 'concluido' || s.includes('concluida')) return true;

    return false;
  }

  function shouldShow(order){
    if (!order) return false;
    if (isReallyDelivered(order)) return false;
    if (isFlex(order)) return false;
    try { if (S().isRetirada(order)) return false; } catch(e) {}
    try { if (!S().hasAddress(order)) return false; } catch(e) {}
    try { if (S().isASeparar(order)) return false; } catch(e) {}
    if (!belongsDate(order)) return false;

    // Logística é só depois de separado/pronto/despachado.
    const st = norm(order.status_logistica || order.status || order.situacao_nome || order.situacao || '');
    if (!st) return true;

    return (
      st.includes('separado') ||
      st.includes('pronto') ||
      st.includes('despachado') ||
      st.includes('pendente de entrega') ||
      st.includes('lancado na plataforma') ||
      st.includes('lançado na plataforma')
    );
  }

  function getOrders(){
    try { return S().orders(); } catch(e) {}
    return Array.isArray(window.orders) ? window.orders : [];
  }

  function filtered(){
    const q = norm(document.getElementById('search')?.value || '');

    return getOrders()
      .filter(shouldShow)
      .filter((o, idx, arr) => arr.findIndex(x => String(S().getKey(x)) === String(S().getKey(o))) === idx)
      .filter(o => {
        if (!q) return true;
        const hay = norm([
          S().getNumber(o),
          S().getKey(o),
          o.cliente_nome,
          o.destinatario,
          o.cliente,
          S().getAddress(o),
          o.numero_ecommerce,
          o.ecom
        ].join(' | '));
        return hay.includes(q);
      });
  }

  function fixHeader(){
    const table = document.getElementById('table-logistica')?.closest('table');
    if (!table) return;

    const thead = table.querySelector('thead');
    if (!thead) return;

    thead.innerHTML = `
      <tr class="text-white font-bold text-xs bg-slate-800 border-b border-slate-700 uppercase">
        <th class="p-3 pl-4">Pedido #</th>
        <th class="p-3 text-center">Data do pedido</th>
        <th class="p-3">Destinatário / Cliente</th>
        <th class="p-3 hidden md:table-cell">Status entrega</th>
        <th class="p-3 hidden md:table-cell">Forma pag.</th>
        <th class="p-3 pr-4 text-right">Ação</th>
      </tr>
    `;
  }

  function obsLink(order){
    try {
      const data = A() && A().getObsCached ? A().getObsCached(order, S().getKey(order)) : S().parseObsLink(order);
      if (!data || (!data.obs && !data.link)) return '';
      return `
        <div class="vesco-obslink-box">
          ${data.obs ? `<span class="vesco-obs-pill"><b>Obs:</b> ${esc(data.obs)}</span>` : ''}
          ${data.link ? `<a class="vesco-link-pill" href="${esc(data.link)}" target="_blank" rel="noopener noreferrer">Abrir link do pedido</a>` : ''}
        </div>
      `;
    } catch(e) {
      return '';
    }
  }

  function row(o, idx){
    const id = S().getKey(o);
    const numero = S().getNumber(o) || id;
    const data = dateBR(orderDate(o));
    const endereco = S().getAddress(o);
    const status = txt(o.status_logistica || o.status || o.situacao_nome || o.situacao || 'Separado pendente de entrega');
    const pagamento = txt(o.forma_pagamento || o.instrucao_entrega || o.condicao_acerto || '—');

    return `
      <tr id="log-row-${esc(id)}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm border-b border-slate-100">
        <td class="p-3 pl-4 font-bold text-slate-900">#${esc(numero)}</td>
        <td class="p-3 text-center font-mono text-[#004f9f] font-bold">${esc(data)}</td>
        <td class="p-3">
          <div class="font-semibold">${esc(o.cliente_nome || o.destinatario || o.cliente || '—')}</div>
          <div class="text-[11px] text-slate-500 mt-1 truncate hidden lg:block">${esc(endereco)}</div>
          ${obsLink(o)}
        </td>
        <td class="p-3 hidden md:table-cell">${esc(status)}</td>
        <td class="p-3 hidden md:table-cell align-middle text-xs">
          <span class="px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-[11px]">${esc(pagamento)}</span>
        </td>
        <td class="p-3 pr-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <button class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px]" onclick="focusOrderOnMap('${esc(numero)}')"><i class="fas fa-crosshairs mr-1"></i>Localizar</button>
            <button class="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px]" onclick="updateStatusJsonp('${esc(id)}','Pronto p/ Entrega')">Concluir</button>
          </div>
        </td>
      </tr>
    `;
  }

  function render(){
    const tbody = document.getElementById('table-logistica');
    if (!tbody) return;

    fixHeader();

    const list = filtered();

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido a entregar para ${dateBR(selectedISO())}.</td></tr>`;
      updateSummary(list.length);
      return;
    }

    tbody.innerHTML = list.map(row).join('');
    updateSummary(list.length);

    try { if (window.VescoObsLink) window.VescoObsLink.apply(); } catch(e) {}
  }

  function updateSummary(total){
    const el = document.getElementById('sum-total');
    if (el) el.textContent = String(total);
  }

  function apply(){ render(); }

  function wrapSwitch(){
    if (window.__vescoLogisticaSwitchWrappedV32 || typeof window.switchTab !== 'function') return;

    window.__vescoLogisticaSwitchWrappedV32 = true;
    const old = window.switchTab;

    window.switchTab = function(which){
      const res = old.apply(this, arguments);
      if (which === 'logistica') setTimeout(render, 120);
      return res;
    };

    try { switchTab = window.switchTab; } catch(e) {}
  }

  function init(){
    wrapSwitch();

    window.addEventListener('vesco:rendered', () => setTimeout(render, 220));
    window.addEventListener('vesco:loaded', () => setTimeout(render, 800));
    window.addEventListener('vesco:obs-link-saved', () => setTimeout(render, 120));

    const search = document.getElementById('search');
    if (search && !search.__vescoLogisticaSearchV32) {
      search.__vescoLogisticaSearchV32 = true;
      search.addEventListener('input', () => setTimeout(render, 80));
    }

    setInterval(() => {
      const active = norm(document.querySelector('.tab-btn.active,button.active,a.active')?.textContent || '');
      if (active.includes('logistica') || active.includes('logística')) render();
    }, 1500);

    setTimeout(render, 900);
  }

  window.VescoLogisticaModular = { init, apply, render, shouldShow, filtered, fixHeader };

  init();

  console.log('modulo.logistica V3.2 ativo — sem Limite Alarme e somente pedidos a entregar.');
})();
