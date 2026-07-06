/**
 * VESCO LOGÍSTICA & PROPOSTAS - VERSÃO 9.2 (SINCRO AUTOMÁTICA DE 30 EM 30 MINUTOS)
 * ATUALIZAÇÃO: Adicionadas camadas de geocodificação resiliente, cache, retry, quota monitor e fallback.
 */

const CONFIG = {
  TINY_TOKEN: '4ff11dd0bf1551085d3a9b75b794fc36436f5af56d9abade56a28a7306e92b17',
  URL_PESQUISA: 'https://api.tiny.com.br/api2/pedidos.pesquisa.php',
  URL_OBTER: 'https://api.tiny.com.br/api2/pedido.obter.php',
  SHEET_NAME: 'Pedidos',
  PROPOSALS_SHEET: 'Propostas',
  DIAS: 7
};

// ATUALIZADO: Adicionado 'lat' e 'lon' no encerramento do cabeçalho
const CABECALHO = [
  'id','numero','data_pedido','data_prevista',
  'cliente_nome','situacao_tiny','valor',
  'endereco_completo','forma_pagamento','instrucao_entrega',
  'status_logistica','observacao_logistica', 'alarme', 'tempo_separacao', 'tipo_entrega',
  'lat', 'lon'
];

/* ---------------------------------------------------------
   FUNÇÕES ORIGINAIS (preservadas) e pontos de extensão
   --------------------------------------------------------- */

/**
 * Função original mantida: buscarCoordenadas_
 * Implementação atualizada abaixo como wrapper chamando a versão aprimorada.
 */
function buscarCoordenadas_(endereco) {
  // Wrapper: chama a versão aprimorada mantendo assinatura original
  return buscarCoordenadasAprimorada_(endereco);
}

/* ---------------------------------------------------------
   NOVAS CAMADAS: Cache, Retry, Quota Monitor, Fallback
   --------------------------------------------------------- */

// NOVO: Sistema de cache para coordenadas (CacheService)
const CoordenadasCache_ = {
  cache: CacheService.getScriptCache(),
  prefix: "geo_",
  
  _keyFor: function(endereco) {
    try {
      const digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, endereco || '');
      return this.prefix + digestBytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
    } catch(e) {
      return this.prefix + encodeURIComponent(endereco || '').substring(0, 200);
    }
  },
  
  get: function(endereco) {
    try {
      const key = this._keyFor(endereco);
      const cached = this.cache.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch(e) {}
    return null;
  },
  
  set: function(endereco, coords) {
    try {
      const key = this._keyFor(endereco);
      this.cache.put(key, JSON.stringify(coords), 86400); // 24 horas
    } catch(e) {}
  }
};

// NOVO: Sistema de retry com backoff exponencial (usa Maps.newGeocoder internamente)
function geocodeComRetry_(endereco, maxTentativas = 3) {
  let tentativa = 0;
  let delay = 1000; // 1 segundo inicial

  while (tentativa < maxTentativas) {
    try {
      // Verifica cache primeiro
      const cached = CoordenadasCache_.get(endereco);
      if (cached) {
        return cached;
      }
      
      // Tenta geocodificação usando Maps Service
      const response = Maps.newGeocoder().geocode(endereco);
      if (response && response.status === 'OK' && response.results && response.results.length > 0) {
        const loc = response.results[0].geometry.location;
        const coords = { lat: loc.lat, lon: loc.lng };
        CoordenadasCache_.set(endereco, coords);
        return coords;
      }
      
      // Se não encontrar resultados, retorna ZERO_RESULTS (sem retry)
      if (response && response.status === 'ZERO_RESULTS') {
        return { lat: '', lon: '' };
      }
    } catch(e) {
      // Log leve para diagnóstico (não impede fluxo)
      console.warn('geocodeComRetry_ tentativa', tentativa + 1, 'falhou:', e && e.message ? e.message : e);
    }

    tentativa++;
    if (tentativa < maxTentativas) {
      Utilities.sleep(delay);
      delay *= 2; // backoff exponencial
    }
  }

  // Todas as tentativas falharam
  return { lat: '', lon: '' };
}

// NOVO: Função de fallback baseada em CEPs / cidades conhecidas
function fallbackCoordenadas_(endereco) {
  try {
    // Tenta extrair CEP no formato 00000-000 ou 00000000
    const cepMatch = endereco ? endereco.match(/(\d{5}-\d{3})|(\d{8})/) : null;
    if (cepMatch) {
      const cepFull = cepMatch[0].replace('-', '');
      const cepBase = cepFull.substring(0,5);
      const cepCoords = {
        '04543': { lat: -23.5950, lon: -46.6850 }, // exemplo: Vila Olímpia
        '01414': { lat: -23.5590, lon: -46.6630 }, // Higienópolis
        '04006': { lat: -23.5750, lon: -46.6300 }, // Paraíso
        '04107': { lat: -23.6150, lon: -46.6400 }, // Saúde
        '04037': { lat: -23.5850, lon: -46.6450 }  // Vila Mariana
      };
      if (cepCoords[cepBase]) return cepCoords[cepBase];
    }

    // Tenta identificar cidade no endereço (simplificado)
    const cityMatch = endereco ? endereco.match(/,\s*([^,]+?)\s*-\s*[A-Z]{2}/) : null;
    if (cityMatch) {
      const city = cityMatch[1].trim().toLowerCase();
      if (city.includes('são paulo') || city.includes('sao paulo')) return { lat: -23.550520, lon: -46.633308 };
      if (city.includes('rio de janeiro') || city.includes('rio')) return { lat: -22.906847, lon: -43.172896 };
    }
  } catch(e) {
    // ignore
  }
  // Default fallback: centro de São Paulo
  return { lat: -23.550520, lon: -46.633308 };
}

// NOVO: Monitor de Quota simples usando Script Properties
const QuotaMonitor_ = {
  propertyStore: PropertiesService.getScriptProperties(),
  keyPrefix: "maps_quota_",
  dailyLimit: 2500, // ajuste conforme necessário, valor conservador

  _todayKey: function() {
    return this.keyPrefix + new Date().toISOString().split('T')[0];
  },

  checkQuota: function() {
    try {
      const key = this._todayKey();
      const count = parseInt(this.propertyStore.getProperty(key) || "0", 10);
      return count < this.dailyLimit;
    } catch(e) {
      return true; // se falhar na verificação, permita (não bloquear)
    }
  },

  incrementQuota: function() {
    try {
      const key = this._todayKey();
      const count = parseInt(this.propertyStore.getProperty(key) || "0", 10);
      this.propertyStore.setProperty(key, String(count + 1));
    } catch(e) {}
  }
};

// NOVO: Geocodificação com monitoramento de quota, cache e retry
function geocodeComQuota_(endereco) {
  // Se indisponível ou endereço inválido, retorna vazio rapidamente
  if (!endereco || endereco === "Endereço não disponível") return { lat: '', lon: '' };

  // Verifica cache primeiro
  const cached = CoordenadasCache_.get(endereco);
  if (cached) return cached;

  // Se quota aparentemente esgotada, usa fallback
  if (!QuotaMonitor_.checkQuota()) {
    const fb = fallbackCoordenadas_(endereco);
    return fb;
  }

  // Incrementa quota e tenta geocodificar
  QuotaMonitor_.incrementQuota();
  const coords = geocodeComRetry_(endereco, 3);

  // Se geocodificação falhar (vazio), tenta fallback
  if ((!coords.lat && !coords.lon) || coords.lat === '' && coords.lon === '') {
    const fb = fallbackCoordenadas_(endereco);
    return fb;
  }

  return coords;
}

/* ---------------------------------------------------------
   Função aprimorada (nova) que engloba os mecanismos acima
   Mantém compatibilidade com assinatura original
   --------------------------------------------------------- */
function buscarCoordenadasAprimorada_(endereco) {
  try {
    if (!endereco || endereco === "Endereço não disponível") return { lat: '', lon: '' };
    // Normaliza endereço (remove pipe e barras problemáticas)
    const enderecoLimpo = endereco.split('|')[0].replace(/[\/]/g, '-').trim();
    try {
      // Principal: geocode com quota/cache/retry
      const coords = geocodeComQuota_(enderecoLimpo);
      return coords || { lat: '', lon: '' };
    } catch(e) {
      // Em caso de erro inesperado, tenta fallback
      return fallbackCoordenadas_(enderecoLimpo);
    }
  } catch(e) {
    return { lat: -23.550520, lon: -46.633308 };
  }
}

/* ---------------------------------------------------------
   FUNÇÕES EXISTENTES DO SISTEMA (mantidas)
   --------------------------------------------------------- */

function sincronizarPedidosRecentes() {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - CONFIG.DIAS);
  const dInicio = Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  let pagina = 1;
  let totalPaginas = 1;
  const todasLinhas = [];

  do {
    const payload = `token=${CONFIG.TINY_TOKEN}&formato=JSON&dataInicial=${dInicio}&dataFinal=${Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy')}&pagina=${pagina}`;
    const res = UrlFetchApp.fetch(CONFIG.URL_PESQUISA, { method: 'post', payload: payload, muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());
  
    if(!json.retorno || json.retorno.status !== 'OK' || !json.retorno.pedidos) break;
    totalPaginas = parseInt(json.retorno.numero_paginas || '1');
  
    json.retorno.pedidos.forEach(item => {
      const p = item.pedido;
      const situacao = (p.situacao || '').toUpperCase();
      const numEcom = (p.numero_ecommerce || '').toString().trim();

      if (numEcom === "" && situacao !== "CANCELADO") {
        const detalhe = obterDetalhePedido_(p.id);
        let enderecoFormatado = "Endereço não disponível";
        let formaPagamento = "Não informado";
        let instrucao = "⚠️ Verificar pagamento";
        let tipoEntrega = "Normal"; 
        let lat = "";
        let lon = "";
      
        if (detalhe) {
          const ent = detalhe.enderecoEntrega || {};
          const cli = detalhe.cliente || {};
          const rua = ent.endereco || cli.endereco || '';
          if (rua) enderecoFormatado = `${rua}, ${ent.numero || cli.numero || ''} - ${ent.bairro || cli.bairro || ''} | ${ent.cidade || cli.cidade || ''}-${ent.uf || cli.uf || ''}`;

          let fpag = [];
          if (detalhe.parcelas) {
            detalhe.parcelas.forEach(parc => {
               if(parc.parcela && parc.parcela.forma_pagamento) fpag.push(parc.parcela.forma_pagamento);
            });
          }
          if (fpag.length === 0 && detalhe.forma_pagamento) fpag.push(detalhe.forma_pagamento);
        
          formaPagamento = fpag.filter(Boolean).join(' + ') || "Não informado";
          instrucao = gerarInstrucao_(formaPagamento, p.valor || detalhe.totalPedido || 0);
        
          const obs = (detalhe.observacoes || '').toLowerCase();
          if (obs.includes('emergencial')) {
            tipoEntrega = 'Emergencial';
          } else if (obs.includes('retirada')) {
            tipoEntrega = 'Retirada';
          }

          // Processa a geocodificação em tempo real se o endereço existir
          if (enderecoFormatado !== "Endereço não disponível") {
            const coords = buscarCoordenadas_(enderecoFormatado);
            lat = coords.lat || "";
            lon = coords.lon || "";
          }
        }

        // Injetado lat e lon no final da array de dados da linha
        todasLinhas.push([
           p.id || '', p.numero || '', p.data_pedido || '', p.data_prevista || '', 
           p.nome || '', p.situacao || '', p.valor || 0, enderecoFormatado, 
           formaPagamento, instrucao, 'A Separar', '', '', '', tipoEntrega,
           lat, lon
        ]);
        Utilities.sleep(150);
      }
    });
    pagina++;
  } while(pagina <= totalPaginas);

  gravarNaPlanilha_(todasLinhas);
}

function gerarInstrucao_(formaPagamento, valor) {
  const fp = (formaPagamento || '').toString().toUpperCase();
  const valorFmt = 'R$ ' + parseFloat(valor || 0).toFixed(2).replace('.', ',');
  if (fp.includes('CARTÃO') || fp.includes('CARTAO')) return `💳 MAQUININHA — ${valorFmt}`;
  if (fp.includes('DINHEIRO')) return `💵 DINHEIRO — TROCO PARA ${valorFmt}`;
  if (fp.includes('BOLETO') || fp.includes('PIX') || fp.includes('LINK')) return `✅ JÁ PAGO`;
  return `⚠️ CONFERIR: ${formaPagamento} — ${valorFmt}`;
}

function obterDetalhePedido_(id) {
  try {
    const payload = `token=${CONFIG.TINY_TOKEN}&formato=JSON&id=${id}`;
    const res = UrlFetchApp.fetch(CONFIG.URL_OBTER, { method: 'post', payload: payload, muteHttpExceptions: true });
    return JSON.parse(res.getContentText()).retorno.pedido;
  } catch (e) { return null; }
}

function gravarNaPlanilha_(linhas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  const statusAntigos = {}, obsAntigos = {}, alarmesAntigos = {}, temposAntigos = {}, tiposAntigos = {};
  const dataPlanilha = sheet.getDataRange().getValues();

  if (dataPlanilha.length > 1) {
    for (let i = 1; i < dataPlanilha.length; i++) {
        const id = dataPlanilha[i][0].toString();
        statusAntigos[id] = dataPlanilha[i][10]; 
        obsAntigos[id] = dataPlanilha[i][11];
        alarmesAntigos[id] = dataPlanilha[i][12]; 
        temposAntigos[id] = dataPlanilha[i][13]; 
        tiposAntigos[id] = dataPlanilha[i][14]; 
    }
  }

  sheet.clear();
  sheet.getRange(1, 1, 1, CABECALHO.length).setValues([CABECALHO]).setFontWeight('bold').setBackground('#004f9f').setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  if(linhas.length > 0) {
    const linesProcessed = linhas.map(lin => {
      const id = lin[0].toString();
      if(statusAntigos[id]) lin[10] = statusAntigos[id];
      if(obsAntigos[id]) lin[11] = obsAntigos[id];
      if(alarmesAntigos[id]) lin[12] = alarmesAntigos[id];
      if(temposAntigos[id]) lin[13] = temposAntigos[id];
      if(tiposAntigos[id]) lin[14] = tiposAntigos[id];
      return lin;
    });
    sheet.getRange(2, 1, linesProcessed.length, CABECALHO.length).setValues(linesProcessed);
  }
  sheet.autoResizeColumns(1, CABECALHO.length);
}

function garantirAbaSeparacao_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Separacao');
  if (!sh) {
    sh = ss.insertSheet('Separacao');
    const headers = ['id','numero','cliente_nome','endereco_completo','data_prevista','status','operador','ts_inicio'];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#004f9f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function upsertSeparacaoRow_(orderObj, operador, status) {
  try {
    const sh = garantirAbaSeparacao_();
    const data = sh.getDataRange().getValues();
    let found = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(orderObj.id)) { found = i + 1; break; }
    }
    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  
    if (found > 0) {
      sh.getRange(found, 6, 1, 2).setValues([[status, operador]]);
    } else {
      sh.appendRow([orderObj.id, orderObj.numero, orderObj.cliente_nome, orderObj.endereco_completo, orderObj.data_prevista, status, operador, ts]);
    }
  } catch (e) {}
}

function calcularTempoEletivoSe_(id) {
  try {
    const sh = garantirAbaSeparacao_();
    const data = sh.getAddressRange ? sh.getDataRange().getValues() : sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        const startTsStr = data[i][7];
        let diffStr = "—";
        if(startTsStr) {
          const start = new Date(startTsStr);
          const end = new Date();
          const diffMs = end - start;
          const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
          const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
          diffStr = `${diffHrs}h ${diffMins}m`;
        }
        sh.deleteRow(i + 1);
        return diffStr;
      }
    }
  } catch(e) {}
  return "—";
}
// NOVO: Adicione este bloco no INÍCIO da sua função doGet(e) existente no Apps Script
function doGet(e) {
  // CONFIGURAÇÃO DE CORS E ROTEAMENTO
  const action = e && e.parameter ? e.parameter.action : null;
  const callback = e && e.parameter ? e.parameter.callback : null;

  // NOVA LÓGICA DE GEOCODIFICAÇÃO (Interceptador)
  if (action === 'geocode') {
    const address = e.parameter.address;
    const coords = buscarCoordenadasAprimorada_(address); // Usa a função que criamos antes
    const result = { success: true, lat: coords.lat, lon: coords.lon };
    
    // Retorno compatível com JSONP para evitar 100% de erros de CORS
    if (callback) {
      return ContentService.createTextOutput(callback + "(" + JSON.stringify(result) + ");")
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // --- O RESTANTTE DO SEU doGet EXISTENTE COMEÇA AQUI ---
  // (Mantenha o código original de buscar pedidos, propostas, etc.)
  try {
     // ... seu código original ...
  } catch (err) {
     // ...
  }
}
function doGet(e) {
  try {
    const callback = e && e.parameter ? e.parameter.callback : null;
    const action = e && e.parameter ? e.parameter.action : null;
    const fusoHorario = Session.getScriptTimeZone();
    let resposta;

    if (action === 'updateStatus') {
      resposta = processarAtualizacaoStatus_(e.parameter.id, e.parameter.status, e.parameter.alarme, e.parameter.observacao, e.parameter.operador);
    } else {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
      const vals = sheet.getDataRange().getValues();
      const headers = vals[0];
      
      const outPedidos = vals.slice(1).map(row => {
        let o = {};
        headers.forEach((h, i) => {
          let val = row[i];
          
          // Tratamento para garantir Data Formatada e evitar anos absurdos no painel
          if ((h === 'data_prevista' || h === 'data_pedido') && val !== '') {
            if (val instanceof Date) {
              val = Utilities.formatDate(val, fusoHorario, "dd/MM/yyyy");
            } else {
              const d = new Date(val);
              if (!isNaN(d.getTime())) val = Utilities.formatDate(d, fusoHorario, "dd/MM/yyyy");
            }
          }
          o[h] = val;
        });
        
        // Ajustes finos para o painel de separação:
        o['ecom'] = ''; // Deixa vazio para remover o texto duplicado abaixo do número do pedido
        o['destinatario'] = o['cliente_nome']; 
        
        // Garante que a forma de envio/pagamento esteja populada pro painel
        o['forma_envio'] = o['forma_pagamento'] || o['tipo_entrega'] || '';
        
        return o;
      });

      let outPropostas = [];
      const sheetProp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PROPOSALS_SHEET);
      if (sheetProp) {
        const valsProp = sheetProp.getDataRange().getValues();
        const headersProp = valsProp[0];
        outPropostas = valsProp.slice(1).map(row => {
          let p = {};
          headersProp.forEach((h, i) => {
            const headClean = String(h).trim();
            if (['numero', 'cliente_nome', 'endereco_completo'].includes(headClean)) {
              p[headClean] = row[i];
            }
          });
          return p;
        });
      }

      resposta = { success: true, data: outPedidos, propostas: outPropostas };
    }

    if (callback) {
      return ContentService.createTextOutput(callback + "(" + JSON.stringify(resposta) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    } else {
      return ContentService.createTextOutput(JSON.stringify(resposta)).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function processarAtualizacaoStatus_(id, status, alarme, observacao, operador) {
  if (!id) return { success: false, error: 'missing_id' };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim());

  const statusCol = headers.indexOf('status_logistica') + 1;
  const alarmCol = headers.indexOf('alarme') + 1;
  const obsCol = headers.indexOf('observacao_logistica') + 1;
  const tempoCol = headers.indexOf('tempo_separacao') + 1;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toString() === id.toString()) {
      const pObj = {};
      headers.forEach((h, idx) => pObj[h] = data[i][idx]);

      if (status) {
        sheet.getRange(i + 1, statusCol).setValue(status);
        const checkStatus = status.toLowerCase();
      
        if (checkStatus === 'em separação' || checkStatus === 'em separacao') {
          upsertSeparacaoRow_(pObj, operador, 'Em Separação');
        } else if (checkStatus === 'pronto p/ entrega') {
          const duration = calcularTempoEletivoSe_(id);
          if (tempoCol > 0) sheet.getRange(i + 1, tempoCol).setValue(duration);
        } else if (checkStatus === 'a separar') {
          try {
            const sh = garantirAbaSeparacao_();
            const sData = sh.getDataRange().getValues();
            for(let k=1; k<sData.length; k++) {
              if(String(sData[k][0]) === String(id)) { sh.deleteRow(k+1); break; }
            }
          } catch(e){}
        }
      }
    
      if (alarme !== undefined && alarme !== null) {
        const rangeAlarme = sheet.getRange(i + 1, alarmCol);
        rangeAlarme.setNumberFormat('@');
        rangeAlarme.setValue(String(alarme).trim());
      }
    
      if (observacao !== undefined && observacao !== null) {
        sheet.getRange(i + 1, obsCol).setValue(observacao);
      }
    
      return { success: true };
    }
  }
  return { success: false, error: 'id_not_found' };
}

// NOVO: Função para criar a Trigger de execução automática a cada 30 minutos sem duplicações
function createSyncTrigger30Min() {
  const fnName = 'sincronizarPedidosRecentes';
  const allTriggers = ScriptApp.getProjectTriggers();
  allTriggers.forEach(t => {
    if (t.getHandlerFunction() === fnName) {
      try { ScriptApp.deleteTrigger(t); } catch (e) {}
    }
  });

  ScriptApp.newTrigger(fnName).timeBased().everyMinutes(30).create();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) ss.toast('Trigger criada: execução automática a cada 30 minutos.', 'Gatilho Ativado', 5);
}

// NOVO: Função para limpar e deletar os gatilhos automáticos do projeto
function deleteSyncTriggers() {
  const fnName = 'sincronizarPedidosRecentes';
  const triggers = ScriptApp.getProjectTriggers();
  let count = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === fnName) {
      ScriptApp.deleteTrigger(t);
      count++;
    }
  });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) ss.toast('Gatilhos automáticos removidos: ' + count, 'Gatilho Desativado', 5);
}

// ATUALIZADO: Menu superior expandido com as funções de controle de tempo de 30 minutos
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚚 Vesco')
    .addItem('🔄 Sincronizar Pedidos', 'sincronizarPedidosRecentes')
    .addSeparator()
    .addItem('⏱️ Ativar sincronia 30m', 'createSyncTrigger30Min')
    .addItem('🗑️ Remover sincronia', 'deleteSyncTriggers')
    .addToUi();
}

function instalar() { garantirAbaSeparacao_(); sincronizarPedidosRecentes(); return 'OK'; }


/* ========================================================================
   VESCO APPS SCRIPT — CAMADA V10 TRANSPORTADORA + OBSERVAÇÕES DO TINY
   Regra de preservação: este bloco NÃO remove as funções antigas.
   Ele cria funções finais com o mesmo nome para que o Apps Script use
   esta versão mais completa, mantendo o legado acima como histórico.
   ======================================================================== */

const CABECALHO_LOGISTICA_V10 = [
  'id','numero','data_pedido','data_prevista',
  'cliente_nome','situacao_tiny','valor',
  'endereco_completo','forma_pagamento','instrucao_entrega',
  'status_logistica','observacao_logistica','alarme','tempo_separacao','tipo_entrega',
  'transportadora','forma_envio','forma_frete','observacoes_tiny','observacoes_internas',
  'prioridade_operacional','prioridade_label',
  'lat','lon'
];

function textoSeguroVesco_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.nome !== undefined) return textoSeguroVesco_(v.nome);
    if (v.descricao !== undefined) return textoSeguroVesco_(v.descricao);
    if (v.valor !== undefined) return textoSeguroVesco_(v.valor);
    try { return JSON.stringify(v); } catch(e) { return ''; }
  }
  return String(v).trim();
}

function normalizarTextoVesco_(v) {
  return textoSeguroVesco_(v)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function primeiroValorVesco_(lista) {
  for (let i = 0; i < lista.length; i++) {
    const v = textoSeguroVesco_(lista[i]);
    if (v && v !== '{}' && v !== '[]' && v !== '[object Object]') return v;
  }
  return '';
}

function pegarCaminhoVesco_(obj, path) {
  try {
    if (!obj) return '';
    const partes = path.split('.');
    let atual = obj;
    for (let i = 0; i < partes.length; i++) {
      if (atual === null || atual === undefined) return '';
      atual = atual[partes[i]];
    }
    return textoSeguroVesco_(atual);
  } catch(e) {
    return '';
  }
}

function juntarUnicosVesco_(lista, separador) {
  const seen = {};
  const out = [];
  lista.forEach(v => {
    const s = textoSeguroVesco_(v);
    if (!s) return;
    const key = normalizarTextoVesco_(s);
    if (seen[key]) return;
    seen[key] = true;
    out.push(s);
  });
  return out.join(separador || ' | ');
}

function extrairObservacoesTinyVesco_(detalhe) {
  detalhe = detalhe || {};

  const observacoes = primeiroValorVesco_([
    detalhe.observacoes,
    detalhe.obs,
    detalhe.observacao,
    detalhe.observacoes_cliente,
    detalhe.observacao_cliente,
    detalhe.mensagem,
    detalhe.mensagem_cliente
  ]);

  const observacoesInternas = primeiroValorVesco_([
    detalhe.observacoes_internas,
    detalhe.observacao_interna,
    detalhe.obs_interna,
    detalhe.obs_internas,
    detalhe.observacoes_interna,
    detalhe.anotacoes
  ]);

  const marcadores = [];
  if (observacoes) marcadores.push('Obs: ' + observacoes);
  if (observacoesInternas) marcadores.push('Interna: ' + observacoesInternas);

  return {
    observacoes: observacoes,
    observacoes_internas: observacoesInternas,
    observacao_completa: marcadores.join(' | ')
  };
}

function extrairTransporteTinyVesco_(pedidoPesquisa, detalhe) {
  const p = pedidoPesquisa || {};
  const d = detalhe || {};

  const transportadora = primeiroValorVesco_([
    pegarCaminhoVesco_(d, 'transportador.nome'),
    pegarCaminhoVesco_(d, 'transportadora.nome'),
    pegarCaminhoVesco_(d, 'transporte.transportador.nome'),
    pegarCaminhoVesco_(d, 'transporte.transportadora.nome'),
    d.nome_transportador,
    d.transportador_nome,
    d.transportadora_nome,
    d.transportador,
    d.transportadora,
    p.nome_transportador,
    p.transportador_nome,
    p.transportadora_nome,
    p.transportador,
    p.transportadora
  ]);

  const formaEnvio = primeiroValorVesco_([
    d.forma_envio,
    d.nome_forma_envio,
    d.formaEnvio,
    d.tipo_envio,
    d.modalidade_envio,
    pegarCaminhoVesco_(d, 'transporte.forma_envio'),
    pegarCaminhoVesco_(d, 'transporte.nome_forma_envio'),
    p.forma_envio,
    p.nome_forma_envio,
    p.formaEnvio,
    p.tipo_envio,
    p.modalidade_envio
  ]);

  const formaFrete = primeiroValorVesco_([
    d.forma_frete,
    d.frete_por_conta,
    d.tipo_frete,
    d.modalidade_frete,
    pegarCaminhoVesco_(d, 'transporte.forma_frete'),
    pegarCaminhoVesco_(d, 'transporte.frete_por_conta'),
    p.forma_frete,
    p.frete_por_conta,
    p.tipo_frete,
    p.modalidade_frete
  ]);

  return {
    transportadora: transportadora,
    forma_envio: formaEnvio,
    forma_frete: formaFrete,
    transporte_completo: juntarUnicosVesco_([transportadora, formaEnvio, formaFrete], ' | ')
  };
}

function classificarTipoEntregaVesco_(transporte, obsTiny, obsLogisticaAtual) {
  const texto = normalizarTextoVesco_([
    transporte && transporte.transportadora,
    transporte && transporte.forma_envio,
    transporte && transporte.forma_frete,
    obsTiny && obsTiny.observacoes,
    obsTiny && obsTiny.observacoes_internas,
    obsLogisticaAtual
  ].join(' | '));

  if (
    texto.includes('emergencial') ||
    texto.includes('urgente') ||
    texto.includes('prioridade') ||
    texto.includes('prioritario')
  ) {
    return {
      tipo_entrega: 'Emergencial',
      prioridade_operacional: 1,
      prioridade_label: '1 - Emergencial'
    };
  }

  if (
    texto.includes('retirada') ||
    texto.includes('retirar') ||
    texto.includes('retira') ||
    texto.includes('retirar pessoalmente') ||
    texto.includes('balcao') ||
    texto.includes('balcão') ||
    texto.includes('cliente retira') ||
    texto.includes('retira pessoalmente')
  ) {
    return {
      tipo_entrega: 'Retirada',
      prioridade_operacional: 2,
      prioridade_label: '2 - Retirada'
    };
  }

  return {
    tipo_entrega: 'Normal',
    prioridade_operacional: 3,
    prioridade_label: '3 - Entrega'
  };
}

function montarEnderecoEntregaVesco_(detalhe) {
  detalhe = detalhe || {};
  const ent = detalhe.enderecoEntrega || detalhe.endereco_entrega || detalhe.entrega || {};
  const cli = detalhe.cliente || {};

  const rua = primeiroValorVesco_([ent.endereco, ent.logradouro, cli.endereco, cli.logradouro]);
  if (!rua) return 'Endereço não disponível';

  const numero = primeiroValorVesco_([ent.numero, cli.numero]);
  const bairro = primeiroValorVesco_([ent.bairro, cli.bairro]);
  const cidade = primeiroValorVesco_([ent.cidade, cli.cidade]);
  const uf = primeiroValorVesco_([ent.uf, cli.uf]);
  const cep = primeiroValorVesco_([ent.cep, cli.cep]);

  let endereco = rua;
  if (numero) endereco += ', ' + numero;
  if (bairro) endereco += ' - ' + bairro;
  if (cidade || uf) endereco += ' | ' + [cidade, uf].filter(Boolean).join('-');
  if (cep) endereco += ' | CEP: ' + cep;

  return endereco;
}

/**
 * V10: sincroniza pedidos trazendo transportadora, forma de envio,
 * forma de frete e observações do Tiny.
 */
function sincronizarPedidosRecentes() {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - CONFIG.DIAS);

  const dInicio = Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const dFinal = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  let pagina = 1;
  let totalPaginas = 1;
  const todasLinhas = [];

  do {
    const payload = `token=${CONFIG.TINY_TOKEN}&formato=JSON&dataInicial=${dInicio}&dataFinal=${dFinal}&pagina=${pagina}`;
    const res = UrlFetchApp.fetch(CONFIG.URL_PESQUISA, { method: 'post', payload: payload, muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());

    if (!json.retorno || json.retorno.status !== 'OK' || !json.retorno.pedidos) break;

    totalPaginas = parseInt(json.retorno.numero_paginas || '1', 10);

    json.retorno.pedidos.forEach(item => {
      const p = item.pedido || {};
      const situacao = (p.situacao || '').toUpperCase();
      const numEcom = (p.numero_ecommerce || '').toString().trim();

      // Preservado do fluxo antigo: só entra pedido sem número e-commerce e não cancelado.
      if (numEcom === "" && situacao !== "CANCELADO") {
        const detalhe = obterDetalhePedido_(p.id);

        let enderecoFormatado = 'Endereço não disponível';
        let formaPagamento = 'Não informado';
        let instrucao = '⚠️ Verificar pagamento';
        let lat = '';
        let lon = '';

        let transporte = { transportadora: '', forma_envio: '', forma_frete: '', transporte_completo: '' };
        let obsTiny = { observacoes: '', observacoes_internas: '', observacao_completa: '' };
        let classificacao = { tipo_entrega: 'Normal', prioridade_operacional: 3, prioridade_label: '3 - Entrega' };

        if (detalhe) {
          enderecoFormatado = montarEnderecoEntregaVesco_(detalhe);

          let fpag = [];
          if (detalhe.parcelas) {
            detalhe.parcelas.forEach(parc => {
              if (parc.parcela && parc.parcela.forma_pagamento) fpag.push(parc.parcela.forma_pagamento);
            });
          }

          if (fpag.length === 0 && detalhe.forma_pagamento) fpag.push(detalhe.forma_pagamento);

          formaPagamento = fpag.filter(Boolean).join(' + ') || 'Não informado';
          instrucao = gerarInstrucao_(formaPagamento, p.valor || detalhe.totalPedido || 0);

          transporte = extrairTransporteTinyVesco_(p, detalhe);
          obsTiny = extrairObservacoesTinyVesco_(detalhe);
          classificacao = classificarTipoEntregaVesco_(transporte, obsTiny, '');

          if (enderecoFormatado !== 'Endereço não disponível') {
            const coords = buscarCoordenadas_(enderecoFormatado);
            lat = coords.lat || '';
            lon = coords.lon || '';
          }
        }

        todasLinhas.push([
          p.id || '',
          p.numero || '',
          p.data_pedido || '',
          p.data_prevista || '',
          p.nome || '',
          p.situacao || '',
          p.valor || 0,
          enderecoFormatado,
          formaPagamento,
          instrucao,
          'A Separar',
          '',
          '',
          '',
          classificacao.tipo_entrega,
          transporte.transportadora || '',
          transporte.forma_envio || '',
          transporte.forma_frete || '',
          obsTiny.observacoes || '',
          obsTiny.observacoes_internas || '',
          classificacao.prioridade_operacional,
          classificacao.prioridade_label,
          lat,
          lon
        ]);

        Utilities.sleep(150);
      }
    });

    pagina++;
  } while (pagina <= totalPaginas);

  gravarNaPlanilha_(todasLinhas);
}

/**
 * V10: grava preservando status/pendências/alarme/tempo já existentes,
 * mas atualizando as informações vindas do Tiny.
 */
function gravarNaPlanilha_(linhas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);

  const antigosPorId = {};
  const dataPlanilha = sheet.getDataRange().getValues();

  if (dataPlanilha.length > 1) {
    const oldHeaders = dataPlanilha[0].map(h => String(h).trim());
    for (let i = 1; i < dataPlanilha.length; i++) {
      const row = dataPlanilha[i];
      const id = String(row[oldHeaders.indexOf('id')] || row[0] || '').trim();
      if (!id) continue;

      const obj = {};
      oldHeaders.forEach((h, idx) => obj[h] = row[idx]);
      antigosPorId[id] = obj;
    }
  }

  const preserveFields = [
    'status_logistica',
    'observacao_logistica',
    'alarme',
    'tempo_separacao'
  ];

  const linhasProcessadas = (linhas || []).map(lin => {
    const id = String(lin[0] || '').trim();
    const antigo = antigosPorId[id] || {};

    const objNovo = {};
    CABECALHO_LOGISTICA_V10.forEach((h, idx) => objNovo[h] = lin[idx]);

    preserveFields.forEach(campo => {
      if (antigo[campo] !== undefined && antigo[campo] !== null && String(antigo[campo]).trim() !== '') {
        objNovo[campo] = antigo[campo];
      }
    });

    // Se o tipo foi alterado manualmente antes, preserva; caso contrário usa a classificação nova.
    if (antigo.tipo_entrega !== undefined && antigo.tipo_entrega !== null && String(antigo.tipo_entrega).trim() !== '') {
      objNovo.tipo_entrega = antigo.tipo_entrega;
    }

    // Recalcula prioridade usando dados atualizados + observação logística preservada.
    const classificacao = classificarTipoEntregaVesco_(
      {
        transportadora: objNovo.transportadora,
        forma_envio: objNovo.forma_envio,
        forma_frete: objNovo.forma_frete
      },
      {
        observacoes: objNovo.observacoes_tiny,
        observacoes_internas: objNovo.observacoes_internas
      },
      objNovo.observacao_logistica
    );

    objNovo.tipo_entrega = objNovo.tipo_entrega || classificacao.tipo_entrega;
    objNovo.prioridade_operacional = classificacao.prioridade_operacional;
    objNovo.prioridade_label = classificacao.prioridade_label;

    return CABECALHO_LOGISTICA_V10.map(h => objNovo[h] !== undefined ? objNovo[h] : '');
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, CABECALHO_LOGISTICA_V10.length)
    .setValues([CABECALHO_LOGISTICA_V10])
    .setFontWeight('bold')
    .setBackground('#004f9f')
    .setFontColor('#ffffff');

  sheet.setFrozenRows(1);

  if (linhasProcessadas.length > 0) {
    sheet.getRange(2, 1, linhasProcessadas.length, CABECALHO_LOGISTICA_V10.length).setValues(linhasProcessadas);
  }

  sheet.autoResizeColumns(1, CABECALHO_LOGISTICA_V10.length);
}

/**
 * V10: doGet final. Mantém updateStatus e geocode, e devolve aliases
 * que o front usa para logística/prioridade/rotas.
 */
function doGet(e) {
  try {
    const callback = e && e.parameter ? e.parameter.callback : null;
    const action = e && e.parameter ? e.parameter.action : null;
    const fusoHorario = Session.getScriptTimeZone();
    let resposta;

    if (action === 'geocode') {
      const address = e.parameter.address;
      const coords = buscarCoordenadasAprimorada_(address);
      resposta = { success: true, lat: coords.lat, lon: coords.lon };
    } else if (action === 'updateStatus') {
      resposta = processarAtualizacaoStatus_(
        e.parameter.id,
        e.parameter.status,
        e.parameter.alarme,
        e.parameter.observacao,
        e.parameter.operador
      );
    } else if (action === 'debugHeaders') {
      const sheetDebug = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
      const valsDebug = sheetDebug ? sheetDebug.getDataRange().getValues() : [];
      resposta = { success: true, headers: valsDebug[0] || [], rows: Math.max(0, valsDebug.length - 1) };
    } else {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
      const vals = sheet.getDataRange().getValues();
      const headers = vals[0].map(h => String(h).trim());

      const outPedidos = vals.slice(1).map(row => {
        let o = {};
        headers.forEach((h, i) => {
          let val = row[i];

          if ((h === 'data_prevista' || h === 'data_pedido') && val !== '') {
            if (val instanceof Date) {
              val = Utilities.formatDate(val, fusoHorario, 'dd/MM/yyyy');
            } else {
              const d = new Date(val);
              if (!isNaN(d.getTime())) val = Utilities.formatDate(d, fusoHorario, 'dd/MM/yyyy');
            }
          }

          o[h] = val;
        });

        const obsTinyCompleta = juntarUnicosVesco_([
          o.observacoes_tiny,
          o.observacoes_internas
        ], ' | ');

        const transporteCompleto = juntarUnicosVesco_([
          o.transportadora,
          o.forma_envio,
          o.forma_frete
        ], ' | ');

        o['ecom'] = '';
        o['destinatario'] = o['cliente_nome'];
        o['transportador'] = o['transportadora'] || '';
        o['nome_transportador'] = o['transportadora'] || '';
        o['nome_transportadora'] = o['transportadora'] || '';
        o['nomeformafenvio'] = o['forma_envio'] || o['transportadora'] || o['forma_pagamento'] || o['tipo_entrega'] || '';
        o['nome_forma_envio'] = o['forma_envio'] || o['transportadora'] || o['forma_pagamento'] || o['tipo_entrega'] || '';
        o['forma_envio_tiny'] = o['forma_envio'] || '';
        o['forma_frete_tiny'] = o['forma_frete'] || '';
        o['frete_por_conta'] = o['forma_frete'] || '';
        o['transporte_completo'] = transporteCompleto;
        o['observacao_tiny'] = obsTinyCompleta;
        o['observacoes'] = obsTinyCompleta;
        o['observacao'] = juntarUnicosVesco_([o['observacao_logistica'], obsTinyCompleta], ' | ');

        // Reforço da prioridade para o front.
        const classificacao = classificarTipoEntregaVesco_(
          { transportadora: o.transportadora, forma_envio: o.forma_envio, forma_frete: o.forma_frete },
          { observacoes: o.observacoes_tiny, observacoes_internas: o.observacoes_internas },
          o.observacao_logistica
        );

        o['tipo_entrega'] = o['tipo_entrega'] || classificacao.tipo_entrega;
        o['prioridade_operacional'] = o['prioridade_operacional'] || classificacao.prioridade_operacional;
        o['prioridade_label'] = o['prioridade_label'] || classificacao.prioridade_label;

        return o;
      });

      let outPropostas = [];
      const sheetProp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PROPOSALS_SHEET);
      if (sheetProp) {
        const valsProp = sheetProp.getDataRange().getValues();
        const headersProp = valsProp[0] || [];
        outPropostas = valsProp.slice(1).map(row => {
          let p = {};
          headersProp.forEach((h, i) => {
            const headClean = String(h).trim();
            if (['numero', 'cliente_nome', 'endereco_completo'].includes(headClean)) {
              p[headClean] = row[i];
            }
          });
          return p;
        });
      }

      resposta = { success: true, data: outPedidos, propostas: outPropostas };
    }

    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(resposta) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService
      .createTextOutput(JSON.stringify(resposta))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    const erro = { success: false, error: err.message, stack: err.stack || '' };
    const callback = e && e.parameter ? e.parameter.callback : null;

    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(erro) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService
      .createTextOutput(JSON.stringify(erro))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ============================================================================
// VESCO LOGÍSTICA — CAMADA V11: IDs DE FORMA DE ENVIO DO TINY
// Regra de Preservação: camada aditiva. Mantém o código anterior e sobrescreve
// apenas os pontos necessários para alimentar a planilha/plataforma com:
// id_forma_envio, forma_envio_nome, transportadora, forma_frete e observações.
// ============================================================================

const FORMA_ENVIO_TINY_IDS_V11 = {
  '747632293': 'Correios',
  '747632297': 'Transportadora',
  '747632298': 'Retirar pessoalmente',
  '769570519': 'Mercado Envios',
  '778029845': 'Shopee Envios',
  '780391986': 'Mercado Envios Flex',
  '849173976': 'Amazon DBA',
  '850044775': 'Magalu Entregas',
  '852535843': 'Loggi',
  '854284026': 'TikTok Shipping',
  '860463094': 'RETIRADA'
};

const IDS_FORMA_ENVIO_RETIRADA_V11 = {
  '747632298': true,
  '860463094': true
};

const CABECALHO_LOGISTICA_V11 = [
  'id','numero','data_pedido','data_prevista',
  'cliente_nome','situacao_tiny','valor',
  'endereco_completo','forma_pagamento','instrucao_entrega',
  'status_logistica','observacao_logistica','alarme','tempo_separacao','tipo_entrega',
  'id_forma_envio','forma_envio_nome',
  'transportadora','forma_envio','forma_frete','observacoes_tiny','observacoes_internas',
  'prioridade_operacional','prioridade_label',
  'lat','lon'
];

function normalizarChaveVescoV11_(v) {
  return String(v || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizarIdFormaEnvioVesco_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const possiveis = [v.id, v.codigo, v.value, v.valor, v.idFormaEnvio, v.id_forma_envio, v.id_forma_envio_psq];
    for (let i = 0; i < possiveis.length; i++) {
      const id = normalizarIdFormaEnvioVesco_(possiveis[i]);
      if (id) return id;
    }
    return '';
  }
  const s = String(v).trim();
  if (!s) return '';
  const m = s.match(/\b(\d{6,})\b/);
  return m ? m[1] : '';
}

function nomeFormaEnvioPorIdVesco_(idFormaEnvio) {
  const id = normalizarIdFormaEnvioVesco_(idFormaEnvio);
  return id ? (FORMA_ENVIO_TINY_IDS_V11[id] || '') : '';
}

function buscarValoresRecursivosVescoV11_(obj, predicadoChave, limite) {
  const out = [];
  const vistos = [];
  const maxDepth = limite || 5;

  function walk(atual, depth) {
    if (atual === null || atual === undefined || depth > maxDepth) return;
    if (typeof atual !== 'object') return;
    if (vistos.indexOf(atual) >= 0) return;
    vistos.push(atual);

    if (Array.isArray(atual)) {
      atual.forEach(v => walk(v, depth + 1));
      return;
    }

    Object.keys(atual).forEach(k => {
      const nk = normalizarChaveVescoV11_(k);
      const val = atual[k];
      if (predicadoChave(nk, k, val)) out.push(val);
      if (val && typeof val === 'object') walk(val, depth + 1);
    });
  }

  walk(obj, 0);
  return out;
}

function extrairIdFormaEnvioTinyVesco_(pedidoPesquisa, detalhe) {
  const p = pedidoPesquisa || {};
  const d = detalhe || {};

  const candidatosDiretos = [
    p.idFormaEnvio, p.id_forma_envio, p.idFormaEnvioPsq, p.id_forma_envio_psq,
    p.forma_envio_id, p.formaEnvioId, p.idFormaFrete, p.id_forma_frete,
    pegarCaminhoVesco_(p, 'forma_envio.id'),
    pegarCaminhoVesco_(p, 'formaEnvio.id'),
    pegarCaminhoVesco_(p, 'transporte.idFormaEnvio'),
    pegarCaminhoVesco_(p, 'transporte.id_forma_envio'),
    d.idFormaEnvio, d.id_forma_envio, d.idFormaEnvioPsq, d.id_forma_envio_psq,
    d.forma_envio_id, d.formaEnvioId, d.idFormaFrete, d.id_forma_frete,
    pegarCaminhoVesco_(d, 'forma_envio.id'),
    pegarCaminhoVesco_(d, 'formaEnvio.id'),
    pegarCaminhoVesco_(d, 'transporte.idFormaEnvio'),
    pegarCaminhoVesco_(d, 'transporte.id_forma_envio'),
    pegarCaminhoVesco_(d, 'transporte.forma_envio.id'),
    pegarCaminhoVesco_(d, 'transporte.formaEnvio.id')
  ];

  for (let i = 0; i < candidatosDiretos.length; i++) {
    const id = normalizarIdFormaEnvioVesco_(candidatosDiretos[i]);
    if (id && FORMA_ENVIO_TINY_IDS_V11[id]) return id;
  }

  const encontrados = []
    .concat(buscarValoresRecursivosVescoV11_(p, nk => nk === 'idformaenvio' || nk === 'idformaenviopsq' || nk === 'idformafrete' || nk === 'formaenvioid', 5))
    .concat(buscarValoresRecursivosVescoV11_(d, nk => nk === 'idformaenvio' || nk === 'idformaenviopsq' || nk === 'idformafrete' || nk === 'formaenvioid', 5));

  for (let j = 0; j < encontrados.length; j++) {
    const id = normalizarIdFormaEnvioVesco_(encontrados[j]);
    if (id && FORMA_ENVIO_TINY_IDS_V11[id]) return id;
  }

  // Fallback por texto caso o Tiny não devolva o ID no payload obter/pesquisa.
  const texto = normalizarTextoVesco_([
    p.forma_envio, p.nome_forma_envio, p.formaEnvio, p.tipo_envio, p.modalidade_envio,
    d.forma_envio, d.nome_forma_envio, d.formaEnvio, d.tipo_envio, d.modalidade_envio,
    pegarCaminhoVesco_(d, 'transporte.forma_envio'),
    pegarCaminhoVesco_(d, 'transporte.nome_forma_envio')
  ].join(' | '));

  const entries = Object.keys(FORMA_ENVIO_TINY_IDS_V11);
  for (let k = 0; k < entries.length; k++) {
    const id = entries[k];
    const nome = normalizarTextoVesco_(FORMA_ENVIO_TINY_IDS_V11[id]);
    if (nome && texto.includes(nome)) return id;
  }

  return '';
}

function extrairTransporteTinyVesco_(pedidoPesquisa, detalhe) {
  const p = pedidoPesquisa || {};
  const d = detalhe || {};

  const idFormaEnvio = extrairIdFormaEnvioTinyVesco_(p, d);
  const nomeFormaEnvioMapeado = nomeFormaEnvioPorIdVesco_(idFormaEnvio);

  const transportadora = primeiroValorVesco_([
    pegarCaminhoVesco_(d, 'transportador.nome'),
    pegarCaminhoVesco_(d, 'transportadora.nome'),
    pegarCaminhoVesco_(d, 'transporte.transportador.nome'),
    pegarCaminhoVesco_(d, 'transporte.transportadora.nome'),
    d.nome_transportador,
    d.transportador_nome,
    d.transportadora_nome,
    d.transportador,
    d.transportadora,
    p.nome_transportador,
    p.transportador_nome,
    p.transportadora_nome,
    p.transportador,
    p.transportadora,
    // Se o Tiny não trouxer transportadora, usamos a forma de envio mapeada como referência operacional.
    nomeFormaEnvioMapeado
  ]);

  const formaEnvio = primeiroValorVesco_([
    nomeFormaEnvioMapeado,
    d.forma_envio,
    d.nome_forma_envio,
    d.formaEnvio,
    d.tipo_envio,
    d.modalidade_envio,
    pegarCaminhoVesco_(d, 'transporte.forma_envio'),
    pegarCaminhoVesco_(d, 'transporte.nome_forma_envio'),
    p.forma_envio,
    p.nome_forma_envio,
    p.formaEnvio,
    p.tipo_envio,
    p.modalidade_envio
  ]);

  const formaFrete = primeiroValorVesco_([
    d.forma_frete,
    d.frete_por_conta,
    d.tipo_frete,
    d.modalidade_frete,
    pegarCaminhoVesco_(d, 'transporte.forma_frete'),
    pegarCaminhoVesco_(d, 'transporte.frete_por_conta'),
    p.forma_frete,
    p.frete_por_conta,
    p.tipo_frete,
    p.modalidade_frete
  ]);

  return {
    id_forma_envio: idFormaEnvio,
    forma_envio_nome: nomeFormaEnvioMapeado || formaEnvio,
    transportadora: transportadora,
    forma_envio: formaEnvio,
    forma_frete: formaFrete,
    transporte_completo: juntarUnicosVesco_([idFormaEnvio, nomeFormaEnvioMapeado, transportadora, formaEnvio, formaFrete], ' | ')
  };
}

function classificarTipoEntregaVesco_(transporte, obsTiny, obsLogisticaAtual) {
  const idFormaEnvio = normalizarIdFormaEnvioVesco_(transporte && transporte.id_forma_envio);
  const texto = normalizarTextoVesco_([
    idFormaEnvio,
    transporte && transporte.forma_envio_nome,
    transporte && transporte.transportadora,
    transporte && transporte.forma_envio,
    transporte && transporte.forma_frete,
    obsTiny && obsTiny.observacoes,
    obsTiny && obsTiny.observacoes_internas,
    obsLogisticaAtual
  ].join(' | '));

  if (
    texto.includes('emergencial') ||
    texto.includes('urgente') ||
    texto.includes('prioridade') ||
    texto.includes('prioritario')
  ) {
    return { tipo_entrega: 'Emergencial', prioridade_operacional: 1, prioridade_label: '1 - Emergencial' };
  }

  if (
    IDS_FORMA_ENVIO_RETIRADA_V11[idFormaEnvio] ||
    texto.includes('retirada') ||
    texto.includes('retirar') ||
    texto.includes('retira') ||
    texto.includes('retirar pessoalmente') ||
    texto.includes('balcao') ||
    texto.includes('cliente retira') ||
    texto.includes('retira pessoalmente')
  ) {
    return { tipo_entrega: 'Retirada', prioridade_operacional: 2, prioridade_label: '2 - Retirada' };
  }

  return { tipo_entrega: 'Normal', prioridade_operacional: 3, prioridade_label: '3 - Entrega' };
}

/**
 * V11: sincroniza pedidos trazendo o ID da forma de envio e o nome oficial
 * conforme o cadastro do Tiny informado pelo usuário.
 */
function sincronizarPedidosRecentes_V11_BASE_() {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - CONFIG.DIAS);

  const dInicio = Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const dFinal = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  let pagina = 1;
  let totalPaginas = 1;
  const todasLinhas = [];

  do {
    const payload = `token=${CONFIG.TINY_TOKEN}&formato=JSON&dataInicial=${dInicio}&dataFinal=${dFinal}&pagina=${pagina}`;
    const res = UrlFetchApp.fetch(CONFIG.URL_PESQUISA, { method: 'post', payload: payload, muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());

    if (!json.retorno || json.retorno.status !== 'OK' || !json.retorno.pedidos) break;

    totalPaginas = parseInt(json.retorno.numero_paginas || '1', 10);

    json.retorno.pedidos.forEach(item => {
      const p = item.pedido || {};
      const situacao = (p.situacao || '').toUpperCase();
      const numEcom = (p.numero_ecommerce || '').toString().trim();

      // Preservado do fluxo antigo: só entra pedido sem número e-commerce e não cancelado.
      if (numEcom === '' && situacao !== 'CANCELADO') {
        const detalhe = obterDetalhePedido_(p.id);

        let enderecoFormatado = 'Endereço não disponível';
        let formaPagamento = 'Não informado';
        let instrucao = '⚠️ Verificar pagamento';
        let lat = '';
        let lon = '';

        let transporte = { id_forma_envio: '', forma_envio_nome: '', transportadora: '', forma_envio: '', forma_frete: '', transporte_completo: '' };
        let obsTiny = { observacoes: '', observacoes_internas: '', observacao_completa: '' };
        let classificacao = { tipo_entrega: 'Normal', prioridade_operacional: 3, prioridade_label: '3 - Entrega' };

        if (detalhe) {
          enderecoFormatado = montarEnderecoEntregaVesco_(detalhe);

          let fpag = [];
          if (detalhe.parcelas) {
            detalhe.parcelas.forEach(parc => {
              if (parc.parcela && parc.parcela.forma_pagamento) fpag.push(parc.parcela.forma_pagamento);
            });
          }

          if (fpag.length === 0 && detalhe.forma_pagamento) fpag.push(detalhe.forma_pagamento);

          formaPagamento = fpag.filter(Boolean).join(' + ') || 'Não informado';
          instrucao = gerarInstrucao_(formaPagamento, p.valor || detalhe.totalPedido || 0);

          transporte = extrairTransporteTinyVesco_(p, detalhe);
          obsTiny = extrairObservacoesTinyVesco_(detalhe);
          classificacao = classificarTipoEntregaVesco_(transporte, obsTiny, '');

          if (enderecoFormatado !== 'Endereço não disponível') {
            const coords = buscarCoordenadas_(enderecoFormatado);
            lat = coords.lat || '';
            lon = coords.lon || '';
          }
        }

        todasLinhas.push([
          p.id || '',
          p.numero || '',
          p.data_pedido || '',
          p.data_prevista || '',
          p.nome || '',
          p.situacao || '',
          p.valor || 0,
          enderecoFormatado,
          formaPagamento,
          instrucao,
          'A Separar',
          '',
          '',
          '',
          classificacao.tipo_entrega,
          transporte.id_forma_envio || '',
          transporte.forma_envio_nome || '',
          transporte.transportadora || '',
          transporte.forma_envio || '',
          transporte.forma_frete || '',
          obsTiny.observacoes || '',
          obsTiny.observacoes_internas || '',
          classificacao.prioridade_operacional,
          classificacao.prioridade_label,
          lat,
          lon
        ]);

        Utilities.sleep(120);
      }
    });

    pagina++;
  } while (pagina <= totalPaginas);

  gravarNaPlanilha_(todasLinhas);
}

/**
 * V11: grava preservando status/pendências/alarme/tempo já existentes,
 * mas atualizando dados de envio do Tiny.
 */
function gravarNaPlanilha_(linhas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);

  const antigosPorId = {};
  const dataPlanilha = sheet.getDataRange().getValues();

  if (dataPlanilha.length > 1) {
    const oldHeaders = dataPlanilha[0].map(h => String(h).trim());
    for (let i = 1; i < dataPlanilha.length; i++) {
      const row = dataPlanilha[i];
      const idIndex = oldHeaders.indexOf('id');
      const id = String(row[idIndex >= 0 ? idIndex : 0] || '').trim();
      if (!id) continue;

      const obj = {};
      oldHeaders.forEach((h, idx) => obj[h] = row[idx]);
      antigosPorId[id] = obj;
    }
  }

  const preserveFields = ['status_logistica','observacao_logistica','alarme','tempo_separacao'];

  const linhasProcessadas = (linhas || []).map(lin => {
    const id = String(lin[0] || '').trim();
    const antigo = antigosPorId[id] || {};

    const objNovo = {};
    CABECALHO_LOGISTICA_V11.forEach((h, idx) => objNovo[h] = lin[idx]);

    preserveFields.forEach(campo => {
      if (antigo[campo] !== undefined && antigo[campo] !== null && String(antigo[campo]).trim() !== '') {
        objNovo[campo] = antigo[campo];
      }
    });

    // Se o operador alterou manualmente o tipo antes, preserva apenas se não houver ID de retirada oficial.
    if (
      antigo.tipo_entrega !== undefined && antigo.tipo_entrega !== null && String(antigo.tipo_entrega).trim() !== '' &&
      !IDS_FORMA_ENVIO_RETIRADA_V11[normalizarIdFormaEnvioVesco_(objNovo.id_forma_envio)]
    ) {
      objNovo.tipo_entrega = antigo.tipo_entrega;
    }

    const classificacao = classificarTipoEntregaVesco_(
      {
        id_forma_envio: objNovo.id_forma_envio,
        forma_envio_nome: objNovo.forma_envio_nome,
        transportadora: objNovo.transportadora,
        forma_envio: objNovo.forma_envio,
        forma_frete: objNovo.forma_frete
      },
      {
        observacoes: objNovo.observacoes_tiny,
        observacoes_internas: objNovo.observacoes_internas
      },
      objNovo.observacao_logistica
    );

    objNovo.tipo_entrega = classificacao.tipo_entrega;
    objNovo.prioridade_operacional = classificacao.prioridade_operacional;
    objNovo.prioridade_label = classificacao.prioridade_label;

    return CABECALHO_LOGISTICA_V11.map(h => objNovo[h] !== undefined ? objNovo[h] : '');
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, CABECALHO_LOGISTICA_V11.length)
    .setValues([CABECALHO_LOGISTICA_V11])
    .setFontWeight('bold')
    .setBackground('#004f9f')
    .setFontColor('#ffffff');

  sheet.setFrozenRows(1);

  if (linhasProcessadas.length > 0) {
    sheet.getRange(2, 1, linhasProcessadas.length, CABECALHO_LOGISTICA_V11.length).setValues(linhasProcessadas);
  }

  sheet.autoResizeColumns(1, CABECALHO_LOGISTICA_V11.length);
}

/**
 * V11: doGet final. Inclui aliases de ID/nome da forma de envio para o front.
 */
function doGet_V11_BASE_(e) {
  try {
    const callback = e && e.parameter ? e.parameter.callback : null;
    const action = e && e.parameter ? e.parameter.action : null;
    const fusoHorario = Session.getScriptTimeZone();
    let resposta;

    if (action === 'geocode') {
      const address = e.parameter.address;
      const coords = buscarCoordenadasAprimorada_(address);
      resposta = { success: true, lat: coords.lat, lon: coords.lon };
    } else if (action === 'updateStatus') {
      resposta = processarAtualizacaoStatus_(
        e.parameter.id,
        e.parameter.status,
        e.parameter.alarme,
        e.parameter.observacao,
        e.parameter.operador
      );
    } else if (action === 'debugHeaders') {
      const sheetDebug = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
      const valsDebug = sheetDebug ? sheetDebug.getDataRange().getValues() : [];
      resposta = { success: true, headers: valsDebug[0] || [], rows: Math.max(0, valsDebug.length - 1) };
    } else if (action === 'debugFormaEnvio') {
      resposta = { success: true, mapa: FORMA_ENVIO_TINY_IDS_V11, idsRetirada: Object.keys(IDS_FORMA_ENVIO_RETIRADA_V11) };
    } else {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
      const vals = sheet.getDataRange().getValues();
      const headers = vals[0].map(h => String(h).trim());

      const outPedidos = vals.slice(1).map(row => {
        let o = {};
        headers.forEach((h, i) => {
          let val = row[i];

          if ((h === 'data_prevista' || h === 'data_pedido') && val !== '') {
            if (val instanceof Date) {
              val = Utilities.formatDate(val, fusoHorario, 'dd/MM/yyyy');
            } else {
              const d = new Date(val);
              if (!isNaN(d.getTime())) val = Utilities.formatDate(d, fusoHorario, 'dd/MM/yyyy');
            }
          }

          o[h] = val;
        });

        const idFormaEnvio = normalizarIdFormaEnvioVesco_(o.id_forma_envio);
        const nomeFormaEnvio = o.forma_envio_nome || nomeFormaEnvioPorIdVesco_(idFormaEnvio) || o.forma_envio || '';

        const obsTinyCompleta = juntarUnicosVesco_([o.observacoes_tiny, o.observacoes_internas], ' | ');
        const transporteCompleto = juntarUnicosVesco_([idFormaEnvio, nomeFormaEnvio, o.transportadora, o.forma_envio, o.forma_frete], ' | ');

        o['ecom'] = '';
        o['destinatario'] = o['cliente_nome'];

        o['idFormaEnvio'] = idFormaEnvio;
        o['idFormaEnvioPsq'] = idFormaEnvio;
        o['id_forma_envio_psq'] = idFormaEnvio;
        o['forma_envio_id'] = idFormaEnvio;

        o['forma_envio_nome'] = nomeFormaEnvio;
        o['nome_forma_envio'] = nomeFormaEnvio || o['forma_envio'] || o['transportadora'] || o['forma_pagamento'] || o['tipo_entrega'] || '';
        o['nomeformafenvio'] = o['nome_forma_envio'];
        o['forma_envio_tiny'] = o['forma_envio'] || nomeFormaEnvio || '';
        o['forma_frete_tiny'] = o['forma_frete'] || '';
        o['frete_por_conta'] = o['forma_frete'] || '';

        o['transportador'] = o['transportadora'] || nomeFormaEnvio || '';
        o['nome_transportador'] = o['transportadora'] || nomeFormaEnvio || '';
        o['nome_transportadora'] = o['transportadora'] || nomeFormaEnvio || '';
        o['transporte_completo'] = transporteCompleto;

        o['observacao_tiny'] = obsTinyCompleta;
        o['observacoes'] = obsTinyCompleta;
        o['observacao'] = juntarUnicosVesco_([o['observacao_logistica'], obsTinyCompleta], ' | ');

        const classificacao = classificarTipoEntregaVesco_(
          {
            id_forma_envio: idFormaEnvio,
            forma_envio_nome: nomeFormaEnvio,
            transportadora: o.transportadora,
            forma_envio: o.forma_envio,
            forma_frete: o.forma_frete
          },
          { observacoes: o.observacoes_tiny, observacoes_internas: o.observacoes_internas },
          o.observacao_logistica
        );

        o['tipo_entrega'] = classificacao.tipo_entrega;
        o['prioridade_operacional'] = classificacao.prioridade_operacional;
        o['prioridade_label'] = classificacao.prioridade_label;

        return o;
      });

      let outPropostas = [];
      const sheetProp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PROPOSALS_SHEET);
      if (sheetProp) {
        const valsProp = sheetProp.getDataRange().getValues();
        const headersProp = valsProp[0] || [];
        outPropostas = valsProp.slice(1).map(row => {
          let p = {};
          headersProp.forEach((h, i) => {
            const headClean = String(h).trim();
            if (['numero', 'cliente_nome', 'endereco_completo'].includes(headClean)) p[headClean] = row[i];
          });
          return p;
        });
      }

      resposta = { success: true, data: outPedidos, propostas: outPropostas };
    }

    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(resposta) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService.createTextOutput(JSON.stringify(resposta)).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    const erro = { success: false, error: err.message, stack: err.stack || '' };
    const callback = e && e.parameter ? e.parameter.callback : null;

    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(erro) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService.createTextOutput(JSON.stringify(erro)).setMimeType(ContentService.MimeType.JSON);
  }
}

console.log('Apps Script V11 ativo — IDs de forma de envio do Tiny integrados à planilha e ao JSON do painel.');


// ============================================================================
// VESCO LOGÍSTICA — CAMADA V12: ABA FORMASENVIO
// Regra de Preservação: mantém a V11 intacta como base e adiciona a criação
// automática da página/aba de formas de envio para alimentar a plataforma.
// ============================================================================

const FORMAS_ENVIO_SHEET_NAME_V12 = 'FormasEnvio';

function montarLinhasFormasEnvioVescoV12_() {
  const agora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
  const ids = Object.keys(FORMA_ENVIO_TINY_IDS_V11 || {});

  return ids.map(id => {
    const nome = FORMA_ENVIO_TINY_IDS_V11[id] || '';
    const isRetirada = !!(IDS_FORMA_ENVIO_RETIRADA_V11 && IDS_FORMA_ENVIO_RETIRADA_V11[id]);
    const nomeNorm = String(nome || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    let tipoOperacional = 'Entrega';
    let prioridade = 3;
    let label = '3 - Entrega';
    let canal = 'Entrega normal';

    if (isRetirada || nomeNorm.includes('retirada') || nomeNorm.includes('retirar')) {
      tipoOperacional = 'Retirada';
      prioridade = 2;
      label = '2 - Retirada';
      canal = 'Retirada';
    } else if (nomeNorm.includes('flex')) {
      canal = 'Mercado Envios Flex';
    } else if (nomeNorm.includes('mercado')) {
      canal = 'Mercado Envios';
    } else if (nomeNorm.includes('shopee')) {
      canal = 'Shopee Envios';
    } else if (nomeNorm.includes('amazon')) {
      canal = 'Amazon DBA';
    } else if (nomeNorm.includes('magalu')) {
      canal = 'Magalu Entregas';
    } else if (nomeNorm.includes('loggi')) {
      canal = 'Loggi';
    } else if (nomeNorm.includes('tiktok')) {
      canal = 'TikTok Shipping';
    } else if (nomeNorm.includes('correios')) {
      canal = 'Correios';
    } else if (nomeNorm.includes('transportadora')) {
      canal = 'Transportadora';
    }

    return [
      id,
      nome,
      tipoOperacional,
      prioridade,
      label,
      isRetirada ? 'SIM' : 'NÃO',
      canal,
      'SIM',
      agora
    ];
  });
}

function criarAtualizarAbaFormasEnvio() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(FORMAS_ENVIO_SHEET_NAME_V12);
  if (!sh) sh = ss.insertSheet(FORMAS_ENVIO_SHEET_NAME_V12);

  const headers = [
    'id_forma_envio',
    'forma_envio_nome',
    'tipo_operacional',
    'prioridade_operacional',
    'prioridade_label',
    'eh_retirada',
    'canal_logistico',
    'ativo',
    'atualizado_em'
  ];

  const linhas = montarLinhasFormasEnvioVescoV12_();

  sh.clear();
  sh.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#004f9f')
    .setFontColor('#ffffff');

  if (linhas.length > 0) {
    sh.getRange(2, 1, linhas.length, headers.length).setValues(linhas);
  }

  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);

  // Formatação visual simples para facilitar conferência.
  if (linhas.length > 0) {
    sh.getRange(2, 4, linhas.length, 1).setNumberFormat('0');
    for (let i = 0; i < linhas.length; i++) {
      const rowNumber = i + 2;
      const tipo = linhas[i][2];
      if (tipo === 'Retirada') {
        sh.getRange(rowNumber, 1, 1, headers.length).setBackground('#fff7ed');
      }
    }
  }

  return { success: true, sheet: FORMAS_ENVIO_SHEET_NAME_V12, total: linhas.length };
}

function lerFormasEnvioVescoV12_() {
  criarAtualizarAbaFormasEnvio();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(FORMAS_ENVIO_SHEET_NAME_V12);
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(h => String(h || '').trim());

  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx]);
    return obj;
  });
}

// V12: agora a sincronização também garante a aba FormasEnvio.
function sincronizarPedidosRecentes() {
  criarAtualizarAbaFormasEnvio();
  return sincronizarPedidosRecentes_V11_BASE_.apply(this, arguments);
}

// V12: endpoint para a plataforma consultar a tabela de formas de envio.
function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : null;
    const callback = e && e.parameter ? e.parameter.callback : null;

    if (action === 'formasEnvio' || action === 'formas_envio' || action === 'listarFormasEnvio') {
      const resposta = {
        success: true,
        formasEnvio: lerFormasEnvioVescoV12_(),
        mapa: FORMA_ENVIO_TINY_IDS_V11,
        idsRetirada: Object.keys(IDS_FORMA_ENVIO_RETIRADA_V11 || {})
      };

      if (callback) {
        return ContentService
          .createTextOutput(callback + '(' + JSON.stringify(resposta) + ');')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }

      return ContentService.createTextOutput(JSON.stringify(resposta)).setMimeType(ContentService.MimeType.JSON);
    }

    return doGet_V11_BASE_(e);
  } catch (err) {
    const callback = e && e.parameter ? e.parameter.callback : null;
    const erro = { success: false, error: err.message, stack: err.stack || '' };

    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(erro) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService.createTextOutput(JSON.stringify(erro)).setMimeType(ContentService.MimeType.JSON);
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚚 Vesco')
    .addItem('🔄 Sincronizar Pedidos', 'sincronizarPedidosRecentes')
    .addItem('🚚 Criar/Atualizar Formas de Envio', 'criarAtualizarAbaFormasEnvio')
    .addSeparator()
    .addItem('⏱️ Ativar sincronia 30m', 'createSyncTrigger30Min')
    .addItem('🗑️ Remover sincronia', 'deleteSyncTriggers')
    .addToUi();
}

function instalar() {
  garantirAbaSeparacao_();
  criarAtualizarAbaFormasEnvio();
  sincronizarPedidosRecentes();
  return 'OK';
}

console.log('Apps Script V12 ativo — aba FormasEnvio criada/atualizada e endpoint action=formasEnvio disponível.');

// ============================================================================
// VESCO LOGÍSTICA — CAMADA V13: MULTI-CONTAS TINY
// Regra de Preservação: mantém toda a V12 intacta e adiciona sincronização
// para mais de uma conta Tiny usando Script Properties.
// Propriedades esperadas:
// - TINY_TOKEN_COMERCIO
// - TINY_TOKEN_DISTRIBUIDORA
// ============================================================================

const CABECALHO_LOGISTICA_V13 = (typeof CABECALHO_LOGISTICA_V11 !== 'undefined' ? CABECALHO_LOGISTICA_V11.slice() : CABECALHO.slice()).concat([
  'conta_tiny',
  'id_tiny',
  'pedido_key'
]);

function obterTinyAccountsV13_() {
  const props = PropertiesService.getScriptProperties();
  const tokenComercio = String(props.getProperty('TINY_TOKEN_COMERCIO') || CONFIG.TINY_TOKEN || '').trim();
  const tokenDistribuidora = String(props.getProperty('TINY_TOKEN_DISTRIBUIDORA') || '').trim();

  const contas = [];

  if (tokenComercio) {
    contas.push({
      key: 'COMERCIO',
      nome: 'Comércio',
      token: tokenComercio,
      manterIdOriginal: true
    });
  }

  if (tokenDistribuidora) {
    contas.push({
      key: 'DISTRIBUIDORA',
      nome: 'Distribuidora',
      token: tokenDistribuidora,
      manterIdOriginal: false
    });
  }

  return contas;
}

function montarIdPainelV13_(conta, idTiny) {
  const raw = String(idTiny || '').trim();
  if (!raw) return '';
  if (conta && conta.manterIdOriginal) return raw;
  const key = String((conta && conta.key) || 'TINY').trim().toUpperCase();
  return key + '__' + raw;
}

function extrairIdTinyDoIdPainelV13_(idPainel) {
  const s = String(idPainel || '').trim();
  const m = s.match(/^[A-Z0-9_-]+__(.+)$/);
  return m ? m[1] : s;
}

function obterDetalhePedidoPorTokenV13_(id, token) {
  try {
    const idTiny = extrairIdTinyDoIdPainelV13_(id);
    const payload = `token=${encodeURIComponent(token)}&formato=JSON&id=${encodeURIComponent(idTiny)}`;
    const res = UrlFetchApp.fetch(CONFIG.URL_OBTER, { method: 'post', payload: payload, muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());
    return json && json.retorno ? json.retorno.pedido : null;
  } catch (e) {
    console.warn('obterDetalhePedidoPorTokenV13_ falhou:', e && e.message ? e.message : e);
    return null;
  }
}

function registrarDebugContasTinyV13_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('ContasTiny');
  if (!sh) sh = ss.insertSheet('ContasTiny');

  const contas = obterTinyAccountsV13_();
  const agora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss');
  const headers = ['conta_key','conta_nome','token_configurado','token_mascarado','atualizado_em'];
  const linhas = contas.map(c => {
    const token = String(c.token || '');
    const masked = token ? token.substring(0, 8) + '...' + token.substring(Math.max(8, token.length - 6)) : '';
    return [c.key, c.nome, token ? 'SIM' : 'NÃO', masked, agora];
  });

  sh.clear();
  sh.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#004f9f')
    .setFontColor('#ffffff');

  if (linhas.length) sh.getRange(2, 1, linhas.length, headers.length).setValues(linhas);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);

  return { success: true, total: contas.length };
}

function sincronizarPedidosRecentes() {
  if (typeof criarAtualizarAbaFormasEnvio === 'function') criarAtualizarAbaFormasEnvio();
  registrarDebugContasTinyV13_();

  const contas = obterTinyAccountsV13_();
  if (!contas.length) throw new Error('Nenhum token Tiny configurado. Configure TINY_TOKEN_COMERCIO e/ou TINY_TOKEN_DISTRIBUIDORA em Propriedades do Script.');

  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - CONFIG.DIAS);

  const dInicio = Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const dFinal = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const todasLinhas = [];
  const resumo = [];

  contas.forEach(conta => {
    let pagina = 1;
    let totalPaginas = 1;
    let totalConta = 0;

    do {
      const payload = `token=${encodeURIComponent(conta.token)}&formato=JSON&dataInicial=${encodeURIComponent(dInicio)}&dataFinal=${encodeURIComponent(dFinal)}&pagina=${pagina}`;
      const res = UrlFetchApp.fetch(CONFIG.URL_PESQUISA, { method: 'post', payload: payload, muteHttpExceptions: true });
      const json = JSON.parse(res.getContentText());

      if (!json.retorno || json.retorno.status !== 'OK' || !json.retorno.pedidos) {
        console.warn('Pesquisa Tiny sem pedidos ou com erro para conta:', conta.key, json && json.retorno ? json.retorno : json);
        break;
      }

      totalPaginas = parseInt(json.retorno.numero_paginas || '1', 10);

      json.retorno.pedidos.forEach(item => {
        const p = item.pedido || {};
        const situacao = (p.situacao || '').toUpperCase();
        const numEcom = (p.numero_ecommerce || '').toString().trim();

        // Preservado do fluxo antigo: só entra pedido sem número e-commerce e não cancelado.
        if (numEcom === '' && situacao !== 'CANCELADO') {
          const idTiny = String(p.id || '').trim();
          const idPainel = montarIdPainelV13_(conta, idTiny);
          const detalhe = obterDetalhePedidoPorTokenV13_(idTiny, conta.token);

          let enderecoFormatado = 'Endereço não disponível';
          let formaPagamento = 'Não informado';
          let instrucao = '⚠️ Verificar pagamento';
          let lat = '';
          let lon = '';

          let transporte = { id_forma_envio: '', forma_envio_nome: '', transportadora: '', forma_envio: '', forma_frete: '', transporte_completo: '' };
          let obsTiny = { observacoes: '', observacoes_internas: '', observacao_completa: '' };
          let classificacao = { tipo_entrega: 'Normal', prioridade_operacional: 3, prioridade_label: '3 - Entrega' };

          if (detalhe) {
            enderecoFormatado = montarEnderecoEntregaVesco_(detalhe);

            let fpag = [];
            if (detalhe.parcelas) {
              detalhe.parcelas.forEach(parc => {
                if (parc.parcela && parc.parcela.forma_pagamento) fpag.push(parc.parcela.forma_pagamento);
              });
            }

            if (fpag.length === 0 && detalhe.forma_pagamento) fpag.push(detalhe.forma_pagamento);

            formaPagamento = fpag.filter(Boolean).join(' + ') || 'Não informado';
            instrucao = gerarInstrucao_(formaPagamento, p.valor || detalhe.totalPedido || 0);

            transporte = extrairTransporteTinyVesco_(p, detalhe);
            obsTiny = extrairObservacoesTinyVesco_(detalhe);
            classificacao = classificarTipoEntregaVesco_(transporte, obsTiny, '');

            if (enderecoFormatado !== 'Endereço não disponível') {
              const coords = buscarCoordenadas_(enderecoFormatado);
              lat = coords.lat || '';
              lon = coords.lon || '';
            }
          }

          todasLinhas.push([
            idPainel,
            p.numero || '',
            p.data_pedido || '',
            p.data_prevista || '',
            p.nome || '',
            p.situacao || '',
            p.valor || 0,
            enderecoFormatado,
            formaPagamento,
            instrucao,
            'A Separar',
            '',
            '',
            '',
            classificacao.tipo_entrega,
            transporte.id_forma_envio || '',
            transporte.forma_envio_nome || '',
            transporte.transportadora || '',
            transporte.forma_envio || '',
            transporte.forma_frete || '',
            obsTiny.observacoes || '',
            obsTiny.observacoes_internas || '',
            classificacao.prioridade_operacional,
            classificacao.prioridade_label,
            lat,
            lon,
            conta.nome,
            idTiny,
            conta.key + '__' + idTiny
          ]);

          totalConta++;
          Utilities.sleep(120);
        }
      });

      pagina++;
    } while (pagina <= totalPaginas);

    resumo.push({ conta: conta.key, nome: conta.nome, total: totalConta });
  });

  gravarNaPlanilha_(todasLinhas);

  PropertiesService.getScriptProperties().setProperty('VESCO_SYNC_LAST_RUN', String(Date.now()));
  return { success: true, total: todasLinhas.length, contas: resumo };
}

function gravarNaPlanilha_(linhas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);

  const antigosPorId = {};
  const antigosPorIdTinyConta = {};
  const dataPlanilha = sheet.getDataRange().getValues();

  if (dataPlanilha.length > 1) {
    const oldHeaders = dataPlanilha[0].map(h => String(h).trim());
    const idIndex = oldHeaders.indexOf('id');
    const idTinyIndex = oldHeaders.indexOf('id_tiny');
    const contaIndex = oldHeaders.indexOf('conta_tiny');

    for (let i = 1; i < dataPlanilha.length; i++) {
      const row = dataPlanilha[i];
      const id = String(row[idIndex >= 0 ? idIndex : 0] || '').trim();
      if (!id) continue;

      const obj = {};
      oldHeaders.forEach((h, idx) => obj[h] = row[idx]);
      antigosPorId[id] = obj;

      const idTiny = String(idTinyIndex >= 0 ? row[idTinyIndex] : extrairIdTinyDoIdPainelV13_(id) || '').trim();
      const conta = String(contaIndex >= 0 ? row[contaIndex] : '').trim();
      if (idTiny && conta) antigosPorIdTinyConta[conta + '__' + idTiny] = obj;
    }
  }

  const preserveFields = ['status_logistica','observacao_logistica','alarme','tempo_separacao'];

  const linhasProcessadas = (linhas || []).map(lin => {
    const id = String(lin[0] || '').trim();
    const objNovo = {};
    CABECALHO_LOGISTICA_V13.forEach((h, idx) => objNovo[h] = lin[idx]);

    const idTiny = String(objNovo.id_tiny || extrairIdTinyDoIdPainelV13_(id) || '').trim();
    const conta = String(objNovo.conta_tiny || '').trim();
    const antigo = antigosPorId[id] || antigosPorIdTinyConta[conta + '__' + idTiny] || {};

    preserveFields.forEach(campo => {
      if (antigo[campo] !== undefined && antigo[campo] !== null && String(antigo[campo]).trim() !== '') {
        objNovo[campo] = antigo[campo];
      }
    });

    if (
      antigo.tipo_entrega !== undefined && antigo.tipo_entrega !== null && String(antigo.tipo_entrega).trim() !== '' &&
      !IDS_FORMA_ENVIO_RETIRADA_V11[normalizarIdFormaEnvioVesco_(objNovo.id_forma_envio)]
    ) {
      objNovo.tipo_entrega = antigo.tipo_entrega;
    }

    const classificacao = classificarTipoEntregaVesco_(
      {
        id_forma_envio: objNovo.id_forma_envio,
        forma_envio_nome: objNovo.forma_envio_nome,
        transportadora: objNovo.transportadora,
        forma_envio: objNovo.forma_envio,
        forma_frete: objNovo.forma_frete
      },
      {
        observacoes: objNovo.observacoes_tiny,
        observacoes_internas: objNovo.observacoes_internas
      },
      objNovo.observacao_logistica
    );

    objNovo.tipo_entrega = classificacao.tipo_entrega;
    objNovo.prioridade_operacional = classificacao.prioridade_operacional;
    objNovo.prioridade_label = classificacao.prioridade_label;

    return CABECALHO_LOGISTICA_V13.map(h => objNovo[h] !== undefined ? objNovo[h] : '');
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, CABECALHO_LOGISTICA_V13.length)
    .setValues([CABECALHO_LOGISTICA_V13])
    .setFontWeight('bold')
    .setBackground('#004f9f')
    .setFontColor('#ffffff');

  sheet.setFrozenRows(1);

  if (linhasProcessadas.length > 0) {
    sheet.getRange(2, 1, linhasProcessadas.length, CABECALHO_LOGISTICA_V13.length).setValues(linhasProcessadas);
  }

  sheet.autoResizeColumns(1, CABECALHO_LOGISTICA_V13.length);
}

function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : null;
    const callback = e && e.parameter ? e.parameter.callback : null;

    if (action === 'formasEnvio' || action === 'formas_envio' || action === 'listarFormasEnvio') {
      const resposta = {
        success: true,
        formasEnvio: lerFormasEnvioVescoV12_(),
        mapa: FORMA_ENVIO_TINY_IDS_V11,
        idsRetirada: Object.keys(IDS_FORMA_ENVIO_RETIRADA_V11 || {})
      };

      if (callback) {
        return ContentService
          .createTextOutput(callback + '(' + JSON.stringify(resposta) + ');')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }

      return ContentService.createTextOutput(JSON.stringify(resposta)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'debugContasTiny') {
      const contas = obterTinyAccountsV13_().map(c => ({
        key: c.key,
        nome: c.nome,
        tokenConfigurado: !!c.token,
        manterIdOriginal: !!c.manterIdOriginal
      }));
      const resposta = { success: true, contas: contas, total: contas.length };

      if (callback) {
        return ContentService
          .createTextOutput(callback + '(' + JSON.stringify(resposta) + ');')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }

      return ContentService.createTextOutput(JSON.stringify(resposta)).setMimeType(ContentService.MimeType.JSON);
    }

    return doGet_V11_BASE_(e);
  } catch (err) {
    const callback = e && e.parameter ? e.parameter.callback : null;
    const erro = { success: false, error: err.message, stack: err.stack || '' };

    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(erro) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService.createTextOutput(JSON.stringify(erro)).setMimeType(ContentService.MimeType.JSON);
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚚 Vesco')
    .addItem('🔄 Sincronizar Pedidos Todas as Contas', 'sincronizarPedidosRecentes')
    .addItem('🚚 Criar/Atualizar Formas de Envio', 'criarAtualizarAbaFormasEnvio')
    .addItem('🧾 Atualizar Aba Contas Tiny', 'registrarDebugContasTinyV13_')
    .addSeparator()
    .addItem('⏱️ Ativar sincronia 30m', 'createSyncTrigger30Min')
    .addItem('🗑️ Remover sincronia', 'deleteSyncTriggers')
    .addToUi();
}

function instalar() {
  garantirAbaSeparacao_();
  criarAtualizarAbaFormasEnvio();
  registrarDebugContasTinyV13_();
  sincronizarPedidosRecentes();
  return 'OK';
}

console.log('Apps Script V13 ativo — multi-contas Tiny habilitado com TINY_TOKEN_COMERCIO e TINY_TOKEN_DISTRIBUIDORA.');

// ============================================================================
// VESCO LOGÍSTICA — CAMADA V14: FORMAS DE ENVIO POR CONTA TINY
// Regra de Preservação: mantém V13 e adiciona/expande o cadastro de formas
// de envio da conta DISTRIBUIDORA, sem remover os IDs já cadastrados.
// ============================================================================

const FORMAS_ENVIO_POR_CONTA_V14 = {
  COMERCIO: {
    '747632293': { nome: 'Correios', ativo: 'SIM' },
    '747632297': { nome: 'Transportadora', ativo: 'SIM' },
    '747632298': { nome: 'Retirar pessoalmente', ativo: 'SIM' },
    '769570519': { nome: 'Mercado Envios', ativo: 'SIM' },
    '778029845': { nome: 'Shopee Envios', ativo: 'SIM' },
    '780391986': { nome: 'Mercado Envios Flex', ativo: 'SIM' },
    '849173976': { nome: 'Amazon DBA', ativo: 'SIM' },
    '850044775': { nome: 'Magalu Entregas', ativo: 'SIM' },
    '852535843': { nome: 'Loggi', ativo: 'SIM' },
    '854284026': { nome: 'TikTok Shipping', ativo: 'SIM' },
    '860463094': { nome: 'RETIRADA', ativo: 'SIM' }
  },
  DISTRIBUIDORA: {
    '758290128': { nome: 'Correios', ativo: 'SIM' },
    '758290130': { nome: 'Transportadora', ativo: 'SIM' },
    '758290131': { nome: 'Retirar pessoalmente', ativo: 'SIM' },
    '778095610': { nome: 'Shopee Envios', ativo: 'SIM' },
    '780192106': { nome: 'Amazon DBA', ativo: 'SIM' },
    '846935602': { nome: 'LALAMOVE', ativo: 'SIM' },
    '847199235': { nome: 'Mercado Envios', ativo: 'SIM' },
    '850341481': { nome: 'Loggi', ativo: 'SIM' },
    '854536867': { nome: 'shopee - spx entrega rápida', ativo: 'NÃO' },
    '857757016': { nome: 'Enviali', ativo: 'SIM' }
  }
};

const IDS_FORMA_ENVIO_RETIRADA_V14 = {
  '747632298': true,
  '860463094': true,
  '758290131': true
};

function obterMapaFormasEnvioGlobalV14_() {
  const mapa = {};
  Object.keys(FORMAS_ENVIO_POR_CONTA_V14 || {}).forEach(conta => {
    const formas = FORMAS_ENVIO_POR_CONTA_V14[conta] || {};
    Object.keys(formas).forEach(id => {
      if (!mapa[id]) mapa[id] = formas[id].nome || '';
    });
  });
  return mapa;
}

function obterFormaEnvioPorIdV14_(idFormaEnvio, contaTiny) {
  const id = normalizarIdFormaEnvioVesco_(idFormaEnvio);
  if (!id) return null;

  const contaKey = String(contaTiny || '').trim().toUpperCase();
  if (contaKey && FORMAS_ENVIO_POR_CONTA_V14[contaKey] && FORMAS_ENVIO_POR_CONTA_V14[contaKey][id]) {
    return Object.assign({ conta_tiny: contaKey, id_forma_envio: id }, FORMAS_ENVIO_POR_CONTA_V14[contaKey][id]);
  }

  const contas = Object.keys(FORMAS_ENVIO_POR_CONTA_V14 || {});
  for (let i = 0; i < contas.length; i++) {
    const c = contas[i];
    const item = FORMAS_ENVIO_POR_CONTA_V14[c] && FORMAS_ENVIO_POR_CONTA_V14[c][id];
    if (item) return Object.assign({ conta_tiny: c, id_forma_envio: id }, item);
  }
  return null;
}

function nomeFormaEnvioPorIdVesco_(idFormaEnvio) {
  const item = obterFormaEnvioPorIdV14_(idFormaEnvio, '');
  return item ? item.nome : '';
}

function extrairIdFormaEnvioTinyVesco_(pedidoPesquisa, detalhe) {
  const p = pedidoPesquisa || {};
  const d = detalhe || {};
  const mapaGlobal = obterMapaFormasEnvioGlobalV14_();

  const candidatosDiretos = [
    p.idFormaEnvio, p.id_forma_envio, p.idFormaEnvioPsq, p.id_forma_envio_psq,
    p.forma_envio_id, p.formaEnvioId, p.idFormaFrete, p.id_forma_frete,
    pegarCaminhoVesco_(p, 'forma_envio.id'),
    pegarCaminhoVesco_(p, 'formaEnvio.id'),
    pegarCaminhoVesco_(p, 'transporte.idFormaEnvio'),
    pegarCaminhoVesco_(p, 'transporte.id_forma_envio'),
    d.idFormaEnvio, d.id_forma_envio, d.idFormaEnvioPsq, d.id_forma_envio_psq,
    d.forma_envio_id, d.formaEnvioId, d.idFormaFrete, d.id_forma_frete,
    pegarCaminhoVesco_(d, 'forma_envio.id'),
    pegarCaminhoVesco_(d, 'formaEnvio.id'),
    pegarCaminhoVesco_(d, 'transporte.idFormaEnvio'),
    pegarCaminhoVesco_(d, 'transporte.id_forma_envio'),
    pegarCaminhoVesco_(d, 'transporte.forma_envio.id'),
    pegarCaminhoVesco_(d, 'transporte.formaEnvio.id')
  ];

  for (let i = 0; i < candidatosDiretos.length; i++) {
    const id = normalizarIdFormaEnvioVesco_(candidatosDiretos[i]);
    if (id && mapaGlobal[id]) return id;
  }

  const encontrados = []
    .concat(buscarValoresRecursivosVescoV11_(p, nk => nk === 'idformaenvio' || nk === 'idformaenviopsq' || nk === 'idformafrete' || nk === 'formaenvioid', 7))
    .concat(buscarValoresRecursivosVescoV11_(d, nk => nk === 'idformaenvio' || nk === 'idformaenviopsq' || nk === 'idformafrete' || nk === 'formaenvioid', 7));

  for (let j = 0; j < encontrados.length; j++) {
    const id = normalizarIdFormaEnvioVesco_(encontrados[j]);
    if (id && mapaGlobal[id]) return id;
  }

  const texto = normalizarTextoVesco_([
    p.forma_envio, p.nome_forma_envio, p.formaEnvio, p.tipo_envio, p.modalidade_envio,
    d.forma_envio, d.nome_forma_envio, d.formaEnvio, d.tipo_envio, d.modalidade_envio,
    pegarCaminhoVesco_(d, 'transporte.forma_envio'),
    pegarCaminhoVesco_(d, 'transporte.nome_forma_envio'),
    pegarCaminhoVesco_(d, 'transportador.nome'),
    pegarCaminhoVesco_(d, 'transportadora.nome')
  ].join(' | '));

  const entries = Object.keys(mapaGlobal);
  for (let k = 0; k < entries.length; k++) {
    const id = entries[k];
    const nome = normalizarTextoVesco_(mapaGlobal[id]);
    if (nome && texto.includes(nome)) return id;
  }

  return '';
}

function classificarTipoEntregaVesco_(transporte, obsTiny, obsLogisticaAtual) {
  const idFormaEnvio = normalizarIdFormaEnvioVesco_(transporte && transporte.id_forma_envio);
  const texto = normalizarTextoVesco_([
    idFormaEnvio,
    transporte && transporte.forma_envio_nome,
    transporte && transporte.transportadora,
    transporte && transporte.forma_envio,
    transporte && transporte.forma_frete,
    obsTiny && obsTiny.observacoes,
    obsTiny && obsTiny.observacoes_internas,
    obsLogisticaAtual
  ].join(' | '));

  if (
    texto.includes('emergencial') ||
    texto.includes('urgente') ||
    texto.includes('prioridade') ||
    texto.includes('prioritario')
  ) {
    return { tipo_entrega: 'Emergencial', prioridade_operacional: 1, prioridade_label: '1 - Emergencial' };
  }

  if (
    IDS_FORMA_ENVIO_RETIRADA_V14[idFormaEnvio] ||
    texto.includes('retirada') ||
    texto.includes('retirar') ||
    texto.includes('retira') ||
    texto.includes('retirar pessoalmente') ||
    texto.includes('balcao') ||
    texto.includes('balcão') ||
    texto.includes('cliente retira') ||
    texto.includes('retira pessoalmente')
  ) {
    return { tipo_entrega: 'Retirada', prioridade_operacional: 2, prioridade_label: '2 - Retirada' };
  }

  return { tipo_entrega: 'Normal', prioridade_operacional: 3, prioridade_label: '3 - Entrega' };
}

function montarLinhasFormasEnvioVescoV12_() {
  const agora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss');
  const linhas = [];

  Object.keys(FORMAS_ENVIO_POR_CONTA_V14 || {}).forEach(conta => {
    const formas = FORMAS_ENVIO_POR_CONTA_V14[conta] || {};

    Object.keys(formas).forEach(id => {
      const item = formas[id] || {};
      const nome = item.nome || '';
      const ativo = item.ativo || 'SIM';
      const isRetirada = !!IDS_FORMA_ENVIO_RETIRADA_V14[id];
      const nomeNorm = String(nome || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      let tipoOperacional = 'Entrega';
      let prioridade = 3;
      let label = '3 - Entrega';
      let canal = 'Entrega normal';

      if (isRetirada || nomeNorm.includes('retirada') || nomeNorm.includes('retirar')) {
        tipoOperacional = 'Retirada';
        prioridade = 2;
        label = '2 - Retirada';
        canal = 'Retirada';
      } else if (nomeNorm.includes('emergencial') || nomeNorm.includes('urgente')) {
        tipoOperacional = 'Emergencial';
        prioridade = 1;
        label = '1 - Emergencial';
        canal = 'Emergencial';
      } else if (nomeNorm.includes('flex')) {
        canal = 'Mercado Envios Flex';
      } else if (nomeNorm.includes('mercado')) {
        canal = 'Mercado Envios';
      } else if (nomeNorm.includes('shopee') || nomeNorm.includes('spx')) {
        canal = 'Shopee Envios';
      } else if (nomeNorm.includes('amazon')) {
        canal = 'Amazon DBA';
      } else if (nomeNorm.includes('magalu')) {
        canal = 'Magalu Entregas';
      } else if (nomeNorm.includes('loggi')) {
        canal = 'Loggi';
      } else if (nomeNorm.includes('lalamove')) {
        canal = 'Lalamove';
      } else if (nomeNorm.includes('enviali')) {
        canal = 'Enviali';
      } else if (nomeNorm.includes('tiktok')) {
        canal = 'TikTok Shipping';
      } else if (nomeNorm.includes('correios')) {
        canal = 'Correios';
      } else if (nomeNorm.includes('transportadora')) {
        canal = 'Transportadora';
      }

      linhas.push([
        conta,
        id,
        nome,
        tipoOperacional,
        prioridade,
        label,
        isRetirada ? 'SIM' : 'NÃO',
        canal,
        ativo,
        agora
      ]);
    });
  });

  return linhas;
}

function criarAtualizarAbaFormasEnvio() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(FORMAS_ENVIO_SHEET_NAME_V12);
  if (!sh) sh = ss.insertSheet(FORMAS_ENVIO_SHEET_NAME_V12);

  const headers = [
    'conta_tiny',
    'id_forma_envio',
    'forma_envio_nome',
    'tipo_operacional',
    'prioridade_operacional',
    'prioridade_label',
    'eh_retirada',
    'canal_logistico',
    'ativo',
    'atualizado_em'
  ];

  const linhas = montarLinhasFormasEnvioVescoV12_();

  sh.clear();
  sh.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#004f9f')
    .setFontColor('#ffffff');

  if (linhas.length > 0) {
    sh.getRange(2, 1, linhas.length, headers.length).setValues(linhas);
  }

  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);

  if (linhas.length > 0) {
    sh.getRange(2, 5, linhas.length, 1).setNumberFormat('0');
    for (let i = 0; i < linhas.length; i++) {
      const rowNumber = i + 2;
      const tipo = linhas[i][3];
      const ativo = linhas[i][8];

      if (tipo === 'Retirada') {
        sh.getRange(rowNumber, 1, 1, headers.length).setBackground('#fff7ed');
      } else if (tipo === 'Emergencial') {
        sh.getRange(rowNumber, 1, 1, headers.length).setBackground('#fef2f2');
      } else if (ativo === 'NÃO') {
        sh.getRange(rowNumber, 1, 1, headers.length).setBackground('#f1f5f9');
      }
    }
  }

  return { success: true, sheet: FORMAS_ENVIO_SHEET_NAME_V12, total: linhas.length };
}

function lerFormasEnvioVescoV12_() {
  criarAtualizarAbaFormasEnvio();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(FORMAS_ENVIO_SHEET_NAME_V12);
  if (!sh) return [];

  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];
  const headers = values[0].map(h => String(h || '').trim());

  return values.slice(1).filter(row => String(row[1] || '').trim() !== '').map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

// Ajuste extra: quando o painel consultar ?action=formasEnvio, a função antiga
// continuará funcionando porque chama lerFormasEnvioVescoV12_(). O campo "mapa"
// antigo ainda pode sair só com IDs da primeira conta, então o dado oficial passa
// a ser o array formasEnvio, que agora contém COMERCIO e DISTRIBUIDORA.

console.log('Apps Script V14 ativo — FormasEnvio por conta Tiny: COMERCIO + DISTRIBUIDORA.');

// ============================================================================
// VESCO LOGÍSTICA — CAMADA V15: RETIRADAS + OBS/LINK + CORREÇÃO FORMA ENVIO
// Objetivos:
// - corrigir forma de envio por conta Tiny (ex.: DISTRIBUIDORA LALAMOVE não virar Mercado Envios Flex);
// - criar campos observacao_pedido e link_pedido;
// - expor dados limpos ao painel;
// - preservar lógica antiga por sobrescrita aditiva.
// ============================================================================

const CABECALHO_LOGISTICA_V15 = (function(){
  const base = (typeof CABECALHO_LOGISTICA_V13 !== 'undefined' ? CABECALHO_LOGISTICA_V13.slice() : (typeof CABECALHO_LOGISTICA_V11 !== 'undefined' ? CABECALHO_LOGISTICA_V11.slice() : CABECALHO.slice()));
  ['observacao_pedido','link_pedido'].forEach(c => { if (base.indexOf(c) === -1) base.push(c); });
  return base;
})();

const FORMAS_ENVIO_CORRECAO_V15 = {
  COMERCIO: {
    '747632293': 'Correios',
    '747632297': 'Transportadora',
    '747632298': 'Retirar pessoalmente',
    '769570519': 'Mercado Envios',
    '778029845': 'Shopee Envios',
    '780391986': 'Mercado Envios Flex',
    '849173976': 'Amazon DBA',
    '850044775': 'Magalu Entregas',
    '852535843': 'Loggi',
    '854284026': 'TikTok Shipping',
    '860463094': 'RETIRADA'
  },
  DISTRIBUIDORA: {
    '758290128': 'Correios',
    '758290130': 'Transportadora',
    '758290131': 'Retirar pessoalmente',
    '778095610': 'Shopee Envios',
    '780192106': 'Amazon DBA',
    '846935602': 'LALAMOVE',
    '847199235': 'Mercado Envios',
    '850341481': 'Loggi',
    '854536867': 'shopee - spx entrega rápida',
    '857757016': 'Enviali'
  }
};

function contaKeyV15_(conta) {
  const txt = String(conta || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (txt.indexOf('DISTRIB') !== -1) return 'DISTRIBUIDORA';
  return 'COMERCIO';
}

function normalizarTextoV15_(v) {
  return String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizarCompactoV15_(v) {
  return normalizarTextoV15_(v).replace(/[^a-z0-9]/g, '');
}

function detectarFormaPorNomeV15_(texto, contaTiny) {
  const conta = contaKeyV15_(contaTiny);
  const t = normalizarCompactoV15_(texto);
  if (!t) return null;

  function out(id, nome) { return { id_forma_envio: id, forma_envio_nome: nome }; }

  if (t.indexOf('lalamove') !== -1) return out('846935602', 'LALAMOVE');
  if (t.indexOf('enviali') !== -1) return out('857757016', 'Enviali');
  if (t.indexOf('retirarpessoalmente') !== -1 || t.indexOf('retirada') !== -1 || t.indexOf('retirar') !== -1) return conta === 'DISTRIBUIDORA' ? out('758290131', 'Retirar pessoalmente') : out('747632298', 'Retirar pessoalmente');
  if (t.indexOf('mercadoenviosflex') !== -1 || t === 'flex' || t.indexOf(' flex') !== -1) return conta === 'DISTRIBUIDORA' ? out('847199235', 'Mercado Envios') : out('780391986', 'Mercado Envios Flex');
  if (t.indexOf('mercadoenvios') !== -1 || t.indexOf('mercado') !== -1) return conta === 'DISTRIBUIDORA' ? out('847199235', 'Mercado Envios') : out('769570519', 'Mercado Envios');
  if (t.indexOf('shopee') !== -1 || t.indexOf('spx') !== -1) return conta === 'DISTRIBUIDORA' ? out('778095610', 'Shopee Envios') : out('778029845', 'Shopee Envios');
  if (t.indexOf('amazon') !== -1) return conta === 'DISTRIBUIDORA' ? out('780192106', 'Amazon DBA') : out('849173976', 'Amazon DBA');
  if (t.indexOf('loggi') !== -1) return conta === 'DISTRIBUIDORA' ? out('850341481', 'Loggi') : out('852535843', 'Loggi');
  if (t.indexOf('tiktok') !== -1) return out('854284026', 'TikTok Shipping');
  if (t.indexOf('correios') !== -1) return conta === 'DISTRIBUIDORA' ? out('758290128', 'Correios') : out('747632293', 'Correios');
  if (t.indexOf('transportadora') !== -1) return conta === 'DISTRIBUIDORA' ? out('758290130', 'Transportadora') : out('747632297', 'Transportadora');
  return null;
}

function nomeFormaPorIdContaV15_(idFormaEnvio, contaTiny) {
  const id = normalizarIdFormaEnvioVesco_(idFormaEnvio);
  const conta = contaKeyV15_(contaTiny);
  if (FORMAS_ENVIO_CORRECAO_V15[conta] && FORMAS_ENVIO_CORRECAO_V15[conta][id]) return FORMAS_ENVIO_CORRECAO_V15[conta][id];
  const contas = Object.keys(FORMAS_ENVIO_CORRECAO_V15);
  for (let i = 0; i < contas.length; i++) {
    const c = contas[i];
    if (FORMAS_ENVIO_CORRECAO_V15[c][id]) return FORMAS_ENVIO_CORRECAO_V15[c][id];
  }
  return '';
}

function corrigirFormaEnvioObjetoV15_(obj) {
  if (!obj) return obj;
  const conta = contaKeyV15_(obj.conta_tiny || obj.conta || '');
  const textoNome = [
    obj.forma_envio_nome,
    obj.nome_forma_envio,
    obj.nomeformafenvio,
    obj.transportadora,
    obj.transportador,
    obj.nome_transportadora,
    obj.forma_envio,
    obj.forma_frete,
    obj.transporte_completo
  ].filter(Boolean).join(' | ');

  const detectado = detectarFormaPorNomeV15_(textoNome, conta);
  const idAtual = normalizarIdFormaEnvioVesco_(obj.id_forma_envio || obj.idFormaEnvio || obj.idFormaEnvioPsq || obj.forma_envio_id);

  // Nome explícito vence ID antigo/incompatível. Esse é o caso LALAMOVE mostrado como Mercado Envios Flex.
  if (detectado && detectado.forma_envio_nome) {
    obj.id_forma_envio = detectado.id_forma_envio;
    obj.forma_envio_nome = detectado.forma_envio_nome;
  } else if (idAtual) {
    const nome = nomeFormaPorIdContaV15_(idAtual, conta);
    if (nome) {
      obj.id_forma_envio = idAtual;
      obj.forma_envio_nome = nome;
    }
  }

  if (obj.forma_envio_nome) {
    obj.nome_forma_envio = obj.forma_envio_nome;
    obj.nomeformafenvio = obj.forma_envio_nome;
    if (!obj.transportadora || normalizarTextoV15_(obj.transportadora) === 'x') obj.transportadora = obj.forma_envio_nome;
    obj.transportador = obj.transportadora || obj.forma_envio_nome;
    obj.nome_transportadora = obj.transportadora || obj.forma_envio_nome;
    obj.nome_transportador = obj.transportadora || obj.forma_envio_nome;
  }

  const classif = classificarTipoEntregaVesco_(
    {
      id_forma_envio: obj.id_forma_envio,
      forma_envio_nome: obj.forma_envio_nome,
      transportadora: obj.transportadora,
      forma_envio: obj.forma_envio,
      forma_frete: obj.forma_frete
    },
    { observacoes: obj.observacoes_tiny, observacoes_internas: obj.observacoes_internas },
    [obj.observacao_logistica, obj.observacao_pedido].filter(Boolean).join(' | ')
  );

  obj.tipo_entrega = classif.tipo_entrega;
  obj.prioridade_operacional = classif.prioridade_operacional;
  obj.prioridade_label = classif.prioridade_label;
  return obj;
}

function garantirColunasPedidosV15_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (!values || values.length === 0 || values[0].length === 0 || String(values[0][0] || '').trim() === '') {
    sheet.getRange(1, 1, 1, CABECALHO_LOGISTICA_V15.length).setValues([CABECALHO_LOGISTICA_V15]);
    return sheet;
  }

  const headers = values[0].map(h => String(h || '').trim());
  let changed = false;
  CABECALHO_LOGISTICA_V15.forEach(h => {
    if (headers.indexOf(h) === -1) {
      headers.push(h);
      changed = true;
    }
  });
  if (changed) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function atualizarExtrasPedidoV15_(params) {
  const id = String(params.id || params.numero || '').trim();
  if (!id) return { success: false, error: 'missing_id' };

  const sheet = garantirColunasPedidosV15_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || '').trim());

  function col(name) {
    let idx = headers.indexOf(name);
    if (idx === -1) {
      headers.push(name);
      idx = headers.length - 1;
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    return idx + 1;
  }

  const idCol = headers.indexOf('id');
  const numeroCol = headers.indexOf('numero');
  const pedidoKeyCol = headers.indexOf('pedido_key');
  const obsCol = col('observacao_pedido');
  const linkCol = col('link_pedido');
  const obsLogCol = headers.indexOf('observacao_logistica') + 1;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const matches = [
      idCol >= 0 ? row[idCol] : '',
      numeroCol >= 0 ? row[numeroCol] : '',
      pedidoKeyCol >= 0 ? row[pedidoKeyCol] : ''
    ].map(v => String(v || '').trim());

    if (matches.indexOf(id) !== -1) {
      if (params.observacao_pedido !== undefined) sheet.getRange(i + 1, obsCol).setValue(String(params.observacao_pedido || '').trim());
      if (params.link_pedido !== undefined) sheet.getRange(i + 1, linkCol).setValue(String(params.link_pedido || '').trim());

      // Também preserva rastreabilidade dentro de observacao_logistica, sem apagar a observação existente.
      if (obsLogCol > 0 && (params.observacao_pedido || params.link_pedido)) {
        const atual = String(row[obsLogCol - 1] || '').trim();
        const bloco = ['[Obs pedido] ' + String(params.observacao_pedido || '').trim(), '[Link pedido] ' + String(params.link_pedido || '').trim()].filter(x => !/\]\s*$/.test(x)).join(' | ');
        if (bloco && atual.indexOf(bloco) === -1) sheet.getRange(i + 1, obsLogCol).setValue([atual, bloco].filter(Boolean).join(' | '));
      }

      return { success: true, row: i + 1 };
    }
  }
  return { success: false, error: 'id_not_found' };
}

function gravarNaPlanilha_(linhas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);

  const antigosPorId = {};
  const antigosPorIdTinyConta = {};
  const dataPlanilha = sheet.getDataRange().getValues();

  if (dataPlanilha.length > 1) {
    const oldHeaders = dataPlanilha[0].map(h => String(h).trim());
    const idIndex = oldHeaders.indexOf('id');
    const idTinyIndex = oldHeaders.indexOf('id_tiny');
    const contaIndex = oldHeaders.indexOf('conta_tiny');

    for (let i = 1; i < dataPlanilha.length; i++) {
      const row = dataPlanilha[i];
      const id = String(row[idIndex >= 0 ? idIndex : 0] || '').trim();
      if (!id) continue;

      const obj = {};
      oldHeaders.forEach((h, idx) => obj[h] = row[idx]);
      antigosPorId[id] = obj;

      const idTiny = String(idTinyIndex >= 0 ? row[idTinyIndex] : extrairIdTinyDoIdPainelV13_(id) || '').trim();
      const conta = String(contaIndex >= 0 ? row[contaIndex] : '').trim();
      if (idTiny && conta) antigosPorIdTinyConta[conta + '__' + idTiny] = obj;
    }
  }

  const preserveFields = ['status_logistica','observacao_logistica','alarme','tempo_separacao','observacao_pedido','link_pedido'];

  const linhasProcessadas = (linhas || []).map(lin => {
    const id = String(lin[0] || '').trim();
    const objNovo = {};
    const origemHeaders = (typeof CABECALHO_LOGISTICA_V13 !== 'undefined' && lin.length <= CABECALHO_LOGISTICA_V13.length) ? CABECALHO_LOGISTICA_V13 : CABECALHO_LOGISTICA_V15;
    origemHeaders.forEach((h, idx) => objNovo[h] = lin[idx]);

    const idTiny = String(objNovo.id_tiny || extrairIdTinyDoIdPainelV13_(id) || '').trim();
    const conta = String(objNovo.conta_tiny || '').trim();
    const antigo = antigosPorId[id] || antigosPorIdTinyConta[conta + '__' + idTiny] || {};

    preserveFields.forEach(campo => {
      if (antigo[campo] !== undefined && antigo[campo] !== null && String(antigo[campo]).trim() !== '') {
        objNovo[campo] = antigo[campo];
      }
    });

    corrigirFormaEnvioObjetoV15_(objNovo);
    return CABECALHO_LOGISTICA_V15.map(h => objNovo[h] !== undefined ? objNovo[h] : '');
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, CABECALHO_LOGISTICA_V15.length)
    .setValues([CABECALHO_LOGISTICA_V15])
    .setFontWeight('bold')
    .setBackground('#004f9f')
    .setFontColor('#ffffff');

  sheet.setFrozenRows(1);

  if (linhasProcessadas.length > 0) {
    sheet.getRange(2, 1, linhasProcessadas.length, CABECALHO_LOGISTICA_V15.length).setValues(linhasProcessadas);
  }

  sheet.autoResizeColumns(1, CABECALHO_LOGISTICA_V15.length);
}

function doGet_V16_FINAL_BASE_(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : null;
    const callback = e && e.parameter ? e.parameter.callback : null;
    const fusoHorario = Session.getScriptTimeZone();
    let resposta;

    if (action === 'formasEnvio' || action === 'formas_envio' || action === 'listarFormasEnvio') {
      resposta = {
        success: true,
        formasEnvio: lerFormasEnvioVescoV12_(),
        formasEnvioPorConta: FORMAS_ENVIO_CORRECAO_V15,
        idsRetirada: Object.keys(IDS_FORMA_ENVIO_RETIRADA_V14 || IDS_FORMA_ENVIO_RETIRADA_V11 || {})
      };
    } else if (action === 'updatePedidoExtras' || action === 'updateExtrasPedido' || action === 'salvarExtrasPedido') {
      resposta = atualizarExtrasPedidoV15_(e.parameter || {});
    } else if (action === 'debugContasTiny') {
      const contas = obterTinyAccountsV13_().map(c => ({ key: c.key, nome: c.nome, tokenConfigurado: !!c.token, manterIdOriginal: !!c.manterIdOriginal }));
      resposta = { success: true, contas: contas, total: contas.length };
    } else if (action === 'geocode' || action === 'updateStatus' || action === 'debugHeaders' || action === 'debugFormaEnvio') {
      return doGet_V11_BASE_(e);
    } else {
      const sheet = garantirColunasPedidosV15_();
      const vals = sheet.getDataRange().getValues();
      const headers = vals[0].map(h => String(h || '').trim());

      const outPedidos = vals.slice(1).filter(row => String(row[0] || '').trim() !== '').map(row => {
        const o = {};
        headers.forEach((h, i) => {
          let val = row[i];
          if ((h === 'data_prevista' || h === 'data_pedido') && val !== '') {
            if (val instanceof Date) {
              val = Utilities.formatDate(val, fusoHorario, 'dd/MM/yyyy');
            } else {
              const d = new Date(val);
              if (!isNaN(d.getTime())) val = Utilities.formatDate(d, fusoHorario, 'dd/MM/yyyy');
            }
          }
          o[h] = val;
        });

        corrigirFormaEnvioObjetoV15_(o);

        const idFormaEnvio = normalizarIdFormaEnvioVesco_(o.id_forma_envio);
        const nomeFormaEnvio = o.forma_envio_nome || nomeFormaPorIdContaV15_(idFormaEnvio, o.conta_tiny) || o.forma_envio || '';
        const obsTinyCompleta = juntarUnicosVesco_([o.observacoes_tiny, o.observacoes_internas], ' | ');
        const transporteCompleto = juntarUnicosVesco_([idFormaEnvio, nomeFormaEnvio, o.transportadora, o.forma_envio, o.forma_frete], ' | ');

        o.ecom = '';
        o.destinatario = o.cliente_nome;
        o.idFormaEnvio = idFormaEnvio;
        o.idFormaEnvioPsq = idFormaEnvio;
        o.id_forma_envio_psq = idFormaEnvio;
        o.forma_envio_id = idFormaEnvio;
        o.forma_envio_nome = nomeFormaEnvio;
        o.nome_forma_envio = nomeFormaEnvio || o.forma_envio || o.transportadora || o.forma_pagamento || o.tipo_entrega || '';
        o.nomeformafenvio = o.nome_forma_envio;
        o.forma_envio_tiny = o.forma_envio || nomeFormaEnvio || '';
        o.forma_frete_tiny = o.forma_frete || '';
        o.frete_por_conta = o.forma_frete || '';
        o.transportador = o.transportadora || nomeFormaEnvio || '';
        o.nome_transportador = o.transportadora || nomeFormaEnvio || '';
        o.nome_transportadora = o.transportadora || nomeFormaEnvio || '';
        o.transporte_completo = transporteCompleto;
        o.observacao_tiny = obsTinyCompleta;
        o.observacoes = obsTinyCompleta;
        o.observacao = juntarUnicosVesco_([o.observacao_logistica, o.observacao_pedido, obsTinyCompleta], ' | ');
        o.linkPedido = o.link_pedido || '';
        o.link_tiny = o.link_pedido || '';
        return o;
      });

      let outPropostas = [];
      const sheetProp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PROPOSALS_SHEET);
      if (sheetProp) {
        const valsProp = sheetProp.getDataRange().getValues();
        const headersProp = valsProp[0] || [];
        outPropostas = valsProp.slice(1).map(row => {
          const p = {};
          headersProp.forEach((h, i) => {
            const headClean = String(h).trim();
            if (['numero', 'cliente_nome', 'endereco_completo'].includes(headClean)) p[headClean] = row[i];
          });
          return p;
        });
      }

      resposta = { success: true, data: outPedidos, propostas: outPropostas };
    }

    if (callback) {
      return ContentService.createTextOutput(callback + '(' + JSON.stringify(resposta) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(JSON.stringify(resposta)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const callback = e && e.parameter ? e.parameter.callback : null;
    const erro = { success: false, error: err.message, stack: err.stack || '' };
    if (callback) return ContentService.createTextOutput(callback + '(' + JSON.stringify(erro) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(erro)).setMimeType(ContentService.MimeType.JSON);
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚚 Vesco')
    .addItem('🔄 Sincronizar Pedidos Todas as Contas', 'sincronizarPedidosRecentes')
    .addItem('🚚 Criar/Atualizar Formas de Envio', 'criarAtualizarAbaFormasEnvio')
    .addItem('🧾 Atualizar Aba Contas Tiny', 'registrarDebugContasTinyV13_')
    .addItem('🧩 Garantir colunas Obs/Link', 'garantirColunasPedidosV15_')
    .addSeparator()
    .addItem('⏱️ Ativar sincronia 30m', 'createSyncTrigger30Min')
    .addItem('🗑️ Remover sincronia', 'deleteSyncTriggers')
    .addToUi();
}

console.log('Apps Script V15 ativo — formas por conta corrigidas, obs/link e endpoint updatePedidoExtras.');

// ============================================================================
// VESCO LOGÍSTICA — CAMADA V16: PROTEÇÃO CONTRA BLOQUEIO DA API TINY
// Regra de Preservação: esta camada mantém todo o legado e substitui apenas
// a rotina de sincronização por uma versão com cooldown, retry controlado,
// preservação de contas bloqueadas e cache de detalhes.
// ============================================================================

const VESCO_TINY_API_V16 = {
  COOLDOWN_MINUTES: 15,
  DELAY_BETWEEN_SEARCH_MS: 900,
  DELAY_BETWEEN_DETAIL_MS: 650,
  DETAIL_CACHE_SECONDS: 1800,
  BLOCK_ERROR_CODE: 6
};

function vescoNormalizeContaKeyV16_(v, pedidoKey) {
  const raw = String(v || pedidoKey || '').trim();
  const s = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  if (s.indexOf('DISTRIBUIDORA') !== -1 || s.indexOf('DISTRIB') !== -1) return 'DISTRIBUIDORA';
  if (s.indexOf('COMERCIO') !== -1 || s.indexOf('COMÉRCIO') !== -1) return 'COMERCIO';
  return s || '';
}

function vescoTinyCooldownKeyV16_(contaKey) {
  return 'VESCO_TINY_BLOCKED_UNTIL_' + vescoNormalizeContaKeyV16_(contaKey);
}

function vescoTinyLastErrorKeyV16_(contaKey) {
  return 'VESCO_TINY_LAST_ERROR_' + vescoNormalizeContaKeyV16_(contaKey);
}

function vescoTinyIsBlockedJsonV16_(json) {
  try {
    const ret = json && json.retorno ? json.retorno : json;
    const codigo = Number(ret && ret.codigo_erro);
    const texto = JSON.stringify(ret || '').toLowerCase();
    return codigo === VESCO_TINY_API_V16.BLOCK_ERROR_CODE ||
      texto.indexOf('api bloqueada') !== -1 ||
      texto.indexOf('excedido o número de acessos') !== -1 ||
      texto.indexOf('excedido o numero de acessos') !== -1;
  } catch (e) {
    return false;
  }
}

function vescoTinyGetCooldownV16_(contaKey) {
  const props = PropertiesService.getScriptProperties();
  const until = Number(props.getProperty(vescoTinyCooldownKeyV16_(contaKey)) || '0');
  return {
    until: until,
    active: until && Date.now() < until,
    remainingMs: until ? Math.max(0, until - Date.now()) : 0
  };
}

function vescoTinySetCooldownV16_(contaKey, json, minutes) {
  const props = PropertiesService.getScriptProperties();
  const mins = Number(minutes || VESCO_TINY_API_V16.COOLDOWN_MINUTES);
  const until = Date.now() + mins * 60 * 1000;
  props.setProperty(vescoTinyCooldownKeyV16_(contaKey), String(until));
  props.setProperty(vescoTinyLastErrorKeyV16_(contaKey), JSON.stringify({
    at: new Date().toISOString(),
    conta: contaKey,
    cooldownMinutes: mins,
    error: json && json.retorno ? json.retorno : json
  }).slice(0, 9000));
  console.warn('Tiny API bloqueada para conta ' + contaKey + '. Cooldown até ' + new Date(until).toLocaleString('pt-BR'));
  return until;
}

function vescoTinyClearCooldownV16_(contaKey) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(vescoTinyCooldownKeyV16_(contaKey));
}

function vescoTinyFetchPostJsonV16_(url, payload, contaKey, origem) {
  const cooldown = vescoTinyGetCooldownV16_(contaKey);
  if (cooldown.active) {
    return {
      success: false,
      skipped: true,
      blocked: true,
      cooldownUntil: cooldown.until,
      json: null,
      error: 'Conta em cooldown por bloqueio da API Tiny. Origem: ' + (origem || 'Tiny')
    };
  }

  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });

    const httpCode = res.getResponseCode ? res.getResponseCode() : 200;
    const text = res.getContentText();
    let json;

    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      json = { retorno: { status: 'Erro', codigo_erro: 'parse', erros: [{ erro: text.slice(0, 300) }] } };
    }

    if (httpCode === 429 || vescoTinyIsBlockedJsonV16_(json)) {
      const until = vescoTinySetCooldownV16_(contaKey, json, VESCO_TINY_API_V16.COOLDOWN_MINUTES);
      return {
        success: false,
        blocked: true,
        cooldownUntil: until,
        json: json,
        error: 'API Tiny bloqueada por limite de acessos.'
      };
    }

    if (json && json.retorno && json.retorno.status === 'OK') {
      vescoTinyClearCooldownV16_(contaKey);
      return { success: true, blocked: false, json: json };
    }

    return {
      success: false,
      blocked: false,
      json: json,
      error: json && json.retorno ? JSON.stringify(json.retorno) : 'Resposta Tiny inválida'
    };
  } catch (err) {
    return {
      success: false,
      blocked: false,
      json: null,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function vescoDetailCacheKeyV16_(contaKey, idTiny) {
  const raw = String(contaKey || '') + '__' + String(idTiny || '');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return 'tiny_detail_v16_' + bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function obterDetalhePedidoPorTokenV16_(id, conta) {
  const contaKey = conta && conta.key ? conta.key : 'TINY';
  const token = conta && conta.token ? conta.token : '';
  const idTiny = extrairIdTinyDoIdPainelV13_(id);
  const cache = CacheService.getScriptCache();
  const cacheKey = vescoDetailCacheKeyV16_(contaKey, idTiny);

  try {
    const cached = cache.get(cacheKey);
    if (cached) return { success: true, blocked: false, pedido: JSON.parse(cached), fromCache: true };
  } catch (e) {}

  const payload = `token=${encodeURIComponent(token)}&formato=JSON&id=${encodeURIComponent(idTiny)}`;
  const result = vescoTinyFetchPostJsonV16_(CONFIG.URL_OBTER, payload, contaKey, 'pedido.obter');

  if (!result.success) {
    return {
      success: false,
      blocked: !!result.blocked,
      skipped: !!result.skipped,
      error: result.error,
      json: result.json
    };
  }

  const pedido = result.json && result.json.retorno ? result.json.retorno.pedido : null;
  if (pedido) {
    try { cache.put(cacheKey, JSON.stringify(pedido), VESCO_TINY_API_V16.DETAIL_CACHE_SECONDS); } catch(e) {}
  }
  return { success: !!pedido, blocked: false, pedido: pedido };
}

function vescoLerLinhasAtuaisPorContaV16_(contasPreservar) {
  const sh = garantirColunasPedidosV15_ ? garantirColunasPedidosV15_() : SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) return [];

  const vals = sh.getDataRange().getValues();
  if (!vals || vals.length < 2) return [];

  const headers = vals[0].map(h => String(h || '').trim());
  const contaIndex = headers.indexOf('conta_tiny');
  const pedidoKeyIndex = headers.indexOf('pedido_key');
  const preserveSet = {};
  (contasPreservar || []).forEach(c => preserveSet[vescoNormalizeContaKeyV16_(c)] = true);

  return vals.slice(1).filter(row => {
    const conta = contaIndex >= 0 ? row[contaIndex] : '';
    const pedidoKey = pedidoKeyIndex >= 0 ? row[pedidoKeyIndex] : '';
    const key = vescoNormalizeContaKeyV16_(conta, pedidoKey);
    return !!preserveSet[key];
  }).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    const cab = typeof CABECALHO_LOGISTICA_V15 !== 'undefined' ? CABECALHO_LOGISTICA_V15 : CABECALHO_LOGISTICA_V13;
    return cab.map(h => obj[h] !== undefined ? obj[h] : '');
  });
}

function vescoMontarLinhaPedidoTinyV16_(conta, pedidoPesquisa, detalhe) {
  const p = pedidoPesquisa || {};
  const idTiny = String(p.id || '').trim();
  const idPainel = montarIdPainelV13_(conta, idTiny);

  let enderecoFormatado = 'Endereço não disponível';
  let formaPagamento = 'Não informado';
  let instrucao = '⚠️ Verificar pagamento';
  let lat = '';
  let lon = '';

  let transporte = { id_forma_envio: '', forma_envio_nome: '', transportadora: '', forma_envio: '', forma_frete: '', transporte_completo: '' };
  let obsTiny = { observacoes: '', observacoes_internas: '', observacao_completa: '' };
  let classificacao = { tipo_entrega: 'Normal', prioridade_operacional: 3, prioridade_label: '3 - Entrega' };

  if (detalhe) {
    enderecoFormatado = montarEnderecoEntregaVesco_(detalhe);

    const fpag = [];
    if (detalhe.parcelas) {
      detalhe.parcelas.forEach(parc => {
        if (parc.parcela && parc.parcela.forma_pagamento) fpag.push(parc.parcela.forma_pagamento);
      });
    }
    if (fpag.length === 0 && detalhe.forma_pagamento) fpag.push(detalhe.forma_pagamento);

    formaPagamento = fpag.filter(Boolean).join(' + ') || 'Não informado';
    instrucao = gerarInstrucao_(formaPagamento, p.valor || detalhe.totalPedido || 0);

    transporte = extrairTransporteTinyVesco_(p, detalhe);
    obsTiny = extrairObservacoesTinyVesco_(detalhe);
    classificacao = classificarTipoEntregaVesco_(transporte, obsTiny, '');

    // Geocodificação preservada, mas só quando realmente existe endereço.
    if (enderecoFormatado !== 'Endereço não disponível') {
      const coords = buscarCoordenadas_(enderecoFormatado);
      lat = coords.lat || '';
      lon = coords.lon || '';
    }
  }

  const linha = [
    idPainel,
    p.numero || '',
    p.data_pedido || '',
    p.data_prevista || '',
    p.nome || '',
    p.situacao || '',
    p.valor || 0,
    enderecoFormatado,
    formaPagamento,
    instrucao,
    'A Separar',
    '',
    '',
    '',
    classificacao.tipo_entrega,
    transporte.id_forma_envio || '',
    transporte.forma_envio_nome || '',
    transporte.transportadora || '',
    transporte.forma_envio || '',
    transporte.forma_frete || '',
    obsTiny.observacoes || '',
    obsTiny.observacoes_internas || '',
    classificacao.prioridade_operacional,
    classificacao.prioridade_label,
    lat,
    lon,
    conta.key, // V16: usa a chave COMERCIO/DISTRIBUIDORA para casar corretamente com FormasEnvio.
    idTiny,
    conta.key + '__' + idTiny,
    '',
    ''
  ];

  if (typeof CABECALHO_LOGISTICA_V15 !== 'undefined') {
    const obj = {};
    CABECALHO_LOGISTICA_V15.forEach((h, idx) => obj[h] = linha[idx] !== undefined ? linha[idx] : '');
    return CABECALHO_LOGISTICA_V15.map(h => obj[h] !== undefined ? obj[h] : '');
  }

  return linha;
}

function sincronizarPedidosRecentes() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.warn('Sincronização ignorada: outra execução ainda está em andamento.');
    return { success: false, locked: true, message: 'Outra sincronização está em andamento.' };
  }

  try {
    if (typeof criarAtualizarAbaFormasEnvio === 'function') criarAtualizarAbaFormasEnvio();
    if (typeof garantirColunasPedidosV15_ === 'function') garantirColunasPedidosV15_();
    if (typeof registrarDebugContasTinyV13_ === 'function') registrarDebugContasTinyV13_();

    const contas = obterTinyAccountsV13_();
    if (!contas.length) throw new Error('Nenhum token Tiny configurado. Configure TINY_TOKEN_COMERCIO e/ou TINY_TOKEN_DISTRIBUIDORA em Propriedades do Script.');

    const hoje = new Date();
    const inicio = new Date();
    const diasSync = Number(PropertiesService.getScriptProperties().getProperty('VESCO_SYNC_DIAS') || CONFIG.DIAS || 7);
    inicio.setDate(hoje.getDate() - diasSync);

    const dInicio = Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy');
    const dFinal = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy');

    const todasLinhasNovas = [];
    const contasSucesso = [];
    const contasPreservar = [];
    const resumo = [];

    contas.forEach(conta => {
      const contaKey = vescoNormalizeContaKeyV16_(conta.key);
      const cooldown = vescoTinyGetCooldownV16_(contaKey);

      if (cooldown.active) {
        contasPreservar.push(contaKey);
        resumo.push({ conta: contaKey, status: 'preservada_cooldown', total: 0, cooldownAte: new Date(cooldown.until).toISOString() });
        console.warn('Conta ' + contaKey + ' preservada: cooldown Tiny ativo até ' + new Date(cooldown.until).toLocaleString('pt-BR'));
        return;
      }

      let pagina = 1;
      let totalPaginas = 1;
      let totalConta = 0;
      let contaFalhou = false;
      let bloqueada = false;
      const linhasConta = [];

      do {
        const payload = `token=${encodeURIComponent(conta.token)}&formato=JSON&dataInicial=${encodeURIComponent(dInicio)}&dataFinal=${encodeURIComponent(dFinal)}&pagina=${pagina}`;
        const pesquisa = vescoTinyFetchPostJsonV16_(CONFIG.URL_PESQUISA, payload, contaKey, 'pedidos.pesquisa');

        if (!pesquisa.success) {
          contaFalhou = true;
          bloqueada = !!pesquisa.blocked;
          console.warn('Pesquisa Tiny sem pedidos ou com erro para conta:', contaKey, pesquisa.json && pesquisa.json.retorno ? pesquisa.json.retorno : pesquisa.error);
          break;
        }

        const json = pesquisa.json;
        if (!json.retorno || json.retorno.status !== 'OK' || !json.retorno.pedidos) {
          contaFalhou = true;
          console.warn('Pesquisa Tiny sem pedidos ou com resposta inesperada para conta:', contaKey, json && json.retorno ? json.retorno : json);
          break;
        }

        totalPaginas = parseInt(json.retorno.numero_paginas || '1', 10);

        json.retorno.pedidos.forEach(item => {
          if (contaFalhou) return;

          const p = item.pedido || {};
          const situacao = (p.situacao || '').toUpperCase();
          const numEcom = (p.numero_ecommerce || '').toString().trim();

          // Preservado do fluxo antigo: só entra pedido sem número e-commerce e não cancelado.
          if (numEcom === '' && situacao !== 'CANCELADO') {
            const idTiny = String(p.id || '').trim();
            const detalheResult = obterDetalhePedidoPorTokenV16_(idTiny, conta);

            if (!detalheResult.success && detalheResult.blocked) {
              contaFalhou = true;
              bloqueada = true;
              console.warn('Detalhe Tiny bloqueado para conta:', contaKey, detalheResult.error);
              return;
            }

            const detalhe = detalheResult.pedido || null;
            linhasConta.push(vescoMontarLinhaPedidoTinyV16_(conta, p, detalhe));
            totalConta++;
            Utilities.sleep(VESCO_TINY_API_V16.DELAY_BETWEEN_DETAIL_MS);
          }
        });

        if (contaFalhou) break;
        pagina++;
        Utilities.sleep(VESCO_TINY_API_V16.DELAY_BETWEEN_SEARCH_MS);
      } while (pagina <= totalPaginas);

      if (contaFalhou) {
        contasPreservar.push(contaKey);
        resumo.push({ conta: contaKey, status: bloqueada ? 'preservada_api_bloqueada' : 'preservada_erro', total: 0 });
      } else {
        contasSucesso.push(contaKey);
        Array.prototype.push.apply(todasLinhasNovas, linhasConta);
        resumo.push({ conta: contaKey, status: 'sincronizada', total: totalConta });
      }
    });

    const linhasPreservadas = vescoLerLinhasAtuaisPorContaV16_(contasPreservar);
    const linhasParaGravar = todasLinhasNovas.concat(linhasPreservadas);

    if (contasSucesso.length === 0 && contasPreservar.length > 0) {
      console.warn('Todas as contas foram preservadas por bloqueio/erro. A aba Pedidos NÃO foi sobrescrita.');
      return { success: false, preservedOnly: true, message: 'Tiny bloqueou ou retornou erro. Dados atuais foram preservados.', contas: resumo };
    }

    gravarNaPlanilha_(linhasParaGravar);

    const props = PropertiesService.getScriptProperties();
    props.setProperty('VESCO_SYNC_LAST_RUN', String(Date.now()));
    props.setProperty('VESCO_SYNC_LAST_RESULT', JSON.stringify({ at: new Date().toISOString(), total: linhasParaGravar.length, contas: resumo }).slice(0, 9000));

    return {
      success: true,
      total: linhasParaGravar.length,
      novas: todasLinhasNovas.length,
      preservadas: linhasPreservadas.length,
      contas: resumo
    };
  } finally {
    try { lock.releaseLock(); } catch(e) {}
  }
}

function vescoLimparCooldownTinyV16() {
  const props = PropertiesService.getScriptProperties();
  obterTinyAccountsV13_().forEach(c => {
    props.deleteProperty(vescoTinyCooldownKeyV16_(c.key));
    props.deleteProperty(vescoTinyLastErrorKeyV16_(c.key));
  });
  SpreadsheetApp.getActiveSpreadsheet().toast('Cooldowns Tiny limpos. Use com cuidado para não bloquear novamente.', 'Vesco Tiny', 5);
  return { success: true };
}

function vescoStatusTinyV16() {
  const contas = obterTinyAccountsV13_().map(c => {
    const cooldown = vescoTinyGetCooldownV16_(c.key);
    return {
      conta: c.key,
      nome: c.nome,
      cooldownAtivo: !!cooldown.active,
      cooldownAte: cooldown.until ? new Date(cooldown.until).toISOString() : '',
      restanteMin: cooldown.remainingMs ? Math.ceil(cooldown.remainingMs / 60000) : 0
    };
  });
  console.log(JSON.stringify(contas, null, 2));
  return contas;
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚚 Vesco')
    .addItem('🔄 Sincronizar Pedidos Todas as Contas', 'sincronizarPedidosRecentes')
    .addItem('🚚 Criar/Atualizar Formas de Envio', 'criarAtualizarAbaFormasEnvio')
    .addItem('🧾 Atualizar Aba Contas Tiny', 'registrarDebugContasTinyV13_')
    .addItem('🧩 Garantir colunas Obs/Link', 'garantirColunasPedidosV15_')
    .addSeparator()
    .addItem('📡 Ver status/cooldown Tiny', 'vescoStatusTinyV16')
    .addItem('🧹 Limpar cooldown Tiny', 'vescoLimparCooldownTinyV16')
    .addSeparator()
    .addItem('⏱️ Ativar sincronia 30m', 'createSyncTrigger30Min')
    .addItem('🗑️ Remover sincronia', 'deleteSyncTriggers')
    .addToUi();
}

console.log('Apps Script V16 ativo — proteção contra API Tiny bloqueada, cooldown por conta e preservação de dados antigos.');


// ============================================================================
// VESCO MOTORISTA EXTERNO — CAMADA V17
// Página isolada para motorista terceirizado com token por rota.
// Endpoints: criarRotaMotorista, motoristaPedidos, confirmarEntregaMotorista, debugMotorista.
// ============================================================================
const VESCO_MOTORISTA_V17 = {
  ROTAS_SHEET: 'RotasMotorista',
  COMPROVANTES_SHEET: 'ComprovantesMotorista'
};

function vescoMotoristaNowV17_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function vescoMotoristaJson_(obj, callback) {
  if (callback) return ContentService.createTextOutput(callback + '(' + JSON.stringify(obj) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function vescoMotoristaEnsureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const range = sh.getDataRange();
  const vals = range.getNumRows() ? range.getValues() : [];
  if (!vals.length || String(vals[0][0] || '').trim() === '') {
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#004f9f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    return sh;
  }
  const oldHeaders = vals[0].map(h => String(h || '').trim());
  let changed = false;
  headers.forEach(h => { if (oldHeaders.indexOf(h) === -1) { oldHeaders.push(h); changed = true; } });
  if (changed) sh.getRange(1, 1, 1, oldHeaders.length).setValues([oldHeaders]).setFontWeight('bold').setBackground('#004f9f').setFontColor('#ffffff');
  return sh;
}

function vescoMotoristaEnsureEstruturaV17_() {
  vescoMotoristaEnsureSheet_(VESCO_MOTORISTA_V17.ROTAS_SHEET, ['rota_id','token','nome_rota','motorista','origem','pedidos_json','paradas_json','status','criado_em','atualizado_em']);
  vescoMotoristaEnsureSheet_(VESCO_MOTORISTA_V17.COMPROVANTES_SHEET, ['ts','rota_id','pedido_id','pedido_numero','recebedor','documento','transportador','observacao','operador_origem','status']);
  return { success: true };
}

function instalarEstruturaMotoristaExterno() {
  const r = vescoMotoristaEnsureEstruturaV17_();
  SpreadsheetApp.getActiveSpreadsheet().toast('Estrutura do motorista externo criada/atualizada.', 'Vesco', 5);
  return r;
}

function vescoMotoristaHeaders_(sh) {
  const vals = sh.getDataRange().getValues();
  return vals.length ? vals[0].map(h => String(h || '').trim()) : [];
}

function vescoMotoristaCol_(headers, name) {
  return headers.indexOf(name);
}

function vescoMotoristaParseJson_(s, fallback) {
  try { return JSON.parse(String(s || '')); } catch(e) { return fallback; }
}

function vescoMotoristaFindRota_(rotaId, token) {
  const sh = vescoMotoristaEnsureSheet_(VESCO_MOTORISTA_V17.ROTAS_SHEET, ['rota_id','token','nome_rota','motorista','origem','pedidos_json','paradas_json','status','criado_em','atualizado_em']);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return null;
  const headers = vals[0].map(h => String(h || '').trim());
  const cRota = vescoMotoristaCol_(headers, 'rota_id');
  const cToken = vescoMotoristaCol_(headers, 'token');
  for (let i = 1; i < vals.length; i++) {
    const row = vals[i];
    if (String(row[cRota] || '') === String(rotaId || '') && String(row[cToken] || '') === String(token || '')) {
      const obj = { rowIndex: i + 1 };
      headers.forEach((h, idx) => obj[h] = row[idx]);
      return obj;
    }
  }
  return null;
}

function vescoMotoristaCriarRota_(params) {
  vescoMotoristaEnsureEstruturaV17_();
  const rotaId = String(params.rota || params.rota_id || '').trim();
  const token = String(params.token || '').trim();
  if (!rotaId || !token) return { success: false, error: 'rota_token_obrigatorio' };

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(VESCO_MOTORISTA_V17.ROTAS_SHEET);
  const vals = sh.getDataRange().getValues();
  const headers = vals[0].map(h => String(h || '').trim());
  const cRota = vescoMotoristaCol_(headers, 'rota_id');
  const now = vescoMotoristaNowV17_();
  const rowObj = {
    rota_id: rotaId,
    token: token,
    nome_rota: params.nome || params.nome_rota || 'Rota',
    motorista: params.motorista || '',
    origem: params.origem || '',
    pedidos_json: params.pedidos || '[]',
    paradas_json: params.paradas || '[]',
    status: 'ativa',
    criado_em: now,
    atualizado_em: now
  };

  let found = -1;
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][cRota] || '') === rotaId) { found = i + 1; break; }
  }
  const out = headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '');
  if (found > 0) {
    const createdCol = vescoMotoristaCol_(headers, 'criado_em');
    if (createdCol >= 0) out[createdCol] = vals[found - 1][createdCol] || now;
    sh.getRange(found, 1, 1, out.length).setValues([out]);
  } else {
    sh.appendRow(out);
  }
  return { success: true, rota: rotaId, token: token };
}

function vescoMotoristaPedidoMatchKeys_(pedido) {
  const keys = [];
  function add(v) { if (v !== undefined && v !== null && String(v).trim() !== '') keys.push(String(v).trim()); }
  add(pedido);
  add(String(pedido || '').replace(/^COMERCIO__|^DISTRIBUIDORA__/i, ''));
  return keys.filter((v, i, a) => a.indexOf(v) === i);
}

function vescoMotoristaFindPedidos_(pedidosList) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) return [];
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const headers = vals[0].map(h => String(h || '').trim());
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);
  const wanted = {};
  (pedidosList || []).forEach(p => vescoMotoristaPedidoMatchKeys_(p).forEach(k => wanted[k] = true));

  const found = [];
  for (let r = 1; r < vals.length; r++) {
    const row = vals[r];
    const candidates = [
      idx.id >= 0 ? row[idx.id] : '',
      idx.numero >= 0 ? row[idx.numero] : '',
      idx.id_tiny >= 0 ? row[idx.id_tiny] : '',
      idx.pedido_key >= 0 ? row[idx.pedido_key] : ''
    ].map(v => String(v || '').trim()).filter(Boolean);
    if (!candidates.some(k => wanted[k])) continue;
    const o = { _row: r + 1 };
    headers.forEach((h, i) => {
      let val = row[i];
      if ((h === 'data_prevista' || h === 'data_pedido' || h === 'data_entrega_realizada') && val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'dd/MM/yyyy');
      }
      o[h] = val;
    });
    found.push(o);
  }
  return found;
}

function vescoMotoristaPedidos_(params) {
  const rota = vescoMotoristaFindRota_(params.rota || params.rota_id, params.token);
  if (!rota) return { success: false, error: 'Rota não encontrada ou token inválido.' };
  const pedidosList = vescoMotoristaParseJson_(rota.pedidos_json, []);
  const pedidos = vescoMotoristaFindPedidos_(pedidosList);
  return {
    success: true,
    rota: { id: rota.rota_id, nome: rota.nome_rota, motorista: rota.motorista, origem: rota.origem, status: rota.status },
    pedidos: pedidos
  };
}

function vescoMotoristaEnsurePedidoCols_(sheet, headers) {
  const required = ['nome_recebedor','doc_recebedor','data_entrega_realizada','entregue_em'];
  let out = headers.slice();
  required.forEach(h => { if (out.indexOf(h) === -1) out.push(h); });
  if (out.length !== headers.length) {
    sheet.getRange(1, 1, 1, out.length).setValues([out]).setFontWeight('bold').setBackground('#004f9f').setFontColor('#ffffff');
  }
  return out;
}

function vescoMotoristaConfirmarEntrega_(params) {
  const rota = vescoMotoristaFindRota_(params.rota || params.rota_id, params.token);
  if (!rota) return { success: false, error: 'Rota não encontrada ou token inválido.' };
  const pedidoParam = String(params.pedido || params.id || '').trim();
  const recebedor = String(params.recebedor || '').trim();
  const documento = String(params.documento || '').trim();
  const transportador = String(params.transportador || 'Motorista Terceirizado').trim();
  const obsExtra = String(params.observacao || '').trim();
  if (!pedidoParam || !recebedor) return { success: false, error: 'pedido_e_recebedor_obrigatorios' };

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return { success: false, error: 'aba_pedidos_nao_encontrada' };
  let data = sheet.getDataRange().getValues();
  let headers = data[0].map(h => String(h || '').trim());
  headers = vescoMotoristaEnsurePedidoCols_(sheet, headers);
  data = sheet.getDataRange().getValues();

  const idx = {};
  headers.forEach((h, i) => idx[h] = i);
  const wanted = vescoMotoristaPedidoMatchKeys_(pedidoParam);
  let rowIndex = -1;
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const candidates = [idx.id >= 0 ? row[idx.id] : '', idx.numero >= 0 ? row[idx.numero] : '', idx.id_tiny >= 0 ? row[idx.id_tiny] : '', idx.pedido_key >= 0 ? row[idx.pedido_key] : ''].map(v => String(v || '').trim());
    if (candidates.some(k => wanted.indexOf(k) !== -1)) { rowIndex = r + 1; break; }
  }
  if (rowIndex < 0) return { success: false, error: 'pedido_nao_encontrado' };

  const now = vescoMotoristaNowV17_();
  const dataBR = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const msgAudit = 'Entregue via: ' + transportador + ' | Recebido por: ' + recebedor + ' (Doc: ' + documento + ')' + (obsExtra ? ' | Obs: ' + obsExtra : '');

  function setCol(name, value) {
    const c = idx[name];
    if (c >= 0) sheet.getRange(rowIndex, c + 1).setValue(value);
  }
  setCol('status_logistica', 'Entregue');
  setCol('situacao_nome', 'Entregue');
  setCol('nome_recebedor', recebedor);
  setCol('doc_recebedor', documento);
  setCol('data_entrega_realizada', dataBR);
  setCol('entregue_em', now);
  const obsCol = idx.observacao_logistica;
  if (obsCol >= 0) {
    const atual = String(sheet.getRange(rowIndex, obsCol + 1).getValue() || '').trim();
    sheet.getRange(rowIndex, obsCol + 1).setValue([atual, msgAudit].filter(Boolean).join(' | '));
  }

  const comp = vescoMotoristaEnsureSheet_(VESCO_MOTORISTA_V17.COMPROVANTES_SHEET, ['ts','rota_id','pedido_id','pedido_numero','recebedor','documento','transportador','observacao','operador_origem','status']);
  const pedidoNumero = idx.numero >= 0 ? data[rowIndex - 1][idx.numero] : pedidoParam;
  comp.appendRow([now, rota.rota_id, pedidoParam, pedidoNumero, recebedor, documento, transportador, obsExtra, 'motorista_externo', 'Entregue']);

  return { success: true, pedido: pedidoParam, status: 'Entregue' };
}

function vescoMotoristaDebug_() {
  vescoMotoristaEnsureEstruturaV17_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rotas = ss.getSheetByName(VESCO_MOTORISTA_V17.ROTAS_SHEET).getLastRow() - 1;
  const comps = ss.getSheetByName(VESCO_MOTORISTA_V17.COMPROVANTES_SHEET).getLastRow() - 1;
  return { success: true, rotas: Math.max(0, rotas), comprovantes: Math.max(0, comps), endpoints: ['criarRotaMotorista','motoristaPedidos','confirmarEntregaMotorista','debugMotorista'] };
}

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const action = params.action || '';
    const callback = params.callback || null;
    let resposta = null;

    if (action === 'criarRotaMotorista') resposta = vescoMotoristaCriarRota_(params);
    else if (action === 'motoristaPedidos') resposta = vescoMotoristaPedidos_(params);
    else if (action === 'confirmarEntregaMotorista') resposta = vescoMotoristaConfirmarEntrega_(params);
    else if (action === 'debugMotorista') resposta = vescoMotoristaDebug_();

    if (resposta) return vescoMotoristaJson_(resposta, callback);
    return doGet_V16_FINAL_BASE_(e);
  } catch (err) {
    const callback = e && e.parameter ? e.parameter.callback : null;
    return vescoMotoristaJson_({ success: false, error: err.message, stack: err.stack || '' }, callback);
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚚 Vesco')
    .addItem('🔄 Sincronizar Pedidos Todas as Contas', 'sincronizarPedidosRecentes')
    .addItem('🚚 Criar/Atualizar Formas de Envio', 'criarAtualizarAbaFormasEnvio')
    .addItem('🧾 Atualizar Aba Contas Tiny', 'registrarDebugContasTinyV13_')
    .addItem('🧩 Garantir colunas Obs/Link', 'garantirColunasPedidosV15_')
    .addItem('🏍️ Garantir estrutura Motorista Externo', 'instalarEstruturaMotoristaExterno')
    .addSeparator()
    .addItem('⏱️ Ativar sincronia 30m', 'createSyncTrigger30Min')
    .addItem('🗑️ Remover sincronia', 'deleteSyncTriggers')
    .addToUi();
}

console.log('Apps Script V17 ativo — motorista externo isolado com rota/token e baixa de entrega.');