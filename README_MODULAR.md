# Vesco Modular V2

Esta versão remove as camadas antigas V14–V23 de dentro do `app.js` e deixa as correções em módulos separados.

## Corrigido nesta V2

- Apenas uma aba **Retiradas**.
- Ícone em **Pronto para Envio**.
- Observação e link aparecem abaixo do pedido, não nos botões da subaba.
- Rotas criadas são lidas do localStorage e tenta buscar do Apps Script com ações compatíveis:
  - `rotasMotorista`
  - `listarRotasMotorista`
  - `getRotasMotorista`
  - `rotas`
  - `getRotas`
  - `listRotas`
- Botão manual para adicionar pedido na rota por número da venda/e-commerce.
- Clique/Mapa no Flex reforçado com `focusFlexOnMap`.
- Status do Flex limpo: remove textos repetidos abaixo do botão Entregue.
- Mantém o legado principal de carregamento, status, mapas e APIs.

## Arquivos para subir

Suba todos estes arquivos na raiz:

- `logistica.html`
- `styles.css`
- `app.js`
- `app.config.js`
- `app.state.js`
- `app.api.js`
- `modulo.mapas.js`
- `modulo.obslink.js`
- `modulo.retiradas.js`
- `modulo.rotas.js`
- `modulo.flex.js`
- `app.bootstrap.js`
- `rotas.js`
- `painel_motorista_link_v22.js`

Não use `app.min.js` nesta fase.

## Testes no console

```js
VescoModules.debug()
VescoRetiradas.render()
VescoRotasModular.render()
VescoRotasModular.loadRemoteRoutes(true)
VescoFlexModular.cleanStatus()
focusFlexOnMap('188319')
toggleMapExpand('map-flex')
```
