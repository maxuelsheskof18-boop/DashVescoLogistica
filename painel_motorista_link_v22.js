// painel_motorista_link_v22.js — fallback local para evitar 404/MIME em ambiente de teste.
(function(){
  if (window.__painelMotoristaFallback) return;
  window.__painelMotoristaFallback = true;
  window.PainelMotoristaLinkV22 = window.PainelMotoristaLinkV22 || {
    init(){ return true; },
    debug(){ return { active: true, fallback: true }; }
  };
  console.log('painel_motorista_link_v22 fallback carregado.');
})();
