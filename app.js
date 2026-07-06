// app.js — Versão corrigida: Mapas sincronizados, sem pins duplicados e foco preciso
// Observações: coloque este arquivo no lugar do app.js atual e recarregue o servidor.

// --- Proteções / Motor de Áudio ---
window.playBeepSound = () => {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // 880Hz (Som de alarme)
    gain.gain.setValueAtTime(0.1, ctx.currentTime); // Volume
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15); // Duração do bipe
  } catch(e) { console.warn("Áudio bloqueado pelo navegador."); }
};

window.stopAudioAlarm = () => {
  const modal = document.getElementById('snoozeModal');
  if (modal) modal.classList.add('hidden');
};
// --- Endpoints (ajuste se necessário) ---
const API = "https://script.google.com/macros/s/AKfycbxEzbxBABMDwi7B7tn_1p-lC0vc50JjHFOrH3w42Oog2-5R2-WMYSrQ27ED7wduJUN6/exec";
const API_FLEX = "https://script.google.com/macros/s/AKfycbzDp2qs2S_MxDc_3afY1TurNKYEwfYKkk2cc4IliNxLiVaJuSKYyRqofOUMnhdFBjwNwg/exec";

// --- Estado global ---
let orders = [];
let flexOrders = [];
let currentOperator = localStorage.getItem('vesco_operator') || '';
let map, mapFlex, markerCluster, markerClusterFlex;
let renderTimer = null;
let geocodeCache = {};
let geocodeQueue = [];
let geocodeProcessing = false;
let currentMapRenderToken = 0; // Previne pins duplicados (Async Bleeding)
const GEOCODE_DELAY_MS = 1100; // delay entre requisições Nominatim

const DEBUG_DATES = (new URLSearchParams(window.location.search)).get('debug_dates') === '1';

// Atualização automática desativada por regra operacional: atualização só manual.
window.VESCO_DISABLE_AUTO_REFRESH = true;


// =================================================================
// CAMADA DE DATA OPERACIONAL — PRESERVAÇÃO V1
// Objetivo: permitir que o botão Atualizar respeite a data escolhida
// no calendário, sem remover a lógica antiga de carregamento/renderização.
// =================================================================
const VESCO_TZ = 'America/Sao_Paulo';
let currentOperationalDateISO = localStorage.getItem('vesco_operational_date_iso') || '';

function getBrazilTodayISO(){
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: VESCO_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const mapParts = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${mapParts.year}-${mapParts.month}-${mapParts.day}`;
  } catch(e) {
    const d = new Date();
    const offset = d.getTimezoneOffset();
    return new Date(d.getTime() - (offset * 60 * 1000)).toISOString().slice(0, 10);
  }
}

function getOperationalDateInputElement(){
  return document.getElementById('topCalendar') ||
         document.getElementById('dataOperacional') ||
         document.getElementById('data-operacional') ||
         document.getElementById('dataFiltro') ||
         document.querySelector('[data-operational-date]') ||
         document.querySelector('input[type="date"]');
}

function isoToBRDate(iso){
  const s = String(iso || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function brToISODate(br){
  const s = String(br || '').trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(!m) return '';
  let y = m[3];
  if(y.length === 2) y = '20' + y;
  return `${y.padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

function dateValueToISO(v){
  if(v === null || v === undefined || String(v).trim() === '') return '';
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = brToISODate(s);
  if(br) return br;
  try {
    if(typeof parseAnyDateValue === 'function') {
      const d = parseAnyDateValue(v);
      if(d && !isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      }
    }
  } catch(e) {}
  const d2 = new Date(s);
  if(!isNaN(d2.getTime())) {
    const yyyy = d2.getFullYear();
    const mm = String(d2.getMonth() + 1).padStart(2, '0');
    const dd = String(d2.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return '';
}

function getSelectedOperationalDateISO(){
  const input = getOperationalDateInputElement();
  const fromInput = input && input.value ? dateValueToISO(input.value) : '';
  const iso = fromInput || currentOperationalDateISO || localStorage.getItem('vesco_operational_date_iso') || getBrazilTodayISO();
  currentOperationalDateISO = iso;
  try { localStorage.setItem('vesco_operational_date_iso', iso); } catch(e) {}
  return iso;
}

function setSelectedOperationalDateISO(iso){
  const normalized = dateValueToISO(iso) || getBrazilTodayISO();
  currentOperationalDateISO = normalized;
  try { localStorage.setItem('vesco_operational_date_iso', normalized); } catch(e) {}
  const input = getOperationalDateInputElement();
  if(input && input.value !== normalized) input.value = normalized;
  return normalized;
}

function getOperationalDatePayload(){
  const iso = getSelectedOperationalDateISO();
  return { iso, br: isoToBRDate(iso), todayISO: getBrazilTodayISO() };
}

function appendQueryParamsSafe(url, params){
  let out = String(url || '');
  const entries = Object.entries(params || {}).filter(([,v]) => v !== undefined && v !== null && String(v).trim() !== '');
  entries.forEach(([k,v]) => {
    const sep = out.includes('?') ? '&' : '?';
    out += `${sep}${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  });
  return out;
}

function appendOperationalDateToUrl(url){
  const p = getOperationalDatePayload();
  // Enviamos aliases compatíveis. Se o Apps Script ignorar algum, não quebra.
  return appendQueryParamsSafe(url, {
    data: p.br,
    dataFiltro: p.br,
    data_operacional: p.br,
    date: p.iso,
    dataISO: p.iso
  });
}

function getStatusTextAny(o){
  return String((o && (o.status_logistica || o.situacao_nome || o.situacao || o.status)) || '').toLowerCase().trim();
}

function isSeparatedReadyStatus(o){
  const st = getStatusTextAny(o);
  return st.includes('separado') || st.includes('pronto');
}

function isDispatchedStatus(o){
  const st = getStatusTextAny(o);
  return st.includes('despach') || st.includes('em rota') || st.includes('saiu para entrega') || st === 'rota';
}

function isDeliveredStatus(o){
  const st = getStatusTextAny(o);
  return st.includes('entregue') || st.includes('finalizado') || st.includes('conclu');
}

function isStillSeparatedNotOut(o){
  return isSeparatedReadyStatus(o) && !isDispatchedStatus(o) && !isDeliveredStatus(o);
}

function firstISODateFromFields(o, keys){
  if(!o) return '';
  for(const k of keys){
    if(o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== '') {
      const iso = dateValueToISO(o[k]);
      if(iso) return iso;
    }
  }
  return '';
}

function getOrderSeparationISO(o){
  const iso = firstISODateFromFields(o, [
    'dataSeparacao','data_separacao','separado_em','separadoEm','separado_data',
    'data_separado','separado','data_separacao_extrato','dt_separacao','separation_date'
  ]);
  if(iso) return iso;

  // Fallback controlado: procura uma data explícita em observações/auditoria.
  const obs = String((o && (o.observacao_logistica || o.observacao || o.audit || o.historico)) || '');
  const found = typeof extractFirstDateLikeString === 'function' ? extractFirstDateLikeString(obs) : '';
  return found ? dateValueToISO(found) : '';
}

function getOrderScheduledISO(o){
  return firstISODateFromFields(o, [
    'data_prevista','data_previsao','previsao','data_prev','data_entrega','data','scheduled','eta','deliverydate'
  ]);
}

function getOrderDeliveryISO(o){
  return firstISODateFromFields(o, [
    'data_entrega_realizada','entregue_em','data_entregue','dataEntrega','delivered_at','concluidaEm'
  ]);
}

function getOrderDispatchISO(o){
  return firstISODateFromFields(o, [
    'data_despacho','despachado_em','data_rota','saiu_em','saiuParaEntregaEm','criadoEm'
  ]);
}

function sameOperationalDate(isoA, isoB){
  return !!isoA && !!isoB && String(isoA).slice(0,10) === String(isoB).slice(0,10);
}

function isSelectedOperationalDateToday(){
  return sameOperationalDate(getSelectedOperationalDateISO(), getBrazilTodayISO());
}

function shouldShowOrderForQueueDate(o){
  const selectedISO = getSelectedOperationalDateISO();
  const scheduledISO = getOrderScheduledISO(o);
  if(scheduledISO) return sameOperationalDate(scheduledISO, selectedISO);
  return isSelectedOperationalDateToday();
}

function shouldShowSeparatedForOperationalDate(o){
  const selectedISO = getSelectedOperationalDateISO();
  const sepISO = getOrderSeparationISO(o);

  if(sepISO && sameOperationalDate(sepISO, selectedISO)) return true;

  // Regra solicitada: separado em dia anterior e ainda não saiu para entrega
  // continua aparecendo no dia atual como separado/disponível para rota.
  if(isSelectedOperationalDateToday() && isStillSeparatedNotOut(o)) return true;

  // Fallback: se o backend ainda não devolve data de separação, mantém visível hoje.
  if(!sepISO && isSelectedOperationalDateToday() && isSeparatedReadyStatus(o)) return true;

  return false;
}

function shouldShowLogisticForOperationalDate(o){
  const selectedISO = getSelectedOperationalDateISO();
  const scheduledISO = getOrderScheduledISO(o);
  const sepISO = getOrderSeparationISO(o);
  const dispatchISO = getOrderDispatchISO(o);
  const deliveryISO = getOrderDeliveryISO(o);

  if(scheduledISO && sameOperationalDate(scheduledISO, selectedISO)) return true;
  if(sepISO && sameOperationalDate(sepISO, selectedISO)) return true;
  if(dispatchISO && sameOperationalDate(dispatchISO, selectedISO)) return true;
  if(deliveryISO && sameOperationalDate(deliveryISO, selectedISO)) return true;

  if(isSelectedOperationalDateToday() && isStillSeparatedNotOut(o)) return true;
  if(!scheduledISO && !sepISO && !dispatchISO && !deliveryISO && isSelectedOperationalDateToday()) return true;

  return false;
}

function shouldShowDeliveredForOperationalDate(o){
  const selectedISO = getSelectedOperationalDateISO();
  const deliveryISO = getOrderDeliveryISO(o) || getOrderDispatchISO(o) || getOrderSeparationISO(o);
  return deliveryISO ? sameOperationalDate(deliveryISO, selectedISO) : isSelectedOperationalDateToday();
}

function shouldShowFlexForOperationalDate(f){
  const selectedISO = getSelectedOperationalDateISO();
  const scheduledISO = getOrderScheduledISO(f);
  const sepISO = getOrderSeparationISO(f);
  if(scheduledISO) return sameOperationalDate(scheduledISO, selectedISO);
  if(sepISO) return sameOperationalDate(sepISO, selectedISO);
  return isSelectedOperationalDateToday();
}

function routeBelongsToOperationalDate(r){
  const selectedISO = getSelectedOperationalDateISO();
  const createdISO = dateValueToISO(r && r.criadoEm);
  const concludedISO = dateValueToISO(r && r.concluidaEm);
  if(createdISO && sameOperationalDate(createdISO, selectedISO)) return true;
  if(concludedISO && sameOperationalDate(concludedISO, selectedISO)) return true;
  // Rotas pendentes/em andamento permanecem visíveis no dia atual.
  if(isSelectedOperationalDateToday() && r && r.status !== 'concluida') return true;
  return false;
}

function syncGlobalOrderState(){
  try {
    window.orders = orders;
    window.flexOrders = flexOrders;
    if(window.appDebug) {
      window.appDebug.orders = orders;
      window.appDebug.flexOrders = flexOrders;
    }
  } catch(e) {}
}

// --- Helpers básicos ---
function debounce(fn, ms = 60) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
function scheduleRender() {
  if (typeof syncGlobalOrderState === 'function') syncGlobalOrderState();
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 60);
}
function escapeHtml(t){ if(t === null || t === undefined) return ''; return String(t).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }
function normalizeOrderNumber(n){
  if(n === null || n === undefined) return '';
  let s = String(n).trim();
  s = s.replace(/^#/, '').replace(/\s+/g, '');
  s = s.replace(/[^0-9A-Za-z\-_.]/g,'');
  return s;
}
function normalizeEcomNumber(v){
  if(v === null || v === undefined) return '';
  let s = String(v).trim();
  const digits = s.replace(/\D/g,'');
  if(digits.length >= 5) return digits;
  s = s.replace(/\s+/g, '').replace(/[^0-9A-Za-z\-_]/g,'');
  return s || '';
}
function parseNumberLoose(v){
  if(v === null || v === undefined) return NaN;
  if(typeof v === 'number') return v;
  return parseFloat(String(v).trim().replace(/\s+/g,'').replace(',', '.').replace(/[^0-9\.\-]/g, ''));
}
function _isValidLat(v){ return Number.isFinite(v) && Math.abs(v) <= 90; }
function _isValidLon(v){ return Number.isFinite(v) && Math.abs(v) <= 180; }
function _tryNormalizeNumber(v, isLat){
  if(v === null || v === undefined) return null;
  const n = parseNumberLoose(v);
  if(!Number.isFinite(n)) return null;
  if(isLat && _isValidLat(n)) return n;
  if(!isLat && _isValidLon(n)) return n;
  const divisors = [1e6, 1e7, 1e5, 1e3, 1e2];
  for(const d of divisors){
    const nv = n / d;
    if(isLat && _isValidLat(nv)) return nv;
    if(!isLat && _isValidLon(nv)) return nv;
  }
  return null;
}
function getCoords(item) {
  if (!item) return null;
  const laRaw = item.lat ?? item.latitude ?? item.latitude_local ?? item.lat_br ?? item.lat_local ?? item.geo_lat ?? item.latitud ?? '';
  const loRaw = item.lon ?? item.longitude ?? item.longitude_local ?? item.lon_br ?? item.lon_local ?? item.geo_lon ?? item.longitud ?? '';
  const lat = _tryNormalizeNumber(laRaw, true);
  const lon = _tryNormalizeNumber(loRaw, false);
  if(lat === null || lon === null) return null;
  return { lat: lat, lon: lon };
}

// -------------------------
// DATA: FUNÇÃO DEFINITIVA
// -------------------------

function excelSerialToDate(serial) {
  const days = Number(serial);
  if (!Number.isFinite(days)) return null;
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const ms = epoch.getTime() + Math.round(days * 24 * 60 * 60 * 1000);
  const d = new Date(ms);
  return isNaN(d) ? null : d;
}

function formatToDDMMYYYY(d){
  if(!d || isNaN(d)) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function extractFirstDateLikeString(s){
  if(!s) return '';
  const str = String(s);
  const regexes = [
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/, 
    /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/,   
    /(\d{10,13})/                          
  ];
  for(const r of regexes){
    const m = str.match(r);
    if(m) return m[1];
  }
  return '';
}

function parseAnyDateValue(v){
  if(v === null || v === undefined) return null;
  if(typeof v === 'number') {
    if (v > 20000 && v < 60000) {
      const d = excelSerialToDate(v);
      if(d) return d;
    }
    if(v > 1e11) { const d = new Date(v); if(!isNaN(d)) return d; }
  }
  const s = String(v).trim();
  if(!s) return null;
  if(/^\d{10,13}$/.test(s)) {
    const n = parseInt(s,10);
    const ts = (s.length === 10) ? n*1000 : n;
    const d = new Date(ts);
    if(!isNaN(d)) return d;
  }
  if(/^\d{5,6}$/.test(s) && Number(s) > 20000 && Number(s) < 60000) {
    const d = excelSerialToDate(Number(s));
    if(d) return d;
  }
  const isoMatch = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if(isoMatch) {
    const y = Number(isoMatch[1]), m = Number(isoMatch[2]) - 1, day = Number(isoMatch[3]);
    const dd = new Date(y, m, day);
    if(!isNaN(dd)) return dd;
  }
  const brMatch = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if(brMatch) {
    let day = Number(brMatch[1]), month = Number(brMatch[2]) - 1, year = Number(brMatch[3]);
    if(year < 100) year += 2000;
    const dd = new Date(year, month, day);
    if(!isNaN(dd)) return dd;
  }
  const d2 = new Date(s);
  if(!isNaN(d2)) return d2;
  return null;
}

function extractDateDefinitive(input){
  if(input && typeof input === 'object' && !Array.isArray(input)) {
    const preferredKeys = [
      'data_prevista','data','data_previsao','data_previsão','previsao','dataentrega',
      'deliverydate','expecteddate','dateexpected','eta','scheduled','scheduledat','data_prev'
    ];
    for(const k of preferredKeys){
      for(const key in input){
        if(!Object.prototype.hasOwnProperty.call(input, key)) continue;
        if(key.toLowerCase().replace(/[^a-z0-9]/g,'').includes(k.replace(/[^a-z0-9]/g,''))) {
          const v = input[key];
          if(v !== undefined && v !== null && String(v).trim() !== '') {
            const candidate = String(v).trim();
            const substr = extractFirstDateLikeString(candidate) || candidate;
            const parsed = parseAnyDateValue(substr);
            if(parsed) return formatToDDMMYYYY(parsed);
            if(/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(candidate)) {
              const parts = candidate.split(/[\/\-]/);
              let day = parts[0].padStart(2,'0'), month = parts[1].padStart(2,'0'), year = parts[2];
              if(year.length === 2) year = '20' + year;
              return `${day}/${month}/${year}`;
            }
          }
        }
      }
    }
    for(const k in input){
      if(!Object.prototype.hasOwnProperty.call(input, k)) continue;
      const v = input[k];
      if(v === null || v === undefined) continue;
      const candidateString = String((typeof v === 'object') ? (v.value || v.text || v.date || '') : v);
      const substr = extractFirstDateLikeString(candidateString);
      if(substr) {
        const parsed = parseAnyDateValue(substr);
        if(parsed) return formatToDDMMYYYY(parsed);
      }
    }
    try {
      const all = JSON.stringify(input);
      const substr = extractFirstDateLikeString(all);
      if(substr) {
        const parsed = parseAnyDateValue(substr);
        if(parsed) return formatToDDMMYYYY(parsed);
      }
    } catch(e){}
    return '';
  }
  if(Array.isArray(input) && input.length > 0 && Array.isArray(input[0])) {
    const header = input[0].map(h => String(h || '').trim());
    const headerNorm = header.map(h => h.toLowerCase().replace(/[^a-z0-9]/g,''));
    const dateCandidates = ['dataprevista','data_prevista','data','previsao','dataentrega','deliverydate','expecteddate','eta','scheduled'];
    let idx = -1;
    for(let i=0;i<headerNorm.length;i++) if(dateCandidates.includes(headerNorm[i])) { idx = i; break; }
    if(idx === -1) {
      for(let i=0;i<headerNorm.length;i++) if(/prev|previs|entreg|delivery|date|data/.test(headerNorm[i])) { idx = i; break; }
    }
    if(idx !== -1 && input.length > 1) {
      const raw = input[1][idx];
      const substr = extractFirstDateLikeString(String(raw||''));
      const parsed = parseAnyDateValue(substr || raw);
      if(parsed) return formatToDDMMYYYY(parsed);
    }
    if(input.length > 1) {
      for(const cell of input[1]) {
        const substr = extractFirstDateLikeString(String(cell||''));
        if(substr) {
          const parsed = parseAnyDateValue(substr);
          if(parsed) return formatToDDMMYYYY(parsed);
        }
      }
    }
    return '';
  }
  const raw = input;
  let candidate = extractFirstDateLikeString(raw) || String(raw||'').trim();
  const parsed = parseAnyDateValue(candidate);
  if(parsed) return formatToDDMMYYYY(parsed);
  return '';
}

function extractDateDefinitiveWithDebug(input){
  const result = extractDateDefinitive(input);
  if(DEBUG_DATES) {
    try { console.info('DATE_EXTRACT DEBUG', { input, result }); } catch(e){}
  }
  return result;
}

// -------------------------
// Geocoding (Fila Lenta de Socorro - PLANO B)
// -------------------------
function normalizeAddressKey(addr){
  if(!addr) return '';
  return String(addr).trim().replace(/\s+/g,' ').toLowerCase();
}

function geocodeAddress(address){
  return new Promise((resolve, reject) => {
    if(!address || String(address).trim() === '') return resolve(null);
    const key = normalizeAddressKey(address);
    if(geocodeCache.hasOwnProperty(key)) return resolve(geocodeCache[key]);
    
    geocodeQueue.push({ address, resolve, reject });
    processGeocodeQueue();
  });
}

function processGeocodeQueue(){
  if(geocodeProcessing) return;
  geocodeProcessing = true;
  
  const next = () => {
    const item = geocodeQueue.shift();
    if(!item){ geocodeProcessing = false; return; }

    const address = item.address;
    const key = normalizeAddressKey(address);
    const q = encodeURIComponent(address + ', Brasil'); // Força a busca no Brasil
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=0`;

    fetch(url, { headers: { 'Accept-Language': 'pt-BR' } })
      .then(r => r.json())
      .then(js => {
        if(Array.isArray(js) && js.length > 0){
          const p = js[0];
          const res = { lat: parseFloat(p.lat), lon: parseFloat(p.lon) };
          geocodeCache[key] = res; // Salva na memória do navegador
          item.resolve(res);
        } else {
          geocodeCache[key] = null;
          item.resolve(null);
        }
      }).catch(err => {
        console.warn('Erro no Geocode de Socorro (Plano B)', err);
        geocodeCache[key] = null;
        item.resolve(null);
      }).finally(() => {
        setTimeout(next, 1500);
      });
  };
  next();
}

function tryGeocodeIfNeeded(item, onResolved){
  const coords = getCoords(item);
  if(coords){ 
    if(typeof onResolved === 'function') onResolved(coords); 
    return; 
  }
  const addr = (item.endereco_completo || item.endereco || '').trim();
  if(!addr) { 
    if(typeof onResolved === 'function') onResolved(null); 
    return;
  }
  const cacheKey = normalizeAddressKey(addr);
  if(geocodeCache.hasOwnProperty(cacheKey)) {
    const c = geocodeCache[cacheKey];
    if(typeof onResolved === 'function') onResolved(c ? {lat: c.lat, lon: c.lon} : null);
    return;
  }
  geocodeAddress(addr).then(res => {
    if(typeof onResolved === 'function') onResolved(res ? { lat: res.lat, lon: res.lon } : null);
  });
}

// -------------------------
// Ícone, jsonp, util, findArrayInObject
// -------------------------
function createPinSVG(color='#eab308', size=28){
  const inner = Math.max(8, Math.round(size * 0.35));
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C8.686 2 6 4.686 6 8c0 4.418 6 12 6 12s6-7.582 6-12c0-3.314-2.686-6-6-6z" fill="${color}" stroke="#ffff" stroke-width="1.2"/>
      <circle cx="12" cy="8" r="${inner/4}" fill="#fff" />
    </svg>
  `;
}
function jsonpFetch(url, cb) {
  const cbName = '__jsonp_cb_' + Math.random().toString(36).substr(2,9);
  const script = document.createElement('script');
  let finished = false;
  let timedOut = false;
  const timeoutMs = 60000;

  function cleanupLater() {
    setTimeout(() => {
      try { delete window[cbName]; } catch(e) { window[cbName] = undefined; }
      try { if (script.parentNode) script.remove(); } catch(e) {}
    }, 120000);
  }

  const timeout = setTimeout(() => {
    if (finished) return;
    timedOut = true;
    finished = true;

    // Mantém um callback fantasma para respostas atrasadas do Apps Script.
    // Isso evita: "Uncaught ReferenceError: __jsonp_cb_xxx is not defined".
    window[cbName] = function(){ cleanupLater(); };

    try { if (typeof cb === 'function') cb(new Error('JSONP timeout'), null); } catch(e) { console.error(e); }
    cleanupLater();
  }, timeoutMs);

  window[cbName] = function(res) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    try { if (typeof cb === 'function') cb(null, res); } catch(e){ console.error(e); }
    cleanupLater();
  };

  script.onerror = function() {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    window[cbName] = function(){ cleanupLater(); };
    try { if (typeof cb === 'function') cb(new Error('JSONP script error'), null); } catch(e){ console.error(e); }
    cleanupLater();
  };

  const sep = url.indexOf('?') === -1 ? '?' : '&';
  script.src = `${url}${sep}callback=${cbName}`;
  script.id = cbName;
  document.head.appendChild(script);
}
function jsonpFetchPromise(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const cbName = '__jsonp_cb_' + Math.random().toString(36).substr(2,9);
    const script = document.createElement('script');
    let finished = false;
    let timer = null;

    function cleanupLater() {
      setTimeout(() => {
        try { delete window[cbName]; } catch(e) { window[cbName] = undefined; }
        try { if (script.parentNode) script.remove(); } catch(e) {}
      }, 120000);
    }

    window[cbName] = function(res){
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({ jsonp: true, resp: res });
      cleanupLater();
    };

    script.onerror = function(){
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      window[cbName] = function(){ cleanupLater(); };
      reject(new Error('JSONP script error'));
      cleanupLater();
    };

    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      window[cbName] = function(){ cleanupLater(); };
      reject(new Error('JSONP timeout'));
      cleanupLater();
    }, timeoutMs || 60000);

    const sep = url.indexOf('?') === -1 ? '?' : '&';
    script.src = `${url}${sep}callback=${cbName}`;
    document.head.appendChild(script);
  });
}
function findArrayInObject(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) return obj;
  if (typeof obj !== 'object') return null;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (v && typeof v === 'object') {
      for (const k2 in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k2)) continue;
        if (Array.isArray(v[k2])) return v[k2];
      }
    }
  }
  return null;
}

// -------------------------
// Normalizadores
// -------------------------
function normalizeKeyName(k){
  if(k === null || k === undefined) return '';
  return String(k).toString().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
}
function extractClientNameFromAny(obj) {
  if (!obj) return '';
  const keys = [
    'cliente_nome','cliente','destinatario','destinatário','nome','receiver','recipient',
    'customer_name','customer','client','nome_cliente','destinatario_nome','nome_destinatario',
    'consignee','to_name','ship_to_name','dest'
  ];
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return String(obj[k]).trim();
    }
  }
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (typeof v === 'string' && /[A-Za-zÀ-ú]+(\s+[A-Za-zÀ-ú]+){1,4}/.test(v) && v.length < 90) {
      return v.trim();
    }
  }
  return '';
}
function extractEcomNumberFromAny(obj) {
  if (!obj) return '';
  const keys = [
    'numero_ecommerce','numero_ecom','ecom','ecom_id','order_reference','order_ref',
    'reference','referencia','reference_number','merchant_order_id','marketplace_order_id',
    'external_id','external_reference','codigo_externo','order_id','orderNumber','id'
  ];
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return normalizeEcomNumber(obj[k]);
    }
  }
  const fallbackCandidates = ['reference','referencia','order_id','codigo_externo','id'];
  for (const f of fallbackCandidates) {
    if (f in obj && obj[f]) {
      const s = String(obj[f]).trim();
      const digits = s.replace(/\D/g, '');
      if (digits.length >= 5) return digits;
      if (s.length >= 4) return s;
    }
  }
  return '';
}
function extractStoreNameFromAny(obj) {
  if (!obj) return '';
  const keys = [
    'conta','loja','store','store_name','nome_loja','account','seller','shop','marketplace','loja_nome','store_id','merchant','conta'
  ];
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return String(obj[k]).trim();
    }
  }
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = String(obj[k] || '');
    const m = v.match(/(loja[:\s]+[A-Za-z0-9\-\s]+)/i);
    if (m && m[1]) return m[1].replace(/loja[:\s]+/i, '').trim();
  }
  return '';
}

// -------------------------
// Carregamento dos dados
// -------------------------
function load(){
  // ERP (JSONP)
  const apiUrlComData = (typeof appendOperationalDateToUrl === 'function') ? appendOperationalDateToUrl(API) : API;
  jsonpFetch(apiUrlComData, function(err, resp){
    if (resp && resp.success) {
      let dadosErp = (resp.data || []).filter(o => (o.numero || o.id || o.pedido));
      orders = dadosErp.map(normalizeOrderObject);
      orders.forEach(o => {
        o.data_prevista = o.data_prevista && String(o.data_prevista).trim() ? extractDateDefinitiveWithDebug(o.data_prevista) : extractDateDefinitiveWithDebug(o);
      });
      scheduleRender();
    } else if (Array.isArray(resp)) {
      orders = (resp || []).map(normalizeOrderObject);
      orders.forEach(o => { o.data_prevista = o.data_prevista && String(o.data_prevista).trim() ? extractDateDefinitiveWithDebug(o.data_prevista) : extractDateDefinitiveWithDebug(o); });
      scheduleRender();
    } else {
      orders = [];
      scheduleRender();
    }
  });

  // FLEX
  (function fetchFlexRobust(){
    const urlBase = (typeof appendOperationalDateToUrl === 'function') ? appendOperationalDateToUrl(`${API_FLEX}?action=separacoesIndex`) : `${API_FLEX}?action=separacoesIndex`;
    const JSONP_TIMEOUT = 15000;

    jsonpFetchPromise(urlBase, JSONP_TIMEOUT).then(result => {
      processFlexResponse(result.resp);
    }).catch(jsonpErr => {
      fetch(urlBase, { cache: 'no-store' }).then(r => r.text()).then(txt => {
        try {
          const parsed = JSON.parse(txt);
          processFlexResponse(parsed);
        } catch(e) {
          const m = txt.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
          if (m && m[1]) {
            try {
              const parsed2 = JSON.parse(m[1]);
              processFlexResponse(parsed2);
              return;
            } catch(e2){}
          }
          try {
            const maybe = JSON.parse(txt.replace(/\n/g,''));
            processFlexResponse(maybe);
            return;
          } catch(e3){}
          flexOrders = [];
          scheduleRender();
        }
      }).catch(fetchErr => {
        flexOrders = [];
        scheduleRender();
      });
    });

    function processFlexResponse(resp){
      let dadosBrutos = findArrayInObject(resp) || (Array.isArray(resp) ? resp : null);
      if(!dadosBrutos || dadosBrutos.length === 0) {
        dadosBrutos = [];
        const q = [resp];
        while(q.length && dadosBrutos.length === 0) {
          const n = q.shift();
          for(const k in n){
            if(!Object.prototype.hasOwnProperty.call(n,k)) continue;
            const v = n[k];
            if(Array.isArray(v)) { dadosBrutos = v; break; }
            if(v && typeof v === 'object') q.push(v);
          }
        }
      }
      if(!dadosBrutos) dadosBrutos = [];

      if (Array.isArray(dadosBrutos) && dadosBrutos.length > 0 && Array.isArray(dadosBrutos[0])) {
        const headerRow = dadosBrutos[0].map(h => String(h || '').trim());
        const headerNorm = headerRow.map(h => normalizeKeyName(h || ''));
        const dataRows = dadosBrutos.slice(1);
        const possibleDateKeys = ['dataprevista','data_prevista','data','previsao','dataentrega','deliverydate','expecteddate','eta','scheduled'];
        let idxDate = -1;
        for (let i = 0; i < headerNorm.length; i++) {
          if (possibleDateKeys.includes(headerNorm[i])) { idxDate = i; break; }
        }
        if (idxDate === -1) {
          for (let i = 0; i < headerNorm.length; i++){
            if (/(prev|previs|entreg|delivery|expected|date|data)/i.test(headerNorm[i])) { idxDate = i; break; }
          }
        }
        const possibleStoreKeys = ['conta','loja','store','store_name','nome_loja','account','merchant'];
        let idxStore = -1;
        for (let i = 0; i < headerNorm.length; i++) {
          if (possibleStoreKeys.includes(headerNorm[i])) { idxStore = i; break; }
        }
        if (idxStore === -1) {
          for (let i = 0; i < headerNorm.length; i++){
            if (/(conta|loja|store|merchant|seller)/i.test(headerNorm[i])) { idxStore = i; break; }
          }
        }

        dadosBrutos = dataRows.map(row => {
          const obj = {};
          for (let i = 0; i < headerRow.length; i++) {
            const key = headerRow[i] || `col${i}`;
            obj[key] = row[i];
          }
          if (idxDate !== -1) obj['data_prevista_raw'] = row[idxDate];
          if (idxStore !== -1) obj['store_raw'] = row[idxStore];
          return obj;
        });
      }

      const normalized = dadosBrutos.map(raw => {
        const f = Object.assign({}, raw);
        f.numero = String(f.numero || f.id || f.pedido || f.order_id || f.orderNumber || f.reference || f.referencia || '').trim();
        f.cliente_nome = extractClientNameFromAny(f) || f.destinatario || f.cliente || f.nome || '';

        let candidate = null;
        if (f.data_prevista_raw !== undefined && f.data_prevista_raw !== null && String(f.data_prevista_raw).trim() !== '') candidate = f.data_prevista_raw;
        else {
          for(const key in f){
            if(!Object.prototype.hasOwnProperty.call(f,key)) continue;
            const nkey = normalizeKeyName(key);
            if(/prev|previs|data|entreg|sched|eta|delivery|expected/i.test(nkey) && String(f[key]).trim() !== '') {
              candidate = f[key];
              break;
            }
          }
        }
        f.data_prevista = candidate ? extractDateDefinitiveWithDebug(candidate) : extractDateDefinitiveWithDebug(f);

        f.numero_ecommerce = extractEcomNumberFromAny(f) || normalizeEcomNumber(f.numero_ecommerce || f.referencia || f.reference || f.id || '');
        const rawStoreCandidate = (f.store_raw !== undefined && f.store_raw !== null && String(f.store_raw).trim() !== '') ? String(f.store_raw).trim()
          : ( (f.conta !== undefined && f.conta !== null && String(f.conta).trim() !== '') ? String(f.conta).trim() : null );
        f.store_name = rawStoreCandidate || extractStoreNameFromAny(f) || (f.loja || f.store || f.merchant || f.conta || '');
        f.endereco_completo = f.endereco_completo || f.endereco || f.address || f.full_address || '';
        f.lat = f.lat || f.latitude || f.latitude_local || f.geo_lat || f.lat_br || '';
        f.lon = f.lon || f.longitude || f.longitude_local || f.geo_lon || f.lon_br || '';
        f.situacao_nome = f.situacao_nome || f.status || f.situacao || '';
        f.id = f.id || f.numero || f.pedido || (f.order_id || '');
        return f;
      });

      flexOrders = normalized;
      scheduleRender();
    }
  })();
}

function normalizeOrderObject(item) {
  const obj = Object.assign({}, item);
  obj.numero = obj.numero || obj.id || obj.pedido || obj.order_id || obj.orderNumber || obj.reference || obj.referencia || '';
  obj.numero = String(obj.numero || '').trim();
  obj.cliente_nome = String(obj.cliente_nome || obj.cliente || obj.destinatario || obj.nome || obj.receiver || obj.recipient || '').trim();
  obj.endereco_completo = obj.endereco_completo || obj.endereco || obj.address || obj.full_address || obj.address_line || '';
  obj.lat = obj.lat || obj.latitude || obj.latitude_local || obj.geo_lat || obj.lat_br || '';
  obj.lon = obj.lon || obj.longitude || obj.longitude_local || obj.geo_lon || obj.lon_br || '';
  obj.data_prevista = obj.data_prevista || obj.data_previsao || obj.previsao || obj.data_prev || obj.data_entrega || '';
  obj.status_logistica = obj.status_logistica || obj.status || obj.situacao || '';
  obj.id = obj.id || obj.numero || '';
  obj.data_prevista = obj.data_prevista && String(obj.data_prevista).trim() ? extractDateDefinitiveWithDebug(obj.data_prevista) : extractDateDefinitiveWithDebug(obj);
  return obj;
}

// -------------------------
// Plotagem de marcadores (COM CORREÇÃO DE DUPLICAÇÃO ASYNC)
// -------------------------
window.activeMainMarkers = {};
window.activeFlexMarkers = {};

let flexBoundsTimer = null;
let mainBoundsTimer = null;

function plotMapMarkers(orderList, flexList){
  if(!markerCluster || !markerClusterFlex) return;

  currentMapRenderToken++;
  const myToken = currentMapRenderToken;

  markerCluster.clearLayers();
  markerClusterFlex.clearLayers();

  window.activeMainMarkers = {};
  window.activeFlexMarkers = {};

  function debouncedFitBoundsMain() {
    clearTimeout(mainBoundsTimer);
    mainBoundsTimer = setTimeout(() => {
        if(myToken !== currentMapRenderToken) return;
        try {
            if (markerCluster.getLayers().length > 0) {
                const b = markerCluster.getBounds();
                if(b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 14 });
            }
        } catch(e){}
    }, 600);
  }

  function debouncedFitBoundsFlex() {
    clearTimeout(flexBoundsTimer);
    flexBoundsTimer = setTimeout(() => {
        if(myToken !== currentMapRenderToken) return;
        try {
            if (markerClusterFlex.getLayers().length > 0) {
                const b = markerClusterFlex.getBounds();
                if(b && b.isValid && b.isValid()) mapFlex.fitBounds(b.pad(0.12), { maxZoom: 14 });
            }
        } catch(e){}
    }, 600);
  }

  function addMainMarker(item, lat, lon){
    if (myToken !== currentMapRenderToken) return; // Async bleeding cancelado!
    
    const ecomNum = (item.numero_ecommerce || getEcomNum(item) || '').toString();
    const normNum = normalizeOrderNumber(item.numero || item.id || item.pedido || '');
    
    if (window.activeMainMarkers[normNum]) return; 

    const popupHtml = `<div class='p-1 font-sans'><b class='text-blue-600 text-sm'>Pedido #${escapeHtml(String(item.numero || ''))}</b><br><small class='text-xs text-slate-600 font-medium'>${escapeHtml(String(item.endereco_completo || ''))}</small><br><div class='text-[13px] text-slate-800 font-semibold mt-1'>${escapeHtml(String(item.cliente_nome || ''))}</div><div class='text-xs text-slate-500 mt-1'>Data Prevista: <b>${escapeHtml(String(item.data_prevista || '—'))}</b></div><div class='text-xs text-slate-400 mt-1'>ecom: ${escapeHtml(ecomNum || '—')}</div></div>`;
    const svgHtml = createPinSVG('#004f9f', 30);
    const icon = L.divIcon({ html: svgHtml, className: '', iconSize: [30,30], iconAnchor: [15,30] });
    const m = L.marker([lat, lon], { icon }).bindPopup(popupHtml);
    
    markerCluster.addLayer(m);
    try { if(normNum) window.activeMainMarkers[normNum] = m; if(ecomNum) window.activeMainMarkers[ecomNum] = m; window.activeMainMarkers[String(item.numero || item.id || '')] = m; } catch(e){}
    debouncedFitBoundsMain();
  }

  function addFlexMarker(item, lat, lon){
    if (myToken !== currentMapRenderToken) return; // Async bleeding cancelado!

    const ecomNum = (item.numero_ecommerce || '').toString();
    const normNum = normalizeOrderNumber(item.numero || item.id || '');

    if (window.activeFlexMarkers[normNum]) return; 

    const popupHtml = `<div class='p-1 font-sans'><b class='text-amber-500 text-sm'>Flex #${escapeHtml(String(item.numero || item.id || ''))}</b><br><small class='text-xs text-slate-600 font-medium'>${escapeHtml(String(item.endereco_completo || ''))}</small><br><div class='text-[13px] text-slate-800 font-semibold mt-1'>${escapeHtml(String(item.cliente_nome || ''))}</div><div class='text-xs text-slate-500 mt-1'>Data Prevista: <b>${escapeHtml(String(item.data_prevista || '—'))}</b></div><div class='text-xs text-slate-400 mt-1'>ecom: ${escapeHtml(ecomNum || '—')}</div><div class='text-xs text-slate-400 mt-1'>Loja: ${escapeHtml(item.store_name || '—')}</div></div>`;
    const svgHtmlFlex = createPinSVG('#eab308', 30);
    const iconFlex = L.divIcon({ html: svgHtmlFlex, className: '', iconSize: [30,30], iconAnchor: [15,30] });
    const mFlex = L.marker([lat, lon], { icon: iconFlex }).bindPopup(popupHtml);
    
    markerClusterFlex.addLayer(mFlex);
    try { if(normNum) window.activeFlexMarkers[normNum] = mFlex; if(ecomNum) window.activeFlexMarkers[ecomNum] = mFlex; window.activeFlexMarkers[String(item.numero || item.id || '')] = mFlex; } catch(e){}
    debouncedFitBoundsFlex();
  }

  for(const item of (orderList||[])){
    const coords = getCoords(item);
    if(coords){
      addMainMarker(item, coords.lat, coords.lon);
    } else {
      tryGeocodeIfNeeded(item, (c) => {
        if(c) addMainMarker(item, c.lat, c.lon);
      });
    }
  }

  for(const item of (flexList||[])){
    const coords = getCoords(item);
    if(coords){
      addFlexMarker(item, coords.lat, coords.lon);
    } else {
      tryGeocodeIfNeeded(item, (c) => {
        if(c) addFlexMarker(item, c.lat, c.lon);
      });
    }
  }
}

function getEcomNum(item){
  if(!item) return '';
  const candidates = [
    item.numero_ecommerce, item.numero_ecom, item.ecom_num, item.id_ecom,
    item.referencia, item.reference, item.ref, item.ecom, item.ecommerce_id,
    item.order_reference, item.order_ref, item.orderNumber, item.order_id, item.order,
    item.codigo_externo, item.codigo
  ];
  for(const c of candidates){
    if(c !== undefined && c !== null && String(c).trim() !== '') {
      const normalized = normalizeEcomNumber(c);
      if(normalized) return normalized;
    }
  }
  const fallback = item.numero || item.id || item.pedido || '';
  const maybe = normalizeEcomNumber(fallback);
  return maybe || '';
}

// -------------------------
// Render da UI (tabelas)
// -------------------------
function render(){
  const searchEl = document.getElementById('search');
  const searchQ = (searchEl && searchEl.value) ? searchEl.value.toLowerCase() : '';
  const tbodyFila = document.getElementById('table-fila');
  const tbodySepHoje = document.getElementById('table-separados-hoje');
  const tbodyPend = document.getElementById('table-pendencias');
  const tbodyLog = document.getElementById('table-logistica');
  const tbodyFlexCorpo = document.getElementById('table-envios-flex-corpo');
  const tbodyEntregues = document.getElementById('table-entregues');

  // 1. FILA ATIVA (ERP)
  const filaOrders = orders.filter(o => {
    const st = String(o.status_logistica || '').toLowerCase().trim();
    const matchBusca = (String(o.numero || '').toLowerCase().includes(searchQ) || String(o.cliente_nome || '').toLowerCase().includes(searchQ));
    const matchData = (typeof shouldShowOrderForQueueDate === 'function') ? shouldShowOrderForQueueDate(o) : true;
    return (st === 'a separar' || st === 'em separação') && matchBusca && matchData;
  });

  if (tbodyFila) {
    if (filaOrders.length === 0) {
      tbodyFila.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido aguardando separação.</td></tr>`;
    } else {
      tbodyFila.innerHTML = filaOrders.map((o, idx) => {
        const id = o.id || o.numero || '';
        const statusAtual = o.status_logistica || 'A Separar';
        const statusLower = String(statusAtual).toLowerCase().trim();
        
        let badgeStyle = 'badge-strict-vermelho', dotStyle = 'dot-blink-red';
        if(statusLower.includes('em separa')) { badgeStyle = 'badge-strict-amarelo'; dotStyle = 'dot-strict-amarelo'; } 
        else if(statusLower.includes('a separar')) { badgeStyle = 'badge-strict-vermelho'; dotStyle = 'dot-blink-red'; } 
        else if(statusLower.includes('pronto')) { badgeStyle = 'badge-strict-verde'; dotStyle = 'dot-strict-verde'; } 
        else { badgeStyle = 'badge-strict-azul'; dotStyle = 'dot-strict-azul'; }
        
        const displayDataPrev = (o.data_prevista && String(o.data_prevista).trim()) ? String(o.data_prevista).trim() : '—';
        const ecomRaw = getEcomNum(o) || '';
        const ecomNorm = normalizeEcomNumber(ecomRaw);
        
        const instrucaoStr = String(o.instrucao_entrega || o.forma_pagamento || '—').toUpperCase();
        let paymentBadgeClass = "bg-slate-50 text-slate-600 border-slate-200"; 
        
        if (instrucaoStr.includes('JÁ PAGO')) {
          paymentBadgeClass = "bg-emerald-50 text-emerald-700 border-emerald-200";
        } else if (instrucaoStr.includes('CONFERIR')) {
          paymentBadgeClass = "bg-amber-50 text-amber-700 border-amber-200";
        } else if (instrucaoStr.includes('MAQUININHA')) {
          paymentBadgeClass = "bg-blue-50 text-blue-700 border-blue-200";
        } else if (instrucaoStr.includes('DINHEIRO')) {
          paymentBadgeClass = "bg-indigo-50 text-indigo-700 border-indigo-200";
        }

        return `
          <tr id="row-pedido-${escapeHtml(id)}" data-num="${escapeHtml(normalizeOrderNumber(o.numero || ''))}" data-ecom="${escapeHtml(ecomNorm)}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 transition-colors text-xs md:text-sm">
            <td class="p-3 pl-4"><span class="status-pill ${badgeStyle}"><span class="status-dot ${dotStyle}"></span><span>${escapeHtml(statusAtual)}</span></span></td>
            
            <td class="p-3 font-bold text-slate-900">#${escapeHtml(o.numero || 'S/N')}
              <div class="text-[12px] text-slate-800 font-semibold mt-1">${escapeHtml(o.cliente_nome || '')}</div>
            </td>
            
            <td class="p-3 text-center"><input type="time" class="bg-white border border-slate-200 rounded-lg px-2 py-0.5 text-center font-bold text-xs md:text-sm w-20 shadow-sm focus:border-blue-500 outline-none" value="${o.alarme || ''}" onchange="updateAlarmTimeJsonp('${escapeHtml(id)}', this.value)"></td>
            
            <td class="p-3 text-center font-mono text-[#004f9f] font-bold hidden md:table-cell">${escapeHtml(displayDataPrev)}</td>
            
            <td class="p-3 text-xs text-slate-500 max-w-xs truncate hidden lg:table-cell">${escapeHtml(o.endereco_completo || '')}</td>
            
            <td class="p-3 align-middle">
              <span class="text-[11px] font-bold px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-sm border ${paymentBadgeClass}">
                ${escapeHtml(instrucaoStr)}
              </span>
            </td>

            <td class="p-3 pr-4 align-middle text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button class="bg-amber-500 hover:bg-amber-600 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="moverParaPendenciaPrompt('${escapeHtml(id)}')">Pendência</button>
                <button class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="updateStatusJsonp('${escapeHtml(id)}','Em Separação')">Iniciar</button>
                <button class="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="updateStatusJsonp('${escapeHtml(id)}','Pronto p/ Entrega')">Concluir</button>
              </div>
            </td>
          </tr>`;
      }).join('');
    }
  }

  // Separados hoje
  if (tbodySepHoje) {
    const prontosOrders = orders.filter(o => {
      const matchStatus = (typeof isSeparatedReadyStatus === 'function') ? isSeparatedReadyStatus(o) : String(o.status_logistica || '').toLowerCase().trim().includes('pronto');
      const matchData = (typeof shouldShowSeparatedForOperationalDate === 'function') ? shouldShowSeparatedForOperationalDate(o) : true;
      const matchBusca = (String(o.numero || '').toLowerCase().includes(searchQ) || String(o.cliente_nome || '').toLowerCase().includes(searchQ));
      return matchStatus && matchData && matchBusca;
    });
    tbodySepHoje.innerHTML = prontosOrders.length === 0 ? `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">Nenhum registro encontrado.</td></tr>` : prontosOrders.map((o, idx) => `
      <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm">
        <td class="p-3 pl-4 font-bold text-slate-900">#${escapeHtml(o.numero)}</td>
        <td class="p-3 font-semibold text-slate-800">${escapeHtml(o.cliente_nome)}</td>
        <td class="p-3 text-center"><span class="text-blue-700 font-mono font-bold bg-blue-50 px-2.5 py-1 rounded-lg border border-blue-100">${escapeHtml(o.tempo_separacao || '—')}</span></td>
        <td class="p-3 text-center"><span class="status-pill badge-strict-verde"><span class="status-dot dot-strict-verde"></span>Separado</span></td>
        <td class="p-3 pr-4 text-right"><button class="bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 px-3 py-1 rounded-lg font-bold text-[11px] transition-all" onclick="updateStatusJsonp('${escapeHtml(o.id)}','A Separar')"><i class="fas fa-rotate-left mr-1"></i>Refazer</button></td>
      </tr>`).join('');
  }

// Pendências - Novo Fluxo com Lista, Link do Tiny e Edição
  if (tbodyPend) {
    const pendOrders = orders.filter(o => {
      const matchData = (typeof shouldShowLogisticForOperationalDate === 'function') ? shouldShowLogisticForOperationalDate(o) : true;
      return String(o.status_logistica || '').toLowerCase().trim() === 'pendente' && matchData;
    });
    tbodyPend.innerHTML = pendOrders.length === 0 ? `<tr><td colspan="4" class="p-4 text-center text-slate-400 font-semibold">Nenhuma pendência ativa no momento.</td></tr>` : pendOrders.map((o, idx) => {
      
      const obsOriginal = o.observacao_logistica || o.observacao || '';
      const hasSolucao = obsOriginal.includes('[Solução]');
      
      let inputHtml = '';
      let btnHtml = '';

      if (hasSolucao) {
          const matchSolucao = obsOriginal.split('[Solução]')[1].trim();
          const partes = matchSolucao.split('[Link]');
          const solucaoText = partes[0].trim();
          const linkText = partes[1] ? partes[1].trim() : '';

          const listItems = solucaoText.split('\n').filter(item => item.trim() !== '').map(item => `<li><i class="fas fa-check text-emerald-500 mr-1"></i> ${escapeHtml(item.trim())}</li>`).join('');
          
          inputHtml = `<div class="bg-emerald-50 px-3 py-2 rounded-lg border border-emerald-100 w-full">
                         <ul class="text-xs font-bold text-emerald-700 space-y-1">${listItems}</ul>`;
          
          if (linkText) {
              inputHtml += `<div class="mt-2.5 border-t border-emerald-200/60 pt-2">
                              <a href="${escapeHtml(linkText)}" target="_blank" class="bg-blue-600 hover:bg-blue-700 text-white font-bold px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider inline-flex items-center gap-1.5 shadow-sm transition-all">
                                <i class="fas fa-file-invoice"></i> PEDIDO Atualizado
                              </a>
                            </div>`;
          }
          inputHtml += `</div>`;

          btnHtml = `
            <div class="flex flex-col gap-1.5">
              <button class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-[11px] font-bold shadow-sm transition-all whitespace-nowrap" onclick="updateStatusJsonp('${escapeHtml(o.id)}', 'Pronto p/ Entrega', '${escapeHtml(obsOriginal)}')"><i class="fas fa-box mr-1"></i>Registrar Separado</button>
              <button class="bg-white hover:bg-slate-100 text-slate-600 px-3 py-1.5 rounded-lg text-[10px] font-bold shadow-sm transition-all border border-slate-200" onclick="editarSolucaoPendencia('${escapeHtml(o.id)}')"><i class="fas fa-edit mr-1"></i>Alterar Produto</button>
            </div>`;
     } else {
          inputHtml = `
            <div class="space-y-2 w-full">
              <textarea id="solucao-${escapeHtml(o.id)}" rows="2" class="w-full bg-slate-50 border border-slate-200 px-3 py-2 rounded-lg text-xs outline-none focus:border-amber-500 focus:bg-white transition-all font-semibold text-slate-800 resize-none" placeholder="Digite os produtos (pressione Enter para listar)"></textarea>
              <div class="relative">
                <i class="fas fa-link absolute left-2.5 top-2.5 text-slate-400 text-[10px]"></i>
                <input type="text" id="link-${escapeHtml(o.id)}" class="w-full bg-slate-50 border border-slate-200 pl-6 pr-3 py-1.5 rounded-lg text-[11px] outline-none focus:border-amber-500 focus:bg-white transition-all font-semibold text-slate-600 font-mono" placeholder="Cole o link do Tiny aqui (OBRIGATÓRIO)">
              </div>
            </div>`;
          btnHtml = `<button class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg text-[11px] font-bold shadow-sm transition-all whitespace-nowrap" onclick="salvarSolucaoPendencia('${escapeHtml(o.id)}')"><i class="fas fa-save mr-1"></i>Salvar Solução</button>`;
      }

      const motivoExibicao = obsOriginal.split('|')[0] || obsOriginal;

      return `
      <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} text-xs md:text-sm text-slate-700 hover:bg-slate-100/50">
        <td class="p-3 pl-4 font-black text-slate-900 align-top">#${escapeHtml(o.numero)}</td>
        <td class="p-3 align-top">
          <div class="font-bold text-slate-800 mb-1">${escapeHtml(o.cliente_nome)}</div>
          <div class="text-red-600 font-medium text-[10px] bg-red-50 inline-block px-2 py-0.5 rounded border border-red-100"><i class="fas fa-circle-exclamation"></i> ${escapeHtml(motivoExibicao)}</div>
        </td>
        <td class="p-3 align-top w-2/5">${inputHtml}</td>
        <td class="p-3 pr-4 text-right align-top">${btnHtml}</td>
      </tr>`;
    }).join('');
  }

  // FLEX (AGORA COM BOTÃO DE FOCO)
  if (tbodyFlexCorpo) {
    const flexFiltrados = (flexOrders || []).filter(f => {
      const q = (searchQ || '').toLowerCase();
      const matchData = (typeof shouldShowFlexForOperationalDate === 'function') ? shouldShowFlexForOperationalDate(f) : true;
      const matchBusca = (
        String(f.numero || '').toLowerCase().includes(q) ||
        String(f.cliente_nome || '').toLowerCase().includes(q) ||
        String(f.endereco_completo || '').toLowerCase().includes(q) ||
        String(f.numero_ecommerce || '').toLowerCase().includes(q) ||
        String(f.store_name || '').toLowerCase().includes(q)
      );
      return matchData && matchBusca;
    });

    if (!flexFiltrados || flexFiltrados.length === 0) {
      tbodyFlexCorpo.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido Flex detectado.</td></tr>`;
    } else {
      tbodyFlexCorpo.innerHTML = flexFiltrados.map((f, idx) => {
        const numeroDoc = f.numero || 'S/N';
        const numeroEcom = f.numero_ecommerce || f.referencia || '—';
        const volumesNum = f.qtd_volumes || f.volumes || f.items_count || '1';
        const clienteNome = f.cliente_nome || f.destinatario || f.cliente || '—';
        const lojaNome = f.store_name || '—';
        const addrDisplay = f.endereco_completo || '';
        const dataPrev = f.data_prevista || '—';
        const situacaoFlex = f.situacao_nome || f.situacao || '—';
        const focusId = escapeHtml(normalizeEcomNumber(numeroEcom) || normalizeOrderNumber(numeroDoc));
        
        const valorDisplay = f.valor && f.valor !== '—' && f.valor !== '' ? f.valor : 'R$ 0,00';
        const produtosDisplay = f.produtos && f.produtos !== '—' && f.produtos !== '' ? f.produtos : 'Sincronize para ver os itens...';

        return `
          <tr data-num="${escapeHtml(normalizeOrderNumber(f.numero || ''))}" data-ecom="${escapeHtml(normalizeEcomNumber(numeroEcom))}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm text-slate-700 cursor-pointer" onclick="focusFlexOnMap('${focusId}')">
            <td class="p-3 pl-4 font-bold text-slate-900">
              <div class="flex items-center gap-1.5">
                <span>#${escapeHtml(numeroDoc)}</span>
                <button class="ml-2 bg-amber-50 hover:bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-md text-[10px] font-bold inline-flex items-center transition-all border border-amber-200" title="Ver localização no mapa" onclick="event.stopPropagation(); focusFlexOnMap('${focusId}')">
                  <i class="fas fa-crosshairs"></i>
                </button>
              </div>
              <div class="text-[11px] text-slate-400">E‑com: ${escapeHtml(numeroEcom)}</div>
            </td>
            <td class="p-3 text-center">${escapeHtml(String(volumesNum))}</td>
            <td class="p-3">
              <b class="text-slate-900">${escapeHtml(clienteNome)}</b>
              <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(addrDisplay)}</div>
              <div class="flex items-center gap-3 text-[10px] text-slate-500 mt-1.5 font-medium">
                 <span>Loja: <b class="text-slate-700">${escapeHtml(lojaNome)}</b></span>
                 <span>Valor: <b class="text-emerald-600">${escapeHtml(valorDisplay)}</b></span>
              </div>
              <div class="text-[10px] text-blue-700 mt-2 font-bold leading-tight bg-blue-50/80 p-1.5 rounded border border-blue-100 inline-block w-full">
                <i class="fas fa-box-open mr-1 text-blue-500"></i> ${escapeHtml(produtosDisplay)}
              </div>
            </td>
            <td class="p-3 text-center hidden md:table-cell"><span class="font-mono text-slate-700 font-bold">${escapeHtml(dataPrev)}</span></td>
            <td class="p-3 hidden md:table-cell">${escapeHtml(situacaoFlex)}</td>
            <td class="p-3 pr-4 text-right">
              <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;">
                <button class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-xl font-bold text-[11px] shadow-sm transition-all" onclick="event.stopPropagation(); markFlexDelivered('${escapeHtml(f.id || f.numero)}','${escapeHtml(numeroDoc)}')"><i class="fas fa-check-double"></i> Entregue</button>
              </div>
            </td>
          </tr>`;
      }).join('');
    }
  }

  // Entregues
  if (tbodyEntregues) {
    const entregueOrders = orders.filter(o => {
      const matchData = (typeof shouldShowDeliveredForOperationalDate === 'function') ? shouldShowDeliveredForOperationalDate(o) : true;
      const matchBusca = (String(o.numero || '').toLowerCase().includes(searchQ) || String(o.cliente_nome || '').toLowerCase().includes(searchQ));
      return String(o.status_logistica || '').toLowerCase().trim() === 'entregue' && matchData && matchBusca;
    });
    
    tbodyEntregues.innerHTML = entregueOrders.length === 0 ? `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">Nenhum despacho realizado.</td></tr>` : entregueOrders.map((o, idx) => {
      
      let recNome = o.nome_recebedor;
      let recDoc = o.doc_recebedor;

      if (!recNome) {
         const strTotal = JSON.stringify(o);
         const match = strTotal.match(/Recebido por:\s*(.*?)\s*\(Doc:\s*(.*?)\)/);
         if (match) {
           recNome = match[1].trim();
           recDoc = match[2].trim();
         }
      }

      const displayNome = recNome || '—';
      const displayDoc = recDoc || '—';

      return `
      <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm">
        <td class="p-3 pl-4 font-black text-slate-900">#${escapeHtml(o.numero)}</td>
        <td class="p-3 font-semibold text-slate-800">${escapeHtml(o.cliente_nome)}</td>
        
        <td class="p-3 hidden md:table-cell">
          <div class="font-bold text-slate-800 flex items-center gap-1.5"><i class="fas fa-user-check text-blue-500"></i>${escapeHtml(displayNome)}</div>
          <div class="text-[11px] text-slate-500 mt-0.5 font-mono"><i class="fas fa-id-card text-slate-400 mr-1"></i>Doc: ${escapeHtml(displayDoc)}</div>
        </td>

        <td class="p-3 text-center text-emerald-700 font-mono font-bold">${escapeHtml(o.tempo_separacao || '—')}</td>
        <td class="p-3 pr-4 text-center"><span class="bg-slate-100 text-slate-600 font-bold border border-slate-200 px-3 py-1 rounded-xl text-[10px] uppercase tracking-wider inline-flex items-center gap-1"><i class="fas fa-archive text-slate-400"></i> Finalizado</span></td>
      </tr>`;
    }).join('');
  }

  // LOGÍSTICA — preenchimento correto (resolução do problema)
  if (tbodyLog) {
    const logFiltrados = (orders || []).filter(o => {
      if (!o) return false;
      const frete = String(o.nomeformafenvio || o.nome_forma_envio || o.forma_envio || '').toLowerCase();
      if (frete.includes('flex') || frete.includes('mercado')) return false;
      const matchData = (typeof shouldShowLogisticForOperationalDate === 'function') ? shouldShowLogisticForOperationalDate(o) : true;
      if (!matchData) return false;
      if (searchQ) {
        return (String(o.numero || '').toLowerCase().includes(searchQ) ||
                String(o.cliente_nome || '').toLowerCase().includes(searchQ) ||
                String(o.endereco_completo || '').toLowerCase().includes(searchQ) ||
                String(o.numero_ecommerce || '').toLowerCase().includes(searchQ));
      }
      return true;
    });

    if (logFiltrados.length === 0) {
      tbodyLog.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido logístico disponível.</td></tr>`;
    } else {
      tbodyLog.innerHTML = logFiltrados.map((o, idx) => {
        const id = o.id || o.numero || '';
        const dataPrev = o.data_prevista ? (parseAnyDateValue(o.data_prevista) ? formatToDDMMYYYY(parseAnyDateValue(o.data_prevista)) : String(o.data_prevista)) : '—';
        const status = (typeof getOperationalEventLabel === 'function' ? getOperationalEventLabel(o) : '') || o.situacao_nome || '—';
        const endereco = o.endereco_completo || o.endereco || '';
        return `
          <tr id="log-row-${escapeHtml(String(id))}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm border-b border-slate-100">
            <td class="p-3 pl-4 font-bold text-slate-900">#${escapeHtml(String(o.numero || id))}</td>
            <td class="p-3 text-center font-mono text-[#004f9f] font-bold hidden md:table-cell">${escapeHtml(dataPrev)}</td>
            <td class="p-3">
              <div class="font-semibold">${escapeHtml(o.cliente_nome || '—')}</div>
              <div class="text-[11px] text-slate-500 mt-1 truncate hidden lg:block">${escapeHtml(endereco)}</div>
            </td>
            <td class="p-3 hidden md:table-cell">${escapeHtml(status)}</td>
            <td class="p-3 align-middle text-xs">
              <span class="px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-[11px]">${escapeHtml(String(o.forma_pagamento || o.nomeformafenvio || '—'))}</span>
            </td>
            <td class="p-3 pr-4 text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px]" onclick="focusOrderOnMap('${escapeHtml(String(o.numero || id))}')"><i class="fas fa-crosshairs mr-1"></i>Localizar</button>
                <button class="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px]" onclick="updateStatusJsonp('${escapeHtml(String(id))}','Pronto p/ Entrega')">Concluir</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // Sumários
  const sumSepararEl = document.getElementById('sum-separar');
  const sumProcessoEl = document.getElementById('sum-processo');
  const sumTotalEl = document.getElementById('sum-total');
  const sumFlexEl = document.getElementById('sum-flex-total');
  if(sumSepararEl) sumSepararEl.innerText = orders.filter(o => (!o.status_logistica || String(o.status_logistica).toLowerCase().includes('a separar')) && ((typeof shouldShowOrderForQueueDate === 'function') ? shouldShowOrderForQueueDate(o) : true)).length;
  if(sumProcessoEl) sumProcessoEl.innerText = orders.filter(o => String(o.status_logistica).toLowerCase().includes('em separa') && ((typeof shouldShowOrderForQueueDate === 'function') ? shouldShowOrderForQueueDate(o) : true)).length;
  if(sumTotalEl) sumTotalEl.innerText = orders.filter(o => (typeof shouldShowLogisticForOperationalDate === 'function') ? shouldShowLogisticForOperationalDate(o) : true).length;
  if(sumFlexEl) {
     const flexFiltrados = (flexOrders || []).filter(f => String(f.numero || '').trim() !== '' && ((typeof shouldShowFlexForOperationalDate === 'function') ? shouldShowFlexForOperationalDate(f) : true));
     sumFlexEl.innerText = flexFiltrados.length;
  }

  document.querySelectorAll('tr[data-num]').forEach(tr => {
    const raw = tr.getAttribute('data-num') || '';
    tr.setAttribute('data-num', normalizeOrderNumber(raw));
  });
  document.querySelectorAll('tr[data-ecom]').forEach(tr => {
    const raw = tr.getAttribute('data-ecom') || '';
    tr.setAttribute('data-ecom', normalizeEcomNumber(raw));
  });

  try {
    const logOrdersForMap = (orders || []).filter(o => {
      const frete = String(o.nomeformafenvio || o.nome_forma_envio || o.forma_envio || '').toLowerCase();
      const matchData = (typeof shouldShowLogisticForOperationalDate === 'function') ? shouldShowLogisticForOperationalDate(o) : true;
      return !frete.includes('flex') && !frete.includes('mercado') && matchData;
    });
    const flexFiltradosParaMapa = (flexOrders || []).filter(f => String(f.numero || '').trim() !== '' && ((typeof shouldShowFlexForOperationalDate === 'function') ? shouldShowFlexForOperationalDate(f) : true));
    plotMapMarkers(logOrdersForMap, flexFiltradosParaMapa);
  } catch (e) {
    console.warn('plotMapMarkers erro', e);
  }
  // Dispara a atualização do painel do motorista se implementado
  if (typeof renderMotorista === 'function') try { renderMotorista(); } catch(e) {}
}
// Ajusta automaticamente a altura da área rolável e aplica comportamento sticky no mapa
function initScrollablePanels(options = {}) {
  const headerOffset = options.headerOffset ?? 100; // ajuste se seu header for maior/menor
  const leftSelectors = options.leftSelectors ?? ['#view-logistica .card', '#view-separacao .card', '.left-panel', '.list-column'];
  const rightMapSelectors = options.mapSelectors ?? ['#map', '#map-active', '#map-wrapper', '#map-flex'];

  // procura o primeiro item que exista no DOM
  let leftEl = null;
  for (const s of leftSelectors) { leftEl = document.querySelector(s); if (leftEl) break; }
  let mapEl = null;
  for (const s of rightMapSelectors) { mapEl = document.querySelector(s); if (mapEl) break; }

  if (leftEl) {
    // cria wrapper scroll-area se não existir
    if (!leftEl.querySelector('.scroll-area')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'scroll-area';
      // move conteúdo atual para o wrapper
      while (leftEl.firstChild) wrapper.appendChild(leftEl.firstChild);
      leftEl.appendChild(wrapper);
    }
    const scrollArea = leftEl.querySelector('.scroll-area');
    function resizeLeft() {
      scrollArea.style.maxHeight = `calc(100vh - ${headerOffset}px)`;
    }
    window.addEventListener('resize', resizeLeft);
    resizeLeft();
  }

  if (mapEl) {
    // aplica classe sticky ao container do mapa
    const parent = mapEl.parentElement;
    if (parent && !parent.classList.contains('map-sticky')) {
      parent.classList.add('map-sticky');
      parent.style.top = `${headerOffset - 10}px`;
      parent.style.height = `calc(100vh - ${headerOffset}px)`;
    }
    // se o mapa já foi inicializado, força invalidateSize quando rolar a area
    const scrollArea = (leftEl && leftEl.querySelector('.scroll-area')) ? leftEl.querySelector('.scroll-area') : null;
    if (scrollArea && map) {
      scrollArea.addEventListener('scroll', debounce(() => {
        try { if (map) map.invalidateSize(); if (mapFlex) mapFlex.invalidateSize(); } catch(e){}
      }, 150));
    }
  }
}

// chamar na inicialização
document.addEventListener('DOMContentLoaded', () => {
  // ajuste headerOffset se precisar
  initScrollablePanels({ headerOffset: 100 });
});
// --- Inits, mapas e handlers menores ---
function initMap() {
  try {
    const mapEl = document.getElementById('map') || document.getElementById('map-active') || document.getElementById('map-active');
    const mapFlexEl = document.getElementById('map-flex');
    if (!mapEl || !mapFlexEl) {
      return;
    }
    if (window._vesco_map_inited) return;
    window._vesco_map_inited = true;

    map = L.map(mapEl.id || 'map').setView([-23.55052, -46.633308], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(map);
    if (typeof L.markerClusterGroup === 'function') {
      markerCluster = L.markerClusterGroup({ iconCreateFunction: function(cluster) { return new L.DivIcon({ html: '<div><span>' + cluster.getChildCount() + '</span></div>', className: 'marker-cluster marker-cluster-main', iconSize: new L.Point(40, 40) }); } });
    } else { markerCluster = L.layerGroup(); }
    map.addLayer(markerCluster);

    mapFlex = L.map(mapFlexEl.id || 'map-flex').setView([-23.55052, -46.633308], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(mapFlex);
    if (typeof L.markerClusterGroup === 'function') {
      markerClusterFlex = L.markerClusterGroup({ chunkedLoading: true, iconCreateFunction: function(cluster) { return new L.DivIcon({ html: '<div><span>' + cluster.getChildCount() + '</span></div>', className: 'marker-cluster marker-cluster-flex', iconSize: new L.Point(40, 40) }); } });
    } else { markerClusterFlex = L.layerGroup(); }
    mapFlex.addLayer(markerClusterFlex);

    window.map = map;
    window.mapFlex = mapFlex;
    window.markerCluster = markerCluster;
    window.markerClusterFlex = markerClusterFlex;

    setTimeout(()=>{ try { if (map) map.invalidateSize(); if (mapFlex) mapFlex.invalidateSize(); } catch(e){} }, 300);
  } catch(e){ console.warn('initMap erro', e); }
}

// focus helpers
function findMainMarkerByKey(key){
  if(!key) return null;
  const k1 = normalizeEcomNumber(key);
  const k2 = normalizeOrderNumber(key);
  if(k1 && window.activeMainMarkers[k1]) return window.activeMainMarkers[k1];
  if(k2 && window.activeMainMarkers[k2]) return window.activeMainMarkers[k2];
  if(window.activeMainMarkers[key]) return window.activeMainMarkers[key];
  return null;
}
function findFlexMarkerByKey(key){
  if(!key) return null;
  const k1 = normalizeEcomNumber(key);
  const k2 = normalizeOrderNumber(key);
  if(k1 && window.activeFlexMarkers[k1]) return window.activeFlexMarkers[k1];
  if(k2 && window.activeFlexMarkers[k2]) return window.activeFlexMarkers[k2];
  if(window.activeFlexMarkers[key]) return window.activeFlexMarkers[key];
  return null;
}

function focusOrderOnMap(numeroOrEcom) {
  const marker = findMainMarkerByKey(numeroOrEcom);
  if (marker) {
    switchTab('logistica');
    setTimeout(() => { // Aguarda a aba ser trocada antes de centralizar
        const latLng = marker.getLatLng();
        map.setView(latLng, 16);
        marker.openPopup();
        document.getElementById('map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
  } else {
    showToast("Aguardando carregamento das coordenadas no mapa...");
  }
}
function focusFlexOnMap(numeroOrEcom) {
  const marker = findFlexMarkerByKey(numeroOrEcom);
  if (marker) {
    switchTab('envios_flex');
    setTimeout(() => { // Aguarda a aba ser trocada antes de centralizar
        const latLng = marker.getLatLng();
        mapFlex.setView(latLng, 16);
        marker.openPopup();
        document.getElementById('map-flex')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
  } else {
    showToast("Aguardando carregamento das coordenadas no mapa...");
  }
}

// UI small utils
function showLoading(on){ const el = document.getElementById('loadingOverlay') || document.getElementById('loading-overlay'); if(el) el.style.display = on ? 'flex' : 'none'; }
function showToast(msg, ms=2500){ const t=document.getElementById('toast') || document.getElementById('toast-container'); if(!t) { console.log(msg); return; } t.innerHTML=String(msg); t.style.display='block'; setTimeout(()=>t.style.display='none', ms); }

// --- JSONP updates (única versão mantida) ---
function updateStatusJsonp(id, status, observacao = ''){
  showLoading(true);

  // Normaliza o status que vamos enviar para o backend
  let sendStatus = status;
  if (status === 'Pronto p/ Entrega') {
    sendStatus = 'Separado';
  }

  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const dd = String(hoje.getDate()).padStart(2, '0');
  const dataSeparacaoBR = `${dd}/${mm}/${yyyy}`;

  const url = `${API}?action=updateStatus&id=${encodeURIComponent(id)}&status=${encodeURIComponent(sendStatus)}&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(observacao)}&dataSeparacao=${encodeURIComponent(dataSeparacaoBR)}`;

  jsonpFetch(url, function(err, response){
  showLoading(false);
  if(err) { showToast('Erro ao atualizar status', 3500); return; }
  // Aqui: se o status enviado indica que o pedido está pronto para entrega, notifica motorista
  const normalizedSend = sendStatus.toLowerCase();
  if (normalizedSend === 'separado' || normalizedSend === 'pronto p/ entrega') {
    // encontra o pedido localmente para enviar ao motorista
    const order = (orders || []).find(o => String(o.id) === String(id) || String(o.numero) === String(id));
    if (order) {
      sendDriverNotification(order).then(res => {
        console.info('Driver notification result', res);
      }).catch(err => console.warn('Driver notify error', err));
    }
  }
  load();
  setTimeout(()=>{ if(typeof switchTab === 'function') switchTab('logistica'); }, 600);
});
}

function updateFlexStatusJsonp(id, status, observacao = '', cb){
  showLoading(true);
  const url = `${API_FLEX}?action=updateStatus&id=${encodeURIComponent(id)}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(observacao)}`;
  jsonpFetch(url, function(err, resp){
    showLoading(false);
    if(typeof cb === 'function') cb(err, resp);
    load();
  });
}

function updateAlarmTimeJsonp(id, timeValue) {
  if (!timeValue) return;
  showLoading(true);
  const url = `${API}?action=updateStatus&id=${id}&alarme=${encodeURIComponent(timeValue)}&operador=${encodeURIComponent(currentOperator)}`;
  jsonpFetch(url, function(){ showLoading(false); load(); });
}

function markFlexDelivered(id, numero){
  if(!id) return;
  if(!confirm(`Confirmar entrega do Flex ${numero || id} ?`)) return;
  const f = (flexOrders||[]).find(x => String(x.id || x.numero) === String(id));
  updateFlexStatusJsonp(id, 'Entregue', `Confirmado via painel por ${currentOperator}`, function(err, resp){
    if(f){
      const newOrder = { id: f.id || f.numero || (`flex-${Date.now()}`), numero: f.numero || f.id || '', cliente_nome: f.destinatario || f.cliente || f.nome || '', endereco_completo: f.endereco_completo || '', tempo_separacao: '—', status_logistica: 'Entregue' };
      flexOrders = (flexOrders || []).filter(x => String(x.id || x.numero) !== String(id));
      orders = orders || [];
      orders.push(newOrder);
      scheduleRender();
      switchTab('entregues');
      showToast(`Flex ${numero || id} marcado como entregue.`);
    } else {
      load();
      showToast(`Atualizando — verifique se Flex ${numero || id} foi registrado.`);
    }
  });
}

function switchTab(which){
  document.getElementById('view-tarefas')?.classList.toggle('hidden', which !== 'tarefas');
  if(document.getElementById('main-tarefas')) document.getElementById('main-tarefas').className = which === 'tarefas' ? 'tab-btn active' : 'tab-btn';
  document.getElementById('view-separacao')?.classList.toggle('hidden', which !== 'separacao');
  document.getElementById('view-separados_hoje')?.classList.toggle('hidden', which !== 'separados_hoje');
  document.getElementById('view-logistica')?.classList.toggle('hidden', which !== 'logistica');
  document.getElementById('view-envios_flex')?.classList.toggle('hidden', which !== 'envios_flex');
  document.getElementById('view-rotas')?.classList.toggle('hidden', which !== 'rotas');
  document.getElementById('view-entregues')?.classList.toggle('hidden', which !== 'entregues');
  document.getElementById('view-motorista')?.classList.toggle('hidden', which !== 'motorista');
  
  if(document.getElementById('main-sep')) document.getElementById('main-sep').className = which === 'separacao' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-sephoje')) document.getElementById('main-sephoje').className = which === 'separados_hoje' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-log')) document.getElementById('main-log').className = which === 'logistica' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-flex')) document.getElementById('main-flex').className = which === 'envios_flex' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-rotas')) document.getElementById('main-rotas').className = which === 'rotas' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-ent')) document.getElementById('main-ent').className = which === 'entregues' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-mot')) document.getElementById('main-mot').className = which === 'motorista' ? 'tab-btn active' : 'tab-btn';
  
  if(which === 'logistica') {
    setTimeout(() => {
      try {
        if (map) map.invalidateSize();
        const b = markerCluster && markerCluster.getBounds && markerCluster.getBounds();
        if(b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 14, animate: false });
      } catch(e){}
    }, 250);
  }
  if(which === 'envios_flex') { 
    setTimeout(() => {
      try { 
        if (mapFlex) mapFlex.invalidateSize(); 
        if(markerClusterFlex && markerClusterFlex.getLayers && markerClusterFlex.getLayers().length > 0){
          const b = markerClusterFlex.getBounds();
          if(b && b.isValid && b.isValid()) {
            if(b.getSouthWest().equals(b.getNorthEast())) mapFlex.setView(b.getSouthWest(), 14);
            else mapFlex.fitBounds(b.pad(0.12), { maxZoom: 14, animate: false });
          }
        }
      } catch(e){}
    }, 300);
  }
  if(which === 'rotas') {
    setTimeout(() => {
       try { if (typeof plotRotasMap === 'function') plotRotasMap(); } catch(e){}
       try { if (typeof renderRotas === 'function') renderRotas(); } catch(e){}
    }, 300);
  }
  if(which === 'motorista') {
    setTimeout(() => {
      if(typeof resizeCanvas === 'function') resizeCanvas();
    }, 200);
  }
}

function switchSubTab(name){
  document.getElementById('subview-fila')?.classList.toggle('hidden', name !== 'fila');
  document.getElementById('subview-pendencias')?.classList.toggle('hidden', name !== 'pendencias');
  document.getElementById('sub-fila') && (document.getElementById('sub-fila').className = name==='fila' ? 'bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 transition-all');
  document.getElementById('sub-pend') && (document.getElementById('sub-pend').className = name==='pendencias' ? 'bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 transition-all');
}

function checkOperator() { if (!currentOperator) { const modal = document.getElementById('operatorModal'); if(modal) modal.classList.remove('hidden'); } else { const el = document.getElementById('activeOperatorDisplay'); if(el) el.innerText = `Op: ${currentOperator}`; } }
function saveOperator() { const name = (document.getElementById('operatorNameInput')?.value || '').trim(); if(name) { localStorage.setItem('vesco_operator', name); currentOperator = name; const modal = document.getElementById('operatorModal'); if(modal) modal.classList.add('hidden'); const el = document.getElementById('activeOperatorDisplay'); if(el) el.innerText = `Op: ${currentOperator}`; } }

// --- Eventos da tabela foram removidos, usamos os botões Crosshair e Onclick da Row ---
document.addEventListener('DOMContentLoaded', function(){
  (function ensureFlexScrollableInit(){
    const flexCard = document.querySelector('#view-envios_flex .card');
    if(flexCard){
      const offset = 240;
      flexCard.style.maxHeight = (window.innerHeight - offset) + 'px';
      flexCard.style.overflowY = 'auto';
      flexCard.style.overflowX = 'auto';
    }
  })();
});

// --- Inicialização principal (bootstrap) ---
document.addEventListener('DOMContentLoaded', function() {
  try {
    setTodayDate();
    initMap();
    let attempts = 0;
    const tryInit = setInterval(()=>{ attempts++; if(window._vesco_map_inited) { clearInterval(tryInit); return; } initMap(); if(attempts>6) clearInterval(tryInit); }, 500);

    checkOperator();
    load();

    // Preservado, porém controlado: o painel não atualiza sozinho; somente pelo botão Atualizar.
    if (!window.VESCO_DISABLE_AUTO_REFRESH) setInterval(load, 60000);
    setInterval(()=> {
      const horaBrasiliaStr = new Date().toLocaleTimeString('pt-BR', {timeZone: 'America/Sao_Paulo'});
      const clockEl = document.getElementById('clock');
      if (clockEl) clockEl.innerText = horaBrasiliaStr;
      if (typeof window.checkTimeAlarms === 'function') window.checkTimeAlarms(horaBrasiliaStr);
    }, 1000);
  } catch(e) {
    console.warn('Erro na inicialização principal', e);
  }
});

function setTodayDate() {
  const dBr = new Date();
  const offset = dBr.getTimezoneOffset();
  const topCalendar = document.getElementById('topCalendar');
  if (topCalendar) {
    const savedISO = currentOperationalDateISO || localStorage.getItem('vesco_operational_date_iso') || '';
    topCalendar.value = dateValueToISO(savedISO) || new Date(dBr.getTime() - (offset*60*1000)).toISOString().split('T')[0];
    if (typeof setSelectedOperationalDateISO === 'function') setSelectedOperationalDateISO(topCalendar.value);
  }
}
// =================================================================
// 1. SISTEMA DE NOTIFICAÇÕES E RASTREIO DE OPERADOR
// =================================================================

function showToast(msg, type = 'info', ms = 4000) {
  const t = document.getElementById('toast') || document.getElementById('toast-container');
  if(!t) { console.log(msg); return; }
  
  let bg = 'bg-slate-800';
  if(type === 'success') bg = 'bg-emerald-600';
  if(type === 'warning') bg = 'bg-amber-500';
  if(type === 'error') bg = 'bg-red-600';

  t.className = `toast fixed top-4 right-4 ${bg} text-white px-5 py-3 rounded-xl shadow-2xl font-bold text-sm flex items-center gap-3 z-[9999] transition-all transform translate-y-0 opacity-100`;
  t.innerHTML = `<i class="fas fa-bell"></i> <div>${msg}</div>`;
  t.style.display = 'flex';
  
  setTimeout(() => {
    t.classList.add('opacity-0', '-translate-y-5');
    setTimeout(() => t.style.display = 'none', 300);
  }, ms);
}

// Atualizamos a função de enviar o status para gerar a notificação na tela
// (A versão unificada está acima — esta chamada adicional é compatibilidade)
window.moverParaPendenciaPrompt = (id) => {
  document.getElementById('pendenciaId').value = id;
  document.getElementById('pendenciaPedidoDisplay').innerText = `Pedido #${id}`;
  document.getElementById('pendenciaDetalhes').value = '';
  document.getElementById('pendenciaModal').classList.remove('hidden');
};

window.fecharPendenciaModal = () => {
  document.getElementById('pendenciaModal').classList.add('hidden');
};

window.salvarPendenciaModal = () => {
  const id = document.getElementById('pendenciaId').value;
  const motivo = document.getElementById('pendenciaMotivo').value;
  const detalhes = document.getElementById('pendenciaDetalhes').value;
  
  if(detalhes.trim() === '') return alert("Por favor, especifique os detalhes/produtos faltantes.");
  
  const observacaoFinal = `[${motivo}] ${detalhes}`;
  fecharPendenciaModal();
  updateStatusJsonp(id, 'Pendente', observacaoFinal);
};

// --- Alarme / pop-up ---
window.checkTimeAlarms = (horaAtualStr) => {
  const horaMinutoAtual = horaAtualStr.slice(0, 5); 
  (orders || []).forEach(o => {
    if (o.alarme && o.alarme === horaMinutoAtual && !o.alarmeTocado) {
      o.alarmeTocado = true;
      if(typeof playBeepSound === 'function') playBeepSound();
      const modal = document.getElementById('snoozeModal');
      const numDisplay = document.getElementById('modalOrderNum');
      if (modal && numDisplay) {
        numDisplay.innerText = `#${o.numero || o.id}`;
        modal.classList.remove('hidden');
      }
    }
  });
};
document.getElementById('btnSnoozeAction')?.addEventListener('click', function() {
  document.getElementById('snoozeModal')?.classList.add('hidden');
  stopAudioAlarm();
});

// =================================================================
// ASSINATURA DIGITAL (APP MOTORISTA) & envios
// =================================================================
let canvas, ctx, desenhando = false;
function resizeCanvas() {
  if(!canvas) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1e293b';
}
function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const ev = e.touches ? e.touches[0] : e;
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}
function startPosition(e) { desenhando = true; draw(e); }
function endPosition() { desenhando = false; ctx && ctx.beginPath(); }
function draw(e) {
  if (!desenhando || !ctx) return;
  e.preventDefault();
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
}
document.addEventListener("DOMContentLoaded", () => {
  canvas = document.getElementById('signatureCanvas');
  if(!canvas) return;
  ctx = canvas.getContext('2d');
  canvas.addEventListener('mousedown', startPosition);
  canvas.addEventListener('mouseup', endPosition);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('touchstart', startPosition, {passive: true});
  canvas.addEventListener('touchend', endPosition);
  canvas.addEventListener('touchmove', draw, {passive: false});
});

window.limparAssinatura = () => {
  if(ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
  }
};

window.enviarComprovante = () => {
  const pedidoId = document.getElementById('motPedidoInput').value.trim();
  const recebedor = document.getElementById('motRecebedor').value.trim();
  const documento = document.getElementById('motDocumento').value.trim();
  const transportador = document.getElementById('motTransportador').value;
  
  if(!pedidoId || !recebedor) return alert("Por favor, preencha o Nome de quem recebeu a mercadoria.");
  
  const docLimpo = (documento || '').replace(/\D/g, '');
  if (docLimpo.length < 8 || docLimpo.length > 14) {
      return alert("Documento inválido. Digite um RG ou CPF real (mínimo de 8 números).");
  }
  showLoading(true);

  const info = getOrderAndApi(pedidoId);
  const realId = info.order ? (info.order.id || info.order.numero) : pedidoId;

  const docFinal = documento || 'Não informado';
  const msgAudit = `Entregue via: ${transportador || '—'} | Recebido por: ${recebedor} (Doc: ${docFinal})`;

  if (info.order) {
      info.order.status_logistica = 'Entregue';
      info.order.situacao_nome = 'Entregue'; 
      info.order.nome_recebedor = recebedor;
      info.order.doc_recebedor = docFinal;
  }

  const form = document.getElementById('form-assinatura-motorista');
  if (form) form.classList.add('hidden');
  document.getElementById('motRecebedor').value = '';
  document.getElementById('motDocumento').value = '';
  
  if (typeof renderMotorista === 'function') renderMotorista();
  if (typeof render === 'function') render();
  
  const url = `${info.api}?action=updateStatus&id=${encodeURIComponent(realId)}&status=Entregue&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(msgAudit)}`;
  
  jsonpFetch(url, function(){ 
     showLoading(false);
     showToast(`Entrega #${pedidoId} finalizada com sucesso!`, 'success', 5000);
     load(); 
  });
};

// =================================================================
// FUNÇÕES MOTORISTA / DESPACHO
// =================================================================
function getOrderAndApi(rawId) {
    const norm = String(rawId || '').replace(/[^0-9A-Za-z]/g, '');
    if (typeof flexOrders !== 'undefined') {
        const f = flexOrders.find(o => String(o.numero || o.id).replace(/[^0-9A-Za-z]/g, '') === norm || String(o.id).replace(/[^0-9A-Za-z]/g, '') === norm);
        if (f) return { order: f, api: API_FLEX };
    }
    if (typeof orders !== 'undefined') {
        const o = orders.find(x => String(x.numero || x.id).replace(/[^0-9A-Za-z]/g, '') === norm || String(x.id).replace(/[^0-9A-Za-z]/g, '') === norm);
        if (o) return { order: o, api: API };
    }
    return { order: null, api: typeof API !== 'undefined' ? API : '' };
}

window.renderMotorista = () => {
  const tbodyMot = document.getElementById('table-motorista');
  if (!tbodyMot) return;

  const todosPedidos = [...(typeof orders !== 'undefined' ? orders : []), ...(typeof flexOrders !== 'undefined' ? flexOrders : [])];
  const emRota = todosPedidos.filter(o => String(o.status_logistica || o.situacao_nome || '').toLowerCase() === 'despachado');

  if (emRota.length === 0) {
    tbodyMot.innerHTML = `<tr><td colspan="3" class="p-8 text-center text-slate-400 font-bold"><i class="fas fa-box-open text-3xl mb-2 block"></i>Nenhuma entrega em rota no momento.</td></tr>`;
    return;
  }

  tbodyMot.innerHTML = emRota.map(o => `
    <tr class="hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0">
      <td class="p-3 font-black text-slate-800 text-sm">#${escapeHtml(o.numero || o.id)}</td>
      <td class="p-3 leading-tight">
        <span class="font-bold text-slate-700 text-sm">${escapeHtml(o.cliente_nome || o.destinatario || '')}</span><br>
        <span class="text-[11px] text-slate-400 font-normal"><i class="fas fa-location-dot text-slate-300 mr-1"></i>${escapeHtml(o.endereco_completo || o.endereco || '')}</span>
      </td>
      <td class="p-3 text-right">
        <button onclick="abrirAssinaturaMotorista('${escapeHtml(o.numero || o.id)}')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold text-[11px] shadow-sm transition-all uppercase whitespace-nowrap"><i class="fas fa-signature mr-1"></i> Entregar</button>
      </td>
    </tr>
  `).join('');
};

window.prepararDespachoMotorista = (numeroPedido) => {
  const info = getOrderAndApi(numeroPedido);
  const realId = info.order ? (info.order.id || info.order.numero) : numeroPedido;

  if (info.order) {
      info.order.status_logistica = 'Despachado';
      info.order.situacao_nome = 'Despachado';
  }

  showToast(`Pedido #${numeroPedido} Despachado com sucesso!`, 'success', 4000);
  switchTab('motorista');

  if (typeof renderMotorista === 'function') renderMotorista();
  if (typeof render === 'function') render();

  const url = `${info.api}?action=updateStatus&id=${encodeURIComponent(realId)}&status=Despachado&operador=${encodeURIComponent(currentOperator)}&observacao=Saiu%20para%20entrega`;

  jsonpFetch(url, function() {
    console.log("Despacho gravado. ID Real: " + realId);
  });
};

window.abrirAssinaturaMotorista = (numeroPedido) => {
  const form = document.getElementById('form-assinatura-motorista');
  if (form) form.classList.remove('hidden'); 
  
  const inputPedido = document.getElementById('motPedidoInput');
  if (inputPedido) inputPedido.value = numeroPedido; 

  const inputRecebedor = document.getElementById('motRecebedor');
  if (inputRecebedor) {
    inputRecebedor.value = ''; 
    inputRecebedor.focus();
  }
  
  if (form) form.scrollIntoView({ behavior: 'smooth', block: 'end' });
};

// =================================================================
// PENDÊNCIAS / SOLUÇÃO (vendedor)
// =================================================================
window.salvarSolucaoPendencia = function(id) {
  const inputSolucao = document.getElementById(`solucao-${id}`);
  const inputLink = document.getElementById(`link-${id}`);
  
  if(!inputSolucao || !inputSolucao.value.trim()) return alert("Operação cancelada: Informe o produto para continuar!");
  
  const solucaoTxt = inputSolucao.value.trim();
  const linkTxt = inputLink ? inputLink.value.trim() : '';
  
  if(!linkTxt) {
      return alert("Operação cancelada: É OBRIGATÓRIO colar o link do pedido atualizado no Tiny ERP para liberar a separação!");
  }
  
  const order = orders.find(o => String(o.id) === String(id) || String(o.numero) === String(id));
  const currentObs = order ? (order.observacao_logistica || order.observacao || '') : 'Pendente';
  
  const novaObs = `${currentObs} | [Solução] ${solucaoTxt} [Link] ${linkTxt}`;
  
  showLoading(true);
  
  const url = `${API}?action=updateStatus&id=${encodeURIComponent(id)}&status=Pendente&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(novaObs)}`;
  
  jsonpFetch(url, function(){
    showLoading(false);
    showToast(`Solução registrada. Liberado para separação!`, 'success');
    load();
  });
};

window.editarSolucaoPendencia = function(id) {
  const order = orders.find(o => String(o.id) === String(id) || String(o.numero) === String(id));
  if (!order) return;
  
  const currentObs = order.observacao_logistica || order.observacao || '';
  const obsLimpa = currentObs.split('| [Solução]')[0].trim();
  
  showLoading(true);
  
  const url = `${API}?action=updateStatus&id=${encodeURIComponent(id)}&status=Pendente&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(obsLimpa)}`;
  
  jsonpFetch(url, function(){
    showLoading(false);
    load(); // Atualiza a tela
  });
};

// =================================================================
// TAREFAS FROTA (front)
// =================================================================
window.tarefasFrota = window.tarefasFrota || [];

window.adicionarTarefaFrota = function() {
  const tipo = document.getElementById('novaTarefaTipo')?.value || 'Externa';
  const local = document.getElementById('novaTarefaLocal')?.value.trim() || '';
  const endereco = document.getElementById('novaTarefaEndereco')?.value.trim() || '';
  const motorista = document.getElementById('novaTarefaMotorista')?.value.trim() || '';
  
  if(!local || !motorista) return alert("Por favor, preencha o Local e o Motorista/Horário.");
  
  const novaTarefa = {
    id: Date.now(),
    tipo: tipo,
    local: local,
    endereco: endereco || '—',
    motorista: motorista,
    horaRegistro: new Date().toLocaleTimeString('pt-BR').slice(0,5)
  };
  
  window.tarefasFrota.push(novaTarefa);
  
  document.getElementById('novaTarefaLocal') && (document.getElementById('novaTarefaLocal').value = '');
  document.getElementById('novaTarefaEndereco') && (document.getElementById('novaTarefaEndereco').value = '');
  document.getElementById('novaTarefaMotorista') && (document.getElementById('novaTarefaMotorista').value = '');
  
  renderTarefasFrota();
  showToast("Tarefa registrada com sucesso! Motorista liberado.", "info");
};

window.concluirTarefaFrota = function(id) {
  window.tarefasFrota = window.tarefasFrota.filter(t => t.id !== id);
  renderTarefasFrota();
  showToast("Tarefa concluída! Motorista retornou à base.", "success");
};

window.renderTarefasFrota = function() {
  const tbody = document.getElementById('table-tarefas');
  if(!tbody) return;
  
  if(window.tarefasFrota.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400 font-semibold">Nenhuma tarefa externa em andamento.</td></tr>`;
    return;
  }
  
  tbody.innerHTML = window.tarefasFrota.map(t => `
    <tr class="hover:bg-slate-50 transition-colors border-b border-slate-100 text-xs md:text-sm">
      <td class="p-3 pl-4">
        <div class="font-bold text-teal-700 flex items-center gap-1.5"><i class="fas fa-truck text-slate-400"></i> ${escapeHtml(t.tipo)}</div>
        <div class="text-slate-800 font-semibold mt-0.5">${escapeHtml(t.local)}</div>
      </td>
      <td class="p-3 text-slate-500 font-medium">${escapeHtml(t.endereco)}</td>
      <td class="p-3 text-center">
        <div class="inline-flex items-center gap-2 bg-slate-100 px-3 py-1 rounded-lg border border-slate-200">
          <span class="font-bold text-slate-700">${escapeHtml(t.motorista)}</span>
          <span class="text-[10px] text-slate-400"><i class="far fa-clock"></i> Reg: ${escapeHtml(t.horaRegistro)}</span>
        </div>
      </td>
      <td class="p-3 pr-4 text-right">
        <button onclick="concluirTarefaFrota(${t.id})" class="bg-white hover:bg-emerald-50 text-emerald-600 border border-emerald-200 px-4 py-2 rounded-lg font-bold text-[11px] shadow-sm transition-all uppercase"><i class="fas fa-check mr-1"></i> Retornou</button>
      </td>
    </tr>
  `).join('');
};

// Compatibilidade: quando a aba 'tarefas' for aberta, renderiza
const switchTabBackupTarefas = window.switchTab;
window.switchTab = function(which) {
  if (typeof switchTabBackupTarefas === 'function') {
      switchTabBackupTarefas(which);
  }
  if (which === 'tarefas' && typeof renderTarefasFrota === 'function') {
      renderTarefasFrota();
  }
};

// Export util para debug
window.appDebug = { load, render, orders, flexOrders, updateStatusJsonp, updateFlexStatusJsonp, plotMapMarkers, initMap };

console.log('app.js atualizado carregado — Logística corrigida e otimizações aplicadas.');
// ================================
// ================================
// Aba "Saiu para entrega" — Rotas
// ================================
(function () {
  const STORAGE_KEY = 'vesco_saiu_rotas_v1';

  window.saiuRotas = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  window.rotaTemp = window.rotaTemp || { motorista: '', nome: '', pedidos: [] };

  function persistRotas() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(window.saiuRotas || []));
  }

  function getPedidosSeparadosHoje() {
    const source = [...(window.orders || []), ...(window.flexOrders || [])];

    return source.filter(o => {
      try {
        if (typeof shouldShowSeparatedForOperationalDate === 'function') {
          return shouldShowSeparatedForOperationalDate(o);
        }

        const rawStatus = String(o.status_logistica || o.situacao_nome || o.situacao || o.status || '').toLowerCase();
        const flagHoje = !!(o.separadoHoje || o.separado_hoje || o.separados_hoje || o.separado_today || o.separadoHojeFlag);
        if (rawStatus.includes('separ') && flagHoje) return true;
        return false;
      } catch (e) {
        return false;
      }
    }).map(o => ({
      id: o.id || o.numero || '',
      numero: normalizeOrderNumber(o.numero || o.id || ''),
      cliente: extractClientNameFromAny(o) || o.cliente_nome || o.razao_social || '',
      endereco: o.endereco_completo || o.endereco || o.logradouro || '',
      raw: o
    }));
  }

  function getSelectedEcomsForRoute() {
    const checkboxes = document.querySelectorAll('#saiu-pedidos-list input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => {
      const ecom =
        cb.getAttribute('data-num') ||
        cb.getAttribute('data-ecom') ||
        cb.value ||
        cb.closest('.pedido-item')?.querySelector('input[type="checkbox"]')?.getAttribute('data-num') ||
        '';
      if (ecom && ecom !== 'on') return String(ecom).trim();

      const rowText = cb.closest('.pedido-item')?.innerText || cb.closest('.saiu-row')?.innerText || '';
      const match = rowText.match(/#?(\d{5,})/);
      return match ? match[1] : null;
    }).filter(Boolean);
  }

  function renderSelectedTemp() {
    const el = document.getElementById('saiu-rota-selected') || document.getElementById('pedidos-rota-lista');
    if (!el) return;

    const pedidos = getSelectedEcomsForRoute();

    if (pedidos.length === 0) {
      el.innerHTML = `<div class="p-2 text-slate-500 text-sm">Nenhum pedido selecionado.</div>`;
      return;
    }

    el.innerHTML = pedidos.map(id => `
      <div class="flex justify-between items-center p-2 bg-blue-50 mb-1 rounded border border-blue-100 text-xs">
        <span class="font-bold">#${escapeHtml(id)}</span>
        <button type="button" class="text-red-500" onclick="window.desmarcarPedido('${escapeHtml(id)}')">×</button>
      </div>
    `).join('');
  }

  window.renderSelectedTemp = renderSelectedTemp;

  window.desmarcarPedido = function (ecom) {
    const cb =
      document.querySelector(`#saiu-pedidos-list input[type="checkbox"][data-num="${ecom}"]`) ||
      document.querySelector(`#saiu-pedidos-list input[type="checkbox"][data-ecom="${ecom}"]`) ||
      Array.from(document.querySelectorAll('#saiu-pedidos-list input[type="checkbox"]')).find(input => {
        const row = input.closest('.pedido-item') || input.closest('.saiu-row');
        return row && row.innerText.includes(`#${ecom}`);
      });

    if (cb) {
      cb.checked = false;
      renderSelectedTemp();
    }
  };

  function renderPedidosDisponiveis() {
    const el = document.getElementById('saiu-pedidos-list');
    if (!el) return;

    const list = getPedidosSeparadosHoje();

    if (list.length === 0) {
      const dataTxt = (typeof isoToBRDate === 'function' && typeof getSelectedOperationalDateISO === 'function') ? isoToBRDate(getSelectedOperationalDateISO()) : 'hoje';
      el.innerHTML = `<div class="p-4 text-slate-500 text-sm">Nenhum pedido separado disponível para ${escapeHtml(dataTxt)}.</div>`;
      return;
    }

    const checkedSet = new Set(getSelectedEcomsForRoute());

    const header = `
      <div class="flex items-center justify-between mb-2">
        <div class="text-sm text-slate-600 font-semibold">${list.length} pedido(s) separado(s) disponíveis na data selecionada</div>
        <button type="button" id="saiu-selecionar-tudo" class="text-xs bg-slate-100 text-slate-700 px-3 py-1 rounded">
          Selecionar todos
        </button>
      </div>
    `;

    const items = list.map(p => {
      const pid = String(p.numero || p.id || '').trim();
      const checked = checkedSet.has(pid) ? 'checked' : '';

      return `
        <div class="flex items-start gap-3 p-3 border rounded mb-2 bg-white shadow-sm pedido-item" data-num="${escapeHtml(pid)}">
          <div class="flex-none">
            <input type="checkbox"
                   data-num="${escapeHtml(pid)}"
                   value="${escapeHtml(pid)}"
                   ${checked}
                   class="mt-1" />
          </div>
          <div class="flex-1">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-semibold">#${escapeHtml(pid)} <span class="text-xs text-slate-400 ml-2">${escapeHtml(p.cliente)}</span></div>
                <div class="text-xs text-slate-500 mt-1">${escapeHtml(p.endereco)}</div>
              </div>
              <div class="flex flex-col items-end gap-2">
                <button type="button"
                        class="bg-blue-600 text-white text-xs px-3 py-1 rounded"
                        onclick="focusOrderOnMap('${escapeHtml(pid)}')">
                  Localizar
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    el.innerHTML = header + items;

    const btnAll = document.getElementById('saiu-selecionar-tudo');
    if (btnAll) {
      btnAll.onclick = () => {
        window.rotaTemp.pedidos = list.map(p => String(p.numero || p.id || '').trim()).filter(Boolean);
        renderSelectedTemp();
        renderPedidosDisponiveis();
      };
    }

    el.querySelectorAll('input[type="checkbox"][data-num]').forEach(cb => {
      cb.onchange = function () {
        const v = String(cb.getAttribute('data-num') || cb.value || '').trim();
        window.rotaTemp.pedidos = window.rotaTemp.pedidos || [];

        if (cb.checked) {
          if (!window.rotaTemp.pedidos.includes(v)) window.rotaTemp.pedidos.push(v);
        } else {
          window.rotaTemp.pedidos = window.rotaTemp.pedidos.filter(x => x !== v);
        }

        renderSelectedTemp();
      };
    });
  }

  function renderRotas() {
    const el = document.getElementById('saiu-rotas-list');
    if (!el) return;

    const rotasFiltradas = (window.saiuRotas || []).filter(r => (typeof routeBelongsToOperationalDate === 'function') ? routeBelongsToOperationalDate(r) : true);

    if (!rotasFiltradas || rotasFiltradas.length === 0) {
      const dataTxt = (typeof isoToBRDate === 'function' && typeof getSelectedOperationalDateISO === 'function') ? isoToBRDate(getSelectedOperationalDateISO()) : 'a data selecionada';
      el.innerHTML = `<div class="p-4 text-slate-500">Nenhuma rota criada ou ativa para ${escapeHtml(dataTxt)}.</div>`;
      return;
    }

    el.innerHTML = rotasFiltradas.map(r => {
      const qnt = (r.pedidos || []).length;
      const statusBadge =
        r.status === 'pendente'
          ? '<span class="px-2 py-1 rounded bg-amber-100 text-amber-700 text-xs">Pendente</span>'
          : r.status === 'despachada'
          ? '<span class="px-2 py-1 rounded bg-blue-100 text-blue-700 text-xs">Em Rota</span>'
          : '<span class="px-2 py-1 rounded bg-emerald-100 text-emerald-700 text-xs">Concluída</span>';

      return `
        <div class="border rounded p-3 mb-3">
          <div class="flex justify-between items-start">
            <div>
              <div class="font-bold">
                ${escapeHtml(r.nome)}
                <small class="text-xs text-slate-500 ml-2">(${escapeHtml(r.motorista)})</small>
              </div>
              <div class="text-xs text-slate-500 mt-1">
                ${qnt} pedido(s) • Criada: ${escapeHtml(new Date(r.criadoEm).toLocaleString())}
              </div>
            </div>
            <div class="text-right">
              ${statusBadge}
              <div class="mt-2 space-x-2">
                ${r.status === 'pendente' ? `<button type="button" class="bg-blue-600 text-white px-3 py-1 rounded text-xs" onclick="window.iniciarRota && window.iniciarRota('${escapeHtml(r.id)}')">Iniciar Rota</button>` : ''}
                ${r.status === 'despachada' ? `<button type="button" class="bg-emerald-600 text-white px-3 py-1 rounded text-xs" onclick="window.concluirRota && window.concluirRota('${escapeHtml(r.id)}')">Concluir Rota</button>` : ''}
                <button type="button" class="bg-slate-100 text-slate-700 px-3 py-1 rounded text-xs" onclick="window.verRotaMapa && window.verRotaMapa('${escapeHtml(r.id)}')">Ver no mapa</button>
                <button type="button" class="bg-white text-red-600 border border-red-100 px-3 py-1 rounded text-xs" onclick="window.removerRota && window.removerRota('${escapeHtml(r.id)}')">Remover</button>
              </div>
            </div>
          </div>
          <div class="mt-3 text-xs text-slate-600">
            <b>Pedidos:</b> ${(r.pedidos || []).map(p => `#${escapeHtml(p)}`).join(', ')}
          </div>
        </div>
      `;
    }).join('');
  }

  window.renderRotas = renderRotas;
  window.renderPedidosDisponiveisSaiu = renderPedidosDisponiveis;

  window.iniciarRota = function (rotaId) {
    const rota = (window.saiuRotas || []).find(r => r.id === rotaId);
    if (!rota) return showToast('Rota inexistente', 'error');
    if (!confirm(`Iniciar rota "${rota.nome}" com ${rota.pedidos.length} pedido(s) e motorista ${rota.motorista}?`)) return;

    rota.status = 'despachada';
    persistRotas();
    renderRotas();

    (rota.pedidos || []).forEach((pedidoNum, idx) => {
      setTimeout(() => {
        try {
          updateStatusJsonp(pedidoNum, 'Despachado', `Saiu para entrega — Rota: ${rota.nome} Motorista: ${rota.motorista}`);
        } catch (e) {
          console.warn('Erro ao enviar updateStatusJsonp para', pedidoNum, e);
        }
      }, idx * 400);
    });

    showToast('Rota iniciada — pedidos marcados como Despachado.', 'info', 3500);
    render();
  };

  window.concluirRota = function (rotaId) {
    const rota = (window.saiuRotas || []).find(r => r.id === rotaId);
    if (!rota) return showToast('Rota inexistente', 'error');
    if (!confirm(`Confirmar conclusão da rota "${rota.nome}"? Isso marcará ${rota.pedidos.length} pedido(s) como Entregue.`)) return;

    rota.status = 'concluida';
    rota.concluidaEm = new Date().toISOString();
    persistRotas();
    renderRotas();

    (rota.pedidos || []).forEach((pedidoNum, idx) => {
      setTimeout(() => {
        try {
          updateStatusJsonp(pedidoNum, 'Entregue', `Rota concluída: ${rota.nome} Motorista: ${rota.motorista}`);
        } catch (e) {
          console.warn('Erro ao enviar updateStatusJsonp para', pedidoNum, e);
        }
      }, idx * 400);
    });

    showToast('Rota concluída — pedidos marcados como Entregue.', 'success', 3500);
    render();
  };

  window.removerRota = function (id) {
    if (!confirm('Remover rota permanentemente?')) return;
    window.saiuRotas = (window.saiuRotas || []).filter(r => r.id !== id);
    persistRotas();
    renderRotas();
  };

  window.verRotaMapa = async function (id) {
    const rota = (window.saiuRotas || []).find(r => r.id === id);
    if (!rota) return showToast('Rota não encontrada', 'error');

    for (const pedidoNum of (rota.pedidos || [])) {
      const marker = findMainMarkerByKey(pedidoNum) || findFlexMarkerByKey(pedidoNum);
      if (marker) {
        try {
          const latLng = marker.getLatLng();
          if (marker._icon && map) {
            switchTab('logistica');
            setTimeout(() => { map.setView(latLng, 15); marker.openPopup(); }, 400);
          } else if (mapFlex) {
            switchTab('envios_flex');
            setTimeout(() => { mapFlex.setView(latLng, 15); marker.openPopup(); }, 400);
          }
          await new Promise(r => setTimeout(r, 900));
        } catch (e) {}
      }
    }

    showToast('Navegação pela rota concluída.', 'info', 2500);
  };

  function initSaiu() {
    renderPedidosDisponiveis();
    renderSelectedTemp();
    renderRotas();
  }

  const switchTabBackupForSaiu = window.switchTab;
  window.switchTab = function (which) {
    if (typeof switchTabBackupForSaiu === 'function') switchTabBackupForSaiu(which);
    document.getElementById('view-saiu')?.classList.toggle('hidden', which !== 'saiu');
    if (which === 'saiu') initSaiu();
  };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnCriarRota') || document.getElementById('btn-criar-rota');
    if (btn) {
      btn.onclick = null;
      btn.addEventListener('click', function (e) {
        e.preventDefault();

        const motorista = (document.getElementById('rotaMotorista')?.value || '').trim();
        const nome = (document.getElementById('rotaNome')?.value || '').trim() || `Rota ${new Date().toLocaleString()}`;
        const pedidos = getSelectedEcomsForRoute();

        if (!motorista) return alert('Informe o nome do motorista.');
        if (pedidos.length === 0) return alert('Adicione ao menos 1 pedido à rota.');

        const nova = {
          id: 'rota-' + Date.now(),
          nome,
          motorista,
          pedidos: Array.from(new Set(pedidos)),
          status: 'pendente',
          criadoEm: new Date().toISOString()
        };

        window.saiuRotas.push(nova);
        persistRotas();

        window.rotaTemp = { motorista: '', nome: '', pedidos: [] };

        const motorEl = document.getElementById('rotaMotorista');
        const nomeEl = document.getElementById('rotaNome');
        if (motorEl) motorEl.value = '';
        if (nomeEl) nomeEl.value = '';

        renderPedidosDisponiveis();
        renderSelectedTemp();
        renderRotas();

        showToast('Rota criada com sucesso!', 'success');
      });
    }
  });

  window.renderSelectedTemp = renderSelectedTemp;
  window._saiuDebug = {
    renderRotas,
    renderPedidosDisponiveis,
    getPedidosSeparadosHoje,
    getSelectedEcomsForRoute,
    persistRotas
  };

})();
/* 
   EVOLUÇÃO LOGÍSTICA - CAMADA DE RESILIÊNCIA DE GEOCODIFICAÇÃO (REGRA DE PRESERVAÇÃO ATIVA)
   Esta camada intercepta falhas de rede e redireciona para o Proxy do Google Apps Script.
*/

// CONSTANTE DE CONFIGURAÇÃO (Substitua pela URL do seu Script Web App implantado)
/* 
   EVOLUÇÃO LOGÍSTICA - CAMADA DE RESILIÊNCIA DE GEOCODIFICAÇÃO
   Preserva a função original e usa JSONP para evitar CORS.
*/

const GAS_GEO_PROXY_URL = "https://script.google.com/macros/s/AKfycbxEzbxBABMDwi7B7tn_1p-lC0vc50JjHFOrH3w42Oog2-5R2-WMYSrQ27ED7wduJUN6/exec";

function geocodeViaVescoProxy(address) {
    return new Promise((resolve) => {
        const callbackName = 'jsonp_callback_' + Math.round(100000 * Math.random());
        const script = document.createElement('script');

        const timeout = setTimeout(() => {
            console.warn("⏱️ Timeout no Geocode Proxy para:", address);
            try { delete window[callbackName]; } catch (e) {}
            if (script.parentNode) script.parentNode.removeChild(script);
            resolve(null);
        }, 4000);

        window[callbackName] = function(data) {
            clearTimeout(timeout);
            try { delete window[callbackName]; } catch (e) {}
            if (script.parentNode) script.parentNode.removeChild(script);

            if (data && data.lat && data.lon) {
                resolve({ lat: parseFloat(data.lat), lon: parseFloat(data.lon) });
            } else {
                resolve(null);
            }
        };

        const url = `${GAS_GEO_PROXY_URL}?action=geocode&address=${encodeURIComponent(address)}&callback=${callbackName}`;
        script.src = url;
        document.body.appendChild(script);
    });
}
/**
 * REINJEÇÃO DE LÓGICA (OVERRIDE SEGURO):
 * Redefinimos a chamada de geocodificação para tentar o Proxy ANTES do Nominatim.
 * Preservamos a função original geocodeAddress renomeando-a ou usando-a como fallback.
 */
const originalGeocodeAddress = typeof geocodeAddress !== 'undefined' ? geocodeAddress : null;

window.geocodeAddress = async function(address) {
    console.log(`🔍 Iniciando Geocodificação Resiliente: ${address}`);
    
    // 1. Tenta via Proxy (Resolução de CORS e 429)
    const proxyCoords = await geocodeViaVescoProxy(address);
    if (proxyCoords) return proxyCoords;

    // 2. Se o proxy falhar, recorre à lógica original (Preservação)
    if (originalGeocodeAddress) {
        console.warn("⚠️ Recorrendo ao método original (Nominatim)...");
        return originalGeocodeAddress(address);
    }

    return null;
};

console.log("🚀 Camada de Resiliência Logística Injetada: CORS/429 mitigados.");
// >>> Proteção segura para o botão "Atualizar" (preserva a função load original)
(function(){
  // Selecionador do botão: mantém compatibilidade com seu HTML atual
  const btnSelector = 'button[onclick="load()"]';
  const btn = document.querySelector(btnSelector);

  // Mantém a referência da função original (se existir)
  const originalLoad = window.load && typeof window.load === 'function' ? window.load : null;

  // Wrapper seguro
  window.load = function safeLoad(...args) {
    // Desabilita botão visualmente
    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-60');
      // se quiser adicionar pointer-events-none para bloquear clique
      btn.classList.add('pointer-events-none');
    }

    // Timeout de segurança (10s por padrão) — ajustável
    const SAFETY_TIMEOUT = 10000;
    let timeoutId = setTimeout(() => {
      console.warn('safeLoad: tempo excedido (' + SAFETY_TIMEOUT + 'ms). Reabilitando UI.');
      if (btn) { btn.disabled = false; btn.classList.remove('opacity-60','pointer-events-none'); }
    }, SAFETY_TIMEOUT);

    try {
      // Se não existir a função original, não interrompemos: apenas logamos e retornamos Promise resolvida
      if (!originalLoad) {
        clearTimeout(timeoutId);
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-60','pointer-events-none'); }
        console.warn('safeLoad: função original load() não encontrada.');
        return Promise.resolve();
      }

      // Chama a função original; se retornar Promise, tratamos; se síncrona, também tratamos
      const result = originalLoad.apply(this, args);

      if (result && typeof result.then === 'function') {
        // Promise: aguarda e trata erros
        return result.then(res => {
          clearTimeout(timeoutId);
          if (btn) { btn.disabled = false; btn.classList.remove('opacity-60','pointer-events-none'); }
          return res;
        }).catch(err => {
          clearTimeout(timeoutId);
          if (btn) { btn.disabled = false; btn.classList.remove('opacity-60','pointer-events-none'); }
          console.error('safeLoad: erro na Promise retornada por load():', err);
          // opcional: mostrar feedback ao usuário
          return Promise.reject(err);
        });
      } else {
        // Síncrono: reabilita e retorna valor
        clearTimeout(timeoutId);
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-60','pointer-events-none'); }
        return result;
      }
    } catch (e) {
      // Erro síncrono
      clearTimeout(timeoutId);
      if (btn) { btn.disabled = false; btn.classList.remove('opacity-60','pointer-events-none'); }
      console.error('safeLoad: exceção ao executar load():', e);
      return Promise.reject(e);
    }
  };

  // Global handlers para ajudar no diagnóstico de erros que travam o load
  window.addEventListener('unhandledrejection', function(ev) {
    console.error('UnhandledPromiseRejection:', ev.reason);
  });
  window.addEventListener('error', function(ev) {
    console.error('GlobalError:', ev.error || ev.message || ev);
  });

  console.log('safeLoad instalado — botão Atualizar protegido.');
})();


// =================================================================
// BOTÃO ATUALIZAR + CALENDÁRIO — PRESERVAÇÃO V2
// Esta camada envolve o load já existente, persiste a data do calendário,
// força renderização da data selecionada e mantém compatibilidade com onclick="load()".
// =================================================================
(function installOperationalDateRefreshLayer(){
  const preservedLoad = (typeof window.load === 'function') ? window.load : (typeof load === 'function' ? load : null);

  function setRefreshButtonsDisabled(disabled){
    const selectors = [
      'button[onclick="load()"]',
      '#btnAtualizar', '#btn-atualizar', '#refreshButton', '#btnRefresh',
      '[data-action="refresh"]', '[data-refresh="true"]'
    ];
    const buttons = selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    Array.from(new Set(buttons)).forEach(btn => {
      btn.disabled = !!disabled;
      btn.classList.toggle('opacity-60', !!disabled);
      btn.classList.toggle('pointer-events-none', !!disabled);
    });
  }

  function enhancedLoad(...args){
    const input = getOperationalDateInputElement && getOperationalDateInputElement();
    if(input && input.value && typeof setSelectedOperationalDateISO === 'function') {
      setSelectedOperationalDateISO(input.value);
    }

    setRefreshButtonsDisabled(true);
    if(typeof showLoading === 'function') showLoading(true);

    let finished = false;
    const finish = () => {
      if(finished) return;
      finished = true;
      setRefreshButtonsDisabled(false);
      if(typeof showLoading === 'function') showLoading(false);
      if(typeof syncGlobalOrderState === 'function') syncGlobalOrderState();
      if(typeof scheduleRender === 'function') scheduleRender();
      if(typeof window.renderRotas === 'function') {
        try { window.renderRotas(); } catch(e) {}
      }
    };

    const SAFETY_TIMEOUT = 12000;
    const timer = setTimeout(finish, SAFETY_TIMEOUT);

    try {
      const result = preservedLoad ? preservedLoad.apply(this, args) : null;
      // O load antigo usa JSONP e nem sempre retorna Promise. O timeout curto abaixo
      // atualiza a UI assim que os callbacks começarem a preencher orders/flexOrders.
      setTimeout(() => {
        clearTimeout(timer);
        finish();
      }, 900);

      if(result && typeof result.then === 'function') {
        return result.finally(() => {
          clearTimeout(timer);
          finish();
        });
      }
      return result;
    } catch(e) {
      clearTimeout(timer);
      finish();
      console.error('enhancedLoad: erro ao atualizar pela data operacional:', e);
      throw e;
    }
  }

  window.load = enhancedLoad;
  try { load = enhancedLoad; } catch(e) {}

  function bindOperationalDateControls(){
    const input = getOperationalDateInputElement && getOperationalDateInputElement();
    if(input && !input.dataset.vescoOperationalDateBound) {
      input.dataset.vescoOperationalDateBound = '1';
      if(!input.value && typeof setSelectedOperationalDateISO === 'function') setSelectedOperationalDateISO(getBrazilTodayISO());
      input.addEventListener('change', function(){
        if(typeof setSelectedOperationalDateISO === 'function') setSelectedOperationalDateISO(this.value);
        if(typeof scheduleRender === 'function') scheduleRender();
      });
    }

    const selectors = [
      'button[onclick="load()"]',
      '#btnAtualizar', '#btn-atualizar', '#refreshButton', '#btnRefresh',
      '[data-action="refresh"]', '[data-refresh="true"]'
    ];
    const buttons = selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    Array.from(new Set(buttons)).forEach(btn => {
      if(btn.dataset.vescoRefreshBound) return;
      btn.dataset.vescoRefreshBound = '1';
      const refreshHandler = function(e){
        if(e) {
          e.preventDefault();
          if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          else if(typeof e.stopPropagation === 'function') e.stopPropagation();
        }
        enhancedLoad();
        return false;
      };
      // Substitui apenas o gatilho do botão Atualizar para evitar duplo clique
      // quando já existe onclick="load()" no HTML. A função load antiga foi preservada
      // dentro de preservedLoad/enhancedLoad.
      btn.onclick = refreshHandler;
      btn.addEventListener('click', refreshHandler, true);
    });
  }

  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindOperationalDateControls);
  } else {
    bindOperationalDateControls();
  }

  console.log('Camada de data operacional ativa — Atualizar respeita topCalendar e preserva separados pendentes.');
})();


// =================================================================
// CAMADA DE HISTÓRICO OPERACIONAL — PRESERVAÇÃO V3
// Regra: calendário NÃO filtra por data prevista. Ele consulta o
// histórico do processo: lançado, separado, saiu para entrega e entregue.
// Separado permanece visível nos dias seguintes até sair para entrega
// ou ser marcado como entregue.
// =================================================================
(function installOperationalHistoryV3(){
  const HISTORY_KEY = 'vesco_order_operational_history_v3';
  const LEGACY_HISTORY_KEY = 'vesco_order_history_v1';

  function safeParseJson(str, fallback){
    try { return JSON.parse(str || ''); } catch(e) { return fallback; }
  }

  function loadOperationalHistory(){
    const newer = safeParseJson(localStorage.getItem(HISTORY_KEY), null);
    if(newer && typeof newer === 'object') return newer;
    const legacy = safeParseJson(localStorage.getItem(LEGACY_HISTORY_KEY), null);
    return (legacy && typeof legacy === 'object') ? legacy : {};
  }

  function saveOperationalHistory(hist){
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist || {})); } catch(e) {}
  }

  function normalizeHistoryKey(v){
    if(v === null || v === undefined) return '';
    const raw = String(v).trim();
    if(!raw) return '';
    if(typeof normalizeOrderNumber === 'function') {
      const n = normalizeOrderNumber(raw);
      if(n) return n;
    }
    return raw.replace(/^#/, '').replace(/\s+/g, '');
  }

  function getOrderHistoryKeys(input){
    const keys = [];
    const add = (v) => {
      const k = normalizeHistoryKey(v);
      if(k && !keys.includes(k)) keys.push(k);
    };

    if(input && typeof input === 'object') {
      add(input.id);
      add(input.numero);
      add(input.pedido);
      add(input.order_id);
      add(input.orderNumber);
      add(input.reference);
      add(input.referencia);
      add(input.numero_ecommerce);
      if(typeof getEcomNum === 'function') add(getEcomNum(input));
    } else {
      add(input);
    }
    return keys;
  }

  function getHistoryForOrder(input){
    const hist = loadOperationalHistory();
    const keys = getOrderHistoryKeys(input);
    for(const k of keys){
      if(hist[k]) return Object.assign({}, hist[k], { _historyKey: k });
    }
    return {};
  }

  function mergeHistoryAliases(input, patch){
    const hist = loadOperationalHistory();
    const keys = getOrderHistoryKeys(input);
    if(keys.length === 0) return;

    let merged = {};
    for(const k of keys){
      if(hist[k]) merged = Object.assign(merged, hist[k]);
    }
    merged = Object.assign(merged, patch || {});
    merged.updatedAt = new Date().toISOString();

    for(const k of keys){
      hist[k] = Object.assign({}, merged);
    }
    saveOperationalHistory(hist);
  }

  function compareISO(a, b){
    const aa = String(a || '').slice(0, 10);
    const bb = String(b || '').slice(0, 10);
    if(!aa || !bb) return 0;
    return aa < bb ? -1 : (aa > bb ? 1 : 0);
  }

  function minISO(a, b){
    if(!a) return b || '';
    if(!b) return a || '';
    return compareISO(a, b) <= 0 ? a : b;
  }

  function maxISO(a, b){
    if(!a) return b || '';
    if(!b) return a || '';
    return compareISO(a, b) >= 0 ? a : b;
  }

  function getTodayISOForHistory(){
    return (typeof getBrazilTodayISO === 'function') ? getBrazilTodayISO() : new Date().toISOString().slice(0,10);
  }

  function readISOFromAnyField(o, keys){
    if(!o) return '';
    for(const k of keys){
      if(o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== '') {
        const iso = (typeof dateValueToISO === 'function') ? dateValueToISO(o[k]) : '';
        if(iso) return iso;
      }
    }
    return '';
  }

  function readISOFromText(o, keys){
    if(!o || typeof extractFirstDateLikeString !== 'function') return '';
    for(const k of keys){
      const raw = String(o[k] || '').trim();
      if(!raw) continue;
      const found = extractFirstDateLikeString(raw);
      const iso = found && typeof dateValueToISO === 'function' ? dateValueToISO(found) : '';
      if(iso) return iso;
    }
    return '';
  }

  function getOrderCreatedISO(o){
    const direct = readISOFromAnyField(o, [
      'data_lancamento','data_lançamento','lancado_em','lançado_em','lancadoEm','criado_em',
      'criadoEm','created_at','createdAt','data_criacao','data_criação','dt_criacao','dt_criação',
      'data_pedido','dataPedido','pedido_em','pedidoEm','emissao','data_emissao','data_venda','dataVenda',
      'data_inclusao','dataInclusao','included_at','inserted_at','timestamp'
    ]);
    if(direct) return direct;

    const hist = getHistoryForOrder(o);
    if(hist.createdISO) return hist.createdISO;
    if(hist.firstSeenISO) return hist.firstSeenISO;

    return '';
  }

  function getOrderSeparationISO(o){
    const direct = readISOFromAnyField(o, [
      'dataSeparacao','data_separacao','data_separação','separado_em','separadoEm','separado_data',
      'data_separado','dataSeparado','data_separacao_extrato','dt_separacao','dt_separação',
      'separation_date','separated_at','separatedAt','separadoHojeData'
    ]);
    if(direct) return direct;

    const textISO = readISOFromText(o, ['observacao_logistica','observacao','audit','historico','historico_status','log_status']);
    if(textISO && isSeparatedReadyStatus(o)) return textISO;

    const hist = getHistoryForOrder(o);
    return hist.separatedISO || '';
  }

  function getOrderDispatchISO(o){
    const direct = readISOFromAnyField(o, [
      'data_despacho','despachado_em','despachadoEm','data_rota','dataRota','saiu_em',
      'saiuEm','saiuParaEntregaEm','saiu_para_entrega_em','dispatch_at','dispatched_at'
    ]);
    if(direct) return direct;

    const hist = getHistoryForOrder(o);
    return hist.dispatchedISO || '';
  }

  function getOrderDeliveryISO(o){
    const direct = readISOFromAnyField(o, [
      'data_entrega_realizada','entregue_em','entregueEm','data_entregue','dataEntregue',
      'dataEntrega','delivered_at','deliveredAt','concluidaEm','concluido_em','finalizado_em'
    ]);
    if(direct) return direct;

    const hist = getHistoryForOrder(o);
    return hist.deliveredISO || '';
  }

  function sameOperationalDate(isoA, isoB){
    return !!isoA && !!isoB && String(isoA).slice(0,10) === String(isoB).slice(0,10);
  }

  function selectedISO(){
    return (typeof getSelectedOperationalDateISO === 'function') ? getSelectedOperationalDateISO() : getTodayISOForHistory();
  }

  function selectedIsToday(){
    return sameOperationalDate(selectedISO(), getTodayISOForHistory());
  }

  function happenedOnSelected(iso){
    return sameOperationalDate(iso, selectedISO());
  }

  function isBeforeOrEqual(a, b){
    if(!a || !b) return false;
    return compareISO(a, b) <= 0;
  }

  function isAfter(a, b){
    if(!a || !b) return false;
    return compareISO(a, b) > 0;
  }

  function wasSeparatedAndStillNotOutOnSelectedDate(o){
    const sel = selectedISO();
    const sep = getOrderSeparationISO(o);
    const disp = getOrderDispatchISO(o);
    const del = getOrderDeliveryISO(o);

    if(sep && isBeforeOrEqual(sep, sel)) {
      if(disp && !isAfter(disp, sel)) return false;
      if(del && !isAfter(del, sel)) return false;
      return true;
    }

    // Fallback seguro para o dia atual: se o backend ainda não devolve data de separação,
    // mantém separado visível enquanto não saiu para entrega/entregue.
    if(!sep && selectedIsToday() && isStillSeparatedNotOut(o)) return true;

    return false;
  }

  function getOperationalEventLabel(o){
    const labels = [];
    if(happenedOnSelected(getOrderCreatedISO(o))) labels.push('Lançado na plataforma');
    if(happenedOnSelected(getOrderSeparationISO(o))) labels.push('Separado neste dia');
    if(wasSeparatedAndStillNotOutOnSelectedDate(o) && !happenedOnSelected(getOrderSeparationISO(o))) labels.push('Separado pendente de entrega');
    if(happenedOnSelected(getOrderDispatchISO(o))) labels.push('Saiu para entrega');
    if(happenedOnSelected(getOrderDeliveryISO(o))) labels.push('Entregue neste dia');
    return labels.join(' • ');
  }

  function enrichOrderWithOperationalHistory(o){
    if(!o || typeof o !== 'object') return o;
    const hist = getHistoryForOrder(o);
    const created = getOrderCreatedISO(o) || hist.firstSeenISO || '';
    const sep = getOrderSeparationISO(o) || '';
    const disp = getOrderDispatchISO(o) || '';
    const del = getOrderDeliveryISO(o) || '';

    o._createdISO = created;
    o._separatedISO = sep;
    o._dispatchedISO = disp;
    o._deliveredISO = del;
    o._evento_operacional = getOperationalEventLabel(o);
    return o;
  }

  function captureLoadedOrdersInHistory(){
    const today = getTodayISOForHistory();
    const all = [].concat(Array.isArray(orders) ? orders : [], Array.isArray(flexOrders) ? flexOrders : []);

    all.forEach(o => {
      if(!o || typeof o !== 'object') return;

      const hist = getHistoryForOrder(o);
      const directCreated = readISOFromAnyField(o, [
        'data_lancamento','data_lançamento','lancado_em','lançado_em','lancadoEm','criado_em',
        'criadoEm','created_at','createdAt','data_criacao','data_criação','dt_criacao','dt_criação',
        'data_pedido','dataPedido','pedido_em','pedidoEm','emissao','data_emissao','data_venda','dataVenda',
        'data_inclusao','dataInclusao','included_at','inserted_at','timestamp'
      ]);

      const patch = {};
      const knownCreated = directCreated || hist.createdISO || hist.firstSeenISO || '';
      if(knownCreated) {
        patch.createdISO = minISO(hist.createdISO || hist.firstSeenISO || '', knownCreated);
        patch.firstSeenISO = patch.createdISO;
      } else if(!hist.firstSeenISO && selectedIsToday()) {
        // Sem campo de lançamento no backend: começa a armazenar a partir do primeiro carregamento real do dia.
        patch.firstSeenISO = today;
      }

      const directSep = readISOFromAnyField(o, [
        'dataSeparacao','data_separacao','data_separação','separado_em','separadoEm','separado_data',
        'data_separado','dataSeparado','data_separacao_extrato','dt_separacao','dt_separação',
        'separation_date','separated_at','separatedAt','separadoHojeData'
      ]);
      if(directSep) patch.separatedISO = hist.separatedISO ? minISO(hist.separatedISO, directSep) : directSep;

      const directDispatch = readISOFromAnyField(o, [
        'data_despacho','despachado_em','despachadoEm','data_rota','dataRota','saiu_em',
        'saiuEm','saiuParaEntregaEm','saiu_para_entrega_em','dispatch_at','dispatched_at'
      ]);
      if(directDispatch) patch.dispatchedISO = hist.dispatchedISO ? minISO(hist.dispatchedISO, directDispatch) : directDispatch;

      const directDelivery = readISOFromAnyField(o, [
        'data_entrega_realizada','entregue_em','entregueEm','data_entregue','dataEntregue',
        'dataEntrega','delivered_at','deliveredAt','concluidaEm','concluido_em','finalizado_em'
      ]);
      if(directDelivery) patch.deliveredISO = hist.deliveredISO ? minISO(hist.deliveredISO, directDelivery) : directDelivery;

      if(Object.keys(patch).length) mergeHistoryAliases(o, patch);
    });

    if(Array.isArray(orders)) orders = orders.map(enrichOrderWithOperationalHistory);
    if(Array.isArray(flexOrders)) flexOrders = flexOrders.map(enrichOrderWithOperationalHistory);
    if(typeof syncGlobalOrderState === 'function') syncGlobalOrderState();
  }

  function rememberStatusTransition(id, status){
    const today = getTodayISOForHistory();
    const st = String(status || '').toLowerCase();
    const all = [].concat(Array.isArray(orders) ? orders : [], Array.isArray(flexOrders) ? flexOrders : []);
    const found = all.find(o => getOrderHistoryKeys(o).includes(normalizeHistoryKey(id))) || id;

    const patch = {};
    if(st.includes('pronto') || st.includes('separado')) patch.separatedISO = today;
    if(st.includes('despach') || st.includes('rota') || st.includes('saiu para entrega')) patch.dispatchedISO = today;
    if(st.includes('entregue') || st.includes('finaliz') || st.includes('conclu')) patch.deliveredISO = today;

    if(Object.keys(patch).length) mergeHistoryAliases(found, patch);
  }

  // O calendário deixa de ser enviado como filtro da API para impedir que o backend
  // interprete a data como data prevista. A data passa a ser usada apenas no histórico operacional.
  window.appendOperationalDateToUrl = appendOperationalDateToUrl = function(url){
    return String(url || '');
  };

  window.getOrderCreatedISO = getOrderCreatedISO;
  window.getOrderSeparationISO = getOrderSeparationISO;
  window.getOrderDispatchISO = getOrderDispatchISO;
  window.getOrderDeliveryISO = getOrderDeliveryISO;
  window.getOperationalEventLabel = getOperationalEventLabel;
  window.captureLoadedOrdersInHistory = captureLoadedOrdersInHistory;
  window.rememberStatusTransition = rememberStatusTransition;

  window.shouldShowOrderForQueueDate = shouldShowOrderForQueueDate = function(o){
    const sel = selectedISO();
    const created = getOrderCreatedISO(o);
    const sep = getOrderSeparationISO(o);
    const del = getOrderDeliveryISO(o);

    // Fila mostra o que entrou na operação até a data selecionada e ainda não foi separado naquela data.
    if(del && !isAfter(del, sel)) return false;
    if(sep && !isAfter(sep, sel)) return false;
    if(created) return isBeforeOrEqual(created, sel);

    // Sem histórico no backend/localStorage, mantém compatibilidade do dia atual.
    return selectedIsToday();
  };

  window.shouldShowSeparatedForOperationalDate = shouldShowSeparatedForOperationalDate = function(o){
    return wasSeparatedAndStillNotOutOnSelectedDate(o);
  };

  window.shouldShowLogisticForOperationalDate = shouldShowLogisticForOperationalDate = function(o){
    if(happenedOnSelected(getOrderCreatedISO(o))) return true;
    if(happenedOnSelected(getOrderSeparationISO(o))) return true;
    if(wasSeparatedAndStillNotOutOnSelectedDate(o)) return true;
    if(happenedOnSelected(getOrderDispatchISO(o))) return true;
    if(happenedOnSelected(getOrderDeliveryISO(o))) return true;

    // Dia atual continua mostrando ativos quando ainda não existe histórico suficiente.
    if(selectedIsToday() && !isDeliveredStatus(o)) return true;
    return false;
  };

  window.shouldShowDeliveredForOperationalDate = shouldShowDeliveredForOperationalDate = function(o){
    return happenedOnSelected(getOrderDeliveryISO(o));
  };

  window.shouldShowFlexForOperationalDate = shouldShowFlexForOperationalDate = function(f){
    if(happenedOnSelected(getOrderCreatedISO(f))) return true;
    if(happenedOnSelected(getOrderSeparationISO(f))) return true;
    if(wasSeparatedAndStillNotOutOnSelectedDate(f)) return true;
    if(happenedOnSelected(getOrderDispatchISO(f))) return true;
    if(happenedOnSelected(getOrderDeliveryISO(f))) return true;
    return selectedIsToday();
  };

  const oldScheduleRender = scheduleRender;
  scheduleRender = function(...args){
    try { captureLoadedOrdersInHistory(); } catch(e) { console.warn('Histórico operacional: erro ao capturar pedidos', e); }
    return oldScheduleRender.apply(this, args);
  };
  window.scheduleRender = scheduleRender;

  const oldUpdateStatusJsonp = updateStatusJsonp;
  updateStatusJsonp = function(id, status, observacao = ''){
    try { rememberStatusTransition(id, status); } catch(e) { console.warn('Histórico operacional: erro ao gravar status', e); }
    return oldUpdateStatusJsonp.apply(this, arguments);
  };
  window.updateStatusJsonp = updateStatusJsonp;

  const oldUpdateFlexStatusJsonp = updateFlexStatusJsonp;
  updateFlexStatusJsonp = function(id, status, observacao = '', cb){
    try { rememberStatusTransition(id, status); } catch(e) { console.warn('Histórico operacional Flex: erro ao gravar status', e); }
    return oldUpdateFlexStatusJsonp.apply(this, arguments);
  };
  window.updateFlexStatusJsonp = updateFlexStatusJsonp;

  // Bloqueio adicional da atualização automática, preservando o relógio e alarmes.
  if(!window.__vescoNoAutoRefreshIntervalGuard){
    window.__vescoNoAutoRefreshIntervalGuard = true;
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = function(callback, delay, ...args){
      const cbName = callback && callback.name ? callback.name : '';
      if(Number(delay) === 60000 && (callback === load || cbName === 'load')) {
        console.info('Atualização automática bloqueada. Use o botão Atualizar.');
        return -1;
      }
      return nativeSetInterval(callback, delay, ...args);
    };
  }

  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){
      try { captureLoadedOrdersInHistory(); } catch(e) {}
    });
  } else {
    try { captureLoadedOrdersInHistory(); } catch(e) {}
  }

  console.log('Histórico operacional V3 ativo — calendário por eventos, sem filtro por data prevista e sem atualização automática.');
})();

// =================================================================
// CAMADA V4 — ROTAS SAINDO PARA ENTREGA + PENDÊNCIA EM ENTREGUES
// Regra de Preservação: esta camada apenas integra e sobrescreve handlers
// por composição, sem remover funções legadas.
// =================================================================
(function installVescoRouteDispatchAndDeliveredPendenciaV4(){
  if (window.__vescoRouteDispatchAndDeliveredPendenciaV4) return;
  window.__vescoRouteDispatchAndDeliveredPendenciaV4 = true;

  const ROUTES_KEY = 'vesco_saiu_rotas_v1';
  const LAST_ROUTE_URL_KEY = 'vesco_last_google_route_url_v4';

  function v4Toast(msg, type = 'info', ms = 3500){
    try {
      if (typeof showToast === 'function') return showToast(msg, type, ms);
    } catch(e) {}
    try { console.log(msg); } catch(e) {}
  }

  function v4Escape(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? ''); }
    catch(e){ return String(v ?? ''); }
  }

  function v4Normalize(v){
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(v) : String(v ?? '').trim(); }
    catch(e){ return String(v ?? '').trim(); }
  }

  function v4NormalizeEcom(v){
    try { return typeof normalizeEcomNumber === 'function' ? normalizeEcomNumber(v) : String(v ?? '').replace(/\D/g,''); }
    catch(e){ return String(v ?? '').trim(); }
  }

  function v4TodayBR(){
    try {
      if (typeof isoToBRDate === 'function' && typeof getBrazilTodayISO === 'function') return isoToBRDate(getBrazilTodayISO());
    } catch(e) {}
    const d = new Date();
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  function v4PersistRoutes(){
    try { localStorage.setItem(ROUTES_KEY, JSON.stringify(window.saiuRotas || [])); } catch(e) {}
  }

  function v4AllOrders(){
    const a = Array.isArray(window.orders) ? window.orders : [];
    const b = Array.isArray(window.flexOrders) ? window.flexOrders : [];
    return a.concat(b);
  }

  function v4OrderKeys(o){
    if(!o) return [];
    const vals = [
      o.id, o.numero, o.pedido, o.order_id, o.orderNumber, o.reference, o.referencia,
      o.numero_ecommerce, o.numero_ecom, o.ecom, o.ecom_id, o.codigo_externo, o.codigo
    ];
    const keys = [];
    vals.forEach(v => {
      if(v === undefined || v === null || String(v).trim() === '') return;
      const raw = String(v).trim();
      keys.push(raw, v4Normalize(raw), v4NormalizeEcom(raw));
    });
    return Array.from(new Set(keys.filter(Boolean)));
  }

  function v4FindOrder(key){
    const targetRaw = String(key ?? '').trim();
    const targetNorm = v4Normalize(targetRaw);
    const targetEcom = v4NormalizeEcom(targetRaw);
    return v4AllOrders().find(o => {
      const keys = v4OrderKeys(o);
      return keys.includes(targetRaw) || keys.includes(targetNorm) || keys.includes(targetEcom);
    }) || null;
  }

  function v4OrderAddress(o){
    if(!o) return '';
    return String(o.endereco_completo || o.endereco || o.address || o.full_address || o.logradouro || '').trim();
  }

  function v4OrderClient(o){
    try { return extractClientNameFromAny(o) || o.cliente_nome || o.cliente || o.nome || o.destinatario || ''; }
    catch(e){ return o && (o.cliente_nome || o.cliente || o.nome || o.destinatario) || ''; }
  }

  function v4MarkerLatLng(key){
    try {
      const m = (typeof findMainMarkerByKey === 'function' && findMainMarkerByKey(key)) ||
                (typeof findFlexMarkerByKey === 'function' && findFlexMarkerByKey(key));
      if(m && typeof m.getLatLng === 'function') {
        const ll = m.getLatLng();
        if(ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) return { lat: ll.lat, lon: ll.lng };
      }
    } catch(e) {}
    return null;
  }

  function v4OrderCoords(o, key){
    try {
      const direct = typeof getCoords === 'function' ? getCoords(o) : null;
      if(direct && Number.isFinite(direct.lat) && Number.isFinite(direct.lon)) return direct;
    } catch(e) {}
    return v4MarkerLatLng(key || (o && (o.numero || o.id)));
  }

  function v4BuildStops(pedidos){
    return Array.from(new Set((pedidos || []).map(v => String(v || '').trim()).filter(Boolean))).map(pedido => {
      const order = v4FindOrder(pedido);
      const coords = v4OrderCoords(order, pedido);
      return {
        pedido,
        id: order && (order.id || order.numero) || pedido,
        numero: order && (order.numero || order.id) || pedido,
        cliente: v4OrderClient(order),
        endereco: v4OrderAddress(order),
        lat: coords ? coords.lat : null,
        lon: coords ? coords.lon : null,
        origem: order && Array.isArray(window.flexOrders) && window.flexOrders.includes(order) ? 'flex' : 'erp'
      };
    });
  }

  function v4EncodeStop(stop){
    if(stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) {
      return `${Number(stop.lat)},${Number(stop.lon)}`;
    }
    return String((stop && stop.endereco) || (stop && stop.cliente) || (stop && stop.numero) || '').trim();
  }

  function v4BuildGoogleMapsRouteUrl(rota){
    const stops = (rota && rota.paradas && rota.paradas.length ? rota.paradas : v4BuildStops(rota && rota.pedidos || []))
      .filter(s => v4EncodeStop(s));

    if(stops.length === 0) return '';
    if(stops.length === 1) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v4EncodeStop(stops[0]))}`;
    }

    const limited = stops.slice(0, 25);
    const origin = v4EncodeStop(limited[0]);
    const destination = v4EncodeStop(limited[limited.length - 1]);
    const waypointStops = limited.slice(1, -1).map(v4EncodeStop).filter(Boolean);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
    if(waypointStops.length) url += `&waypoints=${encodeURIComponent(waypointStops.join('|'))}`;
    return url;
  }

  function v4FindRouteById(id){
    return (window.saiuRotas || []).find(r => String(r.id) === String(id)) || null;
  }

  function v4FindOrCreateRouteMap(){
    const globals = ['routeMap','rotasMap','mapRotas','mapaRotas','mapRoute','saiuMap','map','mapFlex'];
    for(const name of globals){
      const m = window[name];
      if(m && typeof m.setView === 'function' && typeof m.addLayer === 'function') return m;
    }

    if(typeof L === 'undefined') return null;
    const ids = ['map-rotas','rotas-map','route-map','map-route','routeMap','map-saiu','saiu-map'];
    for(const id of ids){
      const el = document.getElementById(id);
      if(el && !el._leaflet_id) {
        try {
          const m = L.map(el).setView([-23.55052, -46.633308], 11);
          L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(m);
          window.routeMap = m;
          return m;
        } catch(e) {}
      }
    }
    return null;
  }

  async function v4ResolveStopCoords(stop){
    if(stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return { lat: Number(stop.lat), lon: Number(stop.lon) };
    const byMarker = v4MarkerLatLng(stop && stop.numero || stop && stop.pedido);
    if(byMarker) return byMarker;
    if(!stop || !stop.endereco || typeof geocodeAddress !== 'function') return null;
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), 4500));
      const geo = geocodeAddress(stop.endereco);
      const res = await Promise.race([geo, timeout]);
      if(res && Number.isFinite(Number(res.lat)) && Number.isFinite(Number(res.lon))) {
        stop.lat = Number(res.lat);
        stop.lon = Number(res.lon);
        return { lat: stop.lat, lon: stop.lon };
      }
    } catch(e) {}
    return null;
  }

  async function v4DrawRouteOnMap(rotaOrId){
    const rota = typeof rotaOrId === 'string' ? v4FindRouteById(rotaOrId) : rotaOrId;
    if(!rota) return v4Toast('Rota não encontrada.', 'error');

    const mapTarget = v4FindOrCreateRouteMap();
    if(!mapTarget || typeof L === 'undefined') {
      const url = v4BuildGoogleMapsRouteUrl(rota);
      if(url) window.open(url, '_blank');
      return;
    }

    try {
      if(window.__vescoRouteLayerV4 && typeof window.__vescoRouteLayerV4.remove === 'function') {
        window.__vescoRouteLayerV4.remove();
      }
    } catch(e) {}

    const layer = L.layerGroup().addTo(mapTarget);
    window.__vescoRouteLayerV4 = layer;

    const stops = rota.paradas && rota.paradas.length ? rota.paradas : v4BuildStops(rota.pedidos || []);
    rota.paradas = stops;

    const latlngs = [];
    for(let i = 0; i < stops.length; i++){
      const s = stops[i];
      const coords = await v4ResolveStopCoords(s);
      if(!coords) continue;
      const ll = [coords.lat, coords.lon];
      latlngs.push(ll);
      try {
        L.marker(ll).addTo(layer).bindPopup(`<b>${i + 1}. Pedido #${v4Escape(s.numero || s.pedido)}</b><br>${v4Escape(s.cliente || '')}<br><small>${v4Escape(s.endereco || '')}</small>`);
      } catch(e) {}
    }

    if(latlngs.length > 1) {
      try { L.polyline(latlngs, { weight: 4, opacity: 0.85 }).addTo(layer); } catch(e) {}
    }

    try {
      if(latlngs.length === 1) mapTarget.setView(latlngs[0], 15);
      if(latlngs.length > 1) mapTarget.fitBounds(L.latLngBounds(latlngs).pad(0.18), { maxZoom: 15 });
      setTimeout(() => mapTarget.invalidateSize && mapTarget.invalidateSize(), 200);
    } catch(e) {}

    const url = v4BuildGoogleMapsRouteUrl(rota);
    if(url) {
      try { localStorage.setItem(LAST_ROUTE_URL_KEY, url); } catch(e) {}
      v4RenderRouteInfo(rota, url);
    }

    v4PersistRoutes();
    return url;
  }

  function v4RenderRouteInfo(rota, url){
    const roots = [document.getElementById('view-rotas'), document.getElementById('view-saiu'), document.body].filter(Boolean);
    const root = roots.find(r => r.querySelector && (r.querySelector('#vesco-route-info-panel') || r.textContent.includes('Obter informações da rota') || r.textContent.includes('Traçar Rota'))) || document.body;
    let panel = document.getElementById('vesco-route-info-panel');
    if(!panel) {
      panel = document.createElement('div');
      panel.id = 'vesco-route-info-panel';
      panel.className = 'my-3 p-3 rounded-xl border border-blue-100 bg-blue-50 text-xs text-slate-700';
      const anchor = Array.from(root.querySelectorAll('button')).find(b => /obter informa|tra[cç]ar rota|p\/ motorista/i.test(b.textContent || ''));
      if(anchor && anchor.parentElement) anchor.parentElement.insertAdjacentElement('afterend', panel);
      else root.prepend(panel);
    }

    const stops = rota.paradas || [];
    panel.innerHTML = `
      <div class="font-black text-blue-800 mb-2"><i class="fas fa-route mr-1"></i>Rota montada: ${v4Escape(rota.nome || 'Rota')}</div>
      <div class="mb-2"><b>Motorista:</b> ${v4Escape(rota.motorista || '—')} • <b>Pedidos:</b> ${stops.length || (rota.pedidos || []).length}</div>
      <div class="max-h-32 overflow-auto bg-white/70 border border-blue-100 rounded-lg p-2 mb-2">
        ${(stops || []).map((s, i) => `<div class="mb-1"><b>${i + 1}. #${v4Escape(s.numero || s.pedido)}</b> — ${v4Escape(s.endereco || 'Endereço não localizado')}</div>`).join('') || 'Nenhum endereço localizado.'}
      </div>
      ${url ? `<a href="${v4Escape(url)}" target="_blank" class="inline-flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold"><i class="fas fa-map-marked-alt"></i>Abrir rota no Google Maps</a>` : ''}
    `;
  }

  function v4MarkLocalOutForDelivery(pedidoNum, rota){
    const order = v4FindOrder(pedidoNum);
    const todayBR = v4TodayBR();
    const now = new Date().toISOString();
    if(order) {
      order.status_logistica = 'Despachado';
      order.situacao_nome = 'Saiu para entrega';
      order.data_despacho = todayBR;
      order.despachado_em = now;
      order.saiuParaEntregaEm = now;
      const obsAntiga = String(order.observacao_logistica || order.observacao || '').trim();
      const obsNova = `Saiu para entrega — Rota: ${rota.nome || 'Rota'} Motorista: ${rota.motorista || '—'}`;
      order.observacao_logistica = obsAntiga ? `${obsAntiga} | ${obsNova}` : obsNova;
    }
    try { if(typeof rememberStatusTransition === 'function') rememberStatusTransition(pedidoNum, 'Despachado'); } catch(e) {}
    try { if(typeof syncGlobalOrderState === 'function') syncGlobalOrderState(); } catch(e) {}
  }

  function v4DispatchRouteToStreet(rota, opts = {}){
    if(!rota) return;
    const now = new Date().toISOString();
    rota.status = 'despachada';
    rota.despachadaEm = rota.despachadaEm || now;
    rota.saiuEm = rota.saiuEm || now;
    rota.paradas = v4BuildStops(rota.pedidos || []);

    (rota.pedidos || []).forEach((pedidoNum, idx) => {
      v4MarkLocalOutForDelivery(pedidoNum, rota);
      if(opts.skipBackend) return;
      setTimeout(() => {
        try {
          if(typeof updateStatusJsonp === 'function') {
            updateStatusJsonp(pedidoNum, 'Despachado', `Saiu para entrega — Rota: ${rota.nome || 'Rota'} Motorista: ${rota.motorista || '—'}`);
          }
        } catch(e) { console.warn('Erro ao registrar pedido na rua:', pedidoNum, e); }
      }, idx * 650);
    });

    v4PersistRoutes();
    try { if(typeof render === 'function') render(); } catch(e) {}
    try { if(typeof window.renderPedidosDisponiveisSaiu === 'function') window.renderPedidosDisponiveisSaiu(); } catch(e) {}
    try { if(typeof window.renderSelectedTemp === 'function') window.renderSelectedTemp(); } catch(e) {}
    try { if(typeof window.renderRotas === 'function') window.renderRotas(); } catch(e) {}
    v4DrawRouteOnMap(rota);
  }

  function v4GetInputValue(candidates){
    for(const sel of candidates){
      const el = document.querySelector(sel);
      if(el && String(el.value || '').trim()) return String(el.value).trim();
    }
    return '';
  }

  function v4CollectSelectedRoutePedidos(){
    const selectors = [
      '#saiu-pedidos-list input[type="checkbox"]:checked',
      '#view-saiu input[type="checkbox"]:checked',
      '#view-rotas input[type="checkbox"]:checked',
      '#pedidosDisponiveis input[type="checkbox"]:checked',
      '[data-route-order]:checked',
      '[data-num][type="checkbox"]:checked',
      '[data-ecom][type="checkbox"]:checked'
    ];
    const inputs = Array.from(new Set(selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)))));
    const out = [];
    inputs.forEach(cb => {
      let val = cb.getAttribute('data-num') || cb.getAttribute('data-ecom') || cb.getAttribute('data-pedido') || cb.value || '';
      if(!val || val === 'on') {
        const row = cb.closest('tr') || cb.closest('.pedido-item') || cb.closest('[data-num]') || cb.parentElement;
        val = (row && (row.getAttribute('data-num') || row.getAttribute('data-ecom') || row.getAttribute('data-pedido'))) || '';
        if(!val && row) {
          const txt = row.innerText || '';
          const m = txt.match(/#\s*([0-9A-Za-z._-]{4,})/) || txt.match(/\b(\d{5,})\b/);
          if(m) val = m[1];
        }
      }
      val = v4Normalize(val);
      if(val) out.push(val);
    });
    return Array.from(new Set(out));
  }

  function v4IsCreateRouteButton(btn){
    if(!btn || !btn.matches || !btn.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')) return false;
    const idName = `${btn.id || ''} ${btn.name || ''} ${btn.getAttribute('onclick') || ''}`;
    const text = `${btn.value || ''} ${btn.textContent || ''}`.trim();
    if(/btn[-_]?criar[-_]?rota|criarRota|createRoute/i.test(idName)) return true;
    if(/\bcriar\s+rota\b/i.test(text)) {
      return !!(btn.closest('#view-saiu') || btn.closest('#view-rotas') || document.getElementById('rotaMotorista') || document.getElementById('rotaNome'));
    }
    return false;
  }

  function v4IsTraceRouteButton(btn){
    if(!btn || !btn.matches || !btn.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')) return false;
    const idName = `${btn.id || ''} ${btn.name || ''} ${btn.getAttribute('onclick') || ''}`;
    const text = `${btn.value || ''} ${btn.textContent || ''}`.trim();
    return /tracar|tra[cç]ar|route|rotaMapa|obter.*rota/i.test(idName) || /tra[cç]ar\s+rota|obter informa[cç][oõ]es da rota/i.test(text);
  }

  function v4HandleCreateRoute(e, btn){
    e.preventDefault();
    e.stopPropagation();
    if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    const motorista = v4GetInputValue(['#rotaMotorista', '#motoristaRota', '#routeDriver', 'input[name="motorista"]', 'input[placeholder*="motorista" i]']);
    const nome = v4GetInputValue(['#rotaNome', '#nomeRota', '#routeName', 'input[name="rota"]', 'input[placeholder*="rota" i]']) || `Rota ${new Date().toLocaleString('pt-BR')}`;
    const pedidos = v4CollectSelectedRoutePedidos();

    if(!motorista) return alert('Informe o nome do motorista.');
    if(!pedidos.length) return alert('Selecione ao menos 1 pedido para criar a rota.');

    window.saiuRotas = Array.isArray(window.saiuRotas) ? window.saiuRotas : [];
    const nova = {
      id: 'rota-' + Date.now(),
      nome,
      motorista,
      pedidos,
      status: 'despachada',
      criadoEm: new Date().toISOString(),
      despachadaEm: new Date().toISOString(),
      saiuEm: new Date().toISOString(),
      paradas: v4BuildStops(pedidos)
    };

    window.saiuRotas.push(nova);
    try { window.rotaTemp = { motorista: '', nome: '', pedidos: [] }; } catch(e) {}
    ['#rotaMotorista', '#motoristaRota', '#routeDriver', '#rotaNome', '#nomeRota', '#routeName'].forEach(sel => {
      const el = document.querySelector(sel);
      if(el) el.value = '';
    });

    v4DispatchRouteToStreet(nova);
    v4Toast(`Rota criada. ${pedidos.length} pedido(s) marcado(s) como saiu para entrega.`, 'success', 4500);
  }

  function v4HandleTraceRoute(e, btn){
    const pedidos = v4CollectSelectedRoutePedidos();
    if(!pedidos.length) return;
    e.preventDefault();
    e.stopPropagation();
    if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    const temp = {
      id: 'rota-preview-' + Date.now(),
      nome: 'Prévia da rota',
      motorista: v4GetInputValue(['#rotaMotorista', '#motoristaRota', '#routeDriver', 'input[name="motorista"]', 'input[placeholder*="motorista" i]']) || '—',
      pedidos,
      status: 'preview',
      criadoEm: new Date().toISOString(),
      paradas: v4BuildStops(pedidos)
    };
    v4DrawRouteOnMap(temp).then(url => {
      v4Toast('Rota traçada com os endereços selecionados.', 'success', 3000);
    });
  }

  document.addEventListener('click', function vescoRouteClickCapture(e){
    const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if(!btn) return;
    if(v4IsCreateRouteButton(btn)) return v4HandleCreateRoute(e, btn);
    if(v4IsTraceRouteButton(btn)) return v4HandleTraceRoute(e, btn);
  }, true);

  const preservedIniciarRota = window.iniciarRota;
  window.iniciarRota = function(rotaId){
    const rota = v4FindRouteById(rotaId);
    if(!rota) return typeof preservedIniciarRota === 'function' ? preservedIniciarRota.apply(this, arguments) : v4Toast('Rota inexistente.', 'error');
    if(!confirm(`Iniciar rota "${rota.nome}" com ${rota.pedidos.length} pedido(s) e motorista ${rota.motorista}?`)) return;
    v4DispatchRouteToStreet(rota);
    v4Toast('Rota iniciada — pedidos marcados como saiu para entrega.', 'success', 3500);
  };

  const preservedVerRotaMapa = window.verRotaMapa;
  window.verRotaMapa = function(rotaId){
    const rota = v4FindRouteById(rotaId);
    if(rota) return v4DrawRouteOnMap(rota);
    if(typeof preservedVerRotaMapa === 'function') return preservedVerRotaMapa.apply(this, arguments);
  };

  window.vescoOpenRouteInGoogle = function(rotaId){
    const rota = v4FindRouteById(rotaId);
    const url = rota ? v4BuildGoogleMapsRouteUrl(rota) : localStorage.getItem(LAST_ROUTE_URL_KEY);
    if(url) window.open(url, '_blank');
    else v4Toast('Nenhuma rota disponível para abrir.', 'warning');
  };

  window.vescoGetRouteInfo = function(rotaId){
    const rota = v4FindRouteById(rotaId);
    if(!rota) return v4Toast('Rota não encontrada.', 'error');
    const url = v4BuildGoogleMapsRouteUrl(rota);
    v4RenderRouteInfo(rota, url);
    return rota;
  };

  function v4InjectRouteExtraButtons(){
    const el = document.getElementById('saiu-rotas-list');
    if(!el) return;
    Array.from(el.children || []).forEach(card => {
      if(card.querySelector && card.querySelector('.vesco-route-v4-actions')) return;
      const html = card.innerHTML || '';
      const m = html.match(/verRotaMapa\s*&&\s*window\.verRotaMapa\('([^']+)'\)/) || html.match(/verRotaMapa\('([^']+)'\)/) || html.match(/concluirRota\s*&&\s*window\.concluirRota\('([^']+)'\)/);
      const id = m && m[1];
      if(!id) return;
      const box = document.createElement('div');
      box.className = 'vesco-route-v4-actions mt-2 flex flex-wrap gap-2 justify-end';
      box.innerHTML = `
        <button type="button" class="bg-indigo-600 text-white px-3 py-1 rounded text-xs font-bold" onclick="window.verRotaMapa && window.verRotaMapa('${v4Escape(id)}')">Traçar no mapa</button>
        <button type="button" class="bg-blue-600 text-white px-3 py-1 rounded text-xs font-bold" onclick="window.vescoOpenRouteInGoogle && window.vescoOpenRouteInGoogle('${v4Escape(id)}')">Google Maps</button>
      `;
      card.appendChild(box);
    });
  }

  const preservedRenderRotas = window.renderRotas;
  if(typeof preservedRenderRotas === 'function') {
    window.renderRotas = function(){
      const res = preservedRenderRotas.apply(this, arguments);
      setTimeout(v4InjectRouteExtraButtons, 0);
      return res;
    };
  }

  function v4InjectDeliveredPendenciaButtons(){
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(row => {
      if(row.querySelector('.vesco-entregue-pendencia-btn')) return;
      const txt = row.innerText || '';
      const m = txt.match(/#\s*([0-9A-Za-z._-]+)/);
      if(!m) return;
      const numero = m[1];
      const order = v4FindOrder(numero);
      const id = order && (order.id || order.numero) || numero;
      const lastTd = row.querySelector('td:last-child');
      if(!lastTd) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'mt-2 flex justify-center';
      wrapper.innerHTML = `<button type="button" class="vesco-entregue-pendencia-btn bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.moverParaPendenciaPrompt && window.moverParaPendenciaPrompt('${v4Escape(id)}')"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>`;
      lastTd.appendChild(wrapper);
    });
  }

  const preservedRender = typeof render === 'function' ? render : null;
  if(preservedRender) {
    render = function(){
      const res = preservedRender.apply(this, arguments);
      setTimeout(v4InjectDeliveredPendenciaButtons, 0);
      setTimeout(v4InjectRouteExtraButtons, 0);
      return res;
    };
    window.render = render;
  }

  const preservedSwitchTab = window.switchTab;
  if(typeof preservedSwitchTab === 'function') {
    window.switchTab = function(which){
      const res = preservedSwitchTab.apply(this, arguments);
      if(which === 'entregues') setTimeout(v4InjectDeliveredPendenciaButtons, 150);
      if(which === 'saiu' || which === 'rotas') setTimeout(v4InjectRouteExtraButtons, 150);
      return res;
    };
  }

  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(v4InjectDeliveredPendenciaButtons, 500);
    setTimeout(v4InjectRouteExtraButtons, 500);
  });

  window.vescoRouteDispatchV4 = {
    buildStops: v4BuildStops,
    buildGoogleMapsRouteUrl: v4BuildGoogleMapsRouteUrl,
    drawRouteOnMap: v4DrawRouteOnMap,
    dispatchRouteToStreet: v4DispatchRouteToStreet,
    injectDeliveredPendenciaButtons: v4InjectDeliveredPendenciaButtons
  };

  console.log('Rotas V4 ativo — criar rota marca pedidos como saiu para entrega, traça endereços e adiciona Pendência em Entregues.');
})();


// =================================================================
// CAMADA V6 PRE — ROTAS COM PONTO DE PARTIDA + MAPA NO TOPO DIREITO
// Regra de Preservação: camada aditiva antes da V5 para interceptar rotas sem apagar legado.
// =================================================================
(function installVescoRouteOriginAndRightMapV6Pre(){
  if (window.__vescoRouteOriginAndRightMapV6Pre) return;
  window.__vescoRouteOriginAndRightMapV6Pre = true;

  const ROUTES_KEY = 'vesco_saiu_rotas_v1';
  const GEO_CACHE_KEY = 'vesco_route_geocode_cache_v6';
  const LAST_ROUTE_URL_KEY = 'vesco_last_google_route_url_v6';
  const ORIGIN_KEY = 'vesco_route_origin_v6';
  const DEFAULT_CENTER = [-23.55052, -46.633308];

  function v6Log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function v6Warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function v6Toast(msg, typeOrMs, ms){
    try {
      if (typeof showToast === 'function') {
        if (typeof typeOrMs === 'string') return showToast(msg, typeOrMs, ms || 3500);
        return showToast(msg, typeOrMs || 3500);
      }
    } catch(e) {}
    v6Log(msg);
  }
  function v6Escape(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function v6Norm(v){
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(v) : String(v ?? '').trim(); }
    catch(e){ return String(v ?? '').trim(); }
  }
  function v6NormEcom(v){
    try { return typeof normalizeEcomNumber === 'function' ? normalizeEcomNumber(v) : String(v ?? '').replace(/\D/g,''); }
    catch(e){ return String(v ?? '').trim(); }
  }
  function v6NowBR(){
    const d = new Date();
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  function v6PersistRoutes(){ try { localStorage.setItem(ROUTES_KEY, JSON.stringify(window.saiuRotas || [])); } catch(e) {} }
  function v6LoadGeoCache(){ try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}') || {}; } catch(e) { return {}; } }
  function v6SaveGeoCache(cache){ try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache || {})); } catch(e) {} }
  function v6CleanAddress(addr){
    return String(addr || '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, ',')
      .replace(/\bSao\b/gi, 'São')
      .trim();
  }
  function v6AddressKey(addr){ return v6CleanAddress(addr).toLowerCase(); }

  function v6AllOrders(){
    const localOrders = (typeof orders !== 'undefined' && Array.isArray(orders)) ? orders : [];
    const localFlex = (typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) ? flexOrders : [];
    const winOrders = Array.isArray(window.orders) ? window.orders : [];
    const winFlex = Array.isArray(window.flexOrders) ? window.flexOrders : [];
    return Array.from(new Set([].concat(localOrders, localFlex, winOrders, winFlex).filter(Boolean)));
  }
  function v6OrderKeys(o){
    if(!o) return [];
    const vals = [
      o.id, o.numero, o.pedido, o.order_id, o.orderNumber, o.reference, o.referencia,
      o.numero_ecommerce, o.numero_ecom, o.ecom, o.ecom_id, o.codigo_externo, o.codigo
    ];
    const keys = [];
    vals.forEach(v => {
      if(v === undefined || v === null || String(v).trim() === '') return;
      const raw = String(v).trim();
      keys.push(raw, v6Norm(raw), v6NormEcom(raw));
    });
    return Array.from(new Set(keys.filter(Boolean)));
  }
  function v6FindOrder(key){
    const raw = String(key ?? '').trim();
    const norm = v6Norm(raw);
    const ecom = v6NormEcom(raw);
    return v6AllOrders().find(o => {
      const keys = v6OrderKeys(o);
      return keys.includes(raw) || keys.includes(norm) || keys.includes(ecom);
    }) || null;
  }
  function v6OrderAddress(o){
    if(!o) return '';
    return v6CleanAddress(o.endereco_completo || o.endereco || o.address || o.full_address || o.logradouro || '');
  }
  function v6OrderClient(o){
    try { return extractClientNameFromAny(o) || o.cliente_nome || o.cliente || o.nome || o.destinatario || ''; }
    catch(e){ return o && (o.cliente_nome || o.cliente || o.nome || o.destinatario) || ''; }
  }
  function v6DirectCoords(o){
    try {
      const c = typeof getCoords === 'function' ? getCoords(o) : null;
      if(c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon))) return { lat: Number(c.lat), lon: Number(c.lon) };
    } catch(e) {}
    return null;
  }
  function v6MarkerCoords(key){
    try {
      const m = (typeof findMainMarkerByKey === 'function' && findMainMarkerByKey(key)) ||
                (typeof findFlexMarkerByKey === 'function' && findFlexMarkerByKey(key));
      if(m && typeof m.getLatLng === 'function') {
        const ll = m.getLatLng();
        if(ll && Number.isFinite(Number(ll.lat)) && Number.isFinite(Number(ll.lng))) return { lat: Number(ll.lat), lon: Number(ll.lng) };
      }
    } catch(e) {}
    return null;
  }
  function v6BuildStops(pedidos, origem){
    const stops = [];
    const originText = v6CleanAddress(origem || v6GetRouteOrigin(false));
    if(originText) {
      stops.push({ pedido: '__ORIGEM__', id: '__ORIGEM__', numero: 'Origem', cliente: 'Ponto de partida', endereco: originText, isOrigin: true, lat: null, lon: null });
    }
    Array.from(new Set((pedidos || []).map(v => String(v || '').trim()).filter(Boolean))).forEach(pedido => {
      const order = v6FindOrder(pedido);
      const coords = v6DirectCoords(order) || v6MarkerCoords(pedido) || v6MarkerCoords(order && (order.numero || order.id));
      stops.push({
        pedido,
        id: order && (order.id || order.numero) || pedido,
        numero: order && (order.numero || order.id) || pedido,
        cliente: v6OrderClient(order),
        endereco: v6OrderAddress(order),
        lat: coords ? coords.lat : null,
        lon: coords ? coords.lon : null,
        isOrigin: false
      });
    });
    return stops;
  }
  function v6EncodeStop(stop){
    if(stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return `${Number(stop.lat)},${Number(stop.lon)}`;
    return v6CleanAddress((stop && stop.endereco) || (stop && stop.cliente) || (stop && stop.numero) || '');
  }
  function v6BuildGoogleMapsRouteUrl(rota){
    const stops = (rota && rota.paradas && rota.paradas.length ? rota.paradas : v6BuildStops(rota && rota.pedidos || [], rota && rota.origem)).filter(s => v6EncodeStop(s));
    if(!stops.length) return '';
    const limited = stops.slice(0, 25);
    if(limited.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v6EncodeStop(limited[0]))}`;
    const origin = v6EncodeStop(limited[0]);
    const destination = v6EncodeStop(limited[limited.length - 1]);
    const waypoints = limited.slice(1, -1).map(v6EncodeStop).filter(Boolean);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
    if(waypoints.length) url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
    return url;
  }
  function v6FindRouteById(id){ return (window.saiuRotas || []).find(r => String(r.id) === String(id)) || null; }

  function v6RouteRoot(){
    const candidates = ['#view-saiu:not(.hidden)', '#view-rotas:not(.hidden)', '#view-saiu', '#view-rotas'];
    for(const sel of candidates){ const el = document.querySelector(sel); if(el) return el; }
    return null;
  }
  function v6InstallRouteCss(){
    if(document.getElementById('vesco-route-v6-style')) return;
    const st = document.createElement('style');
    st.id = 'vesco-route-v6-style';
    st.textContent = `
      #vesco-saiu-layout-v6{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(390px,.9fr);gap:16px;align-items:start;width:100%;}
      #vesco-saiu-left-v6{min-width:0;}
      #vesco-saiu-right-v6{position:sticky;top:92px;align-self:start;z-index:5;}
      #vesco-route-map-panel-v6{border:1px solid #dbe5f1;background:#fff;border-radius:14px;padding:10px;box-shadow:0 8px 22px rgba(15,23,42,.06);}
      #vesco-route-map-v6{height:calc(100vh - 245px);min-height:390px;width:100%;border-radius:12px;overflow:hidden;background:#eef2f7;}
      #vesco-route-info-panel-v6{margin-bottom:12px;padding:12px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:14px;font-size:12px;color:#334155;}
      #vesco-route-map-panel-v5,#vesco-route-info-panel-v5{display:none!important;}
      .vesco-rota-origem-v6 input{width:100%;}
      @media(max-width:1024px){#vesco-saiu-layout-v6{grid-template-columns:1fr;}#vesco-saiu-right-v6{position:relative;top:0;}#vesco-route-map-v6{height:360px;min-height:360px;}}
    `;
    document.head.appendChild(st);
  }
  function v6EnsureLayout(){
    v6InstallRouteCss();
    const root = v6RouteRoot();
    if(!root) return null;
    let shell = document.getElementById('vesco-saiu-layout-v6');
    if(!shell) {
      shell = document.createElement('div');
      shell.id = 'vesco-saiu-layout-v6';
      const left = document.createElement('div'); left.id = 'vesco-saiu-left-v6';
      const right = document.createElement('div'); right.id = 'vesco-saiu-right-v6';
      right.innerHTML = `
        <div id="vesco-route-info-panel-v6">
          <div class="font-black text-blue-800 mb-1"><i class="fas fa-route mr-1"></i>Planejamento da rota</div>
          <div class="text-slate-600">Informe o ponto de partida, selecione os pedidos e clique em <b>Traçar Rota</b> ou <b>Criar Rota</b>.</div>
        </div>
        <div id="vesco-route-map-panel-v6">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[11px] font-black text-slate-500 uppercase">Mapa da rota</div>
            <div class="text-[10px] font-bold text-blue-600 uppercase">Ponto inicial + entregas</div>
          </div>
          <div id="vesco-route-map-v6"></div>
        </div>`;
      const children = Array.from(root.children).filter(ch => ch.id !== 'vesco-saiu-layout-v6');
      root.appendChild(shell);
      shell.appendChild(left); shell.appendChild(right);
      children.forEach(ch => left.appendChild(ch));
    }
    v6InjectOriginField();
    setTimeout(() => { try { const m = v6EnsureRouteMap(); if(m) m.invalidateSize(true); } catch(e) {} }, 120);
    return shell;
  }
  function v6InjectOriginField(){
    if(document.getElementById('vesco-rota-origem-v6')) return;
    const root = v6RouteRoot() || document;
    const saved = localStorage.getItem(ORIGIN_KEY) || '';
    const wrap = document.createElement('div');
    wrap.className = 'vesco-rota-origem-v6 mb-3';
    wrap.innerHTML = `
      <label class="block text-xs font-black text-slate-700 mb-1">Ponto de partida da rota</label>
      <input id="vesco-rota-origem-v6" type="text" value="${v6Escape(saved)}" placeholder="Ex: Rua Conselheiro Dantas, 141 - Brás, São Paulo - SP" class="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm outline-none focus:border-blue-500" />
      <div class="text-[10px] text-slate-400 mt-1">Esse endereço será usado como início no mapa e no Google Maps.</div>`;
    const motorista = root.querySelector('#rotaMotorista, #motoristaRota, #routeDriver, input[name="motorista"], input[placeholder*="motorista" i]');
    const nome = root.querySelector('#rotaNome, #nomeRota, #routeName, input[name="rota"], input[placeholder*="rota" i]');
    const anchor = motorista || nome || root.querySelector('#saiu-pedidos-list') || root.firstElementChild;
    const parent = anchor && (anchor.closest('div') || anchor.parentElement);
    if(parent && parent.parentElement) parent.parentElement.insertBefore(wrap, parent.nextSibling);
    else root.prepend(wrap);
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => { try { localStorage.setItem(ORIGIN_KEY, input.value.trim()); } catch(e) {} });
  }
  function v6GetRouteOrigin(requireValue){
    v6InjectOriginField();
    const el = document.getElementById('vesco-rota-origem-v6');
    const val = v6CleanAddress((el && el.value) || localStorage.getItem(ORIGIN_KEY) || '');
    if(val) { try { localStorage.setItem(ORIGIN_KEY, val); } catch(e) {} }
    if(requireValue && !val) alert('Informe o ponto de partida da rota.');
    return val;
  }
  function v6FindLeafletMapForContainer(el){
    if(!el) return null;
    const seen = new Set();
    const scan = (obj, depth) => {
      if(!obj || seen.has(obj) || depth > 2) return null;
      seen.add(obj);
      try {
        if(obj._container === el && typeof obj.setView === 'function' && typeof obj.invalidateSize === 'function') return obj;
        if(typeof obj === 'object') {
          for(const k in obj){
            if(!Object.prototype.hasOwnProperty.call(obj,k)) continue;
            const v = obj[k];
            if(v && typeof v === 'object') {
              if(v._container === el && typeof v.setView === 'function' && typeof v.invalidateSize === 'function') return v;
              if(depth < 1 && /map|rota|route|saiu|vesco/i.test(k)) {
                const found = scan(v, depth + 1);
                if(found) return found;
              }
            }
          }
        }
      } catch(e) {}
      return null;
    };
    return scan(window, 0);
  }
  function v6EnsureRouteMap(){
    if(typeof L === 'undefined') return null;
    v6EnsureLayout();
    const el = document.getElementById('vesco-route-map-v6');
    if(!el) return null;
    let m = v6FindLeafletMapForContainer(el);
    if(m) { window.routeMapV6 = m; setTimeout(() => { try { m.invalidateSize(true); } catch(e) {} }, 80); return m; }
    try {
      if(el._leaflet_id) { el.innerHTML = ''; try { delete el._leaflet_id; } catch(e) { el._leaflet_id = undefined; } }
      m = L.map(el).setView(DEFAULT_CENTER, 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(m);
      window.routeMapV6 = m;
      setTimeout(() => { try { m.invalidateSize(true); } catch(e) {} }, 150);
      return m;
    } catch(err) { v6Warn('Falha ao iniciar mapa V6:', err); return null; }
  }
  function v6ClearRouteLayer(mapTarget){
    try { if(window.__vescoRouteLayerV6 && typeof window.__vescoRouteLayerV6.remove === 'function') window.__vescoRouteLayerV6.remove(); } catch(e) {}
    const layer = L.layerGroup().addTo(mapTarget);
    window.__vescoRouteLayerV6 = layer;
    return layer;
  }
  async function v6GeocodeAddressFast(address){
    address = v6CleanAddress(address);
    if(!address) return null;
    const key = v6AddressKey(address);
    const cache = v6LoadGeoCache();
    if(cache[key] && Number.isFinite(Number(cache[key].lat)) && Number.isFinite(Number(cache[key].lon))) return cache[key];
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 3200) : null;
    try {
      const q = encodeURIComponent(address.includes('Brasil') ? address : `${address}, Brasil`);
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=0`, {
        headers: { 'Accept-Language': 'pt-BR' }, signal: controller ? controller.signal : undefined
      });
      if(timer) clearTimeout(timer);
      const js = await res.json();
      if(Array.isArray(js) && js[0]) {
        const out = { lat: Number(js[0].lat), lon: Number(js[0].lon) };
        if(Number.isFinite(out.lat) && Number.isFinite(out.lon)) { cache[key] = out; v6SaveGeoCache(cache); return out; }
      }
    } catch(e) { if(timer) clearTimeout(timer); }
    return null;
  }
  async function v6ResolveStopCoords(stop){
    if(stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return { lat: Number(stop.lat), lon: Number(stop.lon) };
    if(stop && !stop.isOrigin) {
      const marker = v6MarkerCoords(stop.numero || stop.pedido);
      if(marker) return marker;
      const order = v6FindOrder(stop.numero || stop.pedido);
      const direct = v6DirectCoords(order);
      if(direct) return direct;
    }
    const geo = await v6GeocodeAddressFast(stop && stop.endereco);
    if(geo && stop) { stop.lat = geo.lat; stop.lon = geo.lon; }
    return geo;
  }
  async function v6ResolveStopsLimited(stops){
    const out = [];
    let index = 0;
    const workers = Array.from({length: Math.min(3, stops.length || 1)}, async () => {
      while(index < stops.length) {
        const i = index++;
        const s = stops[i];
        const coords = await v6ResolveStopCoords(s);
        if(coords) out[i] = { stop: s, coords };
      }
    });
    await Promise.all(workers);
    return out.filter(Boolean);
  }
  function v6RenderRouteInfo(rota, url, subtitle){
    v6EnsureLayout();
    const panel = document.getElementById('vesco-route-info-panel-v6');
    if(!panel) return;
    const stops = rota.paradas || [];
    const origin = rota.origem || (stops[0] && stops[0].isOrigin ? stops[0].endereco : '—');
    panel.innerHTML = `
      <div class="font-black text-blue-800 mb-2"><i class="fas fa-route mr-1"></i>Rota montada: ${v6Escape(rota.nome || 'Rota')}</div>
      <div class="mb-1"><b>Partida:</b> ${v6Escape(origin || '—')}</div>
      <div class="mb-1"><b>Motorista:</b> ${v6Escape(rota.motorista || '—')} • <b>Pedidos:</b> ${(rota.pedidos || []).length}</div>
      ${subtitle ? `<div class="mb-2 text-blue-700 font-bold">${v6Escape(subtitle)}</div>` : ''}
      <div class="max-h-40 overflow-auto bg-white/70 border border-blue-100 rounded-lg p-2 mb-2">
        ${(stops || []).map((s, i) => `<div class="mb-1"><b>${s.isOrigin ? 'Partida' : (i + '. #' + v6Escape(s.numero || s.pedido))}</b> — ${v6Escape(s.endereco || 'Endereço não localizado')}</div>`).join('') || 'Nenhum endereço localizado.'}
      </div>
      ${url ? `<button type="button" onclick="window.open('${v6Escape(url)}','_blank')" class="inline-flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold"><i class="fas fa-map-marked-alt"></i>Abrir rota no Google Maps</button>` : ''}`;
  }
  async function v6DrawRouteOnMap(rotaOrId){
    const rota = typeof rotaOrId === 'string' ? v6FindRouteById(rotaOrId) : rotaOrId;
    if(!rota) return v6Toast('Rota não encontrada.', 'error', 3000);
    v6EnsureLayout();
    const mapTarget = v6EnsureRouteMap();
    rota.origem = v6CleanAddress(rota.origem || v6GetRouteOrigin(false));
    rota.paradas = v6BuildStops(rota.pedidos || [], rota.origem);
    const url = v6BuildGoogleMapsRouteUrl(rota);
    if(url) { try { localStorage.setItem(LAST_ROUTE_URL_KEY, url); } catch(e) {} }
    v6RenderRouteInfo(rota, url, 'Carregando pontos no mapa...');
    if(!mapTarget || typeof L === 'undefined') { if(url) window.open(url, '_blank'); return url; }
    const layer = v6ClearRouteLayer(mapTarget);
    try { mapTarget.setView(DEFAULT_CENTER, 11); setTimeout(() => mapTarget.invalidateSize(true), 100); } catch(e) {}
    const resolved = await v6ResolveStopsLimited(rota.paradas);
    const latlngs = [];
    resolved.forEach((item, idx) => {
      const s = item.stop;
      const coords = item.coords;
      const ll = [coords.lat, coords.lon];
      latlngs.push(ll);
      try {
        const color = s.isOrigin ? '#111827' : '#2563eb';
        const label = s.isOrigin ? 'Partida' : `Pedido #${v6Escape(s.numero || s.pedido)}`;
        const icon = L.divIcon({ html: `<div style="width:28px;height:28px;border-radius:999px;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.25)">${s.isOrigin ? 'P' : idx}</div>`, className: '', iconSize: [28,28], iconAnchor: [14,14] });
        L.marker(ll, { icon }).addTo(layer).bindPopup(`<b>${label}</b><br>${v6Escape(s.cliente || '')}<br><small>${v6Escape(s.endereco || '')}</small>`);
      } catch(e) {}
    });
    if(latlngs.length > 1) { try { L.polyline(latlngs, { weight: 5, opacity: 0.88 }).addTo(layer); } catch(e) {} }
    try {
      if(latlngs.length === 1) mapTarget.setView(latlngs[0], 15);
      else if(latlngs.length > 1) mapTarget.fitBounds(L.latLngBounds(latlngs).pad(0.18), { maxZoom: 15 });
      else mapTarget.setView(DEFAULT_CENTER, 11);
      setTimeout(() => mapTarget.invalidateSize(true), 150);
      setTimeout(() => mapTarget.invalidateSize(true), 650);
    } catch(e) {}
    v6RenderRouteInfo(rota, url, `${Math.max(0, latlngs.length - (rota.origem ? 1 : 0))}/${(rota.pedidos || []).length} entrega(s) carregada(s) no mapa.`);
    v6PersistRoutes();
    return url;
  }
  function v6CollectSelectedRoutePedidos(){
    const selectors = [
      '#saiu-pedidos-list input[type="checkbox"]:checked', '#view-saiu input[type="checkbox"]:checked', '#view-rotas input[type="checkbox"]:checked',
      '#pedidosDisponiveis input[type="checkbox"]:checked', '[data-route-order]:checked', '[data-num][type="checkbox"]:checked', '[data-ecom][type="checkbox"]:checked'
    ];
    const inputs = Array.from(new Set(selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)))));
    const out = [];
    inputs.forEach(cb => {
      let val = cb.getAttribute('data-num') || cb.getAttribute('data-ecom') || cb.getAttribute('data-pedido') || cb.value || '';
      if(!val || val === 'on') {
        const row = cb.closest('tr') || cb.closest('.pedido-item') || cb.closest('[data-num]') || cb.parentElement;
        val = row && (row.getAttribute('data-num') || row.getAttribute('data-ecom') || row.getAttribute('data-pedido')) || '';
        if(!val && row) {
          const txt = row.innerText || '';
          const m = txt.match(/#\s*([0-9A-Za-z._-]{4,})/) || txt.match(/\b(\d{5,})\b/);
          if(m) val = m[1];
        }
      }
      val = v6Norm(val);
      if(val && !out.includes(val)) out.push(val);
    });
    return out;
  }
  function v6GetInputValue(candidates){
    for(const sel of candidates){ const el = document.querySelector(sel); if(el && String(el.value || '').trim()) return String(el.value).trim(); }
    return '';
  }
  function v6IsCreateRouteButton(btn){
    if(!btn || !btn.matches || !btn.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')) return false;
    const idName = `${btn.id || ''} ${btn.name || ''} ${btn.getAttribute('onclick') || ''}`;
    const text = `${btn.value || ''} ${btn.textContent || ''}`.trim();
    if(/btn[-_]?criar[-_]?rota|criarRota|createRoute/i.test(idName)) return true;
    return /\bcriar\s+rota\b/i.test(text) && !!(btn.closest('#view-rotas') || btn.closest('#view-saiu') || document.getElementById('rotaMotorista') || document.getElementById('rotaNome'));
  }
  function v6ExtractRouteIdFromButton(btn){
    const onclick = btn && btn.getAttribute && (btn.getAttribute('onclick') || '');
    const m = onclick.match(/['"](rota-[^'"]+)['"]/i) || onclick.match(/['"]([^'"]*\d{10,}[^'"]*)['"]/i);
    if(m) return m[1];
    const card = btn && btn.closest && btn.closest('[data-rota-id], [data-route-id]');
    return card && (card.getAttribute('data-rota-id') || card.getAttribute('data-route-id')) || '';
  }
  function v6IsTraceRouteButton(btn){
    if(!btn || !btn.matches || !btn.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')) return false;
    const idName = `${btn.id || ''} ${btn.name || ''} ${btn.getAttribute('onclick') || ''}`;
    const text = `${btn.value || ''} ${btn.textContent || ''}`.trim();
    if(/google\s*maps/i.test(text)) return !!v6ExtractRouteIdFromButton(btn);
    return /tracar|tra[cç]ar|route|rotaMapa|obter.*rota|verRotaMapa/i.test(idName) || /tra[cç]ar\s+(no\s+mapa|rota)|ver\s+no\s+mapa|obter informa[cç][oõ]es da rota/i.test(text);
  }
  function v6SilentUpdateStatus(id, status, observacao){
    try {
      if(typeof jsonpFetch !== 'function' || typeof API === 'undefined') return;
      const url = `${API}?action=updateStatus&id=${encodeURIComponent(id)}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator || '')}&observacao=${encodeURIComponent(observacao || '')}&dataSeparacao=${encodeURIComponent(v6NowBR())}`;
      jsonpFetch(url, function(err){ if(err) v6Warn('Erro ao salvar status da rota no backend:', id, err); });
    } catch(e) { v6Warn('Falha no update silencioso V6:', e); }
  }
  function v6MarkLocalOutForDelivery(pedidoNum, rota){
    const order = v6FindOrder(pedidoNum);
    const now = new Date().toISOString();
    if(order) {
      order.status_logistica = 'Despachado';
      order.situacao_nome = 'Despachado';
      order.data_despacho = v6NowBR();
      order.despachado_em = now;
      order.saiuParaEntregaEm = now;
      const obsAntiga = String(order.observacao_logistica || order.observacao || '').trim();
      const obsNova = `Saiu para entrega — Rota: ${rota.nome || 'Rota'} Motorista: ${rota.motorista || '—'} Origem: ${rota.origem || '—'}`;
      order.observacao_logistica = obsAntiga ? `${obsAntiga} | ${obsNova}` : obsNova;
    }
    try { if(typeof rememberStatusTransition === 'function') rememberStatusTransition(pedidoNum, 'Despachado'); } catch(e) {}
    try { if(typeof syncGlobalOrderState === 'function') syncGlobalOrderState(); } catch(e) {}
  }
  function v6DispatchRouteToStreet(rota, opts = {}){
    if(!rota) return;
    const now = new Date().toISOString();
    rota.status = 'despachada';
    rota.despachadaEm = rota.despachadaEm || now;
    rota.saiuEm = rota.saiuEm || now;
    rota.paradas = v6BuildStops(rota.pedidos || [], rota.origem);
    (rota.pedidos || []).forEach((pedidoNum, idx) => {
      v6MarkLocalOutForDelivery(pedidoNum, rota);
      if(!opts.skipBackend) setTimeout(() => v6SilentUpdateStatus(pedidoNum, 'Despachado', `Saiu para entrega — Rota: ${rota.nome || 'Rota'} Motorista: ${rota.motorista || '—'} Origem: ${rota.origem || '—'}`), idx * 180);
    });
    v6PersistRoutes();
    try { if(typeof render === 'function') render(); } catch(e) {}
    try { if(typeof window.renderPedidosDisponiveisSaiu === 'function') window.renderPedidosDisponiveisSaiu(); } catch(e) {}
    try { if(typeof window.renderSelectedTemp === 'function') window.renderSelectedTemp(); } catch(e) {}
    try { if(typeof window.renderRotas === 'function') window.renderRotas(); } catch(e) {}
    v6DrawRouteOnMap(rota);
  }
  function v6HandleCreateRoute(e){
    e.preventDefault(); e.stopPropagation(); if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    v6EnsureLayout();
    const origem = v6GetRouteOrigin(true);
    if(!origem) return;
    const motorista = v6GetInputValue(['#rotaMotorista', '#motoristaRota', '#routeDriver', 'input[name="motorista"]', 'input[placeholder*="motorista" i]']);
    const nome = v6GetInputValue(['#rotaNome', '#nomeRota', '#routeName', 'input[name="rota"]', 'input[placeholder*="rota" i]']) || `Rota ${new Date().toLocaleString('pt-BR')}`;
    const pedidos = v6CollectSelectedRoutePedidos();
    if(!motorista) return alert('Informe o nome do motorista.');
    if(!pedidos.length) return alert('Selecione ao menos 1 pedido para criar a rota.');
    window.saiuRotas = Array.isArray(window.saiuRotas) ? window.saiuRotas : [];
    const nova = { id: 'rota-' + Date.now(), nome, motorista, origem, pedidos, status: 'despachada', criadoEm: new Date().toISOString(), despachadaEm: new Date().toISOString(), saiuEm: new Date().toISOString(), paradas: v6BuildStops(pedidos, origem) };
    window.saiuRotas.push(nova);
    try { window.rotaTemp = { motorista: '', nome: '', pedidos: [] }; } catch(e) {}
    ['#rotaMotorista', '#motoristaRota', '#routeDriver', '#rotaNome', '#nomeRota', '#routeName'].forEach(sel => { const el = document.querySelector(sel); if(el) el.value = ''; });
    v6DispatchRouteToStreet(nova);
    v6Toast(`Rota criada. ${pedidos.length} pedido(s) marcado(s) como saiu para entrega.`, 'success', 4500);
  }
  function v6HandleTraceRoute(e){
    const routeId = v6ExtractRouteIdFromButton(e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]'));
    if(routeId) {
      e.preventDefault(); e.stopPropagation(); if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      const rota = v6FindRouteById(routeId);
      if(rota) return v6DrawRouteOnMap(rota);
    }
    const pedidos = v6CollectSelectedRoutePedidos();
    if(!pedidos.length) return;
    e.preventDefault(); e.stopPropagation(); if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    v6EnsureLayout();
    const origem = v6GetRouteOrigin(true);
    if(!origem) return;
    const temp = { id: 'rota-preview-' + Date.now(), nome: 'Prévia da rota', motorista: v6GetInputValue(['#rotaMotorista', '#motoristaRota', '#routeDriver', 'input[name="motorista"]', 'input[placeholder*="motorista" i]']) || '—', origem, pedidos, status: 'preview', criadoEm: new Date().toISOString(), paradas: v6BuildStops(pedidos, origem) };
    v6DrawRouteOnMap(temp).then(() => v6Toast('Rota traçada com ponto de partida e entregas selecionadas.', 'success', 3000));
  }

  window.addEventListener('click', function vescoRouteClickCaptureV6(e){
    const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if(!btn) return;
    if(v6IsCreateRouteButton(btn)) return v6HandleCreateRoute(e);
    if(v6IsTraceRouteButton(btn)) return v6HandleTraceRoute(e);
  }, true);

  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(v6EnsureLayout, 350);
    setTimeout(v6EnsureRouteMap, 700);
  });

  window.vescoRoutesV6 = {
    ensureLayout: v6EnsureLayout,
    ensureRouteMap: v6EnsureRouteMap,
    drawRouteOnMap: v6DrawRouteOnMap,
    buildStops: v6BuildStops,
    buildGoogleMapsRouteUrl: v6BuildGoogleMapsRouteUrl,
    collectSelectedRoutePedidos: v6CollectSelectedRoutePedidos,
    findRouteById: v6FindRouteById,
    getRouteOrigin: v6GetRouteOrigin,
    dispatchRouteToStreet: v6DispatchRouteToStreet,
    findOrder: v6FindOrder,
    persistRoutes: v6PersistRoutes,
    silentUpdateStatus: v6SilentUpdateStatus,
    nowBR: v6NowBR,
    escape: v6Escape
  };
  v6Log('Rotas V6 PRE ativo — mapa no canto superior direito e ponto de partida obrigatório.');
})();

// =================================================================
// CAMADA V5 — OTIMIZAÇÃO DO MAPA DE ROTAS + PENDÊNCIA ROBUSTA EM ENTREGUES
// Regra de Preservação: camada aditiva, sem remover funções anteriores.
// =================================================================
(function installVescoRoutesMapAndDeliveredPendenciaV5(){
  if (window.__vescoRoutesMapAndDeliveredPendenciaV5) return;
  window.__vescoRoutesMapAndDeliveredPendenciaV5 = true;

  const ROUTES_KEY = 'vesco_saiu_rotas_v1';
  const LAST_ROUTE_URL_KEY = 'vesco_last_google_route_url_v5';
  const GEO_CACHE_KEY = 'vesco_route_geocode_cache_v5';
  const DEFAULT_CENTER = [-23.55052, -46.633308];

  function v5Log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function v5Warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function v5Toast(msg, ms){
    try { if (typeof showToast === 'function') return showToast(msg, ms || 3500); } catch(e) {}
    v5Log(msg);
  }
  function v5Escape(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function v5Norm(v){
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(v) : String(v ?? '').trim(); }
    catch(e){ return String(v ?? '').trim(); }
  }
  function v5NormEcom(v){
    try { return typeof normalizeEcomNumber === 'function' ? normalizeEcomNumber(v) : String(v ?? '').replace(/\D/g,''); }
    catch(e){ return String(v ?? '').trim(); }
  }
  function v5NowBR(){
    const d = new Date();
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  function v5PersistRoutes(){
    try { localStorage.setItem(ROUTES_KEY, JSON.stringify(window.saiuRotas || [])); } catch(e) {}
  }
  function v5LoadGeoCache(){
    try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}') || {}; } catch(e) { return {}; }
  }
  function v5SaveGeoCache(cache){
    try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache || {})); } catch(e) {}
  }
  function v5CleanAddress(addr){
    return String(addr || '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, ',')
      .replace(/\bSao\b/gi, 'São')
      .trim();
  }
  function v5AddressKey(addr){ return v5CleanAddress(addr).toLowerCase(); }

  function v5AllOrders(){
    const localOrders = (typeof orders !== 'undefined' && Array.isArray(orders)) ? orders : [];
    const localFlex = (typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) ? flexOrders : [];
    const winOrders = Array.isArray(window.orders) ? window.orders : [];
    const winFlex = Array.isArray(window.flexOrders) ? window.flexOrders : [];
    return Array.from(new Set([].concat(localOrders, localFlex, winOrders, winFlex).filter(Boolean)));
  }
  function v5OrderKeys(o){
    if(!o) return [];
    const vals = [
      o.id, o.numero, o.pedido, o.order_id, o.orderNumber, o.reference, o.referencia,
      o.numero_ecommerce, o.numero_ecom, o.ecom, o.ecom_id, o.codigo_externo, o.codigo
    ];
    const keys = [];
    vals.forEach(v => {
      if(v === undefined || v === null || String(v).trim() === '') return;
      const raw = String(v).trim();
      keys.push(raw, v5Norm(raw), v5NormEcom(raw));
    });
    return Array.from(new Set(keys.filter(Boolean)));
  }
  function v5FindOrder(key){
    const raw = String(key ?? '').trim();
    const norm = v5Norm(raw);
    const ecom = v5NormEcom(raw);
    return v5AllOrders().find(o => {
      const keys = v5OrderKeys(o);
      return keys.includes(raw) || keys.includes(norm) || keys.includes(ecom);
    }) || null;
  }
  function v5OrderAddress(o){
    if(!o) return '';
    return v5CleanAddress(o.endereco_completo || o.endereco || o.address || o.full_address || o.logradouro || '');
  }
  function v5OrderClient(o){
    try { return extractClientNameFromAny(o) || o.cliente_nome || o.cliente || o.nome || o.destinatario || ''; }
    catch(e){ return o && (o.cliente_nome || o.cliente || o.nome || o.destinatario) || ''; }
  }
  function v5DirectCoords(o){
    try {
      const c = typeof getCoords === 'function' ? getCoords(o) : null;
      if(c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon))) return { lat: Number(c.lat), lon: Number(c.lon) };
    } catch(e) {}
    return null;
  }
  function v5MarkerCoords(key){
    try {
      const m = (typeof findMainMarkerByKey === 'function' && findMainMarkerByKey(key)) ||
                (typeof findFlexMarkerByKey === 'function' && findFlexMarkerByKey(key));
      if(m && typeof m.getLatLng === 'function') {
        const ll = m.getLatLng();
        if(ll && Number.isFinite(Number(ll.lat)) && Number.isFinite(Number(ll.lng))) return { lat: Number(ll.lat), lon: Number(ll.lng) };
      }
    } catch(e) {}
    return null;
  }
  function v5BuildStops(pedidos){
    return Array.from(new Set((pedidos || []).map(v => String(v || '').trim()).filter(Boolean))).map(pedido => {
      const order = v5FindOrder(pedido);
      const coords = v5DirectCoords(order) || v5MarkerCoords(pedido) || v5MarkerCoords(order && (order.numero || order.id));
      return {
        pedido,
        id: order && (order.id || order.numero) || pedido,
        numero: order && (order.numero || order.id) || pedido,
        cliente: v5OrderClient(order),
        endereco: v5OrderAddress(order),
        lat: coords ? coords.lat : null,
        lon: coords ? coords.lon : null
      };
    });
  }
  function v5EncodeStop(stop){
    if(stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return `${Number(stop.lat)},${Number(stop.lon)}`;
    return v5CleanAddress((stop && stop.endereco) || (stop && stop.cliente) || (stop && stop.numero) || '');
  }
  function v5BuildGoogleMapsRouteUrl(rota){
    const stops = (rota && rota.paradas && rota.paradas.length ? rota.paradas : v5BuildStops(rota && rota.pedidos || [])).filter(s => v5EncodeStop(s));
    if(!stops.length) return '';
    const limited = stops.slice(0, 25);
    if(limited.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v5EncodeStop(limited[0]))}`;
    const origin = v5EncodeStop(limited[0]);
    const destination = v5EncodeStop(limited[limited.length - 1]);
    const waypoints = limited.slice(1, -1).map(v5EncodeStop).filter(Boolean);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
    if(waypoints.length) url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
    return url;
  }
  function v5FindRouteById(id){
    return (window.saiuRotas || []).find(r => String(r.id) === String(id)) || null;
  }

  function v5RouteRoot(){
    const candidates = ['#view-rotas:not(.hidden)', '#view-saiu:not(.hidden)', '#view-rotas', '#view-saiu'];
    for(const sel of candidates){
      const el = document.querySelector(sel);
      if(el) return el;
    }
    return document.body;
  }
  function v5Visible(el){
    if(!el) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return (!style || (style.display !== 'none' && style.visibility !== 'hidden')) && el.offsetParent !== null;
  }
  function v5FindLeafletMapForContainer(el){
    if(!el) return null;
    const seen = new Set();
    const scan = (obj, depth) => {
      if(!obj || seen.has(obj) || depth > 2) return null;
      seen.add(obj);
      try {
        if(obj._container === el && typeof obj.setView === 'function' && typeof obj.invalidateSize === 'function') return obj;
        if(typeof obj === 'object') {
          for(const k in obj){
            if(!Object.prototype.hasOwnProperty.call(obj,k)) continue;
            const v = obj[k];
            if(v && typeof v === 'object') {
              if(v._container === el && typeof v.setView === 'function' && typeof v.invalidateSize === 'function') return v;
              if(depth < 1 && /map|rota|route|saiu/i.test(k)) {
                const found = scan(v, depth + 1);
                if(found) return found;
              }
            }
          }
        }
      } catch(e) {}
      return null;
    };
    return scan(window, 0);
  }
  function v5RouteMapContainer(){
    const root = v5RouteRoot();
    const preferredIds = ['vesco-route-map-v5','map-rotas','rotas-map','route-map','map-route','routeMap','map-saiu','saiu-map','mapa-rotas','mapaRotas','mapRota'];
    for(const id of preferredIds){
      const el = document.getElementById(id);
      if(el && (root.contains(el) || id === 'vesco-route-map-v5')) return el;
    }
    const inside = Array.from(root.querySelectorAll('.leaflet-container, [id*="map" i], [class*="map" i]'))
      .filter(el => el instanceof HTMLElement)
      .filter(el => !['map','map-flex'].includes(el.id))
      .filter(el => (el.clientWidth > 120 || el.offsetWidth > 120 || /map/i.test(el.id + ' ' + el.className)));
    if(inside.length) return inside[0];

    let panel = document.getElementById('vesco-route-map-panel-v5');
    if(!panel) {
      panel = document.createElement('div');
      panel.id = 'vesco-route-map-panel-v5';
      panel.className = 'mt-3 rounded-xl border border-slate-200 bg-white p-2';
      panel.innerHTML = `<div class="text-[11px] font-black text-slate-500 mb-2 uppercase">Mapa da rota</div><div id="vesco-route-map-v5" style="height:360px;min-height:360px;width:100%;border-radius:12px;overflow:hidden;background:#eef2f7"></div>`;
      const anchor = root.querySelector('#vesco-route-info-panel-v5') || Array.from(root.querySelectorAll('button')).find(b => /tra[cç]ar rota|obter informa/i.test(b.textContent || ''));
      if(anchor && anchor.parentElement) anchor.parentElement.insertAdjacentElement('afterend', panel);
      else root.appendChild(panel);
    }
    return document.getElementById('vesco-route-map-v5');
  }
  function v5EnsureRouteMap(){
    if(typeof L === 'undefined') return null;
    const el = v5RouteMapContainer();
    if(!el) return null;
    el.style.minHeight = el.style.minHeight || '360px';
    el.style.height = el.style.height || '360px';
    el.style.width = el.style.width || '100%';
    el.style.borderRadius = el.style.borderRadius || '12px';
    el.style.overflow = 'hidden';

    let m = v5FindLeafletMapForContainer(el);
    if(m) {
      window.routeMap = m;
      setTimeout(() => { try { m.invalidateSize(true); } catch(e) {} }, 80);
      return m;
    }

    try {
      if(el._leaflet_id) {
        el.innerHTML = '';
        try { delete el._leaflet_id; } catch(e) { el._leaflet_id = undefined; }
      }
      m = L.map(el).setView(DEFAULT_CENTER, 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(m);
      window.routeMap = m;
      setTimeout(() => { try { m.invalidateSize(true); } catch(e) {} }, 120);
      return m;
    } catch(err) {
      v5Warn('Falha ao iniciar mapa de rotas V5:', err);
      return null;
    }
  }
  function v5ClearRouteLayer(mapTarget){
    try { if(window.__vescoRouteLayerV5 && typeof window.__vescoRouteLayerV5.remove === 'function') window.__vescoRouteLayerV5.remove(); } catch(e) {}
    try { if(window.__vescoRouteLayerV4 && typeof window.__vescoRouteLayerV4.remove === 'function') window.__vescoRouteLayerV4.remove(); } catch(e) {}
    const layer = L.layerGroup().addTo(mapTarget);
    window.__vescoRouteLayerV5 = layer;
    return layer;
  }

  async function v5GeocodeAddressFast(address){
    address = v5CleanAddress(address);
    if(!address) return null;
    const key = v5AddressKey(address);
    const cache = v5LoadGeoCache();
    if(cache[key] && Number.isFinite(Number(cache[key].lat)) && Number.isFinite(Number(cache[key].lon))) return cache[key];

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 2600) : null;
    try {
      const q = encodeURIComponent(address.includes('Brasil') ? address : `${address}, Brasil`);
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=0`, {
        headers: { 'Accept-Language': 'pt-BR' },
        signal: controller ? controller.signal : undefined
      });
      if(timer) clearTimeout(timer);
      const js = await res.json();
      if(Array.isArray(js) && js[0]) {
        const out = { lat: Number(js[0].lat), lon: Number(js[0].lon) };
        if(Number.isFinite(out.lat) && Number.isFinite(out.lon)) {
          cache[key] = out;
          v5SaveGeoCache(cache);
          return out;
        }
      }
    } catch(e) { if(timer) clearTimeout(timer); }
    return null;
  }
  async function v5ResolveStopCoords(stop){
    if(stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return { lat: Number(stop.lat), lon: Number(stop.lon) };
    const marker = v5MarkerCoords(stop && (stop.numero || stop.pedido));
    if(marker) return marker;
    const order = v5FindOrder(stop && (stop.numero || stop.pedido));
    const direct = v5DirectCoords(order);
    if(direct) return direct;
    const geo = await v5GeocodeAddressFast(stop && stop.endereco);
    if(geo) {
      stop.lat = geo.lat;
      stop.lon = geo.lon;
      return geo;
    }
    return null;
  }
  async function v5ResolveStopsLimited(stops){
    const out = [];
    let index = 0;
    const workers = Array.from({length: Math.min(4, stops.length || 1)}, async () => {
      while(index < stops.length) {
        const i = index++;
        const s = stops[i];
        const coords = await v5ResolveStopCoords(s);
        if(coords) out[i] = { stop: s, coords };
      }
    });
    await Promise.all(workers);
    return out.filter(Boolean);
  }

  async function v5DrawRouteOnMap(rotaOrId){
    const rota = typeof rotaOrId === 'string' ? v5FindRouteById(rotaOrId) : rotaOrId;
    if(!rota) return v5Toast('Rota não encontrada.', 3000);

    const mapTarget = v5EnsureRouteMap();
    const stops = (rota.paradas && rota.paradas.length ? rota.paradas : v5BuildStops(rota.pedidos || []));
    rota.paradas = stops;
    const url = v5BuildGoogleMapsRouteUrl(rota);
    if(url) {
      try { localStorage.setItem(LAST_ROUTE_URL_KEY, url); } catch(e) {}
      v5RenderRouteInfo(rota, url, 'Carregando pontos no mapa...');
    }

    if(!mapTarget || typeof L === 'undefined') {
      if(url) window.open(url, '_blank');
      return url;
    }

    const layer = v5ClearRouteLayer(mapTarget);
    try { mapTarget.setView(DEFAULT_CENTER, 11); setTimeout(() => mapTarget.invalidateSize(true), 100); } catch(e) {}

    const resolved = await v5ResolveStopsLimited(stops);
    const latlngs = [];
    resolved.forEach((item, idx) => {
      const s = item.stop;
      const coords = item.coords;
      const ll = [coords.lat, coords.lon];
      latlngs.push(ll);
      try {
        L.marker(ll).addTo(layer).bindPopup(`<b>${idx + 1}. Pedido #${v5Escape(s.numero || s.pedido)}</b><br>${v5Escape(s.cliente || '')}<br><small>${v5Escape(s.endereco || '')}</small>`);
      } catch(e) {}
    });
    if(latlngs.length > 1) {
      try { L.polyline(latlngs, { weight: 4, opacity: 0.85 }).addTo(layer); } catch(e) {}
    }
    try {
      if(latlngs.length === 1) mapTarget.setView(latlngs[0], 15);
      else if(latlngs.length > 1) mapTarget.fitBounds(L.latLngBounds(latlngs).pad(0.18), { maxZoom: 15 });
      else mapTarget.setView(DEFAULT_CENTER, 11);
      setTimeout(() => mapTarget.invalidateSize(true), 150);
      setTimeout(() => mapTarget.invalidateSize(true), 650);
    } catch(e) {}

    v5RenderRouteInfo(rota, url, `${latlngs.length}/${stops.length} endereço(s) carregado(s) no mapa.`);
    v5PersistRoutes();
    return url;
  }
  function v5RenderRouteInfo(rota, url, subtitle){
    const root = v5RouteRoot();
    let panel = document.getElementById('vesco-route-info-panel-v5') || document.getElementById('vesco-route-info-panel');
    if(!panel) {
      panel = document.createElement('div');
      panel.id = 'vesco-route-info-panel-v5';
      panel.className = 'my-3 p-3 rounded-xl border border-blue-100 bg-blue-50 text-xs text-slate-700';
      const anchor = Array.from(root.querySelectorAll('button')).find(b => /p\/ motorista|tra[cç]ar rota|obter informa/i.test(b.textContent || ''));
      if(anchor && anchor.parentElement) anchor.parentElement.insertAdjacentElement('afterend', panel);
      else root.prepend(panel);
    } else {
      panel.id = 'vesco-route-info-panel-v5';
    }
    const stops = rota.paradas || [];
    panel.innerHTML = `
      <div class="font-black text-blue-800 mb-2"><i class="fas fa-route mr-1"></i>Rota montada: ${v5Escape(rota.nome || 'Rota')}</div>
      <div class="mb-1"><b>Motorista:</b> ${v5Escape(rota.motorista || '—')} • <b>Pedidos:</b> ${stops.length || (rota.pedidos || []).length}</div>
      ${subtitle ? `<div class="mb-2 text-blue-700 font-bold">${v5Escape(subtitle)}</div>` : ''}
      <div class="max-h-36 overflow-auto bg-white/70 border border-blue-100 rounded-lg p-2 mb-2">
        ${(stops || []).map((s, i) => `<div class="mb-1"><b>${i + 1}. #${v5Escape(s.numero || s.pedido)}</b> — ${v5Escape(s.endereco || 'Endereço não localizado')}</div>`).join('') || 'Nenhum endereço localizado.'}
      </div>
      ${url ? `<button type="button" onclick="window.open('${v5Escape(url)}','_blank')" class="inline-flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold"><i class="fas fa-map-marked-alt"></i>Abrir rota no Google Maps</button>` : ''}
    `;
  }

  function v5CollectSelectedRoutePedidos(){
    const selectors = [
      '#saiu-pedidos-list input[type="checkbox"]:checked',
      '#view-saiu input[type="checkbox"]:checked',
      '#view-rotas input[type="checkbox"]:checked',
      '#pedidosDisponiveis input[type="checkbox"]:checked',
      '[data-route-order]:checked',
      '[data-num][type="checkbox"]:checked',
      '[data-ecom][type="checkbox"]:checked'
    ];
    const inputs = Array.from(new Set(selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)))));
    const out = [];
    inputs.forEach(cb => {
      let val = cb.getAttribute('data-num') || cb.getAttribute('data-ecom') || cb.getAttribute('data-pedido') || cb.value || '';
      if(!val || val === 'on') {
        const row = cb.closest('tr') || cb.closest('.pedido-item') || cb.closest('[data-num]') || cb.parentElement;
        val = row && (row.getAttribute('data-num') || row.getAttribute('data-ecom') || row.getAttribute('data-pedido')) || '';
        if(!val && row) {
          const txt = row.innerText || '';
          const m = txt.match(/#\s*([0-9A-Za-z._-]{4,})/) || txt.match(/\b(\d{5,})\b/);
          if(m) val = m[1];
        }
      }
      val = v5Norm(val);
      if(val) out.push(val);
    });
    return Array.from(new Set(out));
  }
  function v5GetInputValue(candidates){
    for(const sel of candidates){
      const el = document.querySelector(sel);
      if(el && String(el.value || '').trim()) return String(el.value).trim();
    }
    return '';
  }
  function v5IsCreateRouteButton(btn){
    if(!btn || !btn.matches || !btn.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')) return false;
    const idName = `${btn.id || ''} ${btn.name || ''} ${btn.getAttribute('onclick') || ''}`;
    const text = `${btn.value || ''} ${btn.textContent || ''}`.trim();
    if(/btn[-_]?criar[-_]?rota|criarRota|createRoute/i.test(idName)) return true;
    return /\bcriar\s+rota\b/i.test(text) && !!(btn.closest('#view-rotas') || btn.closest('#view-saiu') || document.getElementById('rotaMotorista') || document.getElementById('rotaNome'));
  }
  function v5IsTraceRouteButton(btn){
    if(!btn || !btn.matches || !btn.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')) return false;
    const idName = `${btn.id || ''} ${btn.name || ''} ${btn.getAttribute('onclick') || ''}`;
    const text = `${btn.value || ''} ${btn.textContent || ''}`.trim();
    return /tracar|tra[cç]ar|route|rotaMapa|obter.*rota/i.test(idName) || /tra[cç]ar\s+rota|obter informa[cç][oõ]es da rota/i.test(text);
  }
  function v5MarkLocalOutForDelivery(pedidoNum, rota){
    const order = v5FindOrder(pedidoNum);
    const now = new Date().toISOString();
    const todayBR = v5NowBR();
    if(order) {
      order.status_logistica = 'Despachado';
      order.situacao_nome = 'Saiu para entrega';
      order.data_despacho = todayBR;
      order.despachado_em = now;
      order.saiuParaEntregaEm = now;
      const obsAntiga = String(order.observacao_logistica || order.observacao || '').trim();
      const obsNova = `Saiu para entrega — Rota: ${rota.nome || 'Rota'} Motorista: ${rota.motorista || '—'}`;
      order.observacao_logistica = obsAntiga ? `${obsAntiga} | ${obsNova}` : obsNova;
    }
    try { if(typeof rememberStatusTransition === 'function') rememberStatusTransition(pedidoNum, 'Despachado'); } catch(e) {}
    try { if(typeof syncGlobalOrderState === 'function') syncGlobalOrderState(); } catch(e) {}
  }
  function v5SilentUpdateStatus(id, status, observacao){
    try {
      if(typeof jsonpFetch !== 'function' || typeof API === 'undefined') return;
      const url = `${API}?action=updateStatus&id=${encodeURIComponent(id)}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator || '')}&observacao=${encodeURIComponent(observacao || '')}&dataSeparacao=${encodeURIComponent(v5NowBR())}`;
      jsonpFetch(url, function(err){ if(err) v5Warn('Erro ao salvar status da rota no backend:', id, err); });
    } catch(e) { v5Warn('Falha no update silencioso:', e); }
  }
  function v5DispatchRouteToStreet(rota, opts = {}){
    if(!rota) return;
    const now = new Date().toISOString();
    rota.status = 'despachada';
    rota.despachadaEm = rota.despachadaEm || now;
    rota.saiuEm = rota.saiuEm || now;
    rota.paradas = v5BuildStops(rota.pedidos || []);
    (rota.pedidos || []).forEach((pedidoNum, idx) => {
      v5MarkLocalOutForDelivery(pedidoNum, rota);
      if(!opts.skipBackend) setTimeout(() => v5SilentUpdateStatus(pedidoNum, 'Despachado', `Saiu para entrega — Rota: ${rota.nome || 'Rota'} Motorista: ${rota.motorista || '—'}`), idx * 220);
    });
    v5PersistRoutes();
    try { if(typeof render === 'function') render(); } catch(e) {}
    try { if(typeof window.renderPedidosDisponiveisSaiu === 'function') window.renderPedidosDisponiveisSaiu(); } catch(e) {}
    try { if(typeof window.renderSelectedTemp === 'function') window.renderSelectedTemp(); } catch(e) {}
    try { if(typeof window.renderRotas === 'function') window.renderRotas(); } catch(e) {}
    v5DrawRouteOnMap(rota);
  }
  function v5HandleCreateRoute(e){
    e.preventDefault();
    e.stopPropagation();
    if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    const motorista = v5GetInputValue(['#rotaMotorista', '#motoristaRota', '#routeDriver', 'input[name="motorista"]', 'input[placeholder*="motorista" i]']);
    const nome = v5GetInputValue(['#rotaNome', '#nomeRota', '#routeName', 'input[name="rota"]', 'input[placeholder*="rota" i]']) || `Rota ${new Date().toLocaleString('pt-BR')}`;
    const pedidos = v5CollectSelectedRoutePedidos();
    if(!motorista) return alert('Informe o nome do motorista.');
    if(!pedidos.length) return alert('Selecione ao menos 1 pedido para criar a rota.');
    window.saiuRotas = Array.isArray(window.saiuRotas) ? window.saiuRotas : [];
    const nova = { id: 'rota-' + Date.now(), nome, motorista, pedidos, status: 'despachada', criadoEm: new Date().toISOString(), despachadaEm: new Date().toISOString(), saiuEm: new Date().toISOString(), paradas: v5BuildStops(pedidos) };
    window.saiuRotas.push(nova);
    try { window.rotaTemp = { motorista: '', nome: '', pedidos: [] }; } catch(e) {}
    ['#rotaMotorista', '#motoristaRota', '#routeDriver', '#rotaNome', '#nomeRota', '#routeName'].forEach(sel => { const el = document.querySelector(sel); if(el) el.value = ''; });
    v5DispatchRouteToStreet(nova);
    v5Toast(`Rota criada. ${pedidos.length} pedido(s) marcado(s) como saiu para entrega.`, 4500);
  }
  function v5HandleTraceRoute(e){
    const pedidos = v5CollectSelectedRoutePedidos();
    if(!pedidos.length) return;
    e.preventDefault();
    e.stopPropagation();
    if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    const temp = { id: 'rota-preview-' + Date.now(), nome: 'Prévia da rota', motorista: v5GetInputValue(['#rotaMotorista', '#motoristaRota', '#routeDriver', 'input[name="motorista"]', 'input[placeholder*="motorista" i]']) || '—', pedidos, status: 'preview', criadoEm: new Date().toISOString(), paradas: v5BuildStops(pedidos) };
    v5DrawRouteOnMap(temp).then(() => v5Toast('Rota traçada com os endereços selecionados.', 3000));
  }

  window.addEventListener('click', function vescoRouteClickCaptureV5(e){
    const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if(!btn) return;
    if(v5IsCreateRouteButton(btn)) return v5HandleCreateRoute(e);
    if(v5IsTraceRouteButton(btn)) return v5HandleTraceRoute(e);
  }, true);

  const prevVerRotaMapa = window.verRotaMapa;
  window.verRotaMapa = function(rotaId){
    const rota = v5FindRouteById(rotaId);
    if(rota) return v5DrawRouteOnMap(rota);
    if(typeof prevVerRotaMapa === 'function') return prevVerRotaMapa.apply(this, arguments);
  };
  window.vescoOpenRouteInGoogle = function(rotaId){
    const rota = v5FindRouteById(rotaId);
    const url = rota ? v5BuildGoogleMapsRouteUrl(rota) : localStorage.getItem(LAST_ROUTE_URL_KEY);
    if(url) window.open(url, '_blank');
    else v5Toast('Nenhuma rota disponível para abrir.', 3000);
  };
  window.vescoGetRouteInfo = function(rotaId){
    const rota = v5FindRouteById(rotaId);
    if(!rota) return v5Toast('Rota não encontrada.', 3000);
    v5RenderRouteInfo(rota, v5BuildGoogleMapsRouteUrl(rota));
    return rota;
  };

  function v5FallbackPendencia(id){
    const motivo = prompt(`Motivo da pendência do pedido #${id}:`);
    if(!motivo) return;
    try {
      if(typeof updateStatusJsonp === 'function') updateStatusJsonp(id, 'Pendente', motivo);
      else v5SilentUpdateStatus(id, 'Pendente', motivo);
    } catch(e) { v5Warn(e); }
  }
  window.vescoEntregueParaPendenciaV5 = function(id){
    if(typeof window.moverParaPendenciaPrompt === 'function') return window.moverParaPendenciaPrompt(id);
    if(typeof moverParaPendenciaPrompt === 'function') return moverParaPendenciaPrompt(id);
    return v5FallbackPendencia(id);
  };
  function v5InjectDeliveredPendenciaButtons(){
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(row => {
      if(row.querySelector('.vesco-entregue-pendencia-btn-v5')) return;
      if(/nenhum despacho|nenhum registro/i.test(row.innerText || '')) return;
      const txt = row.innerText || '';
      const m = txt.match(/#\s*([0-9A-Za-z._-]+)/) || txt.match(/\b(\d{5,})\b/);
      if(!m) return;
      const numero = m[1];
      const order = v5FindOrder(numero);
      const id = order && (order.id || order.numero) || numero;
      let target = row.querySelector('td:last-child');
      if(!target) return;
      const wrap = document.createElement('div');
      wrap.className = 'mt-2 flex justify-center gap-2';
      wrap.innerHTML = `<button type="button" class="vesco-entregue-pendencia-btn-v5 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.vescoEntregueParaPendenciaV5 && window.vescoEntregueParaPendenciaV5('${v5Escape(id)}')"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>`;
      target.appendChild(wrap);
    });
  }

  const prevRender = typeof render === 'function' ? render : null;
  if(prevRender) {
    render = function(){
      const res = prevRender.apply(this, arguments);
      setTimeout(v5InjectDeliveredPendenciaButtons, 0);
      setTimeout(() => { try { const m = v5FindLeafletMapForContainer(v5RouteMapContainer()); if(m) m.invalidateSize(true); } catch(e) {} }, 120);
      return res;
    };
    window.render = render;
  }
  const prevSwitchTab = window.switchTab;
  if(typeof prevSwitchTab === 'function') {
    window.switchTab = function(which){
      const res = prevSwitchTab.apply(this, arguments);
      if(which === 'rotas' || which === 'saiu') setTimeout(() => { const m = v5EnsureRouteMap(); try { if(m) m.invalidateSize(true); } catch(e) {} }, 250);
      if(which === 'entregues') setTimeout(v5InjectDeliveredPendenciaButtons, 150);
      return res;
    };
  }
  const obs = new MutationObserver(() => {
    if(document.getElementById('table-entregues')) v5InjectDeliveredPendenciaButtons();
  });
  document.addEventListener('DOMContentLoaded', function(){
    try { obs.observe(document.body, { childList: true, subtree: true }); } catch(e) {}
    setTimeout(v5InjectDeliveredPendenciaButtons, 500);
    setTimeout(() => { const root = v5RouteRoot(); if(root && (root.id === 'view-rotas' || root.id === 'view-saiu')) v5EnsureRouteMap(); }, 600);
  });

  window.vescoRoutesV5 = {
    buildStops: v5BuildStops,
    drawRouteOnMap: v5DrawRouteOnMap,
    ensureRouteMap: v5EnsureRouteMap,
    injectDeliveredPendenciaButtons: v5InjectDeliveredPendenciaButtons,
    collectSelectedRoutePedidos: v5CollectSelectedRoutePedidos,
    buildGoogleMapsRouteUrl: v5BuildGoogleMapsRouteUrl
  };
  v5Log('Rotas V5 ativo — mapa dedicado de rotas, criação otimizada e Pendência robusta em Entregues.');
})();


// =================================================================
// CAMADA V6 POST — ENTREGAS DO MOTORISTA + PENDÊNCIA EM ENTREGUES + OTIMIZAÇÃO DE GEOCODE
// Regra de Preservação: wrappers aditivos sobre funções legadas/V5.
// =================================================================
(function installVescoDeliveredAndRoutePostV6(){
  if (window.__vescoDeliveredAndRoutePostV6) return;
  window.__vescoDeliveredAndRoutePostV6 = true;

  const SHADOW_DELIVERED_KEY = 'vesco_delivered_shadow_v6';

  function v6Log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function v6Warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function v6Toast(msg, typeOrMs, ms){
    try {
      if (typeof showToast === 'function') {
        if (typeof typeOrMs === 'string') return showToast(msg, typeOrMs, ms || 3500);
        return showToast(msg, typeOrMs || 3500);
      }
    } catch(e) {}
    v6Log(msg);
  }
  function v6Escape(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function v6Norm(v){
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(v) : String(v ?? '').trim(); }
    catch(e){ return String(v ?? '').trim(); }
  }
  function v6NowBR(){
    const d = new Date();
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  function v6FindOrder(id){
    try { if(window.vescoRoutesV6 && typeof window.vescoRoutesV6.findOrder === 'function') return window.vescoRoutesV6.findOrder(id); } catch(e) {}
    const raw = String(id || '').replace(/[^0-9A-Za-z._-]/g,'');
    const pools = [].concat((typeof orders !== 'undefined' && Array.isArray(orders)) ? orders : [], (typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) ? flexOrders : [], Array.isArray(window.orders) ? window.orders : [], Array.isArray(window.flexOrders) ? window.flexOrders : []);
    return pools.find(o => String(o.id || o.numero || '').replace(/[^0-9A-Za-z._-]/g,'') === raw || String(o.numero_ecommerce || '').replace(/[^0-9A-Za-z._-]/g,'') === raw) || null;
  }
  function v6ReadShadow(){ try { return JSON.parse(localStorage.getItem(SHADOW_DELIVERED_KEY) || '[]') || []; } catch(e) { return []; } }
  function v6WriteShadow(list){ try { localStorage.setItem(SHADOW_DELIVERED_KEY, JSON.stringify(list || [])); } catch(e) {} }
  function v6RememberDelivered(order, recebedor, documento, observacao){
    if(!order) return;
    const id = order.id || order.numero;
    const numero = order.numero || order.id || id;
    const payload = Object.assign({}, order, {
      id,
      numero,
      status_logistica: 'Entregue',
      situacao_nome: 'Entregue',
      nome_recebedor: recebedor || order.nome_recebedor || '',
      doc_recebedor: documento || order.doc_recebedor || '',
      observacao_logistica: observacao || order.observacao_logistica || order.observacao || '',
      entregue_em: new Date().toISOString(),
      data_entregue: v6NowBR(),
      data_entrega_realizada: v6NowBR()
    });
    const list = v6ReadShadow().filter(x => String(x.id || x.numero) !== String(id) && String(x.numero) !== String(numero));
    list.push(payload);
    v6WriteShadow(list.slice(-300));
  }
  function v6RemoveShadow(id){
    const raw = String(id || '');
    const norm = v6Norm(raw);
    v6WriteShadow(v6ReadShadow().filter(x => String(x.id || x.numero) !== raw && v6Norm(x.id || x.numero) !== norm && v6Norm(x.numero) !== norm));
  }
  function v6MergeDeliveredShadow(){
    try {
      if(typeof orders === 'undefined' || !Array.isArray(orders)) return;
      const list = v6ReadShadow();
      list.forEach(sh => {
        const found = orders.find(o => String(o.id || o.numero) === String(sh.id || sh.numero) || v6Norm(o.numero || o.id) === v6Norm(sh.numero || sh.id));
        if(found) Object.assign(found, sh, { status_logistica: 'Entregue', situacao_nome: 'Entregue' });
        else orders.push(Object.assign({}, sh, { status_logistica: 'Entregue', situacao_nome: 'Entregue' }));
      });
      try { window.orders = orders; } catch(e) {}
    } catch(e) { v6Warn('Falha ao mesclar entregues shadow:', e); }
  }
  function v6MarkDeliveredLocal(id, recebedor, documento, observacao){
    let order = v6FindOrder(id);
    if(!order) order = { id, numero: id, cliente_nome: '', endereco_completo: '' };
    order.status_logistica = 'Entregue';
    order.situacao_nome = 'Entregue';
    order.nome_recebedor = recebedor || order.nome_recebedor || '';
    order.doc_recebedor = documento || order.doc_recebedor || '';
    order.entregue_em = new Date().toISOString();
    order.data_entregue = v6NowBR();
    order.data_entrega_realizada = v6NowBR();
    if(observacao) order.observacao_logistica = observacao;
    try { if(typeof rememberStatusTransition === 'function') rememberStatusTransition(id, 'Entregue'); } catch(e) {}
    if(typeof orders !== 'undefined' && Array.isArray(orders) && !orders.some(o => String(o.id || o.numero) === String(order.id || order.numero))) orders.push(order);
    if(typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) flexOrders = flexOrders.filter(f => String(f.id || f.numero) !== String(id));
    v6RememberDelivered(order, recebedor, documento, observacao);
    try { if(typeof syncGlobalOrderState === 'function') syncGlobalOrderState(); } catch(e) {}
  }
  function v6MarkPendingLocal(id, observacao){
    const order = v6FindOrder(id);
    if(order) {
      order.status_logistica = 'Pendente';
      order.situacao_nome = 'Pendente';
      order.observacao_logistica = observacao || order.observacao_logistica || order.observacao || '';
    }
    v6RemoveShadow(id);
    try { if(typeof rememberStatusTransition === 'function') rememberStatusTransition(id, 'Pendente'); } catch(e) {}
    try { if(typeof syncGlobalOrderState === 'function') syncGlobalOrderState(); } catch(e) {}
  }

  // Reduz geocodificação em massa fora das abas de mapa logístico.
  try {
    const preservedPlotMapMarkersV6 = typeof plotMapMarkers === 'function' ? plotMapMarkers : null;
    if(preservedPlotMapMarkersV6 && !window.__vescoPlotMapMarkersWrappedV6) {
      window.__vescoPlotMapMarkersWrappedV6 = true;
      plotMapMarkers = function(orderList, flexList){
        const logVisible = !!document.querySelector('#view-logistica:not(.hidden)');
        const flexVisible = !!document.querySelector('#view-envios_flex:not(.hidden)');
        if(!logVisible && !flexVisible) return;
        return preservedPlotMapMarkersV6.apply(this, arguments);
      };
      window.plotMapMarkers = plotMapMarkers;
    }
  } catch(e) { v6Warn('Não foi possível otimizar plotMapMarkers:', e); }

  // Reforça mapa V6 nas ações legadas de rota.
  const prevVerRotaMapaV6Post = window.verRotaMapa;
  window.verRotaMapa = function(rotaId){
    try {
      if(window.vescoRoutesV6 && typeof window.vescoRoutesV6.drawRouteOnMap === 'function') return window.vescoRoutesV6.drawRouteOnMap(rotaId);
    } catch(e) { v6Warn(e); }
    if(typeof prevVerRotaMapaV6Post === 'function') return prevVerRotaMapaV6Post.apply(this, arguments);
  };
  window.vescoOpenRouteInGoogle = function(rotaId){
    try {
      const api = window.vescoRoutesV6;
      const rota = api && api.findRouteById && api.findRouteById(rotaId);
      const url = rota && api.buildGoogleMapsRouteUrl ? api.buildGoogleMapsRouteUrl(rota) : localStorage.getItem('vesco_last_google_route_url_v6');
      if(url) return window.open(url, '_blank');
    } catch(e) { v6Warn(e); }
    v6Toast('Nenhuma rota disponível para abrir.', 'warning', 3000);
  };

  // Motorista: ao confirmar entrega, joga para Entregues imediatamente e mantém opção de pendência.
  const prevEnviarComprovanteV6 = window.enviarComprovante;
  if(typeof prevEnviarComprovanteV6 === 'function') {
    window.enviarComprovante = function(){
      const pedidoId = (document.getElementById('motPedidoInput')?.value || '').trim();
      const recebedor = (document.getElementById('motRecebedor')?.value || '').trim();
      const documento = (document.getElementById('motDocumento')?.value || '').trim();
      const transportador = (document.getElementById('motTransportador')?.value || '').trim();
      const docLimpo = (documento || '').replace(/\D/g, '');
      if(!pedidoId || !recebedor || docLimpo.length < 8 || docLimpo.length > 14) return prevEnviarComprovanteV6.apply(this, arguments);
      const msgAudit = `Entregue via: ${transportador || '—'} | Recebido por: ${recebedor} (Doc: ${documento || 'Não informado'})`;
      const ret = prevEnviarComprovanteV6.apply(this, arguments);
      [250, 1200, 2600].forEach(delay => setTimeout(() => {
        v6MarkDeliveredLocal(pedidoId, recebedor, documento || 'Não informado', msgAudit);
        v6MergeDeliveredShadow();
        try { if(typeof renderMotorista === 'function') renderMotorista(); } catch(e) {}
        try { if(typeof render === 'function') render(); } catch(e) {}
        try { if(typeof switchTab === 'function') switchTab('entregues'); } catch(e) {}
        setTimeout(v6InjectDeliveredPendenciaButtons, 80);
      }, delay));
      return ret;
    };
  }

  const prevConcluirRotaV6 = window.concluirRota;
  if(typeof prevConcluirRotaV6 === 'function') {
    window.concluirRota = function(rotaId){
      const rota = (window.saiuRotas || []).find(r => String(r.id) === String(rotaId));
      const ret = prevConcluirRotaV6.apply(this, arguments);
      setTimeout(() => {
        if(!rota || rota.status !== 'concluida') return;
        (rota.pedidos || []).forEach(p => v6MarkDeliveredLocal(p, '', '', `Rota concluída: ${rota.nome || 'Rota'} Motorista: ${rota.motorista || '—'}`));
        v6MergeDeliveredShadow();
        try { if(typeof render === 'function') render(); } catch(e) {}
        try { if(typeof switchTab === 'function') switchTab('entregues'); } catch(e) {}
        setTimeout(v6InjectDeliveredPendenciaButtons, 100);
      }, 700);
      return ret;
    };
  }

  window.vescoPendenciaEntregaV6 = function(id){
    if(!id) return;
    const modal = document.getElementById('pendenciaModal');
    if(modal && typeof window.moverParaPendenciaPrompt === 'function') {
      try { window.moverParaPendenciaPrompt(id); } catch(e) { v6Warn(e); }
      return;
    }
    const motivo = prompt(`Informe a pendência do pedido #${id}:`);
    if(!motivo) return;
    const obs = `[Pós-entrega] ${motivo}`;
    v6MarkPendingLocal(id, obs);
    try {
      if(typeof updateStatusJsonp === 'function') updateStatusJsonp(id, 'Pendente', obs);
      else if(window.vescoRoutesV6 && typeof window.vescoRoutesV6.silentUpdateStatus === 'function') window.vescoRoutesV6.silentUpdateStatus(id, 'Pendente', obs);
    } catch(e) { v6Warn(e); }
    try { if(typeof render === 'function') render(); } catch(e) {}
    v6Toast('Pendência registrada para o pedido entregue.', 'warning', 3500);
  };

  const prevSalvarPendenciaModalV6 = window.salvarPendenciaModal;
  if(typeof prevSalvarPendenciaModalV6 === 'function') {
    window.salvarPendenciaModal = function(){
      const id = document.getElementById('pendenciaId')?.value || '';
      const motivo = document.getElementById('pendenciaMotivo')?.value || '';
      const detalhes = document.getElementById('pendenciaDetalhes')?.value || '';
      const ret = prevSalvarPendenciaModalV6.apply(this, arguments);
      if(id && String(detalhes).trim()) {
        setTimeout(() => {
          v6MarkPendingLocal(id, `[${motivo}] ${detalhes}`);
          try { if(typeof render === 'function') render(); } catch(e) {}
        }, 120);
      }
      return ret;
    };
  }

  function v6InjectDeliveredPendenciaButtons(){
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(row => {
      if(row.querySelector('.vesco-entregue-pendencia-btn-v6-final')) return;
      if(/nenhum despacho|nenhum registro/i.test(row.innerText || '')) return;
      const txt = row.innerText || '';
      const m = txt.match(/#\s*([0-9A-Za-z._-]+)/) || txt.match(/\b(\d{5,})\b/);
      if(!m) return;
      const numero = m[1];
      const order = v6FindOrder(numero);
      const id = order && (order.id || order.numero) || numero;
      const target = row.querySelector('td:last-child');
      if(!target) return;
      const wrap = document.createElement('div');
      wrap.className = 'mt-2 flex justify-center gap-2';
      wrap.innerHTML = `<button type="button" class="vesco-entregue-pendencia-btn-v6-final bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.vescoPendenciaEntregaV6 && window.vescoPendenciaEntregaV6('${v6Escape(id)}')"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>`;
      target.appendChild(wrap);
    });
  }

  const prevRenderV6Post = typeof render === 'function' ? render : null;
  if(prevRenderV6Post) {
    render = function(){
      v6MergeDeliveredShadow();
      const res = prevRenderV6Post.apply(this, arguments);
      setTimeout(v6InjectDeliveredPendenciaButtons, 0);
      setTimeout(() => { try { if(window.vescoRoutesV6) { window.vescoRoutesV6.ensureLayout(); const m = window.vescoRoutesV6.ensureRouteMap(); if(m) m.invalidateSize(true); } } catch(e) {} }, 160);
      return res;
    };
    window.render = render;
  }

  const prevSwitchTabV6Post = window.switchTab;
  if(typeof prevSwitchTabV6Post === 'function') {
    window.switchTab = function(which){
      const res = prevSwitchTabV6Post.apply(this, arguments);
      if(which === 'saiu' || which === 'rotas') {
        setTimeout(() => { try { if(window.vescoRoutesV6) { window.vescoRoutesV6.ensureLayout(); const m = window.vescoRoutesV6.ensureRouteMap(); if(m) m.invalidateSize(true); } } catch(e) {} }, 180);
      }
      if(which === 'logistica' || which === 'envios_flex') setTimeout(() => { try { if(typeof render === 'function') render(); } catch(e) {} }, 80);
      if(which === 'entregues') setTimeout(v6InjectDeliveredPendenciaButtons, 180);
      return res;
    };
  }

  document.addEventListener('DOMContentLoaded', function(){
    v6MergeDeliveredShadow();
    setTimeout(() => { try { if(window.vescoRoutesV6) { window.vescoRoutesV6.ensureLayout(); window.vescoRoutesV6.ensureRouteMap(); } } catch(e) {} }, 700);
    setTimeout(v6InjectDeliveredPendenciaButtons, 900);
    try {
      const obs = new MutationObserver(() => {
        if(document.getElementById('table-entregues')) v6InjectDeliveredPendenciaButtons();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch(e) {}
  });

  window.vescoDeliveredV6 = {
    mergeShadow: v6MergeDeliveredShadow,
    markDeliveredLocal: v6MarkDeliveredLocal,
    injectPendencia: v6InjectDeliveredPendenciaButtons,
    markPendingLocal: v6MarkPendingLocal
  };
  v6Log('Rotas/Entregues V6 POST ativo — entrega do motorista aparece em Entregues e pendência pós-entrega disponível.');
})();

// =================================================================
// V7 — Correção definitiva da aba Entregues
// Objetivo: puxar entregas reais vindas do backend/planilha mesmo quando
// o Apps Script não devolve campo data_entregue/data_entrega_realizada.
// Preserva todas as camadas anteriores e apenas reforça a leitura/renderização.
// =================================================================
(function installVescoEntreguesBackendV7(){
  if (window.__vescoEntreguesBackendV7) return;
  window.__vescoEntreguesBackendV7 = true;

  const V7_SHADOW_KEYS = ['vesco_delivered_shadow_v6'];

  function v7Log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function v7Warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function v7Escape(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function v7Norm(v){
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(v) : String(v ?? '').replace(/[^0-9A-Za-z._-]/g,'').trim(); }
    catch(e){ return String(v ?? '').replace(/[^0-9A-Za-z._-]/g,'').trim(); }
  }
  function v7TodayISO(){
    try { if(typeof getBrazilTodayISO === 'function') return getBrazilTodayISO(); } catch(e) {}
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function v7TodayBR(){
    const iso = v7TodayISO();
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }
  function v7SelectedISO(){
    try { if(typeof getSelectedOperationalDateISO === 'function') return getSelectedOperationalDateISO(); } catch(e) {}
    return v7TodayISO();
  }
  function v7SameISO(a,b){ return !!a && !!b && String(a).slice(0,10) === String(b).slice(0,10); }
  function v7SelectedIsToday(){ return v7SameISO(v7SelectedISO(), v7TodayISO()); }
  function v7DateToISO(v){
    try { if(typeof dateValueToISO === 'function') return dateValueToISO(v); } catch(e) {}
    if(v === null || v === undefined) return '';
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if(m) {
      let y = m[3]; if(y.length === 2) y = '20' + y;
      return `${y.padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    }
    const d = new Date(s);
    if(!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return '';
  }
  function v7ReadLocalArray(key){
    try {
      const raw = localStorage.getItem(key);
      if(!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch(e) { return []; }
  }
  function v7Pools(){
    const out = [];
    try { if(typeof orders !== 'undefined' && Array.isArray(orders)) out.push(...orders); } catch(e) {}
    try { if(Array.isArray(window.orders)) out.push(...window.orders); } catch(e) {}
    try { if(typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) out.push(...flexOrders); } catch(e) {}
    try { if(Array.isArray(window.flexOrders)) out.push(...window.flexOrders); } catch(e) {}
    V7_SHADOW_KEYS.forEach(k => out.push(...v7ReadLocalArray(k)));
    const map = new Map();
    out.forEach(o => {
      if(!o || typeof o !== 'object') return;
      const key = v7Norm(o.id || o.numero || o.pedido || o.numero_ecommerce || JSON.stringify(o).slice(0,40));
      if(!key) return;
      if(!map.has(key)) map.set(key, Object.assign({}, o));
      else map.set(key, Object.assign({}, map.get(key), o));
    });
    return Array.from(map.values());
  }
  function v7StatusOnly(o){
    return String((o && (o.status_logistica || o.situacao_nome || o.situacao || o.status || o.status_entrega || o.status_rota)) || '').toLowerCase().trim();
  }
  function v7AllText(o){
    if(!o) return '';
    return [
      o.status_logistica, o.situacao_nome, o.situacao, o.status, o.status_entrega, o.status_rota,
      o.observacao_logistica, o.observacao, o.audit, o.historico, o.historico_status
    ].map(x => String(x || '')).join(' ').toLowerCase();
  }
  function v7IsDeliveredRecord(o){
    if(!o) return false;
    const status = v7StatusOnly(o);
    const all = v7AllText(o);

    // Se o status atual voltou para pendência ou separação, não deve aparecer como entregue,
    // mesmo que exista uma observação antiga de entrega.
    if(/\bpendente\b|a separar|em separa[cç][aã]o|pronto p\/? entrega|separado pendente/.test(status) && !/\bentregue\b|finaliz|conclu/.test(status)) {
      return false;
    }

    return /\bentregue\b|entregue via|recebido por|finalizad|conclu[ií]d/.test(all);
  }
  function v7DeliveryISO(o){
    try { if(typeof getOrderDeliveryISO === 'function') { const iso = getOrderDeliveryISO(o); if(iso) return iso; } } catch(e) {}
    const fields = ['data_entrega_realizada','entregue_em','entregueEm','data_entregue','dataEntregue','dataEntrega','delivered_at','deliveredAt','concluidaEm','concluido_em','finalizado_em'];
    for(const k of fields){
      const iso = v7DateToISO(o && o[k]);
      if(iso) return iso;
    }
    const txt = String((o && (o.observacao_logistica || o.observacao || o.audit || o.historico)) || '');
    try {
      if(typeof extractFirstDateLikeString === 'function') {
        const found = extractFirstDateLikeString(txt);
        const iso = v7DateToISO(found);
        if(iso) return iso;
      }
    } catch(e) {}
    return '';
  }
  function v7ShouldShowDeliveredForSelectedDate(o){
    if(!v7IsDeliveredRecord(o)) return false;
    const iso = v7DeliveryISO(o);
    if(iso) return v7SameISO(iso, v7SelectedISO());

    // Correção principal: o backend/planilha já informa status Entregue, mas não fornece data_entregue.
    // Nesse caso, exibe no dia atual e registra no histórico local para próximas renderizações.
    if(v7SelectedIsToday()) return true;

    // Também permite visualizar se o registro local já foi salvo na sombra sem data explícita.
    return false;
  }
  function v7ForceHistoryForBackendDelivered(){
    const all = v7Pools();
    all.forEach(o => {
      if(!v7IsDeliveredRecord(o)) return;
      try {
        if(!v7DeliveryISO(o) && v7SelectedIsToday() && typeof rememberStatusTransition === 'function') {
          rememberStatusTransition(o.id || o.numero || o.pedido || o.numero_ecommerce, 'Entregue');
        }
      } catch(e) {}
      try {
        if(!o.status_logistica || !/entregue/i.test(String(o.status_logistica))) o.status_logistica = 'Entregue';
        if(!o.situacao_nome || !/entregue/i.test(String(o.situacao_nome))) o.situacao_nome = 'Entregue';
        if(!v7DeliveryISO(o) && v7SelectedIsToday()) {
          o.entregue_em = new Date().toISOString();
          o.data_entregue = v7TodayBR();
          o.data_entrega_realizada = v7TodayBR();
        }
      } catch(e) {}
    });
  }
  function v7ReceiverInfo(o){
    let recNome = o && (o.nome_recebedor || o.recebedor || o.recebido_por || '');
    let recDoc = o && (o.doc_recebedor || o.documento_recebedor || o.doc || '');
    const txt = String((o && (o.observacao_logistica || o.observacao || '')) || '');
    if(!recNome) {
      const m = txt.match(/Recebido por:\s*(.*?)\s*\(\s*Doc:\s*(.*?)\s*\)/i);
      if(m) { recNome = m[1].trim(); recDoc = (m[2] || '').trim(); }
    }
    return { nome: recNome || '—', doc: recDoc || '—' };
  }
  function v7GetSearch(){
    const el = document.getElementById('search') || document.querySelector('input[placeholder*="Filtrar" i]');
    return String((el && el.value) || '').toLowerCase().trim();
  }
  function v7IdFor(o){ return o && (o.id || o.numero || o.pedido || o.numero_ecommerce || ''); }
  function v7MatchesSearch(o, q){
    if(!q) return true;
    return [o.numero, o.id, o.pedido, o.numero_ecommerce, o.cliente_nome, o.cliente, o.destinatario, o.nome, o.endereco_completo, o.endereco]
      .some(v => String(v || '').toLowerCase().includes(q));
  }
  function v7RenderDeliveredTable(){
    // V11: quando a camada V10/V11 estiver ativa, a V7 não reescreve mais a tabela.
    // Isso preserva a função antiga, mas evita disputa de renderização e loop visual.
    if(window.__vescoEntreguesV10SafeDate) return;
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;

    v7ForceHistoryForBackendDelivered();

    const q = v7GetSearch();
    const delivered = v7Pools()
      .filter(o => v7ShouldShowDeliveredForSelectedDate(o))
      .filter(o => v7MatchesSearch(o, q));

    const unique = [];
    const seen = new Set();
    delivered.forEach(o => {
      const key = v7Norm(o.id || o.numero || o.pedido || o.numero_ecommerce);
      if(!key || seen.has(key)) return;
      seen.add(key);
      unique.push(o);
    });

    if(unique.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">Nenhum despacho realizado.</td></tr>`;
      return;
    }

    tbody.innerHTML = unique.map((o, idx) => {
      const id = v7IdFor(o);
      const numero = o.numero || o.id || o.pedido || 'S/N';
      const cliente = o.cliente_nome || o.cliente || o.destinatario || o.nome || '—';
      const rec = v7ReceiverInfo(o);
      const tempo = o.tempo_separacao || o.tempo_entrega || o.tempo || '—';
      return `
        <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm">
          <td class="p-3 pl-4 font-black text-slate-900">#${v7Escape(numero)}</td>
          <td class="p-3 font-semibold text-slate-800">${v7Escape(cliente)}</td>
          <td class="p-3 hidden md:table-cell">
            <div class="font-bold text-slate-800 flex items-center gap-1.5"><i class="fas fa-user-check text-blue-500"></i>${v7Escape(rec.nome)}</div>
            <div class="text-[11px] text-slate-500 mt-0.5 font-mono"><i class="fas fa-id-card text-slate-400 mr-1"></i>Doc: ${v7Escape(rec.doc)}</div>
          </td>
          <td class="p-3 text-center text-emerald-700 font-mono font-bold">${v7Escape(tempo)}</td>
          <td class="p-3 pr-4 text-center">
            <div class="flex flex-col items-center gap-2">
              <span class="bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 px-3 py-1 rounded-xl text-[10px] uppercase tracking-wider inline-flex items-center gap-1"><i class="fas fa-check-circle text-emerald-500"></i> Entregue</span>
              <button type="button" class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.vescoPendenciaEntregaV7 ? window.vescoPendenciaEntregaV7('${v7Escape(id)}') : (window.vescoPendenciaEntregaV6 && window.vescoPendenciaEntregaV6('${v7Escape(id)}'))"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  // Torna o filtro global mais tolerante para o render legado.
  try {
    window.shouldShowDeliveredForOperationalDate = shouldShowDeliveredForOperationalDate = function(o){
      return v7ShouldShowDeliveredForSelectedDate(o);
    };
  } catch(e) {}

  window.vescoPendenciaEntregaV7 = function(id){
    if(!id) return;
    try {
      if(typeof window.vescoPendenciaEntregaV6 === 'function') return window.vescoPendenciaEntregaV6(id);
      if(typeof window.moverParaPendenciaPrompt === 'function') return window.moverParaPendenciaPrompt(id);
    } catch(e) { v7Warn(e); }
    const motivo = prompt(`Informe a pendência do pedido #${id}:`);
    if(!motivo) return;
    try { if(typeof updateStatusJsonp === 'function') updateStatusJsonp(id, 'Pendente', `[Pós-entrega] ${motivo}`); } catch(e) {}
    try { setTimeout(() => { if(typeof render === 'function') render(); }, 250); } catch(e) {}
  };

  const prevEnviarComprovanteV7 = window.enviarComprovante;
  if(typeof prevEnviarComprovanteV7 === 'function') {
    window.enviarComprovante = function(){
      const pedidoId = (document.getElementById('motPedidoInput')?.value || '').trim();
      const recebedor = (document.getElementById('motRecebedor')?.value || '').trim();
      const documento = (document.getElementById('motDocumento')?.value || '').trim();
      const transportador = (document.getElementById('motTransportador')?.value || '').trim();
      const ret = prevEnviarComprovanteV7.apply(this, arguments);
      if(pedidoId && recebedor) {
        const msgAudit = `Entregue via: ${transportador || '—'} | Recebido por: ${recebedor} (Doc: ${documento || 'Não informado'})`;
        [80, 450, 1400, 3200].forEach(delay => setTimeout(() => {
          try { if(window.vescoDeliveredV6 && typeof window.vescoDeliveredV6.markDeliveredLocal === 'function') window.vescoDeliveredV6.markDeliveredLocal(pedidoId, recebedor, documento || 'Não informado', msgAudit); } catch(e) {}
          try { if(typeof rememberStatusTransition === 'function') rememberStatusTransition(pedidoId, 'Entregue'); } catch(e) {}
          try { v7RenderDeliveredTable(); } catch(e) {}
          try { if(typeof switchTab === 'function') switchTab('entregues'); } catch(e) {}
        }, delay));
      }
      return ret;
    };
  }

  const prevScheduleRenderV7 = typeof scheduleRender === 'function' ? scheduleRender : null;
  if(prevScheduleRenderV7 && !window.__vescoScheduleRenderV7Wrapped) {
    window.__vescoScheduleRenderV7Wrapped = true;
    scheduleRender = function(){
      try { v7ForceHistoryForBackendDelivered(); } catch(e) {}
      const ret = prevScheduleRenderV7.apply(this, arguments);
      setTimeout(v7RenderDeliveredTable, 90);
      return ret;
    };
    window.scheduleRender = scheduleRender;
  }

  const prevRenderV7 = typeof render === 'function' ? render : null;
  if(prevRenderV7 && !window.__vescoRenderEntreguesV7Wrapped) {
    window.__vescoRenderEntreguesV7Wrapped = true;
    render = function(){
      try { v7ForceHistoryForBackendDelivered(); } catch(e) {}
      const ret = prevRenderV7.apply(this, arguments);
      setTimeout(v7RenderDeliveredTable, 0);
      return ret;
    };
    window.render = render;
  }

  const prevSwitchTabV7 = window.switchTab;
  if(typeof prevSwitchTabV7 === 'function' && !window.__vescoSwitchTabEntreguesV7Wrapped) {
    window.__vescoSwitchTabEntreguesV7Wrapped = true;
    window.switchTab = function(which){
      const ret = prevSwitchTabV7.apply(this, arguments);
      if(which === 'entregues' && !window.__vescoEntreguesV10SafeDate) setTimeout(v7RenderDeliveredTable, 80);
      return ret;
    };
  }

  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(v7RenderDeliveredTable, 900);
    try {
      const obs = new MutationObserver(() => {
        if(document.getElementById('table-entregues')) setTimeout(v7RenderDeliveredTable, 30);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch(e) {}
  });

  window.vescoEntreguesV7 = {
    render: v7RenderDeliveredTable,
    isDelivered: v7IsDeliveredRecord,
    forceHistory: v7ForceHistoryForBackendDelivered,
    collect: function(){ return v7Pools().filter(v7ShouldShowDeliveredForSelectedDate); }
  };

  v7Log('Entregues V7 ativo — status Entregue do backend/planilha agora aparece mesmo sem data_entregue, com Pendência pós-entrega.');
})();

// =================================================================
// CAMADA V8 — COMPATIBILIDADE DEFINITIVA: "SAIU PARA ENTREGA" => "PRONTO PARA ENVIO"
// Regra de Preservação: não remove legado; cria aliases e normalizações.
// =================================================================
(function installProntoParaEnvioCompatibilityV8(){
  if (window.__vescoProntoParaEnvioCompatibilityV8) return;
  window.__vescoProntoParaEnvioCompatibilityV8 = true;

  function v8NormTxt(v){
    return String(v || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function v8Escape(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }

  function v8StatusText(o){
    return v8NormTxt(o && (
      o.status_logistica ||
      o.situacao_nome ||
      o.situacao ||
      o.status ||
      o.status_entrega ||
      o.status_rota ||
      ''
    ));
  }

  function v8IsProntoParaEnvioStatus(o){
    const st = v8StatusText(o);
    const obs = v8NormTxt(o && (o.observacao_logistica || o.observacao || o.audit || o.historico || ''));
    return (
      st.includes('pronto para envio') ||
      st.includes('saiu para entrega') ||
      st.includes('despachado') ||
      st.includes('em rota') ||
      st === 'rota' ||
      obs.includes('pronto para envio') ||
      obs.includes('saiu para entrega')
    );
  }

  function v8AllOrders(){
    const out = [];
    try { if (typeof orders !== 'undefined' && Array.isArray(orders)) out.push(...orders); } catch(e) {}
    try { if (typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) out.push(...flexOrders); } catch(e) {}
    try { if (Array.isArray(window.orders)) out.push(...window.orders); } catch(e) {}
    try { if (Array.isArray(window.flexOrders)) out.push(...window.flexOrders); } catch(e) {}
    const seen = new Set();
    return out.filter(o => {
      if (!o) return false;
      const k = String(o.id || o.numero || o.pedido || o.numero_ecommerce || Math.random());
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function v8FindOrder(id){
    const raw = String(id || '').trim();
    const norm = raw.replace(/[^0-9A-Za-z._-]/g, '');
    return v8AllOrders().find(o => {
      const vals = [o.id, o.numero, o.pedido, o.order_id, o.orderNumber, o.numero_ecommerce, o.referencia, o.reference];
      return vals.some(v => {
        const s = String(v || '').trim();
        return s === raw || s.replace(/[^0-9A-Za-z._-]/g, '') === norm;
      });
    }) || null;
  }

  // Corrige compatibilidade da função antiga isDispatchedStatus.
  const oldIsDispatchedStatusV8 = window.isDispatchedStatus || (typeof isDispatchedStatus === 'function' ? isDispatchedStatus : null);
  window.isDispatchedStatus = isDispatchedStatus = function(o){
    if (v8IsProntoParaEnvioStatus(o)) return true;
    if (typeof oldIsDispatchedStatusV8 === 'function') {
      try { return oldIsDispatchedStatusV8(o); } catch(e) {}
    }
    return false;
  };

  // O motorista precisa enxergar pedidos "Pronto para Envio" também.
  const oldRenderMotoristaV8 = window.renderMotorista;
  window.renderMotorista = function(){
    const tbodyMot = document.getElementById('table-motorista');
    if (!tbodyMot) {
      if (typeof oldRenderMotoristaV8 === 'function') return oldRenderMotoristaV8.apply(this, arguments);
      return;
    }

    const emRota = v8AllOrders().filter(o => v8IsProntoParaEnvioStatus(o));

    if (emRota.length === 0) {
      tbodyMot.innerHTML = `
        <tr>
          <td colspan="3" class="p-8 text-center text-slate-400 font-bold">
            <i class="fas fa-box-open text-3xl mb-2 block"></i>
            Nenhum pedido pronto para envio no momento.
          </td>
        </tr>`;
      return;
    }

    tbodyMot.innerHTML = emRota.map(o => `
      <tr class="hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0">
        <td class="p-3 font-black text-slate-800 text-sm">#${v8Escape(o.numero || o.id)}</td>
        <td class="p-3 leading-tight">
          <span class="font-bold text-slate-700 text-sm">
            ${v8Escape(o.cliente_nome || o.destinatario || o.cliente || o.nome || '')}
          </span><br>
          <span class="text-[11px] text-slate-400 font-normal">
            <i class="fas fa-location-dot text-slate-300 mr-1"></i>
            ${v8Escape(o.endereco_completo || o.endereco || '')}
          </span>
        </td>
        <td class="p-3 text-right">
          <button onclick="abrirAssinaturaMotorista('${v8Escape(o.numero || o.id)}')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold text-[11px] shadow-sm transition-all uppercase whitespace-nowrap">
            <i class="fas fa-signature mr-1"></i> Entregar
          </button>
        </td>
      </tr>
    `).join('');
  };

  // Compatibilidade de abas: o HTML pode chamar pronto_envio, pronto_para_envio,
  // prontoParaEnvio ou envio; internamente o legado continua usando "saiu".
  function v8ResolveSaiuAlias(which){
    if (
      which === 'pronto_envio' ||
      which === 'pronto_para_envio' ||
      which === 'prontoParaEnvio' ||
      which === 'pronto-envio' ||
      which === 'pronto-para-envio' ||
      which === 'envio'
    ) return 'saiu';
    return which;
  }

  function v8ProntoView(){
    return document.getElementById('view-pronto-envio') ||
           document.getElementById('view-pronto_envio') ||
           document.getElementById('view-pronto_para_envio') ||
           document.getElementById('view-prontoParaEnvio');
  }

  function v8RouteViewHasContent(el){
    return !!(el && el.querySelector && el.querySelector('#saiu-pedidos-list, #saiu-rotas-list, #btnCriarRota, #btn-criar-rota, #rotaMotorista, #rotaNome'));
  }

  const oldSwitchTabV8 = window.switchTab;
  window.switchTab = function(which){
    const alvo = v8ResolveSaiuAlias(which);

    const result = typeof oldSwitchTabV8 === 'function'
      ? oldSwitchTabV8.call(this, alvo)
      : undefined;

    const viewSaiu = document.getElementById('view-saiu');
    const viewPronto = v8ProntoView();

    if (alvo === 'saiu') {
      if (viewPronto && !viewSaiu) {
        viewPronto.classList.remove('hidden');
      } else if (viewPronto && viewSaiu) {
        const prontoHas = v8RouteViewHasContent(viewPronto);
        const saiuHas = v8RouteViewHasContent(viewSaiu);
        if (prontoHas && !saiuHas) {
          viewPronto.classList.remove('hidden');
          viewSaiu.classList.add('hidden');
        } else {
          viewSaiu.classList.remove('hidden');
          if (viewPronto !== viewSaiu) viewPronto.classList.add('hidden');
        }
      }
    } else {
      if (viewPronto) viewPronto.classList.add('hidden');
    }

    const btnPronto = document.getElementById('main-pronto-envio') ||
                      document.getElementById('main-pronto_envio') ||
                      document.getElementById('main-pronto_para_envio') ||
                      document.getElementById('main-prontoParaEnvio');

    if (btnPronto) btnPronto.className = alvo === 'saiu' ? 'tab-btn active' : 'tab-btn';

    if (alvo === 'saiu') {
      setTimeout(() => {
        try { if (typeof window.renderPedidosDisponiveisSaiu === 'function') window.renderPedidosDisponiveisSaiu(); } catch(e) {}
        try { if (typeof window.renderRotas === 'function') window.renderRotas(); } catch(e) {}
        try {
          if (window.vescoRoutesV6) {
            window.vescoRoutesV6.ensureLayout();
            const m = window.vescoRoutesV6.ensureRouteMap();
            if (m) m.invalidateSize(true);
          }
        } catch(e) {}
      }, 250);
    }

    return result;
  };

  // Ao mandar pedido para envio, mantém backend como "Despachado"
  // e exibe o processo como "Pronto para Envio".
  const oldPrepararDespachoMotoristaV8 = window.prepararDespachoMotorista;
  window.prepararDespachoMotorista = function(numeroPedido){
    const info = typeof getOrderAndApi === 'function'
      ? getOrderAndApi(numeroPedido)
      : { order: v8FindOrder(numeroPedido), api: (typeof API !== 'undefined' ? API : '') };

    const realId = info.order ? (info.order.id || info.order.numero) : numeroPedido;

    if (info.order) {
      info.order.status_logistica = 'Despachado';
      info.order.situacao_nome = 'Pronto para Envio';
      info.order.data_despacho = new Date().toISOString();
      info.order.saiuParaEntregaEm = new Date().toISOString();
    }

    try { if (typeof rememberStatusTransition === 'function') rememberStatusTransition(numeroPedido, 'Pronto para Envio'); } catch(e) {}
    try { if (typeof syncGlobalOrderState === 'function') syncGlobalOrderState(); } catch(e) {}

    if (typeof showToast === 'function') showToast(`Pedido #${numeroPedido} pronto para envio!`, 'success', 4000);

    if (typeof switchTab === 'function') switchTab('motorista');
    if (typeof renderMotorista === 'function') renderMotorista();
    if (typeof render === 'function') render();

    if (!info.api || typeof jsonpFetch !== 'function') {
      if (typeof oldPrepararDespachoMotoristaV8 === 'function') return oldPrepararDespachoMotoristaV8.apply(this, arguments);
      return;
    }

    const url = `${info.api}?action=updateStatus&id=${encodeURIComponent(realId)}&status=${encodeURIComponent('Despachado')}&operador=${encodeURIComponent(currentOperator || '')}&observacao=${encodeURIComponent('Pronto para Envio')}`;
    jsonpFetch(url, function() {
      console.log('Pronto para Envio gravado. ID Real: ' + realId);
    });
  };

  // Reforça labels visuais antigos na tela sem alterar estrutura.
  function v8ReplaceOldLabels(){
    const root = document.body;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      const txt = node.nodeValue || '';
      let novo = txt;
      novo = novo.replaceAll('Saiu para entrega', 'Pronto para Envio');
      novo = novo.replaceAll('Saiu p/ entrega', 'Pronto p/ Envio');
      novo = novo.replaceAll('saiu para entrega', 'pronto para envio');
      if (novo !== txt) node.nodeValue = novo;
    });
  }

  const oldRenderV8 = window.render || (typeof render === 'function' ? render : null);
  if (oldRenderV8 && !window.__vescoRenderV8Wrapped) {
    window.__vescoRenderV8Wrapped = true;
    window.render = render = function(){
      const res = oldRenderV8.apply(this, arguments);
      setTimeout(v8ReplaceOldLabels, 50);
      setTimeout(() => { try { if (typeof renderMotorista === 'function') renderMotorista(); } catch(e) {} }, 80);
      return res;
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(v8ReplaceOldLabels, 500);
    setTimeout(() => { try { if (typeof renderMotorista === 'function') renderMotorista(); } catch(e) {} }, 700);
  });

  window.vescoProntoParaEnvioV8 = {
    isProntoParaEnvioStatus: v8IsProntoParaEnvioStatus,
    findOrder: v8FindOrder,
    replaceLabels: v8ReplaceOldLabels
  };

  console.log('Compatibilidade V8 ativa — "Pronto para Envio" integrado ao legado "Saiu para entrega/Despachado".');
})();


// =================================================================
// CAMADA V9 — ENTREGUES À PROVA DE BACKEND/FILTRO + CAPTURA RAW DA API
// Regra de Preservação: camada aditiva; não remove V3/V4/V5/V6/V7/V8.
// Objetivo: se a planilha/backend devolver status Entregue em qualquer campo
// ou observação com "Entregue via / Recebido por", a aba Entregues renderiza.
// =================================================================
(function installVescoEntreguesBackendRawV9(){
  if (window.__vescoEntreguesBackendRawV9) return;
  window.__vescoEntreguesBackendRawV9 = true;

  const V9_CACHE_KEY = 'vesco_delivered_backend_v9';
  const V9_MAX_CACHE = 500;

  function v9Log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function v9Warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function v9Escape(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function v9Norm(v){
    const raw = String(v ?? '').trim();
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(raw) : raw.replace(/^#/, '').replace(/\s+/g, '').replace(/[^0-9A-Za-z._-]/g,''); }
    catch(e){ return raw.replace(/^#/, '').replace(/\s+/g, '').replace(/[^0-9A-Za-z._-]/g,''); }
  }
  function v9NormText(v){
    return String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  }
  function v9TodayISO(){
    try { if(typeof getBrazilTodayISO === 'function') return getBrazilTodayISO(); } catch(e) {}
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function v9TodayBR(){
    const iso = v9TodayISO();
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }
  function v9SelectedISO(){
    try { if(typeof getSelectedOperationalDateISO === 'function') return getSelectedOperationalDateISO(); } catch(e) {}
    return v9TodayISO();
  }
  function v9SameISO(a,b){ return !!a && !!b && String(a).slice(0,10) === String(b).slice(0,10); }
  function v9SelectedIsToday(){ return v9SameISO(v9SelectedISO(), v9TodayISO()); }
  function v9DateToISO(v){
    try { if(typeof dateValueToISO === 'function') { const iso = dateValueToISO(v); if(iso) return iso; } } catch(e) {}
    if(v === null || v === undefined) return '';
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if(m){ let y = m[3]; if(y.length === 2) y = '20' + y; return `${y.padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
    const d = new Date(s);
    if(!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return '';
  }
  function v9ReadArray(key){
    try { const parsed = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(parsed) ? parsed : []; } catch(e) { return []; }
  }
  function v9WriteArray(key, arr){
    try { localStorage.setItem(key, JSON.stringify((arr || []).slice(-V9_MAX_CACHE))); } catch(e) {}
  }
  function v9FindArrayInPayload(payload){
    if(!payload) return [];
    if(Array.isArray(payload)) return payload;
    if(typeof payload !== 'object') return [];
    const preferred = ['data','dados','items','pedidos','orders','rows','result','resultados'];
    for(const k of preferred){ if(Array.isArray(payload[k])) return payload[k]; }
    try {
      const queue = [payload];
      const seen = new Set();
      while(queue.length){
        const node = queue.shift();
        if(!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        for(const k in node){
          if(!Object.prototype.hasOwnProperty.call(node,k)) continue;
          const v = node[k];
          if(Array.isArray(v)) return v;
          if(v && typeof v === 'object') queue.push(v);
        }
      }
    } catch(e) {}
    return [];
  }
  function v9NormalizeHeader(k){
    return String(k || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  }
  function v9RowsToObjects(rows){
    if(!Array.isArray(rows)) return [];
    if(rows.length && Array.isArray(rows[0])){
      const headers = rows[0].map(h => String(h || '').trim());
      return rows.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h || `col${i}`] = row[i]; });
        return obj;
      });
    }
    return rows.filter(x => x && typeof x === 'object');
  }
  function v9Pick(o, aliases){
    if(!o) return '';
    const desired = aliases.map(v9NormalizeHeader);
    for(const k in o){
      if(!Object.prototype.hasOwnProperty.call(o,k)) continue;
      const nk = v9NormalizeHeader(k);
      if(desired.includes(nk) && o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== '') return o[k];
    }
    return '';
  }
  function v9NormalizeRecord(raw){
    if(!raw || typeof raw !== 'object') return null;
    let o = Object.assign({}, raw);
    try { if(typeof normalizeOrderObject === 'function') o = Object.assign({}, o, normalizeOrderObject(raw)); } catch(e) {}

    const numero = o.numero || v9Pick(raw, ['numero','pedido','pedido #','pedido#','id','order_id','orderNumber','numero_pedido','n_pedido']);
    const statusLog = o.status_logistica || v9Pick(raw, ['status_logistica','status logistica','status logística','situacao_logistica','situação logística','situacao','situação','status','status_entrega']);
    const obsLog = o.observacao_logistica || v9Pick(raw, ['observacao_logistica','observação logística','observacao logistica','observação logistica','observacao','observação','historico','histórico']);
    const cliente = o.cliente_nome || v9Pick(raw, ['cliente_nome','cliente','destinatario','destinatário','nome','cliente / destinatario','cliente destinatario','razao_social','razão social']);
    const endereco = o.endereco_completo || v9Pick(raw, ['endereco_completo','endereço completo','endereco','endereço','logradouro','address']);
    const formaPag = o.forma_pagamento || v9Pick(raw, ['forma_pagamento','forma pagamento','instrucao_entrega','instrução entrega']);
    const tempo = o.tempo_separacao || v9Pick(raw, ['tempo_separacao','tempo separacao','tempo separação','tempo_entrega','tempo']);

    o.numero = String(numero || o.id || '').trim();
    o.id = o.id || o.numero || v9Pick(raw, ['id']);
    o.status_logistica = String(statusLog || o.status_logistica || '').trim();
    o.situacao_nome = o.situacao_nome || o.status_logistica;
    o.observacao_logistica = String(obsLog || o.observacao_logistica || '').trim();
    o.cliente_nome = String(cliente || o.cliente_nome || '').trim();
    o.endereco_completo = String(endereco || o.endereco_completo || '').trim();
    o.forma_pagamento = String(formaPag || o.forma_pagamento || '').trim();
    o.tempo_separacao = String(tempo || o.tempo_separacao || '').trim();
    return o;
  }
  function v9AllText(o){
    return v9NormText([
      o && o.status_logistica, o && o.situacao_nome, o && o.situacao, o && o.status, o && o.status_entrega, o && o.status_rota,
      o && o.observacao_logistica, o && o.observacao, o && o.audit, o && o.historico, o && o.historico_status
    ].map(x => String(x || '')).join(' '));
  }
  function v9StatusOnly(o){ return v9NormText(o && (o.status_logistica || o.situacao_nome || o.situacao || o.status || o.status_entrega || o.status_rota)); }
  function v9IsDelivered(o){
    if(!o) return false;
    const status = v9StatusOnly(o);
    const all = v9AllText(o);
    const hasDelivered = /\bentregue\b|entregue via|recebido por|finalizad|concluid/.test(all);
    const currentIsPending = /\bpendente\b|a separar|em separa|pronto p\/? entrega|separado pendente/.test(status);
    if(currentIsPending && !/\bentregue\b|finaliz|conclu/.test(status)) return false;
    return hasDelivered;
  }
  function v9DeliveryISO(o){
    try { if(typeof getOrderDeliveryISO === 'function') { const iso = getOrderDeliveryISO(o); if(iso) return iso; } } catch(e) {}
    const fields = [
      'data_entrega_realizada','entregue_em','entregueEm','data_entregue','dataEntregue','dataEntrega','delivered_at','deliveredAt','concluidaEm','concluido_em','finalizado_em',
      'data_despacho','despachado_em','data_rota','saiu_em','saiuParaEntregaEm'
    ];
    for(const k of fields){ const iso = v9DateToISO(o && o[k]); if(iso) return iso; }
    const text = String((o && (o.observacao_logistica || o.observacao || o.audit || o.historico)) || '');
    try { if(typeof extractFirstDateLikeString === 'function') { const found = extractFirstDateLikeString(text); const iso = v9DateToISO(found); if(iso) return iso; } } catch(e) {}
    return '';
  }
  function v9CanShowByDate(o){
    const iso = v9DeliveryISO(o);
    if(iso) return v9SameISO(iso, v9SelectedISO());
    // Quando a planilha só traz status/observação de entregue, sem data de entrega,
    // mostra no dia atual. Para histórico perfeito, o Apps Script precisa enviar data_entregue.
    return v9SelectedIsToday();
  }
  function v9Receiver(o){
    let nome = o && (o.nome_recebedor || o.recebedor || o.recebido_por || '');
    let doc = o && (o.doc_recebedor || o.documento_recebedor || o.doc || '');
    const txt = String((o && (o.observacao_logistica || o.observacao || '')) || '');
    if(!nome){
      const m = txt.match(/Recebido por:\s*(.*?)\s*\(\s*Doc:\s*(.*?)\s*\)/i);
      if(m){ nome = (m[1] || '').trim(); doc = (m[2] || '').trim(); }
    }
    return { nome: nome || '—', doc: doc || '—' };
  }
  function v9Search(){
    const el = document.getElementById('search') || document.querySelector('input[placeholder*="Filtrar" i]');
    return String((el && el.value) || '').toLowerCase().trim();
  }
  function v9Matches(o, q){
    if(!q) return true;
    return [o.numero, o.id, o.pedido, o.numero_ecommerce, o.cliente_nome, o.cliente, o.destinatario, o.nome, o.endereco_completo, o.endereco, o.observacao_logistica]
      .some(v => String(v || '').toLowerCase().includes(q));
  }
  function v9MergeByKey(list){
    const map = new Map();
    list.forEach(raw => {
      const o = v9NormalizeRecord(raw);
      if(!o) return;
      const key = v9Norm(o.id || o.numero || o.pedido || o.numero_ecommerce || JSON.stringify(o).slice(0,60));
      if(!key) return;
      if(!map.has(key)) map.set(key, o);
      else {
        const old = map.get(key);
        // Entregue sempre vence sobre registros antigos do mesmo pedido.
        if(v9IsDelivered(o) || !v9IsDelivered(old)) map.set(key, Object.assign({}, old, o));
      }
    });
    return Array.from(map.values());
  }
  function v9CurrentPools(){
    const out = [];
    try { if(typeof orders !== 'undefined' && Array.isArray(orders)) out.push(...orders); } catch(e) {}
    try { if(Array.isArray(window.orders)) out.push(...window.orders); } catch(e) {}
    try { if(typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) out.push(...flexOrders); } catch(e) {}
    try { if(Array.isArray(window.flexOrders)) out.push(...window.flexOrders); } catch(e) {}
    try { if(Array.isArray(window.__vescoRawErpRowsV9)) out.push(...window.__vescoRawErpRowsV9); } catch(e) {}
    out.push(...v9ReadArray(V9_CACHE_KEY));
    out.push(...v9ReadArray('vesco_delivered_shadow_v6'));
    return v9MergeByKey(out);
  }
  function v9StoreDeliveredFromPayload(payload, sourceUrl){
    try {
      const rows = v9RowsToObjects(v9FindArrayInPayload(payload));
      if(!rows.length) return;
      window.__vescoRawErpRowsV9 = v9MergeByKey([...(window.__vescoRawErpRowsV9 || []), ...rows]);
      const delivered = v9MergeByKey(rows).filter(v9IsDelivered);
      if(delivered.length){
        const cache = v9MergeByKey([...v9ReadArray(V9_CACHE_KEY), ...delivered.map(o => {
          if(!v9DeliveryISO(o) && v9SelectedIsToday()) {
            o.data_entregue = o.data_entregue || v9TodayBR();
            o.data_entrega_realizada = o.data_entrega_realizada || v9TodayBR();
            o.entregue_em = o.entregue_em || new Date().toISOString();
          }
          return o;
        })]);
        v9WriteArray(V9_CACHE_KEY, cache);
      }
    } catch(e) { v9Warn('V9 falhou ao capturar entregues do payload:', e); }
  }

  // Captura a resposta bruta do Apps Script antes de qualquer filtro/render legado.
  try {
    const oldJsonpFetch = window.jsonpFetch || (typeof jsonpFetch === 'function' ? jsonpFetch : null);
    if(oldJsonpFetch && !window.__vescoJsonpFetchCapturedV9){
      window.__vescoJsonpFetchCapturedV9 = true;
      window.jsonpFetch = jsonpFetch = function(url, cb){
        return oldJsonpFetch.call(this, url, function(err, resp){
          try {
            const apiMain = typeof API !== 'undefined' ? String(API) : '';
            const urlStr = String(url || '');
            if(resp && (!apiMain || urlStr.includes(apiMain) || urlStr.includes('script.google.com/macros'))) {
              v9StoreDeliveredFromPayload(resp, urlStr);
            }
          } catch(e) {}
          if(typeof cb === 'function') return cb(err, resp);
        });
      };
    }
  } catch(e) { v9Warn('V9 não conseguiu envolver jsonpFetch:', e); }

  // Opcional: tenta consultar endpoints comuns de entregues. Se o Apps Script ignorar, não quebra.
  function v9TryFetchDeliveredAliases(){
    try {
      if(typeof jsonpFetch !== 'function' || typeof API === 'undefined') return;
      if(window.__vescoDeliveredAliasFetchV9Running) return;
      window.__vescoDeliveredAliasFetchV9Running = true;
      const urls = [
        `${API}?action=entregues`,
        `${API}?action=listEntregues`,
        `${API}?action=getEntregues`,
        `${API}?status=Entregue`
      ];
      let i = 0;
      const next = () => {
        if(i >= urls.length){ window.__vescoDeliveredAliasFetchV9Running = false; return; }
        const u = urls[i++];
        jsonpFetch(u, function(err, resp){
          try { if(resp) v9StoreDeliveredFromPayload(resp, u); } catch(e) {}
          setTimeout(next, 250);
        });
      };
      next();
    } catch(e) { window.__vescoDeliveredAliasFetchV9Running = false; }
  }

  function v9RenderDeliveredTable(){
    // V11: V9 continua coletando/cacheando dados, mas não disputa a renderização com V10/V11.
    if(window.__vescoEntreguesV10SafeDate) return;
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;

    const q = v9Search();
    const delivered = v9CurrentPools()
      .filter(v9IsDelivered)
      .filter(v9CanShowByDate)
      .filter(o => v9Matches(o, q));

    if(!delivered.length){
      tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">Nenhum despacho realizado.</td></tr>`;
      return;
    }

    tbody.innerHTML = delivered.map((o, idx) => {
      const id = o.id || o.numero || o.pedido || o.numero_ecommerce || '';
      const numero = o.numero || o.id || o.pedido || 'S/N';
      const cliente = o.cliente_nome || o.cliente || o.destinatario || o.nome || '—';
      const rec = v9Receiver(o);
      const tempo = o.tempo_separacao || o.tempo_entrega || o.tempo || '—';
      return `
        <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm">
          <td class="p-3 pl-4 font-black text-slate-900">#${v9Escape(numero)}</td>
          <td class="p-3 font-semibold text-slate-800">${v9Escape(cliente)}</td>
          <td class="p-3 hidden md:table-cell">
            <div class="font-bold text-slate-800 flex items-center gap-1.5"><i class="fas fa-user-check text-blue-500"></i>${v9Escape(rec.nome)}</div>
            <div class="text-[11px] text-slate-500 mt-0.5 font-mono"><i class="fas fa-id-card text-slate-400 mr-1"></i>Doc: ${v9Escape(rec.doc)}</div>
          </td>
          <td class="p-3 text-center text-emerald-700 font-mono font-bold">${v9Escape(tempo)}</td>
          <td class="p-3 pr-4 text-center">
            <div class="flex flex-col items-center gap-2">
              <span class="bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 px-3 py-1 rounded-xl text-[10px] uppercase tracking-wider inline-flex items-center gap-1"><i class="fas fa-check-circle text-emerald-500"></i> Entregue</span>
              <button type="button" class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.vescoPendenciaEntregaV9 && window.vescoPendenciaEntregaV9('${v9Escape(id)}')"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  window.vescoPendenciaEntregaV9 = function(id){
    if(!id) return;
    try { if(typeof window.vescoPendenciaEntregaV7 === 'function') return window.vescoPendenciaEntregaV7(id); } catch(e) {}
    try { if(typeof window.vescoPendenciaEntregaV6 === 'function') return window.vescoPendenciaEntregaV6(id); } catch(e) {}
    try { if(typeof window.moverParaPendenciaPrompt === 'function') return window.moverParaPendenciaPrompt(id); } catch(e) {}
    const motivo = prompt(`Informe a pendência do pedido #${id}:`);
    if(!motivo) return;
    try { if(typeof updateStatusJsonp === 'function') updateStatusJsonp(id, 'Pendente', `[Pós-entrega] ${motivo}`); } catch(e) {}
    setTimeout(v9RenderDeliveredTable, 250);
  };

  try {
    window.shouldShowDeliveredForOperationalDate = shouldShowDeliveredForOperationalDate = function(o){
      return v9IsDelivered(o) && v9CanShowByDate(o);
    };
  } catch(e) {}

  const prevRenderV9 = typeof render === 'function' ? render : null;
  if(prevRenderV9 && !window.__vescoRenderEntreguesV9Wrapped){
    window.__vescoRenderEntreguesV9Wrapped = true;
    render = function(){
      const ret = prevRenderV9.apply(this, arguments);
      setTimeout(v9RenderDeliveredTable, 20);
      return ret;
    };
    window.render = render;
  }

  const prevSwitchTabV9 = window.switchTab;
  if(typeof prevSwitchTabV9 === 'function' && !window.__vescoSwitchTabEntreguesV9Wrapped){
    window.__vescoSwitchTabEntreguesV9Wrapped = true;
    window.switchTab = function(which){
      const ret = prevSwitchTabV9.apply(this, arguments);
      if(which === 'entregues' && !window.__vescoEntreguesV10SafeDate) {
        v9TryFetchDeliveredAliases();
        setTimeout(v9RenderDeliveredTable, 80);
        setTimeout(v9RenderDeliveredTable, 900);
      }
      return ret;
    };
  }

  const prevScheduleRenderV9 = typeof scheduleRender === 'function' ? scheduleRender : null;
  if(prevScheduleRenderV9 && !window.__vescoScheduleRenderV9Wrapped){
    window.__vescoScheduleRenderV9Wrapped = true;
    scheduleRender = function(){
      const ret = prevScheduleRenderV9.apply(this, arguments);
      setTimeout(v9RenderDeliveredTable, 120);
      return ret;
    };
    window.scheduleRender = scheduleRender;
  }

  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(v9RenderDeliveredTable, 1000);
    try {
      const obs = new MutationObserver(() => {
        if(document.getElementById('table-entregues')) setTimeout(v9RenderDeliveredTable, 40);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch(e) {}
  });

  window.vescoEntreguesV9 = {
    render: v9RenderDeliveredTable,
    collect: function(){ return v9CurrentPools().filter(v9IsDelivered).filter(v9CanShowByDate); },
    allDelivered: function(){ return v9CurrentPools().filter(v9IsDelivered); },
    cache: function(){ return v9ReadArray(V9_CACHE_KEY); },
    tryFetchDeliveredAliases: v9TryFetchDeliveredAliases,
    debug: function(){
      const all = v9CurrentPools();
      const delivered = all.filter(v9IsDelivered);
      return { totalPools: all.length, delivered: delivered.length, shown: delivered.filter(v9CanShowByDate).length, selectedISO: v9SelectedISO(), todayISO: v9TodayISO(), sampleDelivered: delivered.slice(0,5) };
    }
  };

  v9Log('Entregues V9 ativo — captura payload bruto da API e renderiza Entregue vindo da planilha/backend.');
})();

// =================================================================
// CAMADA V10 — CORREÇÃO FINAL ENTREGUES: DOCUMENTO NÃO É DATA
// Problema encontrado: o V9 capturou 1 pedido entregue, mas mostrou 0 porque
// a observação "Doc: 594516..." podia ser interpretada como data/timestamp.
// Regra de Preservação: esta camada não remove V9; apenas renderiza Entregues
// com filtro de data seguro e explícito.
// =================================================================
(function installVescoEntreguesV10SafeDate(){
  if (window.__vescoEntreguesV10SafeDate) return;
  window.__vescoEntreguesV10SafeDate = true;

  const V10_CACHE_KEY = 'vesco_delivered_cache_v10_safe_date';

  function log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function esc(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function normText(v){
    return String(v || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }
  function todayISO(){
    try { if(typeof getBrazilTodayISO === 'function') return getBrazilTodayISO(); } catch(e) {}
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0,10);
  }
  function selectedISO(){
    try { if(typeof getSelectedOperationalDateISO === 'function') return getSelectedOperationalDateISO(); } catch(e) {}
    return todayISO();
  }
  function sameISO(a,b){ return !!a && !!b && String(a).slice(0,10) === String(b).slice(0,10); }
  function isTodaySelected(){ return sameISO(selectedISO(), todayISO()); }
  function brToday(){
    try { if(typeof isoToBRDate === 'function') return isoToBRDate(todayISO()); } catch(e) {}
    const [y,m,d] = todayISO().split('-');
    return `${d}/${m}/${y}`;
  }
  function dateToISO(v){
    if(v === null || v === undefined || String(v).trim() === '') return '';
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if(m){
      let y = m[3];
      if(y.length === 2) y = '20' + y;
      return `${String(y).padStart(4,'0')}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    }
    return '';
  }
  function readArray(key){ try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch(e) { return []; } }
  function writeArray(key, arr){ try { localStorage.setItem(key, JSON.stringify(arr || [])); } catch(e) {} }
  function normKey(v){
    try { if(typeof normalizeOrderNumber === 'function') return normalizeOrderNumber(v); } catch(e) {}
    return String(v || '').replace(/^#/,'').replace(/\s+/g,'').trim();
  }
  function mergeByKey(list){
    const map = new Map();
    (list || []).forEach(o => {
      if(!o || typeof o !== 'object') return;
      const key = normKey(o.id || o.numero || o.pedido || o.numero_ecommerce || JSON.stringify(o).slice(0,60));
      if(!key) return;
      if(!map.has(key)) map.set(key, o);
      else map.set(key, Object.assign({}, map.get(key), o));
    });
    return Array.from(map.values());
  }
  function allPools(){
    const out = [];
    try { if(typeof orders !== 'undefined' && Array.isArray(orders)) out.push(...orders); } catch(e) {}
    try { if(Array.isArray(window.orders)) out.push(...window.orders); } catch(e) {}
    try { if(typeof flexOrders !== 'undefined' && Array.isArray(flexOrders)) out.push(...flexOrders); } catch(e) {}
    try { if(Array.isArray(window.flexOrders)) out.push(...window.flexOrders); } catch(e) {}
    try { if(Array.isArray(window.__vescoRawErpRowsV9)) out.push(...window.__vescoRawErpRowsV9); } catch(e) {}
    try { if(window.vescoEntreguesV9 && typeof window.vescoEntreguesV9.allDelivered === 'function') out.push(...window.vescoEntreguesV9.allDelivered()); } catch(e) {}
    out.push(...readArray('vesco_delivered_cache_v9'));
    out.push(...readArray('vesco_delivered_shadow_v6'));
    out.push(...readArray(V10_CACHE_KEY));
    return mergeByKey(out);
  }
  function isDelivered(o){
    if(!o) return false;
    const status = normText(o.status_logistica || o.situacao_nome || o.situacao || o.status || o.status_entrega || o.status_rota);
    const obs = normText(o.observacao_logistica || o.observacao || o.audit || o.historico || '');
    const all = `${status} ${obs}`;
    const delivered = /\bentregue\b|entregue via|recebido por|finalizad|concluid/.test(all);
    const pendingStatus = /\bpendente\b|a separar|em separa/.test(status);
    if(pendingStatus && !/\bentregue\b|finaliz|conclu/.test(status)) return false;
    return delivered;
  }
  function explicitDeliveryISO(o){
    if(!o) return '';
    const fields = [
      'data_entrega_realizada','entregue_em','entregueEm','data_entregue','dataEntregue',
      'dataEntrega','delivered_at','deliveredAt','concluidaEm','concluido_em','finalizado_em'
    ];
    for(const k of fields){
      const iso = dateToISO(o[k]);
      if(iso) return iso;
    }

    // Só aceita data textual explícita com barra/hífen. Não aceita número solto,
    // porque documentos/CPF/RG podem virar timestamp/serial por engano.
    const text = String(o.observacao_logistica || o.observacao || o.audit || o.historico || '');
    const br = text.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
    if(br) return dateToISO(br[1]);
    const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if(iso) return dateToISO(iso[1]);
    return '';
  }
  function canShowByDate(o){
    const iso = explicitDeliveryISO(o);
    if(iso) return sameISO(iso, selectedISO());
    // Sem data explícita no backend: se o pedido está entregue e a data selecionada
    // é hoje, mostra. É exatamente o caso da sua planilha atual.
    return isTodaySelected();
  }
  function receiver(o){
    let nome = o && (o.nome_recebedor || o.recebedor || o.recebido_por || '');
    let doc = o && (o.doc_recebedor || o.documento_recebedor || o.doc || '');
    const txt = String((o && (o.observacao_logistica || o.observacao || '')) || '');
    if(!nome){
      const m = txt.match(/Recebido por:\s*(.*?)\s*\(\s*Doc:\s*(.*?)\s*\)/i);
      if(m){ nome = (m[1] || '').trim(); doc = (m[2] || '').trim(); }
    }
    return { nome: nome || '—', doc: doc || '—' };
  }
  function searchValue(){
    const el = document.getElementById('search') || document.querySelector('input[placeholder*="Filtrar" i]');
    return String((el && el.value) || '').toLowerCase().trim();
  }
  function matchesSearch(o, q){
    if(!q) return true;
    return [o.numero, o.id, o.pedido, o.numero_ecommerce, o.cliente_nome, o.cliente, o.destinatario, o.nome, o.endereco_completo, o.endereco, o.observacao_logistica]
      .some(v => String(v || '').toLowerCase().includes(q));
  }
  function normalizeDeliveredForCache(o){
    if(!o || typeof o !== 'object') return null;
    const out = Object.assign({}, o);
    out.status_logistica = 'Entregue';
    out.situacao_nome = 'Entregue';
    if(!explicitDeliveryISO(out) && isTodaySelected()) {
      out.data_entregue = out.data_entregue || brToday();
      out.data_entrega_realizada = out.data_entrega_realizada || brToday();
      out.entregue_em = out.entregue_em || new Date().toISOString();
    }
    return out;
  }
  function saveCurrentDeliveredToV10Cache(){
    const delivered = allPools().filter(isDelivered);
    if(!delivered.length) return;
    const cache = mergeByKey([...readArray(V10_CACHE_KEY), ...delivered.map(normalizeDeliveredForCache).filter(Boolean)]);
    writeArray(V10_CACHE_KEY, cache.slice(-500));
  }
  function deliveredShown(){
    saveCurrentDeliveredToV10Cache();
    const q = searchValue();
    return allPools().filter(isDelivered).filter(canShowByDate).filter(o => matchesSearch(o, q));
  }
  let v10RenderPending = false;
  let v10LastHtml = '';
  function renderDeliveredTable(){
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;
    if(v10RenderPending) return;
    v10RenderPending = true;
    setTimeout(() => { v10RenderPending = false; }, 120);
    const delivered = deliveredShown();
    if(!delivered.length){
      const emptyHtml = `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">Nenhum despacho realizado.</td></tr>`;
      if(v10LastHtml !== emptyHtml){
        v10LastHtml = emptyHtml;
        tbody.innerHTML = emptyHtml;
      }
      return;
    }
    const html = delivered.map((o, idx) => {
      const id = o.id || o.numero || o.pedido || o.numero_ecommerce || '';
      const numero = o.numero || o.id || o.pedido || 'S/N';
      const cliente = o.cliente_nome || o.cliente || o.destinatario || o.nome || '—';
      const rec = receiver(o);
      const tempo = o.tempo_separacao || o.tempo_entrega || o.tempo || '—';
      return `
        <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm">
          <td class="p-3 pl-4 font-black text-slate-900">#${esc(numero)}</td>
          <td class="p-3 font-semibold text-slate-800">${esc(cliente)}</td>
          <td class="p-3 hidden md:table-cell">
            <div class="font-bold text-slate-800 flex items-center gap-1.5"><i class="fas fa-user-check text-blue-500"></i>${esc(rec.nome)}</div>
            <div class="text-[11px] text-slate-500 mt-0.5 font-mono"><i class="fas fa-id-card text-slate-400 mr-1"></i>Doc: ${esc(rec.doc)}</div>
          </td>
          <td class="p-3 text-center text-emerald-700 font-mono font-bold">${esc(tempo)}</td>
          <td class="p-3 pr-4 text-center">
            <div class="flex flex-col items-center gap-2">
              <span class="bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 px-3 py-1 rounded-xl text-[10px] uppercase tracking-wider inline-flex items-center gap-1"><i class="fas fa-check-circle text-emerald-500"></i> Entregue</span>
              <button type="button" class="vesco-entregue-pendencia-btn-v10-main bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.vescoPendenciaEntregaV10 && window.vescoPendenciaEntregaV10('${esc(id)}')"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>
            </div>
          </td>
        </tr>`;
    }).join('');
    if(v10LastHtml !== html){
      v10LastHtml = html;
      tbody.innerHTML = html;
    }
    try { window.__vescoEntreguesV10LastCount = delivered.length; } catch(e) {}
  }

  window.vescoPendenciaEntregaV10 = function(id){
    if(!id) return;
    try { if(typeof window.vescoPendenciaEntregaV9 === 'function') return window.vescoPendenciaEntregaV9(id); } catch(e) {}
    try { if(typeof window.moverParaPendenciaPrompt === 'function') return window.moverParaPendenciaPrompt(id); } catch(e) {}
    const motivo = prompt(`Informe a pendência do pedido #${id}:`);
    if(!motivo) return;
    try { if(typeof updateStatusJsonp === 'function') updateStatusJsonp(id, 'Pendente', `[Pós-entrega] ${motivo}`); } catch(e) {}
    setTimeout(renderDeliveredTable, 250);
  };

  try {
    window.shouldShowDeliveredForOperationalDate = shouldShowDeliveredForOperationalDate = function(o){
      return isDelivered(o) && canShowByDate(o);
    };
  } catch(e) {}

  const prevRender = typeof render === 'function' ? render : null;
  if(prevRender && !window.__vescoRenderEntreguesV10Wrapped){
    window.__vescoRenderEntreguesV10Wrapped = true;
    render = function(){
      const ret = prevRender.apply(this, arguments);
      setTimeout(renderDeliveredTable, 40);
      return ret;
    };
    window.render = render;
  }

  const prevSwitchTab = window.switchTab;
  if(typeof prevSwitchTab === 'function' && !window.__vescoSwitchTabEntreguesV10Wrapped){
    window.__vescoSwitchTabEntreguesV10Wrapped = true;
    window.switchTab = function(which){
      const ret = prevSwitchTab.apply(this, arguments);
      if(which === 'entregues') {
        // V11: alias fetch desativado por performance. O payload principal e o cache já alimentam Entregues.
        setTimeout(renderDeliveredTable, 80);
        setTimeout(renderDeliveredTable, 900);
      }
      return ret;
    };
  }

  const prevScheduleRender = typeof scheduleRender === 'function' ? scheduleRender : null;
  if(prevScheduleRender && !window.__vescoScheduleRenderV10Wrapped){
    window.__vescoScheduleRenderV10Wrapped = true;
    scheduleRender = function(){
      const ret = prevScheduleRender.apply(this, arguments);
      setTimeout(renderDeliveredTable, 160);
      return ret;
    };
    window.scheduleRender = scheduleRender;
  }

  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(renderDeliveredTable, 1000);
    // V11: removido o MutationObserver em body inteiro porque ele reacionava à própria tabela,
    // criando loop de renderização. Atualizações continuam via render(), scheduleRender() e troca de aba.
  });

  window.vescoEntreguesV10 = {
    render: renderDeliveredTable,
    allDelivered: function(){ return allPools().filter(isDelivered); },
    shown: deliveredShown,
    cache: function(){ return readArray(V10_CACHE_KEY); },
    clearCache: function(){ writeArray(V10_CACHE_KEY, []); },
    debug: function(){
      const delivered = allPools().filter(isDelivered);
      return {
        totalPools: allPools().length,
        delivered: delivered.length,
        shown: delivered.filter(canShowByDate).length,
        selectedISO: selectedISO(),
        todayISO: todayISO(),
        sampleDelivered: delivered.slice(0,5).map(o => ({
          numero: o.numero || o.id,
          status: o.status_logistica || o.situacao_nome || o.status,
          explicitDeliveryISO: explicitDeliveryISO(o),
          canShow: canShowByDate(o),
          obs: o.observacao_logistica || o.observacao || ''
        }))
      };
    }
  };

  log('Entregues V10 ativo — corrige filtro de data e ignora documento como data.');
})();


// =================================================================
// CAMADA V11 — PERFORMANCE / ANTI-LOOP / ENTREGUES ESTÁVEL
// Preserva as camadas anteriores, mas impede disputa de renderização,
// duplicidade de botões e geocodificação em massa fora das abas de mapa.
// =================================================================
(function installVescoPerformanceAntiLoopV11(){
  if(window.__vescoPerformanceAntiLoopV11) return;
  window.__vescoPerformanceAntiLoopV11 = true;

  function log(){ try { console.log.apply(console, arguments); } catch(e) {} }

  function ensureStyle(){
    if(document.getElementById('vesco-v11-performance-style')) return;
    const st = document.createElement('style');
    st.id = 'vesco-v11-performance-style';
    st.textContent = `
      #table-entregues .vesco-entregue-pendencia-btn,
      #table-entregues .vesco-entregue-pendencia-btn-v5,
      #table-entregues .vesco-entregue-pendencia-btn-v6-final{
        display:none!important;
      }
      #table-entregues .vesco-entregue-pendencia-btn-v10-main{
        display:inline-flex!important;
      }
    `;
    document.head.appendChild(st);
  }

  function isVisible(el){
    if(!el) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if(cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function currentMainTab(){
    const active = document.querySelector('.tab-btn.active, [id^="main-"].active');
    return active ? String(active.id || active.textContent || '').toLowerCase() : '';
  }

  function isMapTabActive(){
    const tab = currentMainTab();
    const logistica = document.getElementById('view-logistica');
    const flex = document.getElementById('view-envios_flex');
    return (tab.includes('log') && isVisible(logistica)) || (tab.includes('flex') && isVisible(flex));
  }

  try {
    const oldPlot = window.plotMapMarkers || (typeof plotMapMarkers === 'function' ? plotMapMarkers : null);
    if(oldPlot && !window.__vescoPlotMapMarkersV11Wrapped){
      window.__vescoPlotMapMarkersV11Wrapped = true;
      window.plotMapMarkers = plotMapMarkers = function(orderList, flexList){
        if(!isMapTabActive()) return;
        return oldPlot.apply(this, arguments);
      };
    }
  } catch(e) {}

  // Failsafe: se algum callback externo travar a tela de loading, destrava sem afetar os dados já carregados.
  function hideStuckLoading(){
    try {
      const el = document.getElementById('loadingOverlay') || document.getElementById('loading-overlay');
      if(el && isVisible(el)) {
        if(typeof showLoading === 'function') showLoading(false);
        else el.style.display = 'none';
      }
    } catch(e) {}
  }

  // Reduz buscas extras de entregues por aliases, que estavam gerando JSONP/script error e lentidão.
  try {
    if(window.vescoEntreguesV9) window.vescoEntreguesV9.tryFetchDeliveredAliases = function(){ return null; };
  } catch(e) {}

  // Remove duplicados já existentes na tabela após renderizações antigas.
  function cleanDeliveredDuplicates(){
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;
    tbody.querySelectorAll('.vesco-entregue-pendencia-btn, .vesco-entregue-pendencia-btn-v5, .vesco-entregue-pendencia-btn-v6-final').forEach(btn => {
      const wrap = btn.closest('.mt-2') || btn.parentElement;
      if(wrap && wrap.querySelectorAll('button').length === 1) wrap.remove();
      else btn.remove();
    });
  }

  const oldRender = window.render || (typeof render === 'function' ? render : null);
  if(oldRender && !window.__vescoRenderV11Wrapped){
    window.__vescoRenderV11Wrapped = true;
    window.render = render = function(){
      const ret = oldRender.apply(this, arguments);
      setTimeout(cleanDeliveredDuplicates, 120);
      setTimeout(hideStuckLoading, 1800);
      return ret;
    };
  }

  const oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function' && !window.__vescoSwitchV11Wrapped){
    window.__vescoSwitchV11Wrapped = true;
    window.switchTab = function(which){
      const ret = oldSwitch.apply(this, arguments);
      setTimeout(cleanDeliveredDuplicates, 160);
      setTimeout(hideStuckLoading, 1800);
      return ret;
    };
  }

  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){
      ensureStyle();
      setTimeout(cleanDeliveredDuplicates, 700);
      setTimeout(hideStuckLoading, 2500);
    });
  } else {
    ensureStyle();
    setTimeout(cleanDeliveredDuplicates, 700);
    setTimeout(hideStuckLoading, 2500);
  }

  window.vescoPerformanceV11 = {
    cleanDeliveredDuplicates,
    hideStuckLoading,
    isMapTabActive
  };

  log('Performance V11 ativa — anti-loop em Entregues, sem botões duplicados e geocoding fora do mapa bloqueado.');
})();

// =================================================================
// CAMADA V12 — ROTAS ESTÁVEIS + ORIGEM REAL + PENDÊNCIA EM ENTREGUES
// Regra de Preservação: camada aditiva; não remove legado. Ela assume
// a liderança apenas nos pontos quebrados: mapa de rota, geocoding em
// massa e botão Pendência na aba Entregues.
// =================================================================
(function installVescoRoutesPendenciaV12(){
  if(window.__vescoRoutesPendenciaV12) return;
  window.__vescoRoutesPendenciaV12 = true;

  const GEO_CACHE_KEY = 'vesco_route_geocode_cache_v12';
  const ROUTES_KEY = 'vesco_saiu_rotas_v1';
  const ORIGIN_KEY = 'vesco_route_origin_v6';
  const DEFAULT_CENTER = [-23.55052, -46.633308];
  let routeMap = null;
  let routeLayer = null;
  let lastRouteSignature = '';
  let lastDeliveredButtonSignature = '';

  function log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function esc(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function toast(msg, type = 'info', ms = 3500){
    try { if(typeof showToast === 'function') return showToast(msg, type, ms); } catch(e) {}
    try { console.log(msg); } catch(e) {}
  }
  function norm(v){
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(v) : String(v ?? '').replace(/^#/, '').trim(); }
    catch(e){ return String(v ?? '').replace(/^#/, '').trim(); }
  }
  function cleanAddress(v){
    return String(v || '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, ',')
      .replace(/\bSao\b/gi, 'São')
      .trim();
  }
  function readJSON(key, fallback){
    try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch(e) { return fallback; }
  }
  function writeJSON(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
  }
  function isVisible(el){
    if(!el) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if(cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  function activeTabText(){
    const candidates = Array.from(document.querySelectorAll('.tab-btn.active, [id^="main-"].active, nav .active, button.active'));
    return candidates.map(el => `${el.id || ''} ${el.textContent || ''}`).join(' ').toLowerCase();
  }
  function isLogisticaOrFlexActive(){
    const txt = activeTabText();
    return /log[ií]stica/.test(txt) || /envios\s*flex/.test(txt) || /main-log|main-flex/.test(txt);
  }
  function isRouteViewActive(){
    const txt = activeTabText();
    const routeRoot = document.querySelector('#view-saiu:not(.hidden), #view-rotas:not(.hidden), #view-pronto-envio:not(.hidden), #view-pronto_envio:not(.hidden), #view-pronto_para_envio:not(.hidden)');
    return !!routeRoot || /pronto\s+para\s+envio|montar\s+rotas|main-rotas|main-saiu|main-pronto/.test(txt);
  }

  // Bloqueio forte da geocodificação em massa fora das abas corretas.
  try {
    const oldPlot = window.plotMapMarkers || (typeof plotMapMarkers === 'function' ? plotMapMarkers : null);
    if(oldPlot && !window.__vescoPlotMapMarkersV12Wrapped){
      window.__vescoPlotMapMarkersV12Wrapped = true;
      window.plotMapMarkers = plotMapMarkers = function(orderList, flexList){
        if(!isLogisticaOrFlexActive()) return;
        return oldPlot.apply(this, arguments);
      };
    }
    if(Array.isArray(window.geocodeQueue)) window.geocodeQueue.length = 0;
    try { if(typeof geocodeQueue !== 'undefined' && Array.isArray(geocodeQueue)) geocodeQueue.length = 0; } catch(e) {}
  } catch(e) { warn('V12 não conseguiu bloquear geocoding em massa:', e); }

  function allOrders(){
    const pools = [];
    try { if(Array.isArray(orders)) pools.push(...orders); } catch(e) {}
    try { if(Array.isArray(flexOrders)) pools.push(...flexOrders); } catch(e) {}
    if(Array.isArray(window.orders)) pools.push(...window.orders);
    if(Array.isArray(window.flexOrders)) pools.push(...window.flexOrders);
    const seen = new Set();
    return pools.filter(o => {
      if(!o) return false;
      const k = String(o.id || o.numero || o.pedido || Math.random());
      if(seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function orderKeys(o){
    if(!o) return [];
    const vals = [o.id, o.numero, o.pedido, o.order_id, o.orderNumber, o.reference, o.referencia, o.numero_ecommerce, o.numero_ecom, o.codigo_externo, o.codigo];
    const keys = [];
    vals.forEach(v => {
      if(v === undefined || v === null || String(v).trim() === '') return;
      const raw = String(v).trim();
      keys.push(raw, norm(raw), raw.replace(/\D/g,''));
    });
    return Array.from(new Set(keys.filter(Boolean)));
  }
  function findOrder(id){
    const raw = String(id || '').trim();
    const n = norm(raw);
    const digits = raw.replace(/\D/g,'');
    return allOrders().find(o => {
      const keys = orderKeys(o);
      return keys.includes(raw) || keys.includes(n) || (digits && keys.includes(digits));
    }) || null;
  }
  function orderAddress(o){ return cleanAddress(o && (o.endereco_completo || o.endereco || o.address || o.full_address || o.logradouro || '')); }
  function orderClient(o){
    try { return extractClientNameFromAny(o) || o.cliente_nome || o.cliente || o.destinatario || o.nome || ''; }
    catch(e) { return o && (o.cliente_nome || o.cliente || o.destinatario || o.nome) || ''; }
  }
  function directCoords(o){
    try {
      const c = typeof getCoords === 'function' ? getCoords(o) : null;
      if(c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon))) return { lat:Number(c.lat), lon:Number(c.lon) };
    } catch(e) {}
    return null;
  }
  function markerCoords(key){
    try {
      const m = (typeof findMainMarkerByKey === 'function' && findMainMarkerByKey(key)) ||
                (typeof findFlexMarkerByKey === 'function' && findFlexMarkerByKey(key));
      if(m && typeof m.getLatLng === 'function') {
        const ll = m.getLatLng();
        if(ll && Number.isFinite(Number(ll.lat)) && Number.isFinite(Number(ll.lng))) return { lat:Number(ll.lat), lon:Number(ll.lng) };
      }
    } catch(e) {}
    return null;
  }
  function routeRoot(){
    const selectors = ['#view-saiu:not(.hidden)', '#view-rotas:not(.hidden)', '#view-pronto-envio:not(.hidden)', '#view-pronto_envio:not(.hidden)', '#view-pronto_para_envio:not(.hidden)', '#view-saiu', '#view-rotas'];
    for(const sel of selectors){ const el = document.querySelector(sel); if(el) return el; }
    return document.body;
  }
  function installStyle(){
    if(document.getElementById('vesco-v12-style')) return;
    const st = document.createElement('style');
    st.id = 'vesco-v12-style';
    st.textContent = `
      #table-entregues .vesco-entregue-pendencia-btn-v12{display:inline-flex!important;align-items:center;justify-content:center;gap:4px;}
      #vesco-route-map-v12{height:calc(100vh - 250px);min-height:390px;width:100%;border-radius:12px;overflow:hidden;background:#eef2f7;}
      #vesco-route-panel-v12{border:1px solid #dbe5f1;background:#fff;border-radius:14px;padding:10px;box-shadow:0 8px 22px rgba(15,23,42,.06);margin-top:10px;}
      #vesco-route-info-v12{margin-bottom:12px;padding:12px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:14px;font-size:12px;color:#334155;}
      .vesco-route-origin-warning-v12{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:10px;padding:8px;font-size:11px;font-weight:700;margin-top:6px;}
      @media(max-width:1024px){#vesco-route-map-v12{height:360px;min-height:360px;}}
    `;
    document.head.appendChild(st);
  }
  function ensureOriginField(){
    const root = routeRoot();
    let input = document.getElementById('vesco-rota-origem-v6') || document.getElementById('vesco-rota-origem-v12') || document.getElementById('rotaOrigem') || document.getElementById('pontoPartidaRota');
    if(input) return input;
    const saved = localStorage.getItem(ORIGIN_KEY) || '';
    const wrap = document.createElement('div');
    wrap.className = 'vesco-rota-origem-v12 mb-3';
    wrap.innerHTML = `
      <label class="block text-xs font-black text-slate-700 mb-1">Ponto de partida da rota</label>
      <input id="vesco-rota-origem-v12" type="text" value="${esc(saved)}" placeholder="Ex: Rua Conselheiro Dantas, 141 - Brás, São Paulo - SP" class="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm outline-none focus:border-blue-500 w-full" />
      <div class="text-[10px] text-slate-400 mt-1">Informe um endereço real da saída. Nome de rota não serve como ponto de partida.</div>`;
    const anchor = root.querySelector('#rotaMotorista, #motoristaRota, #routeDriver, #rotaNome, #nomeRota, #saiu-pedidos-list') || root.firstElementChild;
    if(anchor && anchor.parentElement) anchor.parentElement.insertBefore(wrap, anchor.nextSibling);
    else root.prepend(wrap);
    input = wrap.querySelector('input');
    input.addEventListener('input', () => localStorage.setItem(ORIGIN_KEY, cleanAddress(input.value)));
    return input;
  }
  function getOrigin(){
    const input = ensureOriginField();
    const value = cleanAddress((input && input.value) || localStorage.getItem(ORIGIN_KEY) || '');
    if(value) localStorage.setItem(ORIGIN_KEY, value);
    return value;
  }
  function looksLikeAddress(v){
    const s = cleanAddress(v).toLowerCase();
    if(!s) return false;
    if(/^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(s)) return true;
    const hasStreet = /(rua|r\.|avenida|av\.|alameda|travessa|estrada|rodovia|pra[cç]a|largo|via)\b/.test(s);
    const hasNumber = /\b\d{1,6}[a-z]?\b/.test(s);
    const hasCity = /(s[aã]o paulo|sp|barueri|osasco|guarulhos|santo andr[eé]|cotia|diadema|tabo[aã]o|carapicu[ií]ba|maua|mau[aá])/.test(s);
    return (hasStreet && hasNumber) || (hasStreet && hasCity) || (hasNumber && hasCity);
  }
  function ensureMapPanel(){
    installStyle();
    const root = routeRoot();
    let panel = document.getElementById('vesco-route-panel-v12');
    if(!panel){
      panel = document.createElement('div');
      panel.id = 'vesco-route-panel-v12';
      panel.innerHTML = `
        <div id="vesco-route-info-v12">
          <div class="font-black text-blue-800 mb-1"><i class="fas fa-route mr-1"></i>Planejamento da rota</div>
          <div class="text-slate-600">Informe um endereço real de partida, selecione os pedidos e trace a rota.</div>
        </div>
        <div class="flex items-center justify-between mb-2">
          <div class="text-[11px] font-black text-slate-500 uppercase">Mapa da rota</div>
          <div class="text-[10px] font-bold text-blue-600 uppercase">Partida + entregas</div>
        </div>
        <div id="vesco-route-map-v12"></div>`;
      const oldRight = document.getElementById('vesco-saiu-right-v6');
      if(oldRight) oldRight.appendChild(panel);
      else root.appendChild(panel);
    }
    return panel;
  }
  function ensureRouteMap(){
    ensureMapPanel();
    if(typeof L === 'undefined') return null;
    const el = document.getElementById('vesco-route-map-v12');
    if(!el) return null;
    if(routeMap && routeMap._container === el){
      setTimeout(() => { try { routeMap.invalidateSize(true); } catch(e) {} }, 80);
      return routeMap;
    }
    try {
      if(el._leaflet_id){ el.innerHTML = ''; try { delete el._leaflet_id; } catch(e){ el._leaflet_id = undefined; } }
      routeMap = L.map(el).setView(DEFAULT_CENTER, 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(routeMap);
      setTimeout(() => routeMap.invalidateSize(true), 150);
      return routeMap;
    } catch(e){ warn('Erro ao iniciar mapa V12:', e); return null; }
  }
  function parseCoordText(addr){
    const m = String(addr || '').trim().match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
    return m ? { lat:Number(m[1]), lon:Number(m[2]) } : null;
  }
  async function geocode(addr){
    addr = cleanAddress(addr);
    if(!addr) return null;
    const direct = parseCoordText(addr);
    if(direct) return direct;
    const key = addr.toLowerCase();
    const cache = readJSON(GEO_CACHE_KEY, {});
    if(cache[key] && Number.isFinite(Number(cache[key].lat)) && Number.isFinite(Number(cache[key].lon))) return cache[key];
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 4200) : null;
      const q = encodeURIComponent(addr.includes('Brasil') ? addr : `${addr}, Brasil`);
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=0`, {
        headers: { 'Accept-Language': 'pt-BR' },
        signal: controller ? controller.signal : undefined
      });
      if(timer) clearTimeout(timer);
      const js = await res.json();
      if(Array.isArray(js) && js[0]){
        const out = { lat:Number(js[0].lat), lon:Number(js[0].lon) };
        if(Number.isFinite(out.lat) && Number.isFinite(out.lon)){
          cache[key] = out;
          writeJSON(GEO_CACHE_KEY, cache);
          return out;
        }
      }
    } catch(e) {}
    return null;
  }
  function routePedidosFromSelection(){
    const selectors = [
      '#saiu-pedidos-list input[type="checkbox"]:checked',
      '#view-saiu input[type="checkbox"]:checked',
      '#view-rotas input[type="checkbox"]:checked',
      '#view-pronto-envio input[type="checkbox"]:checked',
      '[data-route-order]:checked', '[data-num][type="checkbox"]:checked', '[data-ecom][type="checkbox"]:checked'
    ];
    const inputs = Array.from(new Set(selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)))));
    const out = [];
    inputs.forEach(cb => {
      let val = cb.getAttribute('data-num') || cb.getAttribute('data-ecom') || cb.getAttribute('data-pedido') || cb.value || '';
      if(!val || val === 'on'){
        const row = cb.closest('tr') || cb.closest('.pedido-item') || cb.closest('[data-num]') || cb.parentElement;
        val = row && (row.getAttribute('data-num') || row.getAttribute('data-ecom') || row.getAttribute('data-pedido')) || '';
        if(!val && row){ const m = (row.innerText || '').match(/#\s*([0-9A-Za-z._-]{4,})/) || (row.innerText || '').match(/\b(\d{5,})\b/); if(m) val = m[1]; }
      }
      val = norm(val);
      if(val && !out.includes(val)) out.push(val);
    });
    return out;
  }
  function buildStops(pedidos, origin){
    const stops = [];
    origin = cleanAddress(origin || getOrigin());
    if(origin) stops.push({ isOrigin:true, numero:'Partida', pedido:'__ORIGEM__', cliente:'Ponto de partida', endereco:origin, lat:null, lon:null });
    Array.from(new Set((pedidos || []).map(norm).filter(Boolean))).forEach(p => {
      const o = findOrder(p);
      const c = directCoords(o) || markerCoords(p) || markerCoords(o && (o.numero || o.id));
      stops.push({ isOrigin:false, pedido:p, numero:(o && (o.numero || o.id)) || p, cliente:orderClient(o), endereco:orderAddress(o), lat:c ? c.lat : null, lon:c ? c.lon : null });
    });
    return stops;
  }
  async function resolveStop(stop){
    if(stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return { lat:Number(stop.lat), lon:Number(stop.lon) };
    if(!stop.isOrigin){
      const c = markerCoords(stop.numero || stop.pedido) || directCoords(findOrder(stop.numero || stop.pedido));
      if(c) return c;
    }
    const g = await geocode(stop.endereco);
    if(g){ stop.lat = g.lat; stop.lon = g.lon; }
    return g;
  }
  function mapsUrl(stops){
    const valid = (stops || []).filter(s => cleanAddress(s.endereco) || (Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon))));
    if(!valid.length) return '';
    const enc = s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)) ? `${Number(s.lat)},${Number(s.lon)}` : cleanAddress(s.endereco);
    if(valid.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enc(valid[0]))}`;
    const limited = valid.slice(0,25);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(enc(limited[0]))}&destination=${encodeURIComponent(enc(limited[limited.length - 1]))}&travelmode=driving`;
    const way = limited.slice(1,-1).map(enc).filter(Boolean);
    if(way.length) url += `&waypoints=${encodeURIComponent(way.join('|'))}`;
    return url;
  }
  function renderRouteInfo(route, stops, resolvedCount, warning){
    ensureMapPanel();
    const info = document.getElementById('vesco-route-info-v12');
    if(!info) return;
    const url = mapsUrl(stops);
    const deliveries = stops.filter(s => !s.isOrigin);
    info.innerHTML = `
      <div class="font-black text-blue-800 mb-2"><i class="fas fa-route mr-1"></i>Rota montada: ${esc(route.nome || 'Prévia da rota')}</div>
      <div class="mb-1"><b>Partida:</b> ${esc((stops.find(s => s.isOrigin) || {}).endereco || '—')}</div>
      <div class="mb-1"><b>Motorista:</b> ${esc(route.motorista || '—')} • <b>Pedidos:</b> ${deliveries.length}</div>
      <div class="mb-2 text-blue-700 font-bold">${resolvedCount}/${stops.length} ponto(s) carregado(s) no mapa.</div>
      ${warning ? `<div class="vesco-route-origin-warning-v12">${esc(warning)}</div>` : ''}
      <div class="max-h-40 overflow-auto bg-white/70 border border-blue-100 rounded-lg p-2 mb-2 mt-2">
        ${stops.map((s,i) => `<div class="mb-1"><b>${s.isOrigin ? 'Partida' : (i + '. #' + esc(s.numero || s.pedido))}</b> — ${esc(s.endereco || 'Endereço não localizado')}</div>`).join('')}
      </div>
      ${url ? `<button type="button" onclick="window.open('${esc(url)}','_blank')" class="inline-flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold"><i class="fas fa-map-marked-alt"></i>Abrir rota no Google Maps</button>` : ''}`;
  }
  async function drawRoute(routeOrId, opts = {}){
    let route = typeof routeOrId === 'string' ? (window.saiuRotas || []).find(r => String(r.id) === String(routeOrId)) : routeOrId;
    if(!route){
      const pedidos = routePedidosFromSelection();
      route = { id:'preview-v12', nome:'Prévia da rota', motorista:'—', pedidos, origem:getOrigin(), criadoEm:new Date().toISOString() };
    }
    if(!route.pedidos) route.pedidos = [];
    const origin = cleanAddress(route.origem || getOrigin());
    route.origem = origin;
    let warning = '';
    if(!origin) warning = 'Informe o ponto de partida para montar a rota completa.';
    else if(!looksLikeAddress(origin)) warning = 'O ponto de partida parece ser nome de rota, não endereço. Use rua/avenida + número + cidade.';
    const stops = buildStops(route.pedidos, origin);
    route.paradas = stops;
    const sig = JSON.stringify({ id:route.id, pedidos:route.pedidos, origin, t: opts.force ? Date.now() : '' });
    if(!opts.force && sig === lastRouteSignature) return mapsUrl(stops);
    lastRouteSignature = sig;
    const m = ensureRouteMap();
    renderRouteInfo(route, stops, 0, warning);
    if(!m || typeof L === 'undefined') return mapsUrl(stops);
    try { if(routeLayer) routeLayer.remove(); } catch(e) {}
    routeLayer = L.layerGroup().addTo(m);
    const latlngs = [];
    for(let i=0;i<stops.length;i++){
      const s = stops[i];
      const coords = await resolveStop(s);
      if(!coords) continue;
      const ll = [coords.lat, coords.lon];
      latlngs.push(ll);
      try {
        const label = s.isOrigin ? 'P' : String(i);
        const color = s.isOrigin ? '#111827' : '#2563eb';
        const icon = L.divIcon({ html:`<div style="width:30px;height:30px;border-radius:999px;background:${color};color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.25)">${label}</div>`, className:'', iconSize:[30,30], iconAnchor:[15,15] });
        L.marker(ll,{icon}).addTo(routeLayer).bindPopup(`<b>${s.isOrigin ? 'Partida' : ('Pedido #' + esc(s.numero || s.pedido))}</b><br>${esc(s.cliente || '')}<br><small>${esc(s.endereco || '')}</small>`);
      } catch(e) {}
    }
    if(latlngs.length > 1){ try { L.polyline(latlngs, { weight:5, opacity:.9 }).addTo(routeLayer); } catch(e) {} }
    try {
      if(latlngs.length === 1) m.setView(latlngs[0], 15);
      else if(latlngs.length > 1) m.fitBounds(L.latLngBounds(latlngs).pad(0.18), { maxZoom: 15 });
      else m.setView(DEFAULT_CENTER, 11);
      setTimeout(() => m.invalidateSize(true), 120);
      setTimeout(() => m.invalidateSize(true), 650);
    } catch(e) {}
    renderRouteInfo(route, stops, latlngs.length, warning);
    try { localStorage.setItem(ROUTES_KEY, JSON.stringify(window.saiuRotas || [])); } catch(e) {}
    return mapsUrl(stops);
  }
  function latestActiveRoute(){
    const routes = Array.isArray(window.saiuRotas) ? window.saiuRotas : readJSON(ROUTES_KEY, []);
    if(!routes.length) return null;
    return routes.slice().sort((a,b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')))[0];
  }
  function renderLatestRouteSoon(force){
    if(!isRouteViewActive()) return;
    setTimeout(() => {
      ensureOriginField();
      const route = latestActiveRoute();
      if(route) drawRoute(route, { force: !!force });
      else ensureRouteMap();
    }, 250);
  }

  // Substitui as funções expostas de rota para usar a implementação estável V12.
  window.verRotaMapa = function(rotaId){ return drawRoute(rotaId, { force:true }); };
  window.vescoOpenRouteInGoogle = function(rotaId){
    const route = (window.saiuRotas || []).find(r => String(r.id) === String(rotaId)) || latestActiveRoute();
    const stops = route ? buildStops(route.pedidos || [], route.origem || getOrigin()) : buildStops(routePedidosFromSelection(), getOrigin());
    const url = mapsUrl(stops);
    if(url) window.open(url, '_blank');
    else toast('Nenhuma rota disponível para abrir.', 'warning');
  };
  if(window.vescoRoutesV6){
    window.vescoRoutesV6.drawRouteOnMap = drawRoute;
    window.vescoRoutesV6.ensureRouteMap = ensureRouteMap;
    window.vescoRoutesV6.getRouteOrigin = getOrigin;
    window.vescoRoutesV6.buildStops = buildStops;
    window.vescoRoutesV6.buildGoogleMapsRouteUrl = function(route){ return mapsUrl(buildStops(route && route.pedidos || [], route && route.origem || getOrigin())); };
  }

  function injectPendenciaButtons(){
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const signature = rows.map(r => r.innerText).join('|').slice(0, 4000);
    if(signature === lastDeliveredButtonSignature && tbody.querySelector('.vesco-entregue-pendencia-btn-v12')) return;
    lastDeliveredButtonSignature = signature;
    rows.forEach(row => {
      if(/nenhum despacho|nenhum registro/i.test(row.innerText || '')) return;
      if(row.querySelector('.vesco-entregue-pendencia-btn-v12')) return;
      const txt = row.innerText || '';
      const m = txt.match(/#\s*([0-9A-Za-z._-]+)/) || txt.match(/\b(\d{5,})\b/);
      if(!m) return;
      const numero = m[1];
      const order = findOrder(numero);
      const id = (order && (order.id || order.numero)) || numero;
      const target = row.querySelector('td:last-child') || row.lastElementChild;
      if(!target) return;
      const box = document.createElement('div');
      box.className = 'mt-2 flex justify-center';
      box.innerHTML = `<button type="button" class="vesco-entregue-pendencia-btn-v12 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.vescoPendenciaEntregaV12 && window.vescoPendenciaEntregaV12('${esc(id)}')"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>`;
      target.appendChild(box);
    });
  }
  window.vescoPendenciaEntregaV12 = function(id){
    if(!id) return;
    try { if(typeof window.moverParaPendenciaPrompt === 'function') return window.moverParaPendenciaPrompt(id); } catch(e) {}
    const motivo = prompt(`Informe a pendência do pedido #${id}:`);
    if(!motivo) return;
    try { if(typeof updateStatusJsonp === 'function') updateStatusJsonp(id, 'Pendente', `[Pós-entrega] ${motivo}`); } catch(e) {}
    toast('Pendência registrada para o pedido entregue.', 'warning');
  };

  const oldRender = window.render || (typeof render === 'function' ? render : null);
  if(oldRender && !window.__vescoRenderV12Wrapped){
    window.__vescoRenderV12Wrapped = true;
    window.render = render = function(){
      const ret = oldRender.apply(this, arguments);
      setTimeout(injectPendenciaButtons, 180);
      setTimeout(() => renderLatestRouteSoon(false), 280);
      return ret;
    };
  }
  const oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function' && !window.__vescoSwitchV12Wrapped){
    window.__vescoSwitchV12Wrapped = true;
    window.switchTab = function(which){
      const ret = oldSwitch.apply(this, arguments);
      setTimeout(injectPendenciaButtons, 220);
      if(['saiu','rotas','pronto_envio','pronto_para_envio','prontoParaEnvio','envio'].includes(which)) renderLatestRouteSoon(true);
      return ret;
    };
  }

  // Botões de traçar rota: não interfere na criação antiga, mas garante que o botão visual trace usando V12.
  document.addEventListener('click', function(e){
    const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if(!btn) return;
    const text = `${btn.textContent || ''} ${btn.value || ''} ${btn.id || ''}`.toLowerCase();
    if(/tra[cç]ar\s+(rota|no mapa)|google\s*maps|ver\s+no\s+mapa/.test(text)){
      setTimeout(() => renderLatestRouteSoon(true), 150);
    }
    if(/criar\s+rota/.test(text)){
      const origin = getOrigin();
      if(origin && !looksLikeAddress(origin)){
        setTimeout(() => toast('Atenção: o ponto de partida parece não ser endereço. Use rua/avenida + número + cidade para a rota carregar no mapa.', 'warning', 6000), 200);
      }
      setTimeout(() => renderLatestRouteSoon(true), 900);
    }
  }, false);

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){
      installStyle();
      ensureOriginField();
      setTimeout(injectPendenciaButtons, 900);
      setTimeout(() => renderLatestRouteSoon(true), 1200);
    });
  } else {
    installStyle();
    ensureOriginField();
    setTimeout(injectPendenciaButtons, 700);
    setTimeout(() => renderLatestRouteSoon(true), 1000);
  }

  // Pequeno reforço sem MutationObserver: apenas alguns ciclos no início/troca de tela.
  let cycles = 0;
  const t = setInterval(() => {
    cycles++;
    injectPendenciaButtons();
    if(isRouteViewActive()) renderLatestRouteSoon(false);
    if(cycles >= 10) clearInterval(t);
  }, 1000);

  window.vescoRoutesV12 = {
    drawRoute,
    ensureRouteMap,
    ensureOriginField,
    getOrigin,
    looksLikeAddress,
    injectPendenciaButtons,
    geocode,
    findOrder,
    routePedidosFromSelection,
    buildStops
  };

  log('Rotas/Pendências V12 ativo — rota com origem real, geocoding controlado e botão Pendência em Entregues.');
})();

// =================================================================
// CAMADA V13 — MAPA ÚNICO DE ROTAS + ORIGEM VÁLIDA + PENDÊNCIA GARANTIDA
// Regra de Preservação: camada aditiva. Não remove funções antigas;
// apenas oculta mapas legados duplicados e assume a renderização final.
// =================================================================
(function installVescoRouteSingleMapV13(){
  if(window.__vescoRouteSingleMapV13) return;
  window.__vescoRouteSingleMapV13 = true;

  const ROUTES_KEY = 'vesco_saiu_rotas_v1';
  const ORIGIN_KEY = 'vesco_route_origin_v6';
  const GEO_CACHE_KEY = 'vesco_route_geocode_cache_v13';
  const DEFAULT_CENTER = [-23.55052, -46.633308];
  let routeLayerV13 = null;
  let lastDrawSigV13 = '';

  function log(){ try { console.log.apply(console, arguments); } catch(e) {} }
  function warn(){ try { console.warn.apply(console, arguments); } catch(e) {} }
  function esc(v){
    try { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    catch(e){ return String(v ?? ''); }
  }
  function toast(msg, type='info', ms=3500){
    try { if(typeof showToast === 'function') return showToast(msg, type, ms); } catch(e) {}
    console.log(msg);
  }
  function clean(v){ return String(v || '').replace(/\s+/g,' ').replace(/\|/g, ',').replace(/\bSao\b/gi, 'São').trim(); }
  function norm(v){
    try { return typeof normalizeOrderNumber === 'function' ? normalizeOrderNumber(v) : String(v ?? '').replace(/^#/,'').trim(); }
    catch(e){ return String(v ?? '').replace(/^#/,'').trim(); }
  }
  function readJSON(key, fallback){ try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch(e) { return fallback; } }
  function writeJSON(key, value){ try { localStorage.setItem(key, JSON.stringify(value || {})); } catch(e) {} }
  function getComputedVisible(el){
    if(!el) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if(cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  function viewVisible(id){
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('hidden') && getComputedVisible(el);
  }
  function routeViewActive(){
    return viewVisible('view-saiu') || viewVisible('view-rotas') || viewVisible('view-pronto-envio') || viewVisible('view-pronto_envio') || viewVisible('view-pronto_para_envio') || /pronto\s+para\s+envio|montar\s+rotas/i.test((document.querySelector('.tab-btn.active,[id^="main-"].active') || {}).textContent || '');
  }
  function logisticalMapActive(){ return viewVisible('view-logistica') || viewVisible('view-envios_flex'); }

  function installStyle(){
    if(document.getElementById('vesco-v13-style')) return;
    const st = document.createElement('style');
    st.id = 'vesco-v13-style';
    st.textContent = `
      /* Mantém apenas o mapa V12/V13. Os mapas legados ficam preservados no DOM, mas ocultos. */
      #vesco-route-map-panel-v6,
      #vesco-route-info-panel-v6,
      #vesco-route-map-panel-v5,
      #vesco-route-info-panel-v5,
      #vesco-route-map-v5{
        display:none!important;
        height:0!important;
        min-height:0!important;
        max-height:0!important;
        overflow:hidden!important;
        opacity:0!important;
        pointer-events:none!important;
        margin:0!important;
        padding:0!important;
        border:0!important;
      }
      #vesco-route-panel-v12{display:block!important;margin-top:0!important;}
      #vesco-route-map-v12{display:block!important;min-height:390px!important;height:calc(100vh - 250px)!important;width:100%!important;}
      #table-entregues .vesco-entregue-pendencia-btn-v13{display:inline-flex!important;align-items:center;justify-content:center;gap:4px;}
      .vesco-v13-warning{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:10px;padding:8px;font-size:11px;font-weight:800;margin:8px 0;}
      @media(max-width:1024px){#vesco-route-map-v12{height:360px!important;min-height:360px!important;}}
    `;
    document.head.appendChild(st);
  }
  function hideDuplicateMaps(){
    installStyle();
    ['vesco-route-map-panel-v6','vesco-route-info-panel-v6','vesco-route-map-panel-v5','vesco-route-info-panel-v5'].forEach(id => {
      const el = document.getElementById(id);
      if(el) {
        el.setAttribute('aria-hidden','true');
        el.dataset.vescoHiddenDuplicateMap = '1';
      }
    });
  }

  function allOrders(){
    const pool = [];
    try { if(Array.isArray(orders)) pool.push(...orders); } catch(e) {}
    try { if(Array.isArray(flexOrders)) pool.push(...flexOrders); } catch(e) {}
    if(Array.isArray(window.orders)) pool.push(...window.orders);
    if(Array.isArray(window.flexOrders)) pool.push(...window.flexOrders);
    const seen = new Set();
    return pool.filter(o => {
      if(!o) return false;
      const k = String(o.id || o.numero || o.pedido || Math.random());
      if(seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function orderKeys(o){
    if(!o) return [];
    const vals = [o.id,o.numero,o.pedido,o.order_id,o.orderNumber,o.reference,o.referencia,o.numero_ecommerce,o.numero_ecom,o.codigo_externo,o.codigo];
    const keys = [];
    vals.forEach(v => {
      if(v === undefined || v === null || String(v).trim() === '') return;
      const raw = String(v).trim();
      keys.push(raw, norm(raw), raw.replace(/\D/g,''));
    });
    return Array.from(new Set(keys.filter(Boolean)));
  }
  function findOrder(id){
    const raw = String(id || '').trim();
    const n = norm(raw);
    const dig = raw.replace(/\D/g,'');
    return allOrders().find(o => {
      const keys = orderKeys(o);
      return keys.includes(raw) || keys.includes(n) || (dig && keys.includes(dig));
    }) || null;
  }
  function orderAddress(o){ return clean(o && (o.endereco_completo || o.endereco || o.address || o.full_address || o.logradouro || '')); }
  function orderClient(o){
    try { return extractClientNameFromAny(o) || o.cliente_nome || o.cliente || o.destinatario || o.nome || ''; }
    catch(e){ return o && (o.cliente_nome || o.cliente || o.destinatario || o.nome) || ''; }
  }
  function directCoords(o){
    try {
      const c = typeof getCoords === 'function' ? getCoords(o) : null;
      if(c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon))) return {lat:Number(c.lat), lon:Number(c.lon)};
    } catch(e) {}
    return null;
  }
  function markerCoords(key){
    try {
      const m = (typeof findMainMarkerByKey === 'function' && findMainMarkerByKey(key)) || (typeof findFlexMarkerByKey === 'function' && findFlexMarkerByKey(key));
      if(m && typeof m.getLatLng === 'function') {
        const ll = m.getLatLng();
        if(ll && Number.isFinite(Number(ll.lat)) && Number.isFinite(Number(ll.lng))) return {lat:Number(ll.lat), lon:Number(ll.lng)};
      }
    } catch(e) {}
    return null;
  }

  function looksLikeAddress(v){
    const s = clean(v).toLowerCase();
    if(!s) return false;
    if(/^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(s)) return true;
    const hasStreet = /(rua|r\.|avenida|av\.|alameda|travessa|estrada|rodovia|pra[cç]a|largo|via)\b/.test(s);
    const hasNumber = /\b\d{1,6}[a-z]?\b/.test(s);
    const hasCity = /(s[aã]o paulo|sp|barueri|osasco|guarulhos|santo andr[eé]|cotia|diadema|tabo[aã]o|carapicu[ií]ba|mau[aá]|s[aã]o bernardo|emb[uú])/.test(s);
    return (hasStreet && hasNumber) || (hasStreet && hasCity) || (hasNumber && hasCity);
  }
  function parseCoordText(addr){
    const m = clean(addr).match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
    return m ? {lat:Number(m[1]), lon:Number(m[2])} : null;
  }
  function routeRoot(){
    const selectors = ['#view-saiu:not(.hidden)', '#view-rotas:not(.hidden)', '#view-pronto-envio:not(.hidden)', '#view-pronto_envio:not(.hidden)', '#view-pronto_para_envio:not(.hidden)', '#view-saiu', '#view-rotas'];
    for(const sel of selectors){ const el = document.querySelector(sel); if(el) return el; }
    return document.body;
  }
  function ensureOriginField(){
    let input = document.getElementById('vesco-rota-origem-v6') || document.getElementById('vesco-rota-origem-v12') || document.getElementById('rotaOrigem') || document.getElementById('pontoPartidaRota');
    if(input) return input;
    const root = routeRoot();
    const saved = localStorage.getItem(ORIGIN_KEY) || '';
    const wrap = document.createElement('div');
    wrap.className = 'vesco-rota-origem-v13 mb-3';
    wrap.innerHTML = `<label class="block text-xs font-black text-slate-700 mb-1">Ponto de partida da rota</label><input id="vesco-rota-origem-v13" type="text" value="${esc(saved)}" placeholder="Ex: Rua Conselheiro Dantas, 141 - Brás, São Paulo - SP" class="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm outline-none focus:border-blue-500 w-full"/><div class="text-[10px] text-slate-400 mt-1">Use endereço real. Nome da rota não é ponto de partida.</div>`;
    const anchor = root.querySelector('#rotaMotorista,#motoristaRota,#routeDriver,#rotaNome,#nomeRota,#saiu-pedidos-list') || root.firstElementChild;
    if(anchor && anchor.parentElement) anchor.parentElement.insertBefore(wrap, anchor.nextSibling);
    else root.prepend(wrap);
    input = wrap.querySelector('input');
    input.addEventListener('input', () => localStorage.setItem(ORIGIN_KEY, clean(input.value)));
    return input;
  }
  function getOrigin(){
    const input = ensureOriginField();
    const val = clean((input && input.value) || localStorage.getItem(ORIGIN_KEY) || '');
    if(val) localStorage.setItem(ORIGIN_KEY, val);
    return val;
  }
  function ensureMapPanel(){
    hideDuplicateMaps();
    let panel = document.getElementById('vesco-route-panel-v12');
    if(!panel){
      panel = document.createElement('div');
      panel.id = 'vesco-route-panel-v12';
      panel.innerHTML = `<div id="vesco-route-info-v12"><div class="font-black text-blue-800 mb-1"><i class="fas fa-route mr-1"></i>Planejamento da rota</div><div class="text-slate-600">Informe um endereço real de partida, selecione os pedidos e trace a rota.</div></div><div class="flex items-center justify-between mb-2"><div class="text-[11px] font-black text-slate-500 uppercase">Mapa da rota</div><div class="text-[10px] font-bold text-blue-600 uppercase">Partida + entregas</div></div><div id="vesco-route-map-v12"></div>`;
      const right = document.getElementById('vesco-saiu-right-v6');
      if(right) right.appendChild(panel);
      else routeRoot().appendChild(panel);
    }
    return panel;
  }
  function ensureMap(){
    ensureMapPanel();
    if(typeof L === 'undefined') return null;
    const el = document.getElementById('vesco-route-map-v12');
    if(!el) return null;
    let existing = null;
    try {
      if(window.vescoRoutesV12 && typeof window.vescoRoutesV12.ensureRouteMap === 'function' && !window.__vescoV13CallingEnsure) {
        window.__vescoV13CallingEnsure = true;
        existing = window.vescoRoutesV12.ensureRouteMap();
        window.__vescoV13CallingEnsure = false;
      }
    } catch(e){ window.__vescoV13CallingEnsure = false; }
    if(existing && existing._container === el){ setTimeout(() => existing.invalidateSize && existing.invalidateSize(true), 80); return existing; }
    try {
      if(el._leaflet_id){ el.innerHTML = ''; try { delete el._leaflet_id; } catch(e){ el._leaflet_id = undefined; } }
      const m = L.map(el).setView(DEFAULT_CENTER, 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(m);
      setTimeout(() => m.invalidateSize(true), 150);
      return m;
    } catch(e){ warn('V13: erro ao iniciar mapa único:', e); return null; }
  }
  function clearMapLayers(m){
    if(!m || typeof L === 'undefined') return;
    try { if(routeLayerV13 && typeof routeLayerV13.remove === 'function') routeLayerV13.remove(); } catch(e) {}
    try {
      m.eachLayer(layer => {
        if(layer instanceof L.TileLayer) return;
        m.removeLayer(layer);
      });
    } catch(e) {}
    routeLayerV13 = L.layerGroup().addTo(m);
  }

  async function geocode(addr){
    addr = clean(addr);
    if(!addr) return null;
    const direct = parseCoordText(addr);
    if(direct) return direct;
    if(!looksLikeAddress(addr)) return null;
    const cache = readJSON(GEO_CACHE_KEY, {});
    const key = addr.toLowerCase();
    if(cache[key] && Number.isFinite(Number(cache[key].lat)) && Number.isFinite(Number(cache[key].lon))) return cache[key];
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 3500) : null;
      const q = encodeURIComponent(addr.includes('Brasil') ? addr : `${addr}, Brasil`);
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=0`, { headers:{'Accept-Language':'pt-BR'}, signal: controller ? controller.signal : undefined });
      if(timer) clearTimeout(timer);
      const js = await res.json();
      if(Array.isArray(js) && js[0]){
        const out = {lat:Number(js[0].lat), lon:Number(js[0].lon)};
        if(Number.isFinite(out.lat) && Number.isFinite(out.lon)){ cache[key]=out; writeJSON(GEO_CACHE_KEY, cache); return out; }
      }
    } catch(e) {}
    return null;
  }
  function selectedPedidos(){
    const selectors = ['#saiu-pedidos-list input[type="checkbox"]:checked','#view-saiu input[type="checkbox"]:checked','#view-rotas input[type="checkbox"]:checked','#view-pronto-envio input[type="checkbox"]:checked','[data-route-order]:checked','[data-num][type="checkbox"]:checked','[data-ecom][type="checkbox"]:checked'];
    const inputs = Array.from(new Set(selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)))));
    const out = [];
    inputs.forEach(cb => {
      let val = cb.getAttribute('data-num') || cb.getAttribute('data-ecom') || cb.getAttribute('data-pedido') || cb.value || '';
      if(!val || val === 'on'){
        const row = cb.closest('tr') || cb.closest('.pedido-item') || cb.closest('[data-num]') || cb.parentElement;
        val = row && (row.getAttribute('data-num') || row.getAttribute('data-ecom') || row.getAttribute('data-pedido')) || '';
        if(!val && row){ const m = (row.innerText || '').match(/#\s*([0-9A-Za-z._-]{4,})/) || (row.innerText || '').match(/\b(\d{5,})\b/); if(m) val = m[1]; }
      }
      val = norm(val);
      if(val && !out.includes(val)) out.push(val);
    });
    return out;
  }
  function buildStops(pedidos, origin){
    const stops = [];
    origin = clean(origin || getOrigin());
    const originValid = looksLikeAddress(origin) || !!parseCoordText(origin);
    if(origin && originValid) stops.push({isOrigin:true, numero:'Partida', pedido:'__ORIGEM__', cliente:'Ponto de partida', endereco:origin});
    Array.from(new Set((pedidos || []).map(norm).filter(Boolean))).forEach(p => {
      const o = findOrder(p);
      const c = directCoords(o) || markerCoords(p) || markerCoords(o && (o.numero || o.id));
      stops.push({isOrigin:false, pedido:p, numero:(o && (o.numero || o.id)) || p, cliente:orderClient(o), endereco:orderAddress(o), lat:c ? c.lat : null, lon:c ? c.lon : null});
    });
    return stops;
  }
  async function resolveStop(s){
    if(s && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon))) return {lat:Number(s.lat), lon:Number(s.lon)};
    if(!s.isOrigin){
      const c = markerCoords(s.numero || s.pedido) || directCoords(findOrder(s.numero || s.pedido));
      if(c) return c;
    }
    const g = await geocode(s.endereco);
    if(g){ s.lat = g.lat; s.lon = g.lon; }
    return g;
  }
  function mapsUrl(stops){
    const valid = (stops || []).filter(s => clean(s.endereco) || (Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon))));
    if(!valid.length) return '';
    const enc = s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)) ? `${Number(s.lat)},${Number(s.lon)}` : clean(s.endereco);
    if(valid.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enc(valid[0]))}`;
    const limited = valid.slice(0,25);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(enc(limited[0]))}&destination=${encodeURIComponent(enc(limited[limited.length-1]))}&travelmode=driving`;
    const way = limited.slice(1,-1).map(enc).filter(Boolean);
    if(way.length) url += `&waypoints=${encodeURIComponent(way.join('|'))}`;
    return url;
  }
  function routeById(id){ return (window.saiuRotas || readJSON(ROUTES_KEY, []) || []).find(r => String(r.id) === String(id)); }
  function latestRoute(){
    const routes = Array.isArray(window.saiuRotas) ? window.saiuRotas : readJSON(ROUTES_KEY, []);
    if(!routes || !routes.length) return null;
    return routes.slice().sort((a,b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')))[0];
  }
  function renderInfo(route, stops, resolved, warning){
    ensureMapPanel();
    const info = document.getElementById('vesco-route-info-v12');
    if(!info) return;
    const deliveries = stops.filter(s => !s.isOrigin);
    const url = mapsUrl(stops);
    info.innerHTML = `<div class="font-black text-blue-800 mb-2"><i class="fas fa-route mr-1"></i>Rota montada: ${esc(route.nome || 'Prévia da rota')}</div><div class="mb-1"><b>Partida:</b> ${esc((stops.find(s => s.isOrigin) || {}).endereco || '—')}</div><div class="mb-1"><b>Motorista:</b> ${esc(route.motorista || '—')} • <b>Pedidos:</b> ${deliveries.length}</div><div class="mb-2 text-blue-700 font-bold">${resolved}/${stops.length} ponto(s) carregado(s) no mapa.</div>${warning ? `<div class="vesco-v13-warning">${esc(warning)}</div>` : ''}<div class="max-h-40 overflow-auto bg-white/70 border border-blue-100 rounded-lg p-2 mb-2 mt-2">${stops.map((s,i) => `<div class="mb-1"><b>${s.isOrigin ? 'Partida' : (i + '. #' + esc(s.numero || s.pedido))}</b> — ${esc(s.endereco || 'Endereço não localizado')}</div>`).join('')}</div>${url ? `<button type="button" onclick="window.open('${esc(url)}','_blank')" class="inline-flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold"><i class="fas fa-map-marked-alt"></i>Abrir rota no Google Maps</button>` : ''}`;
  }
  async function drawRoute(routeOrId, opts={}){
    hideDuplicateMaps();
    let route = typeof routeOrId === 'string' ? routeById(routeOrId) : routeOrId;
    if(!route){
      route = {id:'preview-v13', nome:'Prévia da rota', motorista:'—', pedidos:selectedPedidos(), origem:getOrigin(), criadoEm:new Date().toISOString()};
    }
    route.pedidos = route.pedidos || [];
    const rawOrigin = clean(route.origem || getOrigin());
    let warning = '';
    if(rawOrigin && !looksLikeAddress(rawOrigin) && !parseCoordText(rawOrigin)) warning = 'O ponto de partida parece ser nome de rota, não endereço. Ele foi ignorado no mapa. Use rua/avenida + número + cidade.';
    if(!rawOrigin) warning = 'Informe o ponto de partida para montar a rota completa.';
    const originForStops = warning && rawOrigin && !looksLikeAddress(rawOrigin) ? '' : rawOrigin;
    const stops = buildStops(route.pedidos, originForStops);
    route.paradas = stops;
    const sig = JSON.stringify({id:route.id, pedidos:route.pedidos, origin:originForStops, force:!!opts.force});
    if(!opts.force && sig === lastDrawSigV13) return mapsUrl(stops);
    lastDrawSigV13 = sig;
    const m = ensureMap();
    renderInfo(route, stops, 0, warning);
    if(!m || typeof L === 'undefined') return mapsUrl(stops);
    clearMapLayers(m);
    const latlngs = [];
    for(let i=0; i<stops.length; i++){
      const s = stops[i];
      const coords = await resolveStop(s);
      if(!coords) continue;
      const ll = [coords.lat, coords.lon];
      latlngs.push(ll);
      try {
        const label = s.isOrigin ? 'P' : String(i);
        const color = s.isOrigin ? '#111827' : '#2563eb';
        const icon = L.divIcon({html:`<div style="width:30px;height:30px;border-radius:999px;background:${color};color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.25)">${label}</div>`, className:'', iconSize:[30,30], iconAnchor:[15,15]});
        L.marker(ll,{icon}).addTo(routeLayerV13).bindPopup(`<b>${s.isOrigin ? 'Partida' : ('Pedido #' + esc(s.numero || s.pedido))}</b><br>${esc(s.cliente || '')}<br><small>${esc(s.endereco || '')}</small>`);
      } catch(e) {}
    }
    if(latlngs.length > 1){ try { L.polyline(latlngs, {weight:5, opacity:.9}).addTo(routeLayerV13); } catch(e) {} }
    try {
      if(latlngs.length === 1) m.setView(latlngs[0], 15);
      else if(latlngs.length > 1) m.fitBounds(L.latLngBounds(latlngs).pad(0.18), {maxZoom:15});
      else m.setView(DEFAULT_CENTER, 11);
      setTimeout(() => m.invalidateSize(true), 120);
      setTimeout(() => m.invalidateSize(true), 650);
    } catch(e) {}
    renderInfo(route, stops, latlngs.length, warning);
    return mapsUrl(stops);
  }
  function renderLatest(force=false){
    if(!routeViewActive()) return;
    setTimeout(() => {
      hideDuplicateMaps();
      ensureOriginField();
      drawRoute(latestRoute() || {id:'preview-v13', nome:'Prévia da rota', motorista:'—', pedidos:selectedPedidos(), origem:getOrigin()}, {force});
    }, 180);
  }

  // Bloqueio final contra geocodificação em massa quando a aba visível não é Logística/Flex.
  try {
    const oldPlot = window.plotMapMarkers || (typeof plotMapMarkers === 'function' ? plotMapMarkers : null);
    if(oldPlot && !window.__vescoPlotMapMarkersV13Wrapped){
      window.__vescoPlotMapMarkersV13Wrapped = true;
      window.plotMapMarkers = plotMapMarkers = function(orderList, flexList){
        if(!logisticalMapActive()) {
          try { if(Array.isArray(window.geocodeQueue)) window.geocodeQueue.length = 0; } catch(e) {}
          try { if(typeof geocodeQueue !== 'undefined' && Array.isArray(geocodeQueue)) geocodeQueue.length = 0; } catch(e) {}
          return;
        }
        return oldPlot.apply(this, arguments);
      };
    }
  } catch(e) {}

  function injectPendencia(){
    const tbody = document.getElementById('table-entregues');
    if(!tbody) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(row => {
      if(/nenhum despacho|nenhum registro/i.test(row.innerText || '')) return;
      if(row.querySelector('.vesco-entregue-pendencia-btn-v13')) return;
      const m = (row.innerText || '').match(/#\s*([0-9A-Za-z._-]+)/) || (row.innerText || '').match(/\b(\d{5,})\b/);
      if(!m) return;
      const numero = m[1];
      const o = findOrder(numero);
      const id = (o && (o.id || o.numero)) || numero;
      const target = row.querySelector('td:last-child') || row.lastElementChild;
      if(!target) return;
      const existingFinalizado = target.querySelector('.vesco-entregue-pendencia-btn-v13');
      if(existingFinalizado) return;
      const wrap = document.createElement('div');
      wrap.className = 'mt-2 flex justify-center';
      wrap.innerHTML = `<button type="button" class="vesco-entregue-pendencia-btn-v13 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="window.vescoPendenciaEntregaV13 && window.vescoPendenciaEntregaV13('${esc(id)}')"><i class="fas fa-triangle-exclamation mr-1"></i>Pendência</button>`;
      target.appendChild(wrap);
    });
  }
  window.vescoPendenciaEntregaV13 = function(id){
    if(!id) return;
    try { if(typeof window.moverParaPendenciaPrompt === 'function') return window.moverParaPendenciaPrompt(id); } catch(e) {}
    const motivo = prompt(`Informe a pendência do pedido #${id}:`);
    if(!motivo) return;
    try { if(typeof updateStatusJsonp === 'function') updateStatusJsonp(id, 'Pendente', `[Pós-entrega] ${motivo}`); } catch(e) {}
    toast('Pendência registrada para o pedido entregue.', 'warning');
  };

  window.verRotaMapa = function(rotaId){ return drawRoute(rotaId, {force:true}); };
  window.vescoOpenRouteInGoogle = function(rotaId){
    const route = routeById(rotaId) || latestRoute();
    const stops = route ? buildStops(route.pedidos || [], route.origem || getOrigin()) : buildStops(selectedPedidos(), getOrigin());
    const url = mapsUrl(stops);
    if(url) window.open(url, '_blank');
    else toast('Nenhuma rota disponível para abrir.', 'warning');
  };
  if(window.vescoRoutesV12){
    window.vescoRoutesV12.drawRoute = drawRoute;
    window.vescoRoutesV12.ensureRouteMap = ensureMap;
    window.vescoRoutesV12.ensureOriginField = ensureOriginField;
    window.vescoRoutesV12.getOrigin = getOrigin;
    window.vescoRoutesV12.injectPendenciaButtons = injectPendencia;
    window.vescoRoutesV12.buildStops = buildStops;
  }
  if(window.vescoRoutesV6){
    window.vescoRoutesV6.drawRouteOnMap = drawRoute;
    window.vescoRoutesV6.ensureRouteMap = ensureMap;
    window.vescoRoutesV6.getRouteOrigin = getOrigin;
    window.vescoRoutesV6.buildStops = buildStops;
  }

  const oldRender = window.render || (typeof render === 'function' ? render : null);
  if(oldRender && !window.__vescoRenderV13Wrapped){
    window.__vescoRenderV13Wrapped = true;
    window.render = render = function(){
      const ret = oldRender.apply(this, arguments);
      setTimeout(hideDuplicateMaps, 80);
      setTimeout(injectPendencia, 180);
      setTimeout(() => renderLatest(false), 260);
      return ret;
    };
  }
  const oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function' && !window.__vescoSwitchV13Wrapped){
    window.__vescoSwitchV13Wrapped = true;
    window.switchTab = function(which){
      const ret = oldSwitch.apply(this, arguments);
      setTimeout(hideDuplicateMaps, 80);
      setTimeout(injectPendencia, 180);
      if(['saiu','rotas','pronto_envio','pronto_para_envio','prontoParaEnvio','envio'].includes(which)) renderLatest(true);
      return ret;
    };
  }
  document.addEventListener('click', function(e){
    const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if(!btn) return;
    const txt = `${btn.textContent || ''} ${btn.value || ''} ${btn.id || ''}`.toLowerCase();
    if(/tra[cç]ar\s+(rota|no mapa)|google\s*maps|ver\s+no\s+mapa|criar\s+rota/.test(txt)) {
      setTimeout(hideDuplicateMaps, 80);
      setTimeout(() => renderLatest(true), /criar\s+rota/.test(txt) ? 900 : 180);
    }
  }, false);

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){
      hideDuplicateMaps();
      ensureOriginField();
      setTimeout(injectPendencia, 800);
      setTimeout(() => renderLatest(true), 1000);
    });
  } else {
    hideDuplicateMaps();
    ensureOriginField();
    setTimeout(injectPendencia, 600);
    setTimeout(() => renderLatest(true), 900);
  }
  let cycles = 0;
  const timer = setInterval(() => {
    cycles++;
    hideDuplicateMaps();
    injectPendencia();
    if(routeViewActive()) renderLatest(false);
    if(cycles >= 8) clearInterval(timer);
  }, 900);

  window.vescoRoutesV13 = { drawRoute, ensureMap, hideDuplicateMaps, injectPendencia, getOrigin, looksLikeAddress, buildStops, findOrder, selectedPedidos };
  log('Rotas/Pendências V13 ativo — mapa único, origem inválida ignorada e Pendência garantida em Entregues.');
})();

// =================================================================

// ============================================================================
// VESCO MODULAR BRIDGE V2 — estado legado acessível aos módulos separados.
// Remove dependência das antigas camadas V14+ e adiciona fallbacks seguros.
// ============================================================================
(function installVescoModularBridgeV2(){
  if (window.__vescoModularBridgeV2) return;
  window.__vescoModularBridgeV2 = true;

  if (typeof window.sendDriverNotification !== 'function') {
    window.sendDriverNotification = function(order){
      return Promise.resolve({ success:true, skipped:true, reason:'sendDriverNotification não configurado', order: order && (order.id || order.numero) });
    };
    try { if (typeof sendDriverNotification === 'undefined') sendDriverNotification = window.sendDriverNotification; } catch(e) {}
  }

  if (typeof window.checkTimeAlarms !== 'function') {
    window.checkTimeAlarms = function(){ return null; };
  }

  window.VescoLegacy = {
    getOrders: function(){ try { return orders || []; } catch(e) { return window.orders || []; } },
    getFlexOrders: function(){ try { return flexOrders || []; } catch(e) { return window.flexOrders || []; } },
    getOperator: function(){ try { return currentOperator || ''; } catch(e) { return localStorage.getItem('vesco_operator') || ''; } },
    setOrders: function(v){ try { orders = Array.isArray(v) ? v : []; window.orders = orders; } catch(e) { window.orders = Array.isArray(v) ? v : []; } },
    setFlexOrders: function(v){ try { flexOrders = Array.isArray(v) ? v : []; window.flexOrders = flexOrders; } catch(e) { window.flexOrders = Array.isArray(v) ? v : []; } },
    refreshState: function(){ try { if (typeof syncGlobalOrderState === 'function') syncGlobalOrderState(); } catch(e) {} }
  };

  const oldScheduleRender = window.scheduleRender;
  if (typeof oldScheduleRender === 'function' && !window.__vescoModularScheduleWrappedV2) {
    window.__vescoModularScheduleWrappedV2 = true;
    window.scheduleRender = function(){
      const res = oldScheduleRender.apply(this, arguments);
      setTimeout(() => window.dispatchEvent(new CustomEvent('vesco:rendered')), 120);
      setTimeout(() => window.dispatchEvent(new CustomEvent('vesco:rendered')), 650);
      return res;
    };
    try { scheduleRender = window.scheduleRender; } catch(e) {}
  }

  const oldLoad = window.load;
  if (typeof oldLoad === 'function' && !window.__vescoModularLoadWrappedV2) {
    window.__vescoModularLoadWrappedV2 = true;
    window.load = function(){
      const res = oldLoad.apply(this, arguments);
      setTimeout(() => window.dispatchEvent(new CustomEvent('vesco:loaded')), 500);
      setTimeout(() => window.dispatchEvent(new CustomEvent('vesco:loaded')), 1600);
      return res;
    };
    try { load = window.load; } catch(e) {}
  }

  window.addEventListener('vesco:module-refresh', function(){
    try { window.VescoLegacy.refreshState(); } catch(e) {}
  });

  console.log('Vesco Modular Bridge V2 ativo — legado enxuto e módulos separados.');
})();
