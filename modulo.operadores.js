// modulo.operadores.js — Registro local/visual de operador, início, fim e tempo de separação.
(function(){
  if (window.VescoOperadores) return;

  const KEY = 'vesco_operador_tempo_v3';
  const S = () => window.VescoState;

  function nowISO(){ return new Date().toISOString(); }
  function operator(){
    try { return (window.VescoLegacy && window.VescoLegacy.getOperator && window.VescoLegacy.getOperator()) || localStorage.getItem('vesco_operator') || window.currentOperator || ''; }
    catch(e){ return localStorage.getItem('vesco_operator') || ''; }
  }
  function read(){ return S().readJSON(KEY, {}); }
  function write(v){ S().writeJSON(KEY, v || {}); }

  function keysFor(id){
    const set = new Set([S().txt(id)].filter(Boolean));
    const order = S().findOrder(id);
    if (order) S().keys(order).forEach(k => set.add(k));
    return Array.from(set).filter(Boolean);
  }

  function get(id){
    const cache = read();
    for (const k of keysFor(id)) if (cache[k]) return cache[k];
    return {};
  }

  function setAll(id, data){
    const cache = read();
    keysFor(id).forEach(k => { cache[k] = Object.assign({}, cache[k] || {}, data); });
    write(cache);
  }

  function parseDate(v){
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const s = String(v).trim();
    if (!s) return null;
    const d1 = new Date(s);
    if (!isNaN(d1.getTime())) return d1;
    const br = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (br) {
      let y = br[3]; if (y.length === 2) y = '20' + y;
      const d = new Date(Number(y), Number(br[2])-1, Number(br[1]), Number(br[4]||0), Number(br[5]||0), Number(br[6]||0));
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  function timeBR(v){
    const d = parseDate(v);
    if (!d) return '';
    return d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  }

  function diffText(start, end){
    const a = parseDate(start), b = parseDate(end);
    if (!a || !b) return '';
    const min = Math.max(0, Math.round((b - a) / 60000));
    if (min < 60) return min + 'm';
    return Math.floor(min / 60) + 'h ' + String(min % 60).padStart(2, '0') + 'm';
  }

  function extractAudit(order){
    const id = S().getKey(order);
    const local = get(id);

    const inicio = order.inicio_separacao_em || order.inicio_separacao || order.iniciado_em || order.data_inicio_separacao || local.inicio || '';
    const fim = order.conclusao_separacao_em || order.fim_separacao || order.finalizado_em || order.data_separacao || order.status_atualizado_em || local.fim || '';
    const opInicio = order.operador_inicio_separacao || order.operador_inicio || local.operador_inicio || '';
    const opFim = order.operador_conclusao_separacao || order.operador_separacao || order.operador_ultima_alteracao || order.operador || local.operador_fim || local.operador_inicio || '';
    const tempo = order.tempo_separacao || order.tempo || local.tempo || diffText(inicio, fim) || '';

    return { inicio, fim, opInicio, opFim, tempo };
  }

  function onStatus(id, status){
    const st = S().norm(status);
    const op = operator();
    if (st.includes('em separacao') || st.includes('em separação')) {
      setAll(id, { inicio: nowISO(), operador_inicio: op });
    }
    if (st.includes('pronto') || st === 'separado' || st.includes('separado')) {
      const prev = get(id);
      const inicio = prev.inicio || nowISO();
      const fim = nowISO();
      setAll(id, { inicio, fim, operador_fim: op, tempo: diffText(inicio, fim) });
    }
    if (st.includes('a separar')) {
      setAll(id, { inicio:'', fim:'', operador_inicio:'', operador_fim:'', tempo:'' });
    }
  }

  function wrapUpdateStatus(){
    if (window.__vescoOperadoresWrapped || typeof window.updateStatusJsonp !== 'function') return;
    window.__vescoOperadoresWrapped = true;
    const old = window.updateStatusJsonp;
    window.updateStatusJsonp = function(id, status, observacao){
      try { onStatus(id, status); } catch(e) { console.warn('VescoOperadores onStatus erro', e); }
      const res = old.apply(this, arguments);
      setTimeout(apply, 500);
      setTimeout(apply, 1500);
      return res;
    };
    try { updateStatusJsonp = window.updateStatusJsonp; } catch(e) {}
  }

  function findOrderByRow(row){
    const text = row.innerText || '';
    const m = text.match(/#\s*([0-9A-Za-z._-]{4,})/) || text.match(/\b(\d{5,})\b/);
    return m ? S().findOrder(m[1]) : null;
  }

  function decorateSeparados(){
    const tbody = document.getElementById('table-separados-hoje');
    if (!tbody) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(row => {
      const order = findOrderByRow(row);
      if (!order) return;
      const audit = extractAudit(order);
      const tempo = audit.tempo || '—';
      const op = audit.opFim || audit.opInicio || operator() || '—';
      const inicio = timeBR(audit.inicio) || '—';
      const fim = timeBR(audit.fim) || '—';
      const cells = row.querySelectorAll('td');
      if (!cells.length) return;

      // Coluna tempo de separação é a terceira no legado.
      const tempoCell = cells[2] || cells[cells.length - 3];
      if (tempoCell) {
        tempoCell.innerHTML = `
          <div class="vesco-tempo-box">
            <span class="vesco-tempo-main">${S().esc(tempo)}</span>
            <small>Op: ${S().esc(op)} • ${S().esc(inicio)} → ${S().esc(fim)}</small>
          </div>
        `;
      }
    });
  }

  function decorateFila(){
    const tbody = document.getElementById('table-fila');
    if (!tbody) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(row => {
      const order = findOrderByRow(row);
      if (!order) return;
      const audit = extractAudit(order);
      if (!audit.inicio && !audit.fim && !audit.opInicio && !audit.opFim) return;
      const cell = row.querySelector('td:nth-child(2)') || row.querySelector('td');
      if (!cell || cell.querySelector('.vesco-operador-mini')) return;
      const op = audit.opFim || audit.opInicio || operator() || '—';
      const inicio = timeBR(audit.inicio) || '—';
      const fim = timeBR(audit.fim) || '';
      cell.insertAdjacentHTML('beforeend', `<div class="vesco-operador-mini">Op: ${S().esc(op)} • Início: ${S().esc(inicio)}${fim ? ` • Fim: ${S().esc(fim)}` : ''}</div>`);
    });
  }

  function apply(){
    wrapUpdateStatus();
    decorateSeparados();
    decorateFila();
  }

  function init(){
    wrapUpdateStatus();
    window.addEventListener('vesco:rendered', () => setTimeout(apply, 250));
    window.addEventListener('vesco:loaded', () => setTimeout(apply, 850));
    setInterval(apply, 1800);
    setTimeout(apply, 800);
  }

  window.VescoOperadores = { init, apply, get, onStatus, extractAudit, wrapUpdateStatus };
  init();
  console.log('modulo.operadores ativo');
})();
