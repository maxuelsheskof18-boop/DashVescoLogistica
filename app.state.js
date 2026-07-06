// app.state.js — Estado e regras de negócio compartilhadas pelos módulos.
(function(){
  if (window.VescoState) return;

  const CFG = window.VescoConfig || {};
  const RETIRADA_IDS = new Set(CFG.RETIRADA_IDS || []);

  function txt(v){ return v === null || v === undefined ? '' : String(v).trim(); }
  function norm(v){
    return txt(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  }
  function esc(v){
    return txt(v).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function digits(v){ return txt(v).replace(/\D/g,''); }

  function refreshLegacy(){
    try { if (window.VescoLegacy && typeof window.VescoLegacy.refreshState === 'function') window.VescoLegacy.refreshState(); } catch(e) {}
  }

  function orders(){
    refreshLegacy();
    if (window.VescoLegacy && typeof window.VescoLegacy.getOrders === 'function') return window.VescoLegacy.getOrders() || [];
    return Array.isArray(window.orders) ? window.orders : [];
  }

  function flexOrders(){
    refreshLegacy();
    if (window.VescoLegacy && typeof window.VescoLegacy.getFlexOrders === 'function') return window.VescoLegacy.getFlexOrders() || [];
    return Array.isArray(window.flexOrders) ? window.flexOrders : [];
  }

  function allOrders(){ return orders().concat(flexOrders()); }

  function getKey(o){
    return txt(o && (o.id || o.pedido_key || o.numero || o.id_tiny || o.numero_ecommerce || o.ecom || ''));
  }

  function getNumber(o){
    return txt(o && (o.numero || o.pedido || o.id_tiny || o.id || o.numero_ecommerce || o.ecom || ''));
  }

  function keys(o){
    const vals = [
      o && o.id, o && o.numero, o && o.pedido, o && o.id_tiny, o && o.pedido_key,
      o && o.numero_ecommerce, o && o.numero_ecommerc, o && o.ecom, o && o.referencia,
      o && o.reference, o && o.order_id, o && o.orderNumber
    ].map(txt).filter(Boolean);

    const out = new Set();
    vals.forEach(v => {
      out.add(v);
      out.add(v.replace(/^#/,''));
      const d = digits(v);
      if (d) out.add(d);
      try { if (typeof normalizeOrderNumber === 'function') out.add(normalizeOrderNumber(v)); } catch(e) {}
      try { if (typeof normalizeEcomNumber === 'function') out.add(normalizeEcomNumber(v)); } catch(e) {}
    });
    return Array.from(out).filter(Boolean);
  }

  function findOrder(key){
    const wanted = new Set([txt(key), txt(key).replace(/^#/,''), digits(key)].filter(Boolean));
    try { if (typeof normalizeOrderNumber === 'function') wanted.add(normalizeOrderNumber(key)); } catch(e) {}
    try { if (typeof normalizeEcomNumber === 'function') wanted.add(normalizeEcomNumber(key)); } catch(e) {}
    return allOrders().find(o => keys(o).some(k => wanted.has(k))) || null;
  }

  function getStatus(o){
    return txt(o && (o.status_logistica || o.situacao_nome || o.situacao || o.status || o.status_operacional || ''));
  }

  function isDelivered(o){
    const s = norm(getStatus(o));
    if (s.includes('pendente de entrega')) return false;
    return s === 'entregue' || s === 'finalizado' || s === 'concluido' || s.includes('concluida');
  }

  function isASeparar(o){
    const s = norm(getStatus(o));
    return s.includes('a separar') || s.includes('em separacao') || s.includes('em separação');
  }

  function isSeparatedOrReady(o){
    const s = norm(getStatus(o));
    return s.includes('separado') || s.includes('pronto') || s.includes('pendente de entrega') || s.includes('lancado na plataforma') || s.includes('lançado na plataforma');
  }

  function getAddress(o){
    return txt(o && (o.endereco_completo || o.endereco || o.address || o.full_address || ''));
  }

  function hasAddress(o){
    const a = norm(getAddress(o));
    if (!a || a === '-' || a === '—') return false;
    if (a.includes('endereco nao disponivel') || a.includes('endereço não disponível')) return false;
    if (a.includes('endereco indisponivel') || a.includes('erro de leitura')) return false;
    if (a.includes('sem endereco') || a.includes('sem endereço')) return false;
    return true;
  }

  function formaRaw(o){
    return [
      o && o.id_forma_envio, o && o.idFormaEnvio, o && o.idFormaEnvioPsq, o && o.forma_envio_id,
      o && o.forma_envio_nome, o && o.nome_forma_envio, o && o.nomeformafenvio,
      o && o.transportadora, o && o.transportador, o && o.forma_envio, o && o.tipo_entrega,
      o && o.prioridade_label, o && o.transporte_completo
    ].map(txt).filter(Boolean).join(' | ');
  }

  function getFormaId(o){
    const raw = txt(o && (o.id_forma_envio || o.idFormaEnvio || o.idFormaEnvioPsq || o.forma_envio_id || o.id_forma_envio_psq || ''));
    if (raw === '0') return '0';
    const m = raw.match(/\b\d{6,}\b/);
    return m ? m[0] : raw;
  }

  function isRetirada(o){
    const id = getFormaId(o);
    if (RETIRADA_IDS.has(id)) return true;
    const f = norm(formaRaw(o));
    return f.includes('retirar pessoalmente') || f.includes('retirada') || f.includes('retirar na loja') || f.includes('cliente retira') || f.includes('retirar');
  }

  function formaLabel(o){
    const f = norm(formaRaw(o));
    const known = [
      ['mercado envios flex','Mercado Envios Flex'], ['mercado envios','Mercado Envios'],
      ['shopee','Shopee Envios'], ['amazon dba','Amazon DBA'], ['magalu','Magalu Entregas'],
      ['tiktok','TikTok Shipping'], ['lalamove','LALAMOVE'], ['loggi','Loggi'],
      ['correios','Correios'], ['transportadora','Transportadora'],
      ['retirar pessoalmente','Retirar pessoalmente'], ['retirada','Retirar pessoalmente']
    ];
    for (const [k,v] of known) if (f.includes(k)) return v;
    if (getFormaId(o) === '0' || f.includes('nao definida') || f.includes('não definida') || f.includes('forma de envio nao informada')) return 'Não definida';
    return txt(o && (o.forma_envio_nome || o.transportadora || o.forma_envio)) || 'Entrega';
  }

  function parseDateISO(v){
    const s = txt(v);
    if (!s) return '';
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const br = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (br) {
      let y = br[3]; if (y.length === 2) y = '20' + y;
      return `${y.padStart(4,'0')}-${br[2].padStart(2,'0')}-${br[1].padStart(2,'0')}`;
    }
    return '';
  }

  function dateBR(v){
    const iso = parseDateISO(v);
    if (!iso) return txt(v) || '—';
    return `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}`;
  }

  function getOrderDate(o){
    return txt(o && (o.data_prevista || o.data_previsao || o.previsao || o.data_pedido || o.data || ''));
  }

  function selectedDateISO(){
    try { if (typeof getSelectedOperationalDateISO === 'function') return getSelectedOperationalDateISO(); } catch(e) {}
    const el = document.getElementById('topCalendar') || document.querySelector('input[type="date"]');
    if (el && el.value) return parseDateISO(el.value) || el.value;
    return new Date().toISOString().slice(0,10);
  }

  function parseObsLink(o){
    const raw = txt(o && (o.observacao_logistica || o.observacao || o.observacoes || o.observacao_pedido || ''));
    let obs = txt(o && (o.observacao_pedido || o.obs_pedido || ''));
    let link = txt(o && (o.link_pedido || o.linkPedido || o.link_tiny || ''));

    if (!obs) {
      const m = raw.match(/\[Solu[cç][aã]o\]\s*([\s\S]*?)(?=\s*\[Link\]|\s*\[Link pedido\]|\s*$)/i) ||
                raw.match(/\[Obs pedido\]\s*([\s\S]*?)(?=\s*\[Link pedido\]|\s*\[Link\]|\s*$)/i) ||
                raw.match(/Obs:\s*([\s\S]*?)(?=\s*\|\s*Link:|\s*$)/i);
      if (m) obs = txt(m[1]);
    }

    if (!link) {
      const m = raw.match(/\[Link\]\s*(https?:\/\/\S+)/i) ||
                raw.match(/\[Link pedido\]\s*(https?:\/\/\S+)/i) ||
                raw.match(/Link:\s*(https?:\/\/\S+)/i) ||
                raw.match(/(https?:\/\/erp\.tiny\.com\.br\/\S+)/i) ||
                raw.match(/(https?:\/\/\S+)/i);
      if (m) link = txt(m[1]).replace(/[)\].,;]+$/g,'');
    }

    if (obs) obs = obs.replace(/\s*\[Link\][\s\S]*$/i,'').replace(/\s*\[Link pedido\][\s\S]*$/i,'').replace(/\s*\|\s*Link:[\s\S]*$/i,'').trim();
    return { obs, link, raw };
  }

  function readJSON(key, fallback){
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch(e) { return fallback; }
  }
  function writeJSON(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
  }

  window.VescoState = {
    txt, norm, esc, digits, orders, flexOrders, allOrders, getKey, getNumber, keys, findOrder,
    getStatus, isDelivered, isASeparar, isSeparatedOrReady,
    getAddress, hasAddress, isRetirada, formaLabel, formaRaw, getFormaId,
    parseDateISO, dateBR, getOrderDate, selectedDateISO, parseObsLink,
    readJSON, writeJSON
  };
})();
