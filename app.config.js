// app.config.js — Configuração única dos endpoints e regras estáveis.
(function(){
  window.VescoConfig = Object.freeze({
    API: "https://script.google.com/macros/s/AKfycbxEzbxBABMDwi7B7tn_1p-lC0vc50JjHFOrH3w42Oog2-5R2-WMYSrQ27ED7wduJUN6/exec",
    API_FLEX: "https://script.google.com/macros/s/AKfycbzDp2qs2S_MxDc_3afY1TurNKYEwfYKkk2cc4IliNxLiVaJuSKYyRqofOUMnhdFBjwNwg/exec",
    TZ: "America/Sao_Paulo",
    RETIRADA_IDS: ["747632298", "758290131", "860463094"],
    ROUTES_KEY: "vesco_saiu_rotas_v1",
    ROUTES_KEY_MODULAR: "vesco_routes_modular_v2",
    ROUTES_REMOTE_CACHE_KEY: "vesco_routes_remote_cache_v2",
    OBS_LINK_KEY: "vesco_obs_link_modular_v2"
  });
})();
