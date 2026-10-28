const assert = require("assert");
const { parseSlot, blockKeys, validateSlot, mpDate, dayOfWeek, DEFAULT_SETTINGS } = require("../lib");

const settings = { ...DEFAULT_SETTINGS }; // 09:00-18:00, passo 30, ter-sáb, antecedência 60min
// "agora" = segunda 2026-11-02 12:00 (SP)
const NOW = parseSlot("2026-11-02", "12:00");

// parseSlot
assert.strictEqual(parseSlot("2026-11-03", "14:00"), Date.parse("2026-11-03T17:00:00Z"));
assert.strictEqual(parseSlot("2026-02-31", "10:00"), null);
assert.strictEqual(parseSlot("2026-11-03", "25:00"), null);
assert.strictEqual(parseSlot("lixo", "10:00"), null);
assert.strictEqual(parseSlot("2026-11-03", "9:00"), null);

// dia da semana independente do fuso do servidor
assert.strictEqual(dayOfWeek("2026-11-03"), 2); // terça
assert.strictEqual(dayOfWeek("2026-11-01"), 0); // domingo

const ok = (o, opts) => validateSlot({ duration: 60, ...o }, settings, NOW, opts);

assert.ok(ok({ day: "2026-11-03", time: "09:00" }).ok);
assert.ok(ok({ day: "2026-11-03", time: "17:00" }).ok);                 // termina exatamente às 18:00
assert.ok(!ok({ day: "2026-11-03", time: "17:30" }).ok);                // estoura o expediente
assert.ok(!ok({ day: "2026-11-03", time: "08:30" }).ok);                // antes de abrir
assert.ok(!ok({ day: "2026-11-02", time: "14:00" }).ok);                // segunda: não atende
assert.ok(!ok({ day: "2026-11-01", time: "10:00" }).ok);                // domingo
assert.ok(!ok({ day: "2026-11-02", time: "12:30" }).ok);                // passado/antecedência (e segunda)
assert.ok(!ok({ day: "2026-11-03", time: "09:15" }).ok);                // fora da grade de 30min
assert.ok(!ok({ day: "2027-06-01", time: "10:00" }).ok);                // além de 90 dias
assert.ok(!validateSlot({ day: "2026-11-03", time: "10:00", duration: 45 }, settings, NOW).ok); // duração inválida
assert.ok(!validateSlot({ day: "2026-11-03", time: "10:00", duration: 0 }, settings, NOW).ok);

// antecedência: terça 09:00 com "agora" = terça 08:30 → bloqueia; admin pode
const NOW2 = parseSlot("2026-11-03", "08:30");
assert.ok(!validateSlot({ day: "2026-11-03", time: "09:00", duration: 60 }, settings, NOW2).ok);
assert.ok(validateSlot({ day: "2026-11-03", time: "09:00", duration: 60 }, settings, NOW2, { admin: true }).ok);

// passo de 60 min
const s60 = { ...settings, slotStep: 60 };
assert.ok(validateSlot({ day: "2026-11-03", time: "10:00", duration: 60 }, s60, NOW).ok);
assert.ok(!validateSlot({ day: "2026-11-03", time: "10:30", duration: 60 }, s60, NOW).ok);

// blockKeys: 2h = 4 blocos de 30min, consecutivos e inteiros
const start = parseSlot("2026-11-03", "14:00");
const keys = blockKeys(start, 120);
assert.strictEqual(keys.length, 4);
assert.deepStrictEqual(keys.map((k, i) => k - keys[0] - i * 30), [0, 0, 0, 0]);
assert.ok(keys.every(Number.isInteger));
// dois atendimentos que se sobrepõem compartilham ao menos um bloco
const other = blockKeys(parseSlot("2026-11-03", "15:30"), 60);
assert.ok(keys.some((k) => other.includes(k)));
// atendimentos colados não compartilham
const next = blockKeys(parseSlot("2026-11-03", "16:00"), 60);
assert.ok(!keys.some((k) => next.includes(k)));

// mpDate
assert.strictEqual(mpDate(Date.parse("2026-11-03T17:00:00Z")), "2026-11-03T14:00:00.000-03:00");

console.log("lib.test.js: todos os testes passaram");
