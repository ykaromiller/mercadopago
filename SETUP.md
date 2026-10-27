# Pagamentos com Mercado Pago — Barbearia Ruan

## Como funciona

- **PIX:** o site pede ao servidor (Cloud Function `createPayment`) → o Mercado Pago gera o QR Code → o cliente paga → o Mercado Pago avisa o servidor (`mpwebhook`) → o agendamento vira **Pago** sozinho. O horário fica reservado por 15 min enquanto o cliente paga.
- **Cartão (crédito/débito):** o cliente é levado ao **Checkout Pro** do Mercado Pago (que coleta os dados do cartão com segurança) e volta para o site. O formulário de cartão que existia no site foi removido.
- O **Access Token** fica só no servidor (Secret Manager). Nada de chave secreta no `index.html`.

## Estrutura

```
public/index.html      → o site (já alterado)
functions/index.js     → backend (createPayment, cancelPayment, mpwebhook, cleanupExpired)
functions/.env         → SITE_URL (endereço do seu site)
firebase.json / .firebaserc
```

## Passo a passo

### 1. Ferramentas
```bash
npm install -g firebase-tools
firebase login
```
Precisa do Node 22 ou mais novo.

### 2. Plano Blaze
No console do Firebase (projeto **barbearia-ruan**) → Uso e faturamento → mude para o plano **Blaze**. Cloud Functions, Secret Manager e agendador exigem esse plano. Para uma barbearia o custo costuma ficar dentro da cota gratuita, mas é cobrança por uso.

### 3. Mercado Pago — aplicação e credenciais
1. Em **mercadopago.com.br/developers** → *Suas integrações* → **Criar aplicação** (produto: *Checkout Pro* / pagamentos online).
2. Em *Credenciais de teste*, copie o **Access Token** (começa com `TEST-`).
3. A conta que recebe o dinheiro é a conta Mercado Pago do dono da aplicação. Para receber de verdade, ela precisa estar verificada.

### 4. Guardar os segredos no Firebase
```bash
firebase functions:secrets:set MP_ACCESS_TOKEN      # cole o Access Token
firebase functions:secrets:set MP_WEBHOOK_SECRET    # cole qualquer texto por enquanto; troca no passo 6
```

### 5. Deploy do backend
```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```
Se o seu site **não** for `https://barbearia-ruan.web.app`, edite `functions/.env` (`SITE_URL=...`) antes do deploy.

### 6. Configurar o webhook no Mercado Pago
1. Na sua aplicação → **Webhooks** → modo teste.
2. URL: `https://southamerica-east1-barbearia-ruan.cloudfunctions.net/mpwebhook`
   (confira no final do deploy a URL da função `mpwebhook`; se for diferente, coloque em `functions/.env` como `WEBHOOK_URL=...` e faça deploy de novo).
3. Evento: **Pagamentos**.
4. Copie a **Assinatura secreta** que o Mercado Pago mostrar e grave de novo:
   ```bash
   firebase functions:secrets:set MP_WEBHOOK_SECRET
   firebase deploy --only functions
   ```

### 7. Publicar o site
```bash
firebase deploy --only hosting
```
(publica `public/index.html`). Se o site fica em outro lugar (Netlify, GitHub Pages etc.), basta subir o `public/index.html` lá e colocar o endereço em `SITE_URL`.

### 8. Testar
- **Cartão:** use as credenciais de teste e os cartões de teste da documentação do Mercado Pago.
- **PIX:** o jeito mais confiável é usar as credenciais de **produção** com um serviço de valor baixo (ex.: R$ 1), pagar você mesmo e depois estornar no app do Mercado Pago.
- Se algo falhar: `firebase functions:log`.

### 9. Ir para produção
Troque o Access Token pelo de **produção** (`firebase functions:secrets:set MP_ACCESS_TOKEN`), configure o webhook também no modo produção (com a assinatura secreta de produção) e faça `firebase deploy --only functions`.

## Pontos de atenção

- **E-mail do pagador no PIX:** o site não pede e-mail, então o servidor usa um e-mail genérico por agendamento (`cliente+ID@barbeariaruan.com.br`). Se o Mercado Pago recusar, o erro aparece em `firebase functions:log` — me avise que eu passo a pedir o e-mail do cliente.
- **Pagamento órfão:** se alguém pagar depois da reserva expirar, o webhook grava em `orphanPayments/` no banco para você estornar manualmente.
- **Cancelamento de agendamento já pago** não estorna automaticamente (o site avisa o cliente). O estorno é feito no painel do Mercado Pago.

## Segurança — ainda pendente (fora desta entrega)

- **Regras do Realtime Database:** se estiverem abertas, qualquer pessoa pode editar `paymentStatus` direto no banco e se marcar como pago. Isso precisa de Firebase Authentication para fechar direito.
- **Senhas dos clientes em texto puro** no banco.
- **Login do barbeiro (`Ruan / ruan1`)** escrito no código do site.
