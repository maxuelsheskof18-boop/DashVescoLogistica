// motorista.js — App isolado para motorista externo
// Carrega somente pedidos da rota/token e permite confirmar entrega.
(function(){
  const API = window.VESCO_API_URL || 'https://script.google.com/macros/s/AKfycbxEzbxBABMDwi7B7tn_1p-lC0vc50JjHFOrH3w42Oog2-5R2-WMYSrQ27ED7wduJUN6/exec';
  const params = new URLSearchParams(location.search);
  const rotaId = params.get('rota') || params.get('route') || '';
  const token = params.get('token') || '';
  let state = { rota:null, pedidos:[] };

  function $(id){ return document.getElementById(id); }
  function escapeHtml(v){ return String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function onlyDigits(v){ return String(v||'').replace(/\D/g,''); }
  function setStatus(txt){ const el = $('statusPill'); if(el) el.textContent = txt; }
  function toast(msg, ms=3000){ const el=$('toast'); if(!el) { alert(msg); return; } el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'), ms); }

  function jsonp(action, data={}){
    return new Promise((resolve,reject)=>{
      const cb = '__vesco_motorista_cb_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const qs = new URLSearchParams({ action, callback: cb, ...data });
      const timer = setTimeout(()=>{ cleanup(); reject(new Error('Tempo excedido na comunicação.')); }, 20000);
      function cleanup(){ clearTimeout(timer); try{ delete window[cb]; }catch(e){} if(script.parentNode) script.remove(); }
      window[cb] = function(resp){ cleanup(); resolve(resp); };
      script.onerror = function(){ cleanup(); reject(new Error('Falha ao acessar servidor.')); };
      script.src = API + (API.includes('?') ? '&' : '?') + qs.toString();
      document.head.appendChild(script);
    });
  }

  function mapsUrl(addr){ return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr || ''); }

  function renderHeader(){
    const el = $('routeCard');
    const rota = state.rota || {};
    const total = state.pedidos.length;
    const entregues = state.pedidos.filter(p => isDelivered(p)).length;
    const pendentes = total - entregues;
    el.innerHTML = `
      <div class="route-title">
        <div>
          <h1>${escapeHtml(rota.nome || 'Rota do motorista')}</h1>
          <div class="sub">Motorista: ${escapeHtml(rota.motorista || '—')} ${rota.origem ? ' • Partida: ' + escapeHtml(rota.origem) : ''}</div>
        </div>
        <span class="badge">${escapeHtml(rotaId)}</span>
      </div>
      <div class="stats">
        <div class="stat"><b>${total}</b><span>Total</span></div>
        <div class="stat"><b>${pendentes}</b><span>Pendentes</span></div>
        <div class="stat"><b>${entregues}</b><span>Entregues</span></div>
      </div>`;
    setStatus(pendentes ? `${pendentes} pendente(s)` : 'Finalizada');
  }

  function isDelivered(p){
    const st = String(p.status_logistica || p.situacao_nome || p.status || '').toLowerCase();
    return st.includes('entregue') || st.includes('finalizado') || !!p.entregue_em || !!p.data_entrega_realizada;
  }

  function renderOrders(){
    const root = $('ordersList');
    if(!state.pedidos.length){
      root.innerHTML = `<div class="card empty">Nenhum pedido disponível nesta rota.</div>`;
      return;
    }
    root.innerHTML = state.pedidos.map((p, idx)=>{
      const delivered = isDelivered(p);
      const id = p.id || p.pedido_key || p.numero || '';
      const numero = p.numero || id;
      const addr = p.endereco_completo || p.endereco || '';
      return `
      <article class="order" id="pedido-${escapeHtml(String(id))}">
        <div class="order-head">
          <div>
            <div class="order-num">#${escapeHtml(numero)}</div>
            <div class="sub">Parada ${idx+1} de ${state.pedidos.length}</div>
          </div>
          <span class="badge ${delivered ? 'ok' : ''}">${delivered ? 'Entregue' : 'Pendente'}</span>
        </div>
        <div class="order-body">
          <div><div class="label">Cliente / destinatário</div><div class="value">${escapeHtml(p.cliente_nome || p.destinatario || '—')}</div></div>
          <div><div class="label">Endereço</div><div class="value address">${escapeHtml(addr || 'Endereço não informado')}</div></div>
          ${p.instrucao_entrega ? `<div><div class="label">Instrução</div><div class="value">${escapeHtml(p.instrucao_entrega)}</div></div>` : ''}
          <div class="actions">
            ${addr ? `<a class="btn btn-light" target="_blank" href="${mapsUrl(addr)}">Abrir mapa</a>` : ''}
            <button class="btn btn-blue" ${delivered ? 'disabled' : ''} onclick="VescoMotorista.openForm('${escapeHtml(String(id))}')">Entregar</button>
          </div>
        </div>
        <form class="form" data-form-for="${escapeHtml(String(id))}" onsubmit="VescoMotorista.confirm(event, '${escapeHtml(String(id))}')">
          <div class="grid">
            <div class="field"><label class="label">Nome de quem recebeu</label><input name="recebedor" required placeholder="Ex: João Silva" /></div>
            <div class="field"><label class="label">Documento RG/CPF</label><input name="documento" required inputmode="numeric" placeholder="Somente números" /></div>
          </div>
          <div class="grid" style="margin-top:10px">
            <div class="field"><label class="label">Transportador</label><select name="transportador"><option>Frota Interna Vesco</option><option>Lalamove</option><option>Loggi</option><option>Motorista Terceirizado</option><option>Retirada no local</option></select></div>
            <div class="field"><label class="label">Observação opcional</label><input name="observacao" placeholder="Ex: portaria, vizinho, recepção..." /></div>
          </div>
          <div class="actions" style="margin-top:12px">
            <button class="btn btn-green" type="submit">Confirmar entrega</button>
            <button class="btn btn-light" type="button" onclick="VescoMotorista.closeForm('${escapeHtml(String(id))}')">Cancelar</button>
          </div>
        </form>
      </article>`;
    }).join('');
  }

  async function load(){
    if(!rotaId || !token){
      $('routeCard').innerHTML = `<div class="error">Link inválido. Solicite um novo link para a equipe Vesco.</div>`;
      setStatus('Link inválido');
      return;
    }
    try{
      setStatus('Carregando');
      const resp = await jsonp('motoristaPedidos', { rota: rotaId, token });
      if(!resp || !resp.success) throw new Error(resp && resp.error ? resp.error : 'Rota não encontrada ou token inválido.');
      state.rota = resp.rota || {};
      state.pedidos = resp.pedidos || [];
      renderHeader(); renderOrders();
    } catch(e){
      $('routeCard').innerHTML = `<div class="error">${escapeHtml(e.message || e)}</div>`;
      $('ordersList').innerHTML = '';
      setStatus('Erro');
    }
  }

  window.VescoMotorista = {
    openForm(id){ document.querySelectorAll('.form.open').forEach(f => f.classList.remove('open')); const f=document.querySelector(`[data-form-for="${CSS.escape(id)}"]`); if(f){ f.classList.add('open'); f.scrollIntoView({behavior:'smooth',block:'center'}); } },
    closeForm(id){ const f=document.querySelector(`[data-form-for="${CSS.escape(id)}"]`); if(f) f.classList.remove('open'); },
    async confirm(ev, id){
      ev.preventDefault();
      const form = ev.currentTarget;
      const recebedor = form.recebedor.value.trim();
      const documento = form.documento.value.trim();
      const doc = onlyDigits(documento);
      if(!recebedor) return toast('Informe o nome de quem recebeu.');
      if(doc.length < 8 || doc.length > 14) return toast('Documento inválido. Digite RG ou CPF com 8 a 14 números.');
      const btn = form.querySelector('button[type="submit"]'); if(btn) btn.disabled = true;
      try{
        const resp = await jsonp('confirmarEntregaMotorista', { rota: rotaId, token, pedido: id, recebedor, documento, transportador: form.transportador.value, observacao: form.observacao.value.trim() });
        if(!resp || !resp.success) throw new Error(resp && resp.error ? resp.error : 'Não foi possível confirmar.');
        toast('Entrega confirmada com sucesso.');
        const p = state.pedidos.find(x => String(x.id || x.pedido_key || x.numero) === String(id));
        if(p){ p.status_logistica='Entregue'; p.nome_recebedor=recebedor; p.doc_recebedor=documento; p.entregue_em=new Date().toISOString(); }
        renderHeader(); renderOrders();
      } catch(e){ toast(e.message || String(e), 4500); if(btn) btn.disabled = false; }
    },
    reload: load,
    debug(){ return { rotaId, token: token ? 'ok' : '', state }; }
  };
  load();
})();