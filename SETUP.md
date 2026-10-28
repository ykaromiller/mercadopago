# Lumi Studio — Cílios & Sobrancelhas (agendamento + pagamento)

Site de agendamento com pagamento por **PIX** e **cartão** (Mercado Pago) em projeto Firebase **novo e separado** do da barbearia.
Para trocar o nome "Lumi Studio": entre como administradora → Configurações → *Nome do studio*.

## Como funciona

- **Cliente** cria conta (e-mail + senha), escolhe serviço, dia e horário e paga. O horário só fica **confirmado depois que o Mercado Pago aprova**. Enquanto paga, o horário fica reservado por 15 min (PIX) ou 30 min (cartão); se não pagar, é liberado sozinho.
- **Administradora** (você) vê a agenda do dia/mês e o total recebido, agenda para clientes (inclusive "pago no local"), cancela/estorna e edita horários, serviços e preços.
- Cada serviço tem **duração própria** (ex.: Volume Russo 2h30). A agenda bloqueia todos os blocos de 30 min do atendimento, então não há horários sobrepostos.

## Estrutura

```
public/index.html        → o site (cliente + administradora)
functions/index.js       → backend: reserva, PIX/cartão, webhook, cancelamento/estorno
functions/lib.js         → regras de horário (testadas: npm test dentro de functions/)
database.rules.json      → regras de segurança do banco (publicar!)
firebase.json / .firebaserc / functions/.env
```

## O que foi reforçado no banco (em relação à barbearia)

| Antes | Agora |
|---|---|
| Senhas em texto puro no banco | Login pelo **Firebase Authentication** (senha com hash, recuperação por e-mail) |
| Login do dono escrito no código | Administradora = `admins/{uid}`, definido **só no console do Firebase** |
| Navegador gravava agendamentos direto | Regras **proíbem** gravar em `appointments` e `busy`; tudo passa pelas Cloud Functions |
| Dava para se marcar como "pago" pelo console do navegador | Só o servidor marca pago, depois de consultar o Mercado Pago |
| Preço vinha do navegador | Preço e duração vêm sempre do banco, no servidor |
| Cliente lia todos os agendamentos (nomes, telefones) | Cliente lê só os **seus**; a agenda pública mostra apenas horários ocupados, sem nomes |
| Dois cliques no mesmo horário podiam colidir | Travas atômicas (transações) por bloco de 30 min |
| Nome digitado era injetado no HTML | Todo texto é escapado (sem XSS) |
| Qualquer pessoa podia cancelar pagamento alheio | Funções checam que o agendamento é da cliente logada |
| Pagamento fora do prazo ficava para estorno manual | Estorno **automático** (e registro em `orphanPayments`) |
| Sem histórico | `auditLog` (cancelamentos, estornos, marcações manuais) legível só pela administradora |

Também: limite de 3 reservas abertas por cliente (evita "segurar" a agenda toda), validação de dados nas regras e cabeçalhos de segurança no hosting.

## Passo a passo

### 1. Ferramentas
```bash
npm install -g firebase-tools
firebase login
```
Precisa do Node 22 ou mais novo.

### 2. Criar o projeto Firebase
1. console.firebase.google.com → **Adicionar projeto** (anote o **ID do projeto**).
2. **Compilação → Authentication → Começar → E-mail/senha → Ativar.**
3. **Compilação → Realtime Database → Criar banco de dados** (modo **bloqueado**; as regras certas são publicadas no passo 5). Copie a URL que aparece no topo.
4. **Plano Blaze** (Uso e faturamento). Cloud Functions, Secret Manager e agendador exigem. Para um studio, normalmente fica dentro da cota gratuita.
5. **Configurações do projeto → Seus apps → Web (</>)** → registre o app e copie o objeto `firebaseConfig`.

### 3. Preencher os dados do projeto
- `.firebaserc` → troque `SEU-PROJETO-ID` pelo ID do projeto.
- `public/index.html` → no bloco `FIREBASE_CONFIG`, cole os valores do passo 2.5.
- `functions/.env` → `SITE_URL` (ex.: `https://SEU-PROJETO-ID.web.app`) e `DATABASE_URL` (a URL do passo 2.3).

### 4. Mercado Pago
1. mercadopago.com.br/developers → *Suas integrações* → **Criar aplicação** (Checkout Pro).
2. Em *Credenciais de teste*, copie o **Access Token** (`TEST-...`).
3. Guardar os segredos:
```bash
firebase functions:secrets:set MP_ACCESS_TOKEN      # cole o Access Token
firebase functions:secrets:set MP_WEBHOOK_SECRET    # qualquer texto por enquanto
```

### 5. Publicar banco, backend e site
```bash
cd functions && npm install && cd ..
firebase deploy --only database,functions,hosting
```

### 6. Webhook do Mercado Pago
1. Na aplicação → **Webhooks** → URL: `https://southamerica-east1-SEU-PROJETO-ID.cloudfunctions.net/mpwebhook` → evento **Pagamentos**.
2. Copie a **Assinatura secreta** e grave de novo:
```bash
firebase functions:secrets:set MP_WEBHOOK_SECRET
firebase deploy --only functions
```

### 7. Criar a sua conta de administradora (importante)
1. Abra o site e **crie uma conta** com o seu e-mail.
2. Console Firebase → **Authentication → Usuários** → copie o **UID** da sua conta.
3. **Realtime Database → Dados** → adicione o nó `admins` → dentro, uma chave com o seu UID e valor `true` (boolean).
4. Saia e entre de novo no site: aparece o painel 👑 de administradora.

Daí em diante: Configurações → horários, dias de atendimento, WhatsApp, serviços e preços.

### 8. Testar
- **Cartão:** use as credenciais de teste e os cartões de teste da documentação do Mercado Pago.
- **PIX:** o jeito mais confiável é trocar para o token de **produção**, criar um serviço de R$ 1, pagar você mesma e estornar pelo painel do site.
- Se algo falhar: `firebase functions:log`.

### 9. Produção
Troque o Access Token pelo de **produção** (`firebase functions:secrets:set MP_ACCESS_TOKEN`), configure o webhook também em modo produção (com a assinatura secreta de produção) e faça `firebase deploy --only functions`.

## Pontos de atenção

- **Estorno:** cliente cancela com pagamento confirmado até 24h antes → estorno automático. Administradora escolhe estornar ou não ao cancelar.
- **Serviços padrão** (nomes, preços, durações) são exemplos — ajuste em Configurações.
- **Domínio próprio:** se usar outro endereço, coloque-o em `SITE_URL` e em *Authentication → Configurações → Domínios autorizados*.
- **Opcional, recomendado depois:** ativar o **Firebase App Check** (reCAPTCHA) para barrar robôs.
- **Aviso honesto:** este projeto foi testado com simulações (lógica de horários com testes automáticos e o site em navegador com Firebase simulado). Ainda **não foi executado contra um Firebase e um Mercado Pago reais** — faça o passo 8 antes de divulgar.
