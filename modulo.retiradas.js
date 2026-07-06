// modulo.retiradas.js — Página Retiradas única, independente e estável.
(function(){
  if (window.VescoRetiradas) return;

  const S = () => window.VescoState;
  const A = () => window.VescoAPI;

  const KEEP_TAB_ID = 'main-retiradas';

  function dedupeLegacy(){
    // Remove botões antigos criados por camadas V16/V18/V19 e mantém somente #main-retiradas.
    document.querySelectorAll('[id^="main-retiradas"]').forEach(btn => {
      if (btn.id !== KEEP_TAB_ID) btn.remove();
    });

    // Se por algum motivo existir mais de um #main-retiradas, mantém o primeiro.
    const tabs = Array.from(document.querySelectorAll('#main-retiradas'));
    tabs.slice(1).forEach(el => el.remove());

    // Remove views antigas de retirada para não competir com a modular.
    document.querySelectorAll('#view-retiradas-v16, #view-retiradas-v18, #view-retiradas-v19, #view-retiradas_legacy').forEach(v => {
      v.classList.add('hidden');
      v.setAttribute('data-vesco-disabled', 'true');
      v.style.display = 'none';
    });

    // Remove badges antigos que entravam em botões internos.
    document.querySelectorAll('.vesco-v51-retirada-badge, .vesco-v53-retirada-badge, .vesco-v54-retirada-badge, .vesco-v55-retirada-badge').forEach(b => b.remove());
  }

  function ensureProntoIcon(){
    const btn = document.getElementById('main-saiu');
    if (!btn) return;
    const hasIcon = !!btn.querySelector('i');
    if (!hasIcon) {
      btn.innerHTML = '<i class="fas fa-truck text-blue-500"></i> Pronto para Envio';
    }
  }

  function ensureTab(){
    dedupeLegacy();
    ensureProntoIcon();

    let btn = document.getElementById(KEEP_TAB_ID);
    const tabsWrap = document.querySelector('.tab-nav .flex') || document.querySelector('.tab-nav') || document.body;

    if (!btn) {
      btn = document.createElement('button');
      btn.id = KEEP_TAB_ID;
      btn.className = 'tab-btn';
      btn.setAttribute('onclick', "switchTab('retiradas')");
      btn.innerHTML = '<i class="fas fa-store text-purple-500"></i>Retiradas <span id="retiradas-count" class="vesco-count-badge hidden">00</span>';
      const after = document.getElementById('main-saiu') || document.getElementById('main-log');
      if (after && after.parentNode) after.parentNode.insertBefore(btn, after.nextSibling);
      else tabsWrap.appendChild(btn);
    }

    if (!btn.querySelector('i')) {
      btn.insertAdjacentHTML('afterbegin', '<i class="fas fa-store text-purple-500"></i>');
    }

    let badge = document.getElementById('retiradas-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'retiradas-count';
      badge.className = 'vesco-count-badge hidden';
      badge.textContent = '00';
      btn.appendChild(badge);
    }

    return btn;
  }

  function ensureView(){
    let view = document.getElementById('view-retiradas');
    if (!view) {
      view = document.createElement('section');
      view.id = 'view-retiradas';
      view.className = 'hidden w-full p-3 md:p-6 max-w-[1800px] mx-auto';
      const main = document.querySelector('main') || document.body;
      main.insertBefore(view, main.firstChild || null);
    }
    return view;
  }

  function eligible(){
    return S().orders()
      .filter(o => !S().isDelivered(o))
      .filter(o => !S().isASeparar(o))
      .filter(o => S().isRetirada(o) || !S().hasAddress(o))
      .filter((o, idx, arr) => arr.findIndex(x => S().getKey(x) === S().getKey(o)) === idx);
  }

  function updateBadge(qtd){
    ensureTab();
    const badge = document.getElementById('retiradas-count');
    if (!badge) return;

    if (!qtd) {
      badge.classList.add('hidden');
      badge.textContent = '00';
    } else {
      badge.classList.remove('hidden');
      badge.textContent = String(qtd).padStart(2, '0');
    }
  }

  function card(o){
    const id = S().getKey(o);
    const num = S().getNumber(o) || id;
    const obs = A().getObsCached(o, id);
    const tipo = S().isRetirada(o) ? 'Retirada' : 'Sem endereço';
    const address = S().hasAddress(o) ? S().getAddress(o) : 'Endereço não disponível';

    return `
      <div class="vesco-retirada-card" data-pedido="${S().esc(id)}">
        <div class="vesco-retirada-info">
          <div class="vesco-retirada-title">#${S().esc(num)} — ${S().esc(o.cliente_nome || o.destinatario || o.cliente || o.nome || 'Cliente não informado')}</div>
          <div class="vesco-retirada-sub">${S().esc(address)}</div>
          <div class="vesco-retirada-tags">
            <span>${S().esc(tipo)} • ${S().dateBR(S().getOrderDate(o))}</span>
            <span>${S().esc(S().getStatus(o) || 'Separado')}</span>
            ${!S().hasAddress(o) ? '<span>Sem rota</span>' : ''}
          </div>
          ${(obs.obs || obs.link) ? `
            <div class="vesco-retirada-obs">
              ${obs.obs ? `<span><b>Obs:</b> ${S().esc(obs.obs)}</span>` : ''}
              ${obs.link ? `<a href="${S().esc(obs.link)}" target="_blank" rel="noopener noreferrer">Abrir link do pedido</a>` : ''}
            </div>
          ` : ''}
        </div>
        <div class="vesco-retirada-actions">
          <button type="button" class="vesco-btn green" data-entregar="${S().esc(id)}"><i class="fas fa-check"></i> Registrar retirada</button>
          <button type="button" class="vesco-btn amber" data-pendencia="${S().esc(id)}"><i class="fas fa-triangle-exclamation"></i> Pendência</button>
        </div>
      </div>
    `;
  }

  function render(){
    dedupeLegacy();
    const view = ensureView();
    const pedidos = eligible();
    updateBadge(pedidos.length);

    view.innerHTML = `
      <div class="card p-4 md:p-5">
        <div class="flex items-start justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
          <div>
            <h2 class="font-black text-slate-800 uppercase text-sm">Pedidos para retirada / sem rota</h2>
            <p class="text-xs text-slate-500 mt-1">Pedidos de retirada e pedidos sem endereço não entram em rota.</p>
          </div>
          <button class="bg-slate-900 text-white px-3 py-2 rounded-lg text-xs font-black" type="button" onclick="VescoRetiradas.render()">
            Atualizar retiradas
          </button>
        </div>
        <div id="retiradas-list-modular">
          ${pedidos.length ? pedidos.map(card).join('') : `<div class="vesco-empty">Nenhum pedido para retirada ou sem endereço.</div>`}
        </div>
      </div>
    `;

    try { if (window.VescoObsLink) setTimeout(() => window.VescoObsLink.apply(), 60); } catch(e) {}
  }

  function hideAllViewsExceptRetiradas(){
    const keep = document.getElementById('view-retiradas');
    document.querySelectorAll('main > section, body > #view-saiu, body > #view-retiradas').forEach(el => {
      if (el === keep) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
    document.querySelectorAll('#view-retiradas-v16, #view-retiradas-v18, #view-retiradas-v19').forEach(v => {
      v.classList.add('hidden');
      v.style.display = 'none';
    });
  }

  function setActive(which){
    dedupeLegacy();
    ensureTab();
    ensureView();

    const isRet = ['retiradas','retirada','retiradas_v16','retiradas_v18','retiradas_v19'].includes(String(which || ''));

    const view = document.getElementById('view-retiradas');
    const btn = document.getElementById(KEEP_TAB_ID);

    if (isRet) {
      hideAllViewsExceptRetiradas();
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      render();
    } else {
      if (view) view.classList.add('hidden');
      if (btn) btn.classList.remove('active');
    }
  }

  async function handleClick(e){
    const ent = e.target && e.target.closest && e.target.closest('[data-entregar]');
    const pen = e.target && e.target.closest && e.target.closest('[data-pendencia]');
    if (!ent && !pen) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();

    const id = ent ? ent.dataset.entregar : pen.dataset.pendencia;

    if (ent) {
      await A().updateStatus(id, 'Entregue', 'Retirada registrada no painel.');
      render();
      try { if (typeof load === 'function') load(); } catch(e) {}
    }

    if (pen) {
      const obs = prompt('Informe a pendência do pedido:');
      if (obs) {
        await A().updateStatus(id, 'Pendente', obs);
        render();
      }
    }
  }

  function wrapSwitch(){
    if (window.__vescoRetiradasSwitchWrappedV2 || typeof window.switchTab !== 'function') return;
    window.__vescoRetiradasSwitchWrappedV2 = true;
    const old = window.switchTab;

    window.switchTab = function(which){
      const isRet = ['retiradas','retirada','retiradas_v16','retiradas_v18','retiradas_v19'].includes(String(which || ''));
      if (isRet) {
        setActive('retiradas');
        return true;
      }

      const res = old.apply(this, arguments);
      setActive(which);
      return res;
    };

    try { switchTab = window.switchTab; } catch(e) {}
  }

  function init(){
    ensureTab();
    ensureView();
    wrapSwitch();

    window.renderRetiradas = render;
    window.renderRetiradasV16 = render;
    window.renderRetiradasV18 = render;
    window.renderRetiradasV19 = render;

    document.addEventListener('click', handleClick, true);

    window.addEventListener('vesco:rendered', () => setTimeout(() => { dedupeLegacy(); updateBadge(eligible().length); }, 200));
    window.addEventListener('vesco:loaded', () => setTimeout(() => { dedupeLegacy(); updateBadge(eligible().length); }, 700));

    setInterval(() => {
      dedupeLegacy();
      const active = S().norm(document.querySelector('.tab-btn.active, button.active, a.active')?.textContent || '');
      if (active.includes('retiradas')) render();
      else updateBadge(eligible().length);
    }, 1200);

    setTimeout(() => { dedupeLegacy(); updateBadge(eligible().length); }, 700);
  }

  window.VescoRetiradas = { init, render, eligible, updateBadge, dedupeLegacy, setActive };
  init();
  console.log('modulo.retiradas V2 ativo');
})();
