/* ============================================================================
   PATCH APPS SCRIPT — ROTAS DO DIA + OPERADOR/TEMPO DE SEPARAÇÃO
   Cole este bloco no final do Apps Script principal.

   Depois, dentro do seu doGet(e), adicione antes do else final:

   } else if (action === 'listarRotasMotorista' || action === 'rotasMotorista' || action === 'getRotasMotorista' || action === 'listRotaMotorista') {
     resposta = listarRotasMotorista_(params);

   Se o seu doGet já tiver essa ação, não precisa adicionar de novo.
   ============================================================================ */

function vescoPatchGetSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function vescoPatchParseDateISO_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v || '').trim();
  var mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) return mIso[1] + '-' + mIso[2] + '-' + mIso[3];
  var mBr = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (mBr) {
    var y = mBr[3];
    if (y.length === 2) y = '20' + y;
    return y + '-' + ('0' + mBr[2]).slice(-2) + '-' + ('0' + mBr[1]).slice(-2);
  }
  return '';
}

function listarRotasMotorista_(params) {
  params = params || {};
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.ROTAS_MOTORISTA_SHEET) ? CONFIG.ROTAS_MOTORISTA_SHEET : 'RotasMotorista';
  var sh = vescoPatchGetSheet_(sheetName);
  var vals = sh.getDataRange().getValues();

  if (vals.length < 2) return { success: true, rotas: [], data: [] };

  var headers = vals[0].map(function(h) { return String(h || '').trim(); });
  var selectedISO = vescoPatchParseDateISO_(params.dataISO || params.data || params.date || '');

  var rotas = [];

  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });

    var pedidosRaw = obj.pedidos_json || obj.pedidos || '[]';
    var paradasRaw = obj.paradas_json || obj.paradas || '[]';
    var pedidos = [];
    var paradas = [];

    try { pedidos = JSON.parse(String(pedidosRaw || '[]')); } catch(e) { pedidos = String(pedidosRaw || '').split(/[\s,;]+/).filter(Boolean); }
    try { paradas = JSON.parse(String(paradasRaw || '[]')); } catch(e) { paradas = []; }

    if (!Array.isArray(pedidos)) pedidos = [];
    if (!pedidos.length) continue;

    var rotaISO = vescoPatchParseDateISO_(obj.data_operacional || obj.criado_em || obj.atualizado_em || obj.criadoEm || '');
    if (selectedISO && rotaISO && rotaISO !== selectedISO) continue;

    rotas.push({
      id: obj.rota_id || obj.id || obj.token || ('rota-linha-' + (r + 1)),
      rota_id: obj.rota_id || obj.id || '',
      token: obj.token || '',
      nome: obj.nome_rota || obj.nome || 'Rota',
      nome_rota: obj.nome_rota || obj.nome || 'Rota',
      motorista: obj.motorista || '',
      origem: obj.origem || '',
      pedidos: pedidos,
      pedidos_json: pedidos,
      paradas: paradas,
      paradas_json: paradas,
      status: obj.status || 'ativa',
      data_operacional: rotaISO || selectedISO || '',
      criadoEm: obj.criado_em || obj.criadoEm || '',
      atualizadoEm: obj.atualizado_em || obj.atualizadoEm || ''
    });
  }

  return { success: true, rotas: rotas, data: rotas };
}

/*
  Opcional, mas recomendado: substitua sua função processarAtualizacaoStatus_ por uma versão que
  grave início/fim/operador/tempo, ou mantenha o patch V27.1 se já aplicou.
*/
