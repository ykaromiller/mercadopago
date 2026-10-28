/**
 * Funções puras (sem Firebase) — fáceis de testar.
 * Todo horário é interpretado em America/Sao_Paulo (UTC-3, sem horário de verão).
 */
const TZ_OFFSET = "-03:00";
const BLOCK = 30; // minutos — granularidade da agenda (cada bloco é uma "trava" no banco)

const DEFAULT_SERVICES = {
  cilios_fio_a_fio:   { name: "Cílios Fio a Fio",          price: 150, duration: 120 },
  cilios_volume_br:   { name: "Volume Brasileiro",         price: 170, duration: 150 },
  cilios_volume_russo:{ name: "Volume Russo",              price: 190, duration: 150 },
  cilios_manutencao:  { name: "Manutenção de Cílios",      price: 90,  duration: 60 },
  lash_lifting:       { name: "Lash Lifting",              price: 120, duration: 60 },
  design_sobrancelha: { name: "Design de Sobrancelha",     price: 45,  duration: 30 },
  design_henna:       { name: "Design com Henna",          price: 60,  duration: 60 },
  brow_lamination:    { name: "Brow Lamination",           price: 110, duration: 60 },
};

const DEFAULT_SETTINGS = {
  studioName: "Lumi Studio",
  startTime: "09:00",
  endTime: "18:00",
  slotStep: 30,            // de quanto em quanto tempo um horário pode começar
  workingDays: [2, 3, 4, 5, 6],
  leadMinutes: 60,         // antecedência mínima para agendar
  maxAdvanceDays: 90,      // até quantos dias à frente se pode agendar
  whatsapp: "",
};

function parseSlot(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || !/^\d{2}:\d{2}$/.test(String(time))) return null;
  const ms = Date.parse(`${day}T${time}:00${TZ_OFFSET}`);
  if (isNaN(ms)) return null;
  // ida e volta: rejeita datas inexistentes (ex.: 2026-02-31)
  const back = new Date(ms - 3 * 3600 * 1000).toISOString();
  if (back.slice(0, 10) !== day || back.slice(11, 16) !== time) return null;
  return ms;
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

function dayOfWeek(day) {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** Chaves (em minutos desde 1970) dos blocos de 30 min ocupados por um atendimento. */
function blockKeys(startMs, duration) {
  const first = Math.round(startMs / 60000);
  const keys = [];
  for (let i = 0; i < Math.ceil(duration / BLOCK); i++) keys.push(first + i * BLOCK);
  return keys;
}

/**
 * Valida se (day, time) é um início de atendimento permitido.
 * opts.admin = true ignora antecedência mínima e limite de dias à frente.
 */
function validateSlot({ day, time, duration }, settings, nowMs, opts = {}) {
  const start = parseSlot(day, time);
  if (start === null) return { ok: false, error: "Data ou horário inválido." };
  if (!Number.isInteger(duration) || duration <= 0 || duration % BLOCK !== 0) {
    return { ok: false, error: "Duração do serviço inválida." };
  }
  if (!opts.admin) {
    if (start < nowMs + (Number(settings.leadMinutes) || 0) * 60000) {
      return { ok: false, error: "Esse horário já passou ou está muito próximo." };
    }
    if (start > nowMs + (Number(settings.maxAdvanceDays) || 90) * 86400000) {
      return { ok: false, error: "Esse dia ainda não está disponível para agendamento." };
    }
  }
  const working = (settings.workingDays || []).map(Number);
  if (!working.includes(dayOfWeek(day))) {
    return { ok: false, error: "O studio não atende nesse dia." };
  }
  const startMin = toMin(time);
  const open = toMin(settings.startTime);
  const close = toMin(settings.endTime);
  const step = Math.max(BLOCK, parseInt(settings.slotStep) || BLOCK);
  if (startMin < open || startMin + duration > close || (startMin - open) % step !== 0) {
    return { ok: false, error: "Horário fora do expediente." };
  }
  return { ok: true, start };
}

// "2026-10-27T20:00:00.000-03:00" (formato exigido pelo Mercado Pago)
function mpDate(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().replace("Z", "-03:00");
}

module.exports = {
  BLOCK, DEFAULT_SERVICES, DEFAULT_SETTINGS,
  parseSlot, toMin, dayOfWeek, blockKeys, validateSlot, mpDate,
};
