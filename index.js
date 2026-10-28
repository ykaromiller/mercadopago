/**
 * Studio de Cílios e Sobrancelhas — Cloud Functions
 *
 * TODA escrita de agendamento passa por aqui (as regras do banco proíbem o navegador
 * de gravar em /appointments e /busy). Assim ninguém consegue se marcar como "pago",
 * mudar preço ou furar a agenda pelo console do navegador.
 *
 *  createPayment   (callable)  reserva o horário e gera PIX ou link do Checkout Pro (cartão)
 *  cancelPayment   (callable)  cliente desiste de um pagamento pendente → libera o horário
 *  checkPayment    (callable)  confere direto no Mercado Pago se o pagamento foi aprovado
 *  cancelAppointment(callable) cliente (até 24h antes) ou admin cancela; estorna se pago
 *  adminBook       (callable)  admin agenda para uma cliente (pago no local ou pendente)
 *  adminMarkPaid   (callable)  admin marca como pago um agendamento "pagar no local"
 *  mpwebhook       (HTTP)      Mercado Pago avisa que o pagamento foi aprovado
 *  cleanupExpired  (agendada)  libera reservas não pagas que expiraram
 *
 * O Access Token do Mercado Pago fica SOMENTE aqui (Secret Manager).
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const {
  BLOCK, DEFAULT_SERVICES, DEFAULT_SETTINGS, blockKeys, validateSlot, mpDate,
} = require("./lib");

const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");
const SITE_URL = defineString("SITE_URL");
const DATABASE_URL = defineString("DATABASE_URL");
const WEBHOOK_URL = defineString("WEBHOOK_URL", { default: "" });

const REGION = "southamerica-east1";
const TZ = "America/Sao_Paulo";
const PIX_MINUTES = 15;
const CARD_MINUTES = 30;
const MAX_OPEN_PER_USER = 3; // reservas "aguardando pagamento" simultâneas por cliente

let _db;
function db() {
  if (!_db) {
    admin.initializeApp({ databaseURL: DATABASE_URL.value() });
    _db = admin.database();
  }
  return _db;
}

/* ───────────────────────── helpers gerais ───────────────────────── */

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
    err.status = res.status;
    err.mp = json;
    throw err;
  }
  return json;
}

function requireAuth(req) {
  if (!req.auth || !req.auth.uid) {
    throw new HttpsError("unauthenticated", "Faça login para continuar.");
  }
  return { uid: req.auth.uid, email: req.auth.token?.email || "" };
}

async function isAdmin(uid) {
  const s = await db().ref(`admins/${uid}`).get();
  return s.val() === true;
}
async function requireAdmin(req) {
  const a = requireAuth(req);
  if (!(await isAdmin(a.uid))) throw new HttpsError("permission-denied", "Acesso restrito.");
  return a;
}

async function getServices() {
  const s = await db().ref("services").get();
  return s.exists() ? s.val() : DEFAULT_SERVICES;
}
async function getSettings() {
  const s = await db().ref("settings").get();
  return s.exists() ? { ...DEFAULT_SETTINGS, ...s.val() } : DEFAULT_SETTINGS;
}

function methodFromMp(payment) {
  switch (payment.payment_type_id) {
    case "credit_card": return "credit";
    case "debit_card": return "debit";
    default: return "pix";
  }
}

async function audit(type, data) {
  try {
    await db().ref("auditLog").push({ type, at: new Date().toISOString(), ...data });
  } catch (e) { logger.warn("audit falhou", e); }
}

/* ───────────────────────── trava de horários (/busy) ─────────────────────────
 * Cada atendimento ocupa N blocos de 30 min em /busy/{minutos}: { a: idAgendamento, e: expiraEm|0 }.
 * Cada bloco é gravado com transação atômica → duas clientes nunca pegam o mesmo horário,
 * mesmo clicando no mesmo milissegundo.
 */
async function acquireBlocks(aptId, keys, expiresAt) {
  const got = [];
  for (const k of keys) {
    const res = await db().ref(`busy/${k}`).transaction((cur) => {
      const now = Date.now();
      if (cur && cur.a !== aptId && (cur.e === 0 || cur.e > now)) return; // ocupado → aborta
      return { a: aptId, e: expiresAt };
    });
    if (!res.committed) {
      await releaseBlocks(aptId, got);
      return false;
    }
    got.push(k);
  }
  return true;
}

async function releaseBlocks(aptId, keys) {
  await Promise.all(keys.map((k) =>
    db().ref(`busy/${k}`).transaction((cur) => (cur && cur.a === aptId ? null : cur))
  ));
}

async function removeAppointment(aptId, apt) {
  await releaseBlocks(aptId, blockKeys(apt.start, apt.duration));
  const updates = { [`appointments/${aptId}`]: null };
  if (apt.uid) updates[`userAppointments/${apt.uid}/${aptId}`] = null;
  await db().ref().update(updates);
}

/* ───────────────────────── Mercado Pago: cancelar / estornar ───────────────────────── */

async function cancelMpPayment(paymentId) {
  try {
    await mp(`/v1/payments/${paymentId}`, { method: "PUT", body: { status: "cancelled" } });
  } catch (e) {
    logger.warn("Não foi possível cancelar pagamento no MP", { paymentId });
  }
}

async function refundMpPayment(paymentId) {
  try {
    await mp(`/v1/payments/${paymentId}/refunds`, {
      method: "POST", body: {}, idem: `refund-${paymentId}`,
    });
    return true;
  } catch (e) {
    return false;
  }
}

/* ───────────────────────── confirmar pagamento (webhook + checkPayment) ───────────────────────── */

async function orphan(payment, reason) {
  logger.error("PAGAMENTO ÓRFÃO", { paymentId: payment.id, reason });
  const refunded = await refundMpPayment(payment.id);
  await db().ref(`orphanPayments/${payment.id}`).set({
    aptId: payment.external_reference || null,
    amount: payment.transaction_amount,
    reason,
    refunded,
    receivedAt: new Date().toISOString(),
  });
  await audit("orphan_payment", { paymentId: String(payment.id), reason, refunded });
  return refunded ? "orphan-refunded" : "orphan-needs-manual-refund";
}

/** Fonte da verdade: recebe o objeto de pagamento vindo DIRETO da API do Mercado Pago. */
async function settlePayment(payment) {
  const aptId = payment.external_reference;
  if (!aptId) return "no-reference";
  const ref = db().ref(`appointments/${aptId}`);
  const snap = await ref.get();

  if (payment.status === "approved") {
    if (!snap.exists()) return orphan(payment, "reserva já tinha sido removida");
    const apt = snap.val();

    if (apt.paymentStatus === "paid") {
      if (apt.mpPaymentId && apt.mpPaymentId !== String(payment.id)) {
        return orphan(payment, "pagamento duplicado");
      }
      return "already-paid";
    }
    if (apt.paymentStatus === "refunded") return "refunded";
    if (Number(payment.transaction_amount) + 0.001 < Number(apt.servicePrice)) {
      return orphan(payment, "valor pago menor que o do serviço");
    }

    // Garante o horário (pode ter expirado enquanto a cliente pagava)
    const ok = await acquireBlocks(aptId, blockKeys(apt.start, apt.duration), 0);
    if (!ok) {
      await removeAppointment(aptId, apt);
      return orphan(payment, "horário foi ocupado após a reserva expirar");
    }
    await ref.update({
      paymentStatus: "paid",
      paymentMethod: methodFromMp(payment),
      mpPaymentId: String(payment.id),
      paidAt: new Date().toISOString(),
      expiresAt: null,
    });
    logger.info("Agendamento pago", { aptId, paymentId: payment.id });
    return "paid";
  }

  if (["refunded", "charged_back"].includes(payment.status) && snap.exists()) {
    const apt = snap.val();
    if (apt.paymentStatus === "paid" && apt.mpPaymentId === String(payment.id)) {
      await releaseBlocks(aptId, blockKeys(apt.start, apt.duration));
      await ref.update({ paymentStatus: "refunded", refundedAt: new Date().toISOString() });
      return "refunded";
    }
  }
  logger.info("Pagamento não aprovado", { id: payment.id, status: payment.status });
  return "not-approved";
}

/* ───────────────────────── createPayment ───────────────────────── */

exports.createPayment = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN], maxInstances: 10, cors: true },
  async (req) => {
    const { uid, email } = requireAuth(req);
    const { method, appointmentId, booking } = req.data || {};
    if (!["pix", "credit", "debit"].includes(method)) {
      throw new HttpsError("invalid-argument", "Forma de pagamento inválida.");
    }

    const minutes = method === "pix" ? PIX_MINUTES : CARD_MINUTES;
    const expiresAt = Date.now() + minutes * 60 * 1000;
    let aptId = appointmentId;
    let apt;
    let isNew = false;

    if (aptId) {
      // pagar (de novo) uma reserva que já existe
      const snap = await db().ref(`appointments/${aptId}`).get();
      if (!snap.exists()) throw new HttpsError("not-found", "Agendamento não encontrado ou expirado.");
      apt = snap.val();
      if (apt.uid !== uid) throw new HttpsError("permission-denied", "Agendamento de outra cliente.");
      if (apt.paymentStatus !== "awaiting_payment") {
        throw new HttpsError("failed-precondition", "Este agendamento não está aguardando pagamento.");
      }
      const ok = await acquireBlocks(aptId, blockKeys(apt.start, apt.duration), expiresAt);
      if (!ok) throw new HttpsError("already-exists", "Esse horário foi ocupado. Escolha outro.");
      if (apt.mpPaymentId) await cancelMpPayment(apt.mpPaymentId);
      await db().ref(`appointments/${aptId}`).update({ expiresAt, paymentMethod: method });
      apt.expiresAt = expiresAt;
    } else {
      const services = await getServices();
      const settings = await getSettings();
      const svc = services[booking?.service];
      if (!svc) throw new HttpsError("invalid-argument", "Serviço inválido.");

      const v = validateSlot(
        { day: booking?.day, time: booking?.time, duration: Number(svc.duration) },
        settings, Date.now()
      );
      if (!v.ok) throw new HttpsError("failed-precondition", v.error);

      // limite de reservas abertas por cliente (evita "segurar" a agenda inteira)
      const mine = await db().ref(`userAppointments/${uid}`).get();
      if (mine.exists()) {
        const rows = await Promise.all(Object.keys(mine.val()).map((id) => db().ref(`appointments/${id}`).get()));
        const open = rows.filter((r) => r.exists() && r.val().paymentStatus === "awaiting_payment"
          && (r.val().expiresAt || 0) > Date.now()).length;
        if (open >= MAX_OPEN_PER_USER) {
          throw new HttpsError("resource-exhausted",
            "Você já tem reservas aguardando pagamento. Pague ou cancele antes de reservar outra.");
        }
      }

      const profile = (await db().ref(`users/${uid}`).get()).val() || {};
      aptId = db().ref("appointments").push().key;
      const keys = blockKeys(v.start, svc.duration);
      const got = await acquireBlocks(aptId, keys, expiresAt);
      if (!got) throw new HttpsError("already-exists", "Esse horário acabou de ser reservado. Escolha outro.");

      apt = {
        uid,
        clientName: String(profile.name || email || "Cliente").slice(0, 60),
        clientPhone: String(profile.phone || "").slice(0, 20),
        clientEmail: email,
        start: v.start,
        duration: Number(svc.duration),
        service: booking.service,
        serviceName: svc.name,
        servicePrice: Number(svc.price),
        paymentMethod: method,
        paymentStatus: "awaiting_payment",
        expiresAt,
        createdAt: new Date().toISOString(),
      };
      try {
        await db().ref().update({
          [`appointments/${aptId}`]: apt,
          [`userAppointments/${uid}/${aptId}`]: true,
        });
      } catch (e) {
        await releaseBlocks(aptId, keys);
        throw new HttpsError("internal", "Não foi possível reservar. Tente novamente.");
      }
      isNew = true;
    }

    const amount = Number(apt.servicePrice);
    const studio = (await getSettings()).studioName || DEFAULT_SETTINGS.studioName;
    const notificationUrl =
      WEBHOOK_URL.value() ||
      `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/mpwebhook`;

    try {
      if (method === "pix") {
        const payment = await mp("/v1/payments", {
          method: "POST",
          idem: `${aptId}-pix-${Date.now()}`,
          body: {
            transaction_amount: amount,
            description: `${apt.serviceName} - ${studio}`.slice(0, 250),
            payment_method_id: "pix",
            payer: {
              email: apt.clientEmail || email,
              first_name: String(apt.clientName).slice(0, 30),
            },
            external_reference: aptId,
            notification_url: notificationUrl,
            date_of_expiration: mpDate(expiresAt),
          },
        });
        const td = payment.point_of_interaction?.transaction_data || {};
        await db().ref(`appointments/${aptId}`).update({ mpPaymentId: String(payment.id) });
        return {
          appointmentId: aptId,
          amount,
          expiresAt,
          pix: { qrCode: td.qr_code, qrCodeBase64: td.qr_code_base64 },
        };
      }

      // Cartão → Checkout Pro (o Mercado Pago coleta os dados do cartão com segurança)
      const site = SITE_URL.value().replace(/\/+$/, "");
      const back = (r) => `${site}/?apt=${aptId}&result=${r}`;
      const blocked = method === "credit"
        ? ["debit_card", "ticket", "bank_transfer", "atm", "account_money", "prepaid_card"]
        : ["credit_card", "ticket", "bank_transfer", "atm", "account_money", "prepaid_card"];
      const pref = await mp("/checkout/preferences", {
        method: "POST",
        body: {
          items: [{
            id: apt.service,
            title: `${apt.serviceName} - ${studio}`.slice(0, 250),
            quantity: 1,
            currency_id: "BRL",
            unit_price: amount,
          }],
          payer: { email: apt.clientEmail || email, name: String(apt.clientName).slice(0, 30) },
          external_reference: aptId,
          notification_url: notificationUrl,
          back_urls: { success: back("success"), pending: back("pending"), failure: back("failure") },
          auto_return: "approved",
          payment_methods: { excluded_payment_types: blocked.map((id) => ({ id })) },
          expires: true,
          expiration_date_to: mpDate(expiresAt),
          statement_descriptor: studio.replace(/[^A-Za-z0-9 ]/g, "").toUpperCase().slice(0, 22) || "STUDIO",
        },
      });
      await db().ref(`appointments/${aptId}`).update({ mpPreferenceId: pref.id });
      return { appointmentId: aptId, amount, checkoutUrl: pref.init_point };
    } catch (e) {
      logger.error("createPayment failed", e);
      if (isNew) await removeAppointment(aptId, apt);
      throw new HttpsError("internal", "Não foi possível gerar o pagamento. Tente novamente.");
    }
  }
);

/* ───────────────────────── cancelPayment (pagamento ainda não feito) ───────────────────────── */

exports.cancelPayment = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN], maxInstances: 10, cors: true },
  async (req) => {
    const { uid } = requireAuth(req);
    const id = req.data?.appointmentId;
    if (!id) throw new HttpsError("invalid-argument", "Agendamento inválido.");
    const snap = await db().ref(`appointments/${id}`).get();
    if (!snap.exists()) return { ok: true };
    const apt = snap.val();
    if (apt.uid !== uid) throw new HttpsError("permission-denied", "Agendamento de outra cliente.");
    if (apt.paymentStatus === "paid") return { ok: false, reason: "paid" };
    if (apt.paymentStatus !== "awaiting_payment") {
      throw new HttpsError("failed-precondition", "Use o cancelamento de agendamento.");
    }
    if (apt.mpPaymentId) await cancelMpPayment(apt.mpPaymentId);
    await removeAppointment(id, apt);
    return { ok: true };
  }
);

/* ───────────────────────── checkPayment ───────────────────────── */

exports.checkPayment = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN], maxInstances: 10, cors: true },
  async (req) => {
    const { uid } = requireAuth(req);
    const id = req.data?.appointmentId;
    if (!id) throw new HttpsError("invalid-argument", "Agendamento inválido.");
    const snap = await db().ref(`appointments/${id}`).get();
    if (!snap.exists()) return { status: "gone" };
    let apt = snap.val();
    if (apt.uid !== uid && !(await isAdmin(uid))) {
      throw new HttpsError("permission-denied", "Agendamento de outra cliente.");
    }
    if (apt.paymentStatus === "awaiting_payment") {
      try {
        const found = await mp(
          `/v1/payments/search?external_reference=${encodeURIComponent(id)}&sort=date_created&criteria=desc&limit=10`
        );
        const approved = (found.results || []).find((p) => p.status === "approved");
        if (approved) {
          await settlePayment(approved);
          apt = (await db().ref(`appointments/${id}`).get()).val() || {};
        }
      } catch (e) {
        logger.warn("checkPayment: busca no MP falhou", { id });
      }
    }
    return { status: apt.paymentStatus || "gone" };
  }
);

/* ───────────────────────── cancelAppointment ───────────────────────── */

exports.cancelAppointment = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN], maxInstances: 10, cors: true },
  async (req) => {
    const { uid } = requireAuth(req);
    const { appointmentId, refund } = req.data || {};
    if (!appointmentId) throw new HttpsError("invalid-argument", "Agendamento inválido.");
    const snap = await db().ref(`appointments/${appointmentId}`).get();
    if (!snap.exists()) return { ok: true };
    const apt = snap.val();
    const adm = await isAdmin(uid);
    if (apt.uid !== uid && !adm) throw new HttpsError("permission-denied", "Agendamento de outra cliente.");

    if (!adm && apt.start - Date.now() <= 24 * 3600 * 1000) {
      throw new HttpsError("failed-precondition", "Cancelamento só é permitido até 24h antes do horário.");
    }

    let refunded = false;
    if (apt.paymentStatus === "paid" && apt.mpPaymentId) {
      const wantRefund = adm ? refund === true : true; // cliente: estorno automático
      if (wantRefund) {
        refunded = await refundMpPayment(apt.mpPaymentId);
        if (!refunded) {
          throw new HttpsError("internal",
            "Não foi possível estornar agora. Nada foi cancelado — tente de novo ou fale com o studio.");
        }
      }
    }
    if (apt.mpPaymentId && apt.paymentStatus === "awaiting_payment") await cancelMpPayment(apt.mpPaymentId);

    await removeAppointment(appointmentId, apt);
    await audit("cancel", {
      aptId: appointmentId, by: uid, admin: adm, wasPaid: apt.paymentStatus === "paid", refunded,
      amount: apt.servicePrice, client: apt.clientName,
    });
    return { ok: true, refunded };
  }
);

/* ───────────────────────── ações de admin ───────────────────────── */

exports.adminBook = onCall(
  { region: REGION, maxInstances: 5, cors: true },
  async (req) => {
    const { uid } = await requireAdmin(req);
    const { clientName, clientPhone, service, day, time, paid } = req.data || {};
    const name = String(clientName || "").trim().slice(0, 60);
    if (name.length < 2) throw new HttpsError("invalid-argument", "Informe o nome da cliente.");
    const svc = (await getServices())[service];
    if (!svc) throw new HttpsError("invalid-argument", "Serviço inválido.");
    const v = validateSlot({ day, time, duration: Number(svc.duration) }, await getSettings(), Date.now(), { admin: true });
    if (!v.ok) throw new HttpsError("failed-precondition", v.error);

    const aptId = db().ref("appointments").push().key;
    const keys = blockKeys(v.start, svc.duration);
    if (!(await acquireBlocks(aptId, keys, 0))) {
      throw new HttpsError("already-exists", "Esse horário já está ocupado.");
    }
    const apt = {
      uid: null,
      clientName: name,
      clientPhone: String(clientPhone || "").replace(/\D/g, "").slice(0, 20),
      start: v.start,
      duration: Number(svc.duration),
      service,
      serviceName: svc.name,
      servicePrice: Number(svc.price),
      paymentMethod: paid ? "presencial" : null,
      paymentStatus: paid ? "paid" : "pending",
      bookedByAdmin: true,
      createdAt: new Date().toISOString(),
      ...(paid ? { paidAt: new Date().toISOString() } : {}),
    };
    try {
      await db().ref(`appointments/${aptId}`).set(apt);
    } catch (e) {
      await releaseBlocks(aptId, keys);
      throw new HttpsError("internal", "Não foi possível agendar.");
    }
    await audit("admin_book", { aptId, by: uid, client: name });
    return { ok: true, appointmentId: aptId };
  }
);

exports.adminMarkPaid = onCall(
  { region: REGION, maxInstances: 5, cors: true },
  async (req) => {
    const { uid } = await requireAdmin(req);
    const id = req.data?.appointmentId;
    const snap = await db().ref(`appointments/${id}`).get();
    if (!snap.exists()) throw new HttpsError("not-found", "Agendamento não encontrado.");
    const apt = snap.val();
    if (apt.paymentStatus !== "pending") {
      throw new HttpsError("failed-precondition", "Só dá para marcar como pago um agendamento 'pagar no local'.");
    }
    await db().ref(`appointments/${id}`).update({
      paymentStatus: "paid", paymentMethod: "presencial", paidAt: new Date().toISOString(),
    });
    await audit("admin_mark_paid", { aptId: id, by: uid, amount: apt.servicePrice });
    return { ok: true };
  }
);

/* ───────────────────────── webhook do Mercado Pago ───────────────────────── */

function validSignature(req, dataId) {
  const header = req.get("x-signature");
  const requestId = req.get("x-request-id");
  if (!header || !requestId) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=").map((s) => s.trim()))
  );
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET.value()).update(manifest).digest("hex");
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

      let payment;
      try {
        payment = await mp(`/v1/payments/${dataId}`); // consulta direto no MP: nunca confia no corpo da requisição
      } catch (e) {
        if (e.status === 404) return res.status(200).send("payment not found"); // ex.: notificação de teste
        throw e;
      }
      const result = await settlePayment(payment);
      return res.status(200).send(result);
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
    const now = Date.now();
    const snap = await db().ref("appointments").orderByChild("paymentStatus").equalTo("awaiting_payment").get();
    const jobs = [];
    if (snap.exists()) {
      snap.forEach((c) => {
        const a = c.val();
        if ((a.expiresAt || 0) < now - 2 * 60 * 1000) { // margem de 2 min
          if (a.mpPaymentId) jobs.push(cancelMpPayment(a.mpPaymentId));
          jobs.push(removeAppointment(c.key, a));
        }
      });
    }
    // blocos órfãos: reservas vencidas ou horários antigos
    const busy = await db().ref("busy").get();
    if (busy.exists()) {
      const upd = {};
      busy.forEach((c) => {
        const b = c.val();
        const expired = b.e !== 0 && b.e < now;
        const old = Number(c.key) * 60000 < now - 2 * 86400000;
        if (expired || old) upd[`busy/${c.key}`] = null;
      });
      if (Object.keys(upd).length) jobs.push(db().ref().update(upd));
    }
    await Promise.all(jobs);
    logger.info("cleanupExpired", { jobs: jobs.length });
  }
);
