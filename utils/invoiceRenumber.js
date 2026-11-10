// Renumbering the sales invoices in order (0001, 0002, 0003 … by sale date, then by the time they were
// entered) — and carrying the new numbers into every place that copied the old ones as text.
//
// The numbers are only ever linked by the invoice's id; the text copies are the ledger entry descriptions
// ("Sale cost - Invoice INV-AMD26-0004" …) and, for completeness, a few other free-text fields. All of that
// is rewritten in a single pass from an old -> new lookup, so one rename can never cascade into another.

import crypto from "crypto";

export const MIN_AGE_MINUTES = 10; // refuse to run if an invoice was created more recently than this
const NUMBER_RE = /^(.*)-(\d+)$/;

// Every free-text field that may hold an invoice number
export const TEXT_TARGETS = [
  { delegate: "ledgerEntry", collection: "LedgerEntry", field: "remarks" },
  { delegate: "refund", collection: "Refund", field: "remarks" },
  { delegate: "refund", collection: "Refund", field: "refundReason" },
  { delegate: "salePayment", collection: "SalePayment", field: "remarks" },
  { delegate: "vendorCustomerPayment", collection: "VendorCustomerPayment", field: "remarks" },
  { delegate: "sale", collection: "Sale", field: "remarks" },
  { delegate: "expense", collection: "Expense", field: "description" },
  { delegate: "balanceAdjustment", collection: "BalanceAdjustment", field: "remarks" },
  { delegate: "balanceAdjustment", collection: "BalanceAdjustment", field: "reason" },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pad = (n, width) => String(n).padStart(width, "0");

export function parseInvoiceNo(no) {
  const m = NUMBER_RE.exec(String(no || ""));
  return m ? { prefix: m[1], n: Number(m[2]), width: m[2].length } : null;
}

export function safeTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Karachi";
  }
}

// the calendar day (YYYY-MM-DD) of a date in the user's time zone
const dayKey = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));

/**
 * The plan: per numbering series (the text before the last "-"), sort the invoices by sale DAY, then by when
 * they were entered, then by their old number, and number them 1..N with no gaps.
 * @param invoices  [{ id, invoiceNo, saleDate, createdAt, salesCount }]
 */
export function buildPlan(invoices, tz) {
  const zone = safeTimeZone(tz);
  const skipped = [];
  const series = new Map();
  for (const inv of invoices) {
    const parsed = parseInvoiceNo(inv.invoiceNo);
    if (!parsed) {
      skipped.push({ id: inv.id, invoiceNo: inv.invoiceNo, reason: "not in the PREFIX-NUMBER format" });
      continue;
    }
    if (!series.has(parsed.prefix)) series.set(parsed.prefix, []);
    series.get(parsed.prefix).push({ ...inv, prefix: parsed.prefix, oldN: parsed.n });
  }

  const rows = [];
  const groups = [];
  for (const [prefix, list] of [...series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort(
      (a, b) =>
        dayKey(a.saleDate, zone).localeCompare(dayKey(b.saleDate, zone)) ||
        new Date(a.createdAt) - new Date(b.createdAt) ||
        a.oldN - b.oldN,
    );
    const width = Math.max(4, String(list.length).length);
    let changed = 0;
    list.forEach((inv, i) => {
      const newNo = `${prefix}-${pad(i + 1, width)}`;
      const isChanged = newNo !== inv.invoiceNo;
      if (isChanged) changed += 1;
      rows.push({
        id: inv.id,
        prefix,
        oldNo: inv.invoiceNo,
        newNo,
        saleDate: new Date(inv.saleDate).toISOString(),
        day: dayKey(inv.saleDate, zone),
        createdAt: new Date(inv.createdAt).toISOString(),
        salesCount: inv.salesCount ?? 0,
        changed: isChanged,
      });
    });
    groups.push({ prefix, total: list.length, changed, nextNumber: list.length + 1 });
  }

  // a fingerprint of exactly what would change: a preview can only be run if nothing moved since
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify([zone, rows.map((r) => `${r.id}:${r.oldNo}>${r.newNo}`)]))
    .digest("hex");

  const mapping = new Map(rows.map((r) => [r.oldNo, r.newNo])); // every invoice, changed or not
  return { tz: zone, rows, groups, skipped, mapping, hash, prefixes: [...series.keys()] };
}

/** Rewrites every invoice number in `text` from the lookup, in ONE pass. Returns { text, found, dangling }. */
export function rewriteText(text, mapping, prefixes) {
  if (!text || !prefixes.length) return { text, found: 0, dangling: 0 };
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${prefixes.map(esc).join("|")})-\\d+`, "g");
  let found = 0;
  let dangling = 0;
  const out = text.replace(re, (token) => {
    found += 1;
    if (mapping.has(token)) return mapping.get(token);
    dangling += 1; // a number in some text that no invoice has any more (e.g. a deleted invoice)
    return token;
  });
  return { text: out, found, dangling };
}

/** Every text field that mentions a number of these series, with its rewritten text. */
export async function scanTexts(client, plan) {
  const rows = [];
  let dangling = 0;
  const seen = new Set();
  for (const t of TEXT_TARGETS) {
    for (const prefix of plan.prefixes) {
      const hits = await client[t.delegate].findMany({
        where: { [t.field]: { contains: `${prefix}-` } },
        select: { id: true, [t.field]: true },
      });
      for (const h of hits) {
        const key = `${t.collection}.${t.field}:${h.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { text, dangling: d } = rewriteText(h[t.field], plan.mapping, plan.prefixes);
        dangling += d;
        if (text !== h[t.field]) rows.push({ model: t.collection, field: t.field, id: h.id, oldText: h[t.field], newText: text });
      }
    }
  }
  return { rows, dangling };
}

/** One command, many updates (the transaction-safe way to change hundreds of rows quickly). */
export async function bulkSet(tx, collection, items) {
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const r = await tx.$runCommandRaw({
      update: collection,
      updates: chunk.map((it) => ({ q: { _id: { $oid: it.id } }, u: { $set: it.set } })),
    });
    if (!r.ok || r.n !== chunk.length || (r.writeErrors && r.writeErrors.length)) {
      throw new Error(`Bulk update of ${collection} did not apply to every row (${r.n}/${chunk.length})`);
    }
  }
}

export async function loadInvoices(client, onlyPrefix = null) {
  const list = await client.salesInvoice.findMany({
    select: { id: true, invoiceNo: true, saleDate: true, createdAt: true, _count: { select: { sales: true } } },
  });
  return list
    .filter((i) => !onlyPrefix || i.invoiceNo.startsWith(`${onlyPrefix}-`))
    .map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, saleDate: i.saleDate, createdAt: i.createdAt, salesCount: i._count.sales }));
}

export const newestInvoiceAgeMinutes = (invoices) =>
  invoices.length ? (Date.now() - Math.max(...invoices.map((i) => new Date(i.createdAt).getTime()))) / 60000 : Infinity;

const ledgerTotals = async (client) => {
  const agg = await client.ledgerEntry.aggregate({ _count: { _all: true }, _sum: { debit: true, credit: true } });
  const acc = await client.account.aggregate({ _sum: { balance: true } });
  return { entries: agg._count._all, debit: agg._sum.debit || 0, credit: agg._sum.credit || 0, balances: acc._sum.balance || 0 };
};

/**
 * Renames the invoices and rewrites the texts, all inside ONE transaction, then checks the result; any failed
 * check throws and the transaction is rolled back. `direction` "forward" applies old->new, "restore" new->old.
 */
export async function applyRenumber(prisma, { plan, texts, counters, direction = "forward", onlyPrefix = null }) {
  const forward = direction === "forward";
  return prisma.$transaction(
    async (tx) => {
      // ---- the state must still be exactly what was previewed ----
      const current = await loadInvoices(tx, onlyPrefix);
      const byId = new Map(current.map((i) => [i.id, i]));
      for (const r of plan.rows) {
        const from = forward ? r.oldNo : r.newNo;
        if (byId.get(r.id)?.invoiceNo !== from) throw new Error(`Invoice ${from} is no longer what it was — start again from the preview`);
      }

      const before = await ledgerTotals(tx);
      const changed = plan.rows.filter((r) => r.changed);

      // ---- invoices: a temporary name first, then the final one (the numbers are unique) ----
      await bulkSet(tx, "SalesInvoice", changed.map((r) => ({ id: r.id, set: { invoiceNo: `RENUMBER-TMP-${r.id}` } })));
      await bulkSet(tx, "SalesInvoice", changed.map((r) => ({ id: r.id, set: { invoiceNo: forward ? r.newNo : r.oldNo } })));

      // ---- the text copies ----
      const byField = new Map();
      for (const t of texts) {
        const k = `${t.model}|${t.field}`;
        if (!byField.has(k)) byField.set(k, []);
        byField.get(k).push(t);
      }
      for (const [k, list] of byField) {
        const [collection, field] = k.split("|");
        // each row must still hold the text we expect to replace
        const target = TEXT_TARGETS.find((x) => x.collection === collection && x.field === field);
        const live = await tx[target.delegate].findMany({ where: { id: { in: list.map((t) => t.id) } }, select: { id: true, [field]: true } });
        const liveById = new Map(live.map((l) => [l.id, l[field]]));
        for (const t of list) {
          if (liveById.get(t.id) !== (forward ? t.oldText : t.newText)) throw new Error(`A ${collection} ${field} changed since the preview — start again`);
        }
        await bulkSet(tx, collection, list.map((t) => ({ id: t.id, set: { [field]: forward ? t.newText : t.oldText } })));
      }

      // ---- the counters ----
      for (const c of counters) {
        await tx.invoiceCounter.updateMany({ where: { key: c.key }, data: { currentNumber: forward ? c.after : c.before } });
      }

      // ---- checks: any failure rolls everything back ----
      const checks = [];
      const check = (name, ok, detail = "") => {
        checks.push({ name, ok: !!ok, detail });
        if (!ok) throw new Error(`Check failed: ${name}${detail ? ` (${detail})` : ""} — nothing was changed`);
      };
      const after = await loadInvoices(tx, onlyPrefix);
      check("same number of invoices", after.length === current.length, `${current.length} -> ${after.length}`);
      check("no temporary names left", !after.some((i) => i.invoiceNo.startsWith("RENUMBER-TMP-")));
      check("no duplicate numbers", new Set(after.map((i) => i.invoiceNo)).size === after.length);
      const afterById = new Map(after.map((i) => [i.id, i.invoiceNo]));
      check(
        "every invoice has its planned number",
        plan.rows.every((r) => afterById.get(r.id) === (forward ? r.newNo : r.oldNo)),
      );
      if (forward) {
        for (const g of plan.groups) {
          const nums = after.filter((i) => i.invoiceNo.startsWith(`${g.prefix}-`)).map((i) => parseInvoiceNo(i.invoiceNo).n).sort((a, b) => a - b);
          check(`${g.prefix}: numbers run 1 to ${g.total} with no gaps`, nums.length === g.total && nums.every((n, i) => n === i + 1));
        }
      }
      for (const [k, list] of byField) {
        const [collection, field] = k.split("|");
        const target = TEXT_TARGETS.find((x) => x.collection === collection && x.field === field);
        const live = await tx[target.delegate].findMany({ where: { id: { in: list.map((t) => t.id) } }, select: { id: true, [field]: true } });
        const liveById = new Map(live.map((l) => [l.id, l[field]]));
        check(
          `${collection}.${field}: ${list.length} text(s) carry the right numbers`,
          list.every((t) => liveById.get(t.id) === (forward ? t.newText : t.oldText)),
        );
      }
      const post = await ledgerTotals(tx);
      check("ledger entries, debits, credits and account balances are exactly as before", JSON.stringify(post) === JSON.stringify(before), JSON.stringify({ before, post }));
      for (const c of counters) {
        const doc = await tx.invoiceCounter.findUnique({ where: { key: c.key }, select: { currentNumber: true } });
        check(`counter ${c.key} is ${forward ? c.after : c.before}`, doc?.currentNumber === (forward ? c.after : c.before));
      }
      return { checks, invoicesRenamed: changed.length, textsRewritten: texts.length };
    },
    { maxWait: 20000, timeout: 120000 },
  );
}
