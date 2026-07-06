// modulo.obslink.js — Observação e link do pedido, com editor e exibição abaixo do pedido.
(function(){
  if (window.VescoObsLink && window.VescoObsLink.__v3) return;

  const S = () => window.VescoState;
  const A = () => window.VescoAPI;

  function getIdFromRow(row){
    if (!row) return '';
    let id = row.dataset.pedido || row.dataset.num || row.getAttribute('data-pedido') || row.getAttribute('data-num') || '';
    if (id) return id;
    const text = row.innerText || '';
    const m = text.match(/#\s*([0-9A-Za-z._-]{4,})/) || text.match(/\b(\d{5,})\b/);
    return m ? m[1] : '';
  }

  function candidateRows(root){
    return Array.from(root.querySelectorAll([
      '#table-fila tr',
      '#table-pendencias tr',
      '#table-separados-hoje tr',
      '#table-logistica tr',
      '#table-envios-flex-corpo tr',
      '#retiradas-list-modular .vesco-retirada-card',
      '[data-pedido]',
      '[data-num]'
    ].join(','))).filter(row => {
      if (!row || row.querySelector('th')) return false;
      const t = S().norm(row.innerText || '');
      if (!t || t.includes('nenhum registro') || t.includes('nenhum pedido')) return false;
      return !!getIdFromRow(row);
    });
  }

  function findRow(order){
    const keys = S().keys(order);
    const roots = [
      document.getElementById('view-separacao'),
      document.getElementById('view-retiradas'),
      document.getElementById('view-logistica'),
      document.getElementById('view-envios_flex'),
      document.getElementById('view-saiu'),
      document.body
    ].filter(Boolean);

    for (const root of roots) {
      const nodes = candidateRows(root);
      for (const n of nodes) {
        const t = n.innerText || '';
        if (keys.some(k => k && t.includes(k))) return n;
      }
    }

    return null;
  }

  function findPedidoCell(row, order){
    if (!row) return null;
    const keys = order ? S().keys(order) : [getIdFromRow(row)];
    const cells = Array.from(row.querySelectorAll('td, .vesco-retirada-info, .min-w-0'));

    for (const c of cells) {
      const t = c.innerText || '';
      if (keys.some(k => k && t.includes(k))) return c;
    }

    return row.querySelector('td:nth-child(2), td:nth-child(3), .vesco-retirada-info, .min-w-0') || row;
  }

  function getObsLink(order, id){
    return A().getObsCached(order, id || (order && S().getKey(order)));
  }

  function ensureEditorForRow(row){
    if (!row || row.querySelector('.vesco-obslink-editor')) return;

    const id = getIdFromRow(row);
    if (!id) return;

    const order = S().findOrder(id);
    const cell = findPedidoCell(row, order);
    if (!cell) return;

    const data = getObsLink(order, id);
    const editor = document.createElement('div');
    editor.className = 'vesco-obslink-editor';
    editor.dataset.pedido = id;
    editor.innerHTML = `
      <input class="vesco-obslink-input" id="vesco-obs-v16-${S().esc(id)}" placeholder="Observação do pedido" value="${S().esc(data.obs || '')}">
      <input class="vesco-obslink-input" id="vesco-link-v16-${S().esc(id)}" placeholder="Link do pedido" value="${S().esc(data.link || '')}">
      <button type="button" class="vesco-obslink-save" data-save-obslink="${S().esc(id)}">Salvar obs/link</button>
    `;

    cell.appendChild(editor);
  }

  function ensureEditors(){
    const roots = [document.getElementById('view-separacao')].filter(Boolean);
    roots.forEach(root => {
      // Na Fila Ativa os campos sempre precisam existir.
      root.querySelectorAll('#table-fila tr').forEach(ensureEditorForRow);

      // Nas pendências, só cria se o fluxo antigo não criou campos.
      root.querySelectorAll('#table-pendencias tr').forEach(row => {
        if (!row.querySelector('input[id^="solucao-"], input[id^="link-"], textarea[id^="solucao-"], textarea[id^="link-"]')) {
          ensureEditorForRow(row);
        }
      });
    });
  }

  function hydrateInputs(){
    S().allOrders().forEach(order => {
      const id = S().getKey(order);
      const data = getObsLink(order, id);
      if (!data.obs && !data.link) return;

      S().keys(order).forEach(k => {
        ['vesco-obs-v16-', 'solucao-'].forEach(prefix => {
          const el = document.getElementById(prefix + k);
          if (el && !S().txt(el.value)) el.value = data.obs;
        });
        ['vesco-link-v16-', 'link-'].forEach(prefix => {
          const el = document.getElementById(prefix + k);
          if (el && !S().txt(el.value)) el.value = data.link;
        });
      });
    });
  }

  function renderBadges(){
    // Remove badges antigos que caíram no botão "Fila Ativa" ou subabas.
    document.querySelectorAll('#sub-fila .vesco-obslink-box, #sub-pend .vesco-obslink-box, .tab-btn .vesco-obslink-box').forEach(el => el.remove());

    S().allOrders().forEach(order => {
      const id = S().getKey(order);
      const data = getObsLink(order, id);
      if (!data.obs && !data.link) return;

      const row = findRow(order);
      if (!row) return;

      let box = row.querySelector('.vesco-obslink-box');
      if (!box) {
        box = document.createElement('div');
        box.className = 'vesco-obslink-box';
        const target = findPedidoCell(row, order);
        target.appendChild(box);
      }

      box.innerHTML = `
        ${data.obs ? `<span class="vesco-obs-pill"><b>Obs:</b> ${S().esc(data.obs)}</span>` : ''}
        ${data.link ? `<a class="vesco-link-pill" href="${S().esc(data.link)}" target="_blank" rel="noopener noreferrer">Abrir link do pedido</a>` : ''}
      `;
    });
  }

  async function save(id, obs, link, opts = {}){
    if (opts.requireObs && !S().txt(obs)) return alert('Informe a observação/solução antes de salvar.');
    if (opts.requireLink && !S().txt(link)) return alert('Cole o link do pedido antes de salvar.');

    const order = S().findOrder(id);
    if (order) {
      order.observacao_pedido = S().txt(obs);
      order.link_pedido = S().txt(link);
    }

    A().saveObsCache(order, id, obs, link);
    hydrateInputs();
    renderBadges();

    const result = await A().saveObsLink(id, obs, link, opts);
    if (result.ok) {
      try { if (typeof showToast === 'function') showToast('Observação e link salvos.', 'success'); } catch(e) {}
    } else {
      try { if (typeof showToast === 'function') showToast('Salvo na tela. Verifique se o Apps Script confirmou a gravação.', 'warning'); } catch(e) {}
      console.warn('VescoObsLink save sem confirmação:', result);
    }

    setTimeout(() => { ensureEditors(); hydrateInputs(); renderBadges(); }, 250);
    return result;
  }

  function readFormNear(btn){
    const row = btn.closest('tr, .vesco-retirada-card, .pedido-card, [data-pedido], [data-num]') || document;
    const text = row.innerText || '';
    let id = btn.dataset.saveObslink || btn.dataset.id || btn.dataset.pedido || row.dataset.pedido || row.dataset.num || '';
    if (!id) {
      const m = text.match(/#\s*([0-9A-Za-z._-]{4,})/) || text.match(/\b(\d{5,})\b/);
      if (m) id = m[1];
    }

    const obsEl =
      row.querySelector('textarea[id^="vesco-obs-v16-"], textarea[id^="solucao-"], input[id^="vesco-obs-v16-"], input[id^="solucao-"]') ||
      document.getElementById('vesco-obs-v16-' + id) ||
      document.getElementById('solucao-' + id);

    const linkEl =
      row.querySelector('input[id^="vesco-link-v16-"], input[id^="link-"], textarea[id^="vesco-link-v16-"], textarea[id^="link-"]') ||
      document.getElementById('vesco-link-v16-' + id) ||
      document.getElementById('link-' + id);

    return { id, obs: obsEl ? obsEl.value : '', link: linkEl ? linkEl.value : '' };
  }

  function intercept(e){
    const btn = e.target && e.target.closest && e.target.closest('button, a');
    if (!btn) return;
    const t = S().norm(btn.textContent || btn.value || '');
    const explicit = !!btn.dataset.saveObslink;
    if (!explicit && !t.includes('salvar obs') && !t.includes('salvar solucao') && !t.includes('salvar solução')) return;

    const form = readFormNear(btn);
    if (!form.id) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();

    save(form.id, form.obs, form.link, {
      status: t.includes('solucao') || t.includes('solução') ? 'Pendente' : undefined,
      requireObs: t.includes('solucao') || t.includes('solução'),
      requireLink: t.includes('solucao') || t.includes('solução')
    });
  }

  window.salvarExtrasPedidoV16 = function(id){
    const order = S().findOrder(id);
    const keys = order ? S().keys(order) : [id];
    let obs = '', link = '';
    for (const k of keys) {
      const o = document.getElementById('vesco-obs-v16-' + k) || document.getElementById('solucao-' + k);
      const l = document.getElementById('vesco-link-v16-' + k) || document.getElementById('link-' + k);
      if (o && !obs) obs = o.value;
      if (l && !link) link = l.value;
    }
    return save(id, obs, link);
  };

  window.salvarSolucaoPendencia = function(id){
    const order = S().findOrder(id);
    const keys = order ? S().keys(order) : [id];
    let obs = '', link = '';
    for (const k of keys) {
      const o = document.getElementById('solucao-' + k) || document.getElementById('vesco-obs-v16-' + k);
      const l = document.getElementById('link-' + k) || document.getElementById('vesco-link-v16-' + k);
      if (o && !obs) obs = o.value;
      if (l && !link) link = l.value;
    }
    return save(id, obs, link, { status:'Pendente', requireObs:true, requireLink:true });
  };

  function apply(){
    ensureEditors();
    hydrateInputs();
    renderBadges();
  }

  function init(){
    document.addEventListener('click', intercept, true);
    window.addEventListener('vesco:rendered', () => setTimeout(apply, 220));
    window.addEventListener('vesco:loaded', () => setTimeout(apply, 700));
    window.addEventListener('vesco:obs-link-saved', () => setTimeout(apply, 100));
    setInterval(apply, 1800);
    setTimeout(apply, 800);
  }

  window.VescoObsLink = { __v3:true, init, apply, save, ensureEditors, hydrateInputs, renderBadges, getObsLink, findRow };
  init();
  console.log('modulo.obslink V3 ativo');
})();
