// app.bootstrap.js — Inicialização central dos módulos.
(function(){
  function refresh(){
    try { window.dispatchEvent(new CustomEvent('vesco:module-refresh')); } catch(e) {}
    try { if (window.VescoRetiradas) window.VescoRetiradas.render(); } catch(e) {}
    try { if (window.VescoObsLink) window.VescoObsLink.apply(); } catch(e) {}
    try { if (window.VescoRotasModular) window.VescoRotasModular.render(); } catch(e) {}
    try { if (window.VescoMapas) window.VescoMapas.enableAll(); } catch(e) {}
    try { if (window.VescoFlexModular) window.VescoFlexModular.renderSummary(); } catch(e) {}
    try { if (window.VescoLogisticaModular) window.VescoLogisticaModular.apply(); } catch(e) {}
    try { if (window.VescoOperadores) window.VescoOperadores.apply(); } catch(e) {}
  }

  window.VescoModules = {
    refresh,
    debug(){
      return {
        orders: (window.VescoState && window.VescoState.orders().length) || 0,
        flex: (window.VescoState && window.VescoState.flexOrders().length) || 0,
        retiradas: (window.VescoRetiradas && window.VescoRetiradas.eligible().length) || 0,
        flexCoords: window.VescoFlexModular ? window.VescoFlexModular.countLatLon() : null,
        modules: ['state','api','mapas','obslink','retiradas','rotas','flex','logistica','operadores'].filter(name => {
          const map = {
            state:'VescoState', api:'VescoAPI', mapas:'VescoMapas', obslink:'VescoObsLink',
            retiradas:'VescoRetiradas', rotas:'VescoRotasModular', flex:'VescoFlexModular', logistica:'VescoLogisticaModular', operadores:'VescoOperadores'
          };
          return !!window[map[name]];
        })
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(refresh, 900));
  else setTimeout(refresh, 500);

  setTimeout(refresh, 1800);
  console.log('Vesco Modules bootstrap ativo');
})();
