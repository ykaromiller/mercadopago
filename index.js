/**
 * Barbearia Ruan — Cloud Functions (Mercado Pago)
 *
 *  createPayment  (callable)  cria o agendamento "aguardando pagamento" e
 *                             gera o PIX (QR Code) ou o link do Checkout Pro (cartão)
 *  cancelPayment  (callable)  cancela uma cobrança pendente e libera o horário
 *  mpwebhook      (HTTP)      recebe a notificação do Mercado Pago e marca como pago
 *  cleanupExpired (agendada)  remove reservas não pagas que expiraram
 *
 * O Access Token do Mercado Pago fica SOMENTE aqui (Secret Manager), nunca no site.
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");
const SITE_URL = defineString("SITE_URL");
const WEBHOOK_URL = defineString("WEBHOOK_URL", { default: "" });

const REGION = "southamerica-east1";
const TZ = "America/Sao_Paulo";
const PIX_MINUTES = 15;
const CARD_MINUTES = 30;

admin.initializeApp({
  databaseURL: "https://barbearia-ruan-default-rtdb.firebaseio.com",
});
const db = admin.database();

const DEFAULT_SERVICES = {
  corte: { name: "Corte", price: 30 },
  corte_barba: { name: "Corte + Barba", price: 35 },
  barba: { name: "Barba", price: 10 },
  sobrancelha: { name: "Sobrancelha", price: 5 },
  luzes: { name: "Luzes", price: 50 },
  platinado: { name: "Platinado", price: 90 },
  platinado_corte: { name: "Platinado + Corte", price: 110 },
};
const DEFAULT_SETTINGS = {
  slotDuration: 60,
  slotGap: 0,
  startTime: "08:00",
  endTime: "18:00",
  workingDays: [1, 2, 3, 4, 5],
};

/* ───────────────────────── helpers ───────────────────────── */

async function mp(path, { method = "GET", body, idem } = {}) {
  const res = await fetch("https://api.mercadopago.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
      "Content-Type": "application/json",
      ...(idem ? { "X-Idempotency-Key": idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.error("Mercado Pago error", { path, status: res.status, json });
    const err = new Error(`MP ${res.status}`);
    err.mp = json;
    throw err;
  }
  return json;
}

// "2026-10-27T20:00:00.000-03:00" (formato exigido pelo MP)
function mpDate(ms) {
  const d = new Date(ms - 3 * 3600 * 1000); // desloca para UTC-3 (Brasil não usa horário de verão)
  return d.toISOString().replace("Z", "-03:00");
}

function spParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  return { dow, minutes: parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10) };
}

const blocksSlot = (a, now) =>
  a.paymentStatus !== "awaiting_payment" || (a.expiresAt || 0) > now;

async function getServices() {
  const s = await db.ref("customServices").get();
  return s.exists() ? s.val() : DEFAULT_SERVICES;
}
async function getSettings() {
  const s = await db.ref("settings").get();
  return s.exists() ? { ...DEFAULT_SETTINGS, ...s.val() } : DEFAULT_SETTINGS;
}

function methodFromMp(payment) {
  switch (payment.payment_type_id) {
    case "credit_card": return "credit";
    case "debit_card": return "debit";
    default: return "pix"; // bank_transfer / account_money
  }
}

async function validateSlot(date, settings) {
  const now = Date.now();
  if (isNaN(date.getTime()) || date.getTime() <= now) {
    throw new HttpsError("failed-precondition", "Esse horário já passou.");
  }
  const { dow, minutes } = spParts(date);
  const workingDays = (settings.workingDays || []).map(Number);
  if (!workingDays.includes(dow)) {
    throw new HttpsError("failed-precondition", "A barbearia não atende nesse dia.");
  }
  const [sh, sm] = String(settings.startTime).split(":").map(Number);
  const [eh, em] = String(settings.endTime).split(":").map(Number);
  const dur = parseInt(settings.slotDuration) || 60;
  const step = dur + (parseInt(settings.slotGap) || 0);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (minutes < start || minutes + dur > end || (minutes - start) % step !== 0) {
    throw new HttpsError("failed-precondition", "Horário fora do expediente.");
  }
}

async function slotTaken(isoDate, exceptId) {
  const snap = await db.ref("appointments").orderByChild("date").equalTo(isoDate).get();
  if (!snap.exists()) return false;
  const now = Date.now();
  let taken = false;
  snap.forEach((child) => {
    if (child.key !== exceptId && blocksSlot(child.val(), now)) taken = true;
  });
  return taken;
}

/* ───────────────────────── createPayment ───────────────────────── */

exports.createPayment = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN], maxInstances: 10, cors: true },
  async (req) => {
    const { method, appointmentId, booking } = req.data || {};
    if (!["pix", "credit", "debit"].includes(method)) {
      throw new HttpsError("invalid-argument", "Forma de pagamento inválida.");
    }

    const services = await getServices();
    let aptId = appointmentId;
    let apt;
    let isNew = false;

    if (aptId) {
      const snap = await db.ref(`appointments/${aptId}`).get();
      if (!snap.exists()) throw new HttpsError("not-found", "Agendamento não encontrado.");
      apt = snap.val();
      if (!["pending", "awaiting_payment"].includes(apt.paymentStatus)) {
        throw new HttpsError("failed-precondition", "Este agendamento já foi pago.");
      }
    } else {
      const username = String(booking?.username || "").trim().slice(0, 60);
      const svc = services[booking?.service];
      const date = new Date(booking?.date);
      if (!username) throw new HttpsError("invalid-argument", "Usuário inválido.");
      if (!svc) throw new HttpsError("invalid-argument", "Serviço inválido.");

      await validateSlot(date, await getSettings());
      const iso = date.toISOString();
      if (await slotTaken(iso)) {
        throw new HttpsError("already-exists", "Esse horário acabou de ser reservado. Escolha outro.");
      }

      const minutes = method === "pix" ? PIX_MINUTES : CARD_MINUTES;
      apt = {
        username,
        date: iso,
        service: booking.service,
        serviceName: svc.name,
        servicePrice: Number(svc.price),
        paymentMethod: method,
        paymentStatus: "awaiting_payment",
        expiresAt: Date.now() + minutes * 60 * 1000,
        createdAt: new Date().toISOString(),
      };
      const ref = db.ref("appointments").push();
      await ref.set(apt);
      aptId = ref.key;
      isNew = true;

      // Segunda checagem contra corrida: se outro pedido chegou antes, desiste.
      const snap = await db.ref("appointments").orderByChild("date").equalTo(iso).get();
      let loser = false;
      snap.forEach((c) => {
        const o = c.val();
        if (c.key !== aptId && blocksSlot(o, Date.now()) &&
            (o.createdAt < apt.createdAt || (o.createdAt === apt.createdAt && c.key < aptId))) {
          loser = true;
        }
      });
      if (loser) {
        await db.ref(`appointments/${aptId}`).remove();
        throw new HttpsError("already-exists", "Esse horário acabou de ser reservado. Escolha outro.");
      }
    }

    const amount = Number(apt.servicePrice);
    const notificationUrl =
      WEBHOOK_URL.value() ||
      `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/mpwebhook`;

    try {
      if (method === "pix") {
        const expiresAt = isNew ? apt.expiresAt : Date.now() + PIX_MINUTES * 60 * 1000;
        const payment = await mp("/v1/payments", {
          method: "POST",
          idem: `${aptId}-pix-${Date.now()}`,
          body: {
            transaction_amount: amount,
            description: `${apt.serviceName} - Barbearia Ruan`,
            payment_method_id: "pix",
            payer: {
              email: `cliente+${aptId.toLowerCase().replace(/[^a-z0-9]/g, "")}@barbeariaruan.com.br`,
              first_name: String(apt.username).slice(0, 30),
            },
            external_reference: aptId,
            notification_url: notificationUrl,
            date_of_expiration: mpDate(expiresAt),
          },
        });
        const td = payment.point_of_interaction?.transaction_data || {};
        await db.ref(`appointments/${aptId}`).update({
          paymentMethod: "pix",
          mpPaymentId: String(payment.id),
          ...(isNew ? {} : {}),
        });
        return {
          appointmentId: aptId,
          amount,
          serviceName: apt.serviceName,
          date: apt.date,
          expiresAt,
          pix: { qrCode: td.qr_code, qrCodeBase64: td.qr_code_base64 },
        };
      }

      // Cartão (crédito/débito) → Checkout Pro (o Mercado Pago coleta os dados do cartão)
      const site = SITE_URL.value().replace(/\/+$/, "");
      const back = (r) => `${site}/?apt=${aptId}&result=${r}`;
      const blocked = method === "credit"
        ? ["debit_card", "ticket", "bank_transfer", "atm", "account_money", "prepaid_card"]
        : ["credit_card", "ticket", "bank_transfer", "atm", "account_money", "prepaid_card"];
      const expiresAt = isNew ? apt.expiresAt : Date.now() + CARD_MINUTES * 60 * 1000;
      const pref = await mp("/checkout/preferences", {
        method: "POST",
        body: {
          items: [{
            id: apt.service,
            title: `${apt.serviceName} - Barbearia Ruan`,
            quantity: 1,
            currency_id: "BRL",
            unit_price: amount,
          }],
          external_reference: aptId,
          notification_url: notificationUrl,
          back_urls: { success: back("success"), pending: back("pending"), failure: back("failure") },
          auto_return: "approved",
          payment_methods: { excluded_payment_types: blocked.map((id) => ({ id })) },
          expires: true,
          expiration_date_to: mpDate(expiresAt),
          statement_descriptor: "BARBEARIA RUAN",
        },
      });
      await db.ref(`appointments/${aptId}`).update({ paymentMethod: method, mpPreferenceId: pref.id });
      return { appointmentId: aptId, amount, checkoutUrl: pref.init_point };
    } catch (e) {
      if (isNew) await db.ref(`appointments/${aptId}`).remove();
      logger.error("createPayment failed", e);
      throw new HttpsError("internal", "Não foi possível gerar o pagamento. Tente novamente.");
    }
  }
);

/* ───────────────────────── cancelPayment ───────────────────────── */

async function cancelMpPayment(paymentId) {
  try {
    await mp(`/v1/payments/${paymentId}`, { method: "PUT", body: { status: "cancelled" } });
  } catch (e) {
    logger.warn("Não foi possível cancelar pagamento no MP", { paymentId });
  }
}

exports.cancelPayment = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN], maxInstances: 10, cors: true },
  async (req) => {
    const id = req.data?.appointmentId;
    if (!id) throw new HttpsError("invalid-argument", "Agendamento inválido.");
    const snap = await db.ref(`appointments/${id}`).get();
    if (!snap.exists()) return { ok: true };
    const apt = snap.val();
    if (apt.paymentStatus === "paid") return { ok: false, reason: "paid" };
    if (apt.mpPaymentId) await cancelMpPayment(apt.mpPaymentId);
    if (apt.paymentStatus === "awaiting_payment") {
      await db.ref(`appointments/${id}`).remove();
    }
    return { ok: true };
  }
);

/* ───────────────────────── webhook ───────────────────────── */

function validSignature(req, dataId) {
  const header = req.get("x-signature");
  const requestId = req.get("x-request-id");
  if (!header || !requestId) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=").map((s) => s.trim()))
  );
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET.value())
    .update(manifest)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.mpwebhook = onRequest(
  { region: REGION, secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET], maxInstances: 10 },
  async (req, res) => {
    try {
      const type = req.query.type || req.query.topic || req.body?.type;
      const dataId = req.query["data.id"] || req.body?.data?.id || req.query.id;
      if (!dataId) return res.status(200).send("ignored");

      if (!validSignature(req, dataId)) {
        logger.warn("Assinatura inválida no webhook");
        return res.status(401).send("invalid signature");
      }
      if (type !== "payment") return res.status(200).send("ignored");

      // Fonte da verdade: consulta o pagamento direto na API do Mercado Pago
      const payment = await mp(`/v1/payments/${dataId}`);
      const aptId = payment.external_reference;
      if (!aptId) return res.status(200).send("no reference");

      const ref = db.ref(`appointments/${aptId}`);
      const snap = await ref.get();

      if (payment.status !== "approved") {
        logger.info("Pagamento não aprovado", { dataId, status: payment.status });
        return res.status(200).send("ok");
      }
      if (!snap.exists()) {
        // Pagou mas a reserva já tinha sido removida → precisa de atenção manual/reembolso
        logger.error("PAGAMENTO ÓRFÃO", { paymentId: dataId, aptId });
        await db.ref(`orphanPayments/${dataId}`).set({
          aptId,
          amount: payment.transaction_amount,
          receivedAt: new Date().toISOString(),
        });
        return res.status(200).send("orphan");
      }
      const apt = snap.val();
      if (apt.paymentStatus === "paid") return res.status(200).send("already paid");
      if (Number(payment.transaction_amount) + 0.001 < Number(apt.servicePrice)) {
        logger.error("Valor pago menor que o do serviço", { dataId, aptId });
        return res.status(200).send("amount mismatch");
      }

      await ref.update({
        paymentStatus: "paid",
        paymentMethod: methodFromMp(payment),
        mpPaymentId: String(payment.id),
        paidAt: new Date().toISOString(),
        expiresAt: null,
      });
      logger.info("Agendamento pago", { aptId, paymentId: dataId });
      return res.status(200).send("ok");
    } catch (e) {
      logger.error("webhook error", e);
      return res.status(500).send("error"); // o MP tenta de novo
    }
  }
);

/* ───────────────────────── limpeza ───────────────────────── */

exports.cleanupExpired = onSchedule(
  { region: REGION, schedule: "every 15 minutes", timeZone: TZ, secrets: [MP_ACCESS_TOKEN] },
  async () => {
    const snap = await db.ref("appointments").orderByChild("paymentStatus").equalTo("awaiting_payment").get();
    if (!snap.exists()) return;
    const limit = Date.now() - 2 * 60 * 1000; // margem de 2 min
    const jobs = [];
    snap.forEach((c) => {
      const a = c.val();
      if ((a.expiresAt || 0) < limit) {
        if (a.mpPaymentId) jobs.push(cancelMpPayment(a.mpPaymentId));
        jobs.push(db.ref(`appointments/${c.key}`).remove());
      }
    });
    await Promise.all(jobs);
    logger.info("cleanupExpired", { removed: jobs.length });
  }
);
