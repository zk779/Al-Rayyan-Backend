import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import {
  MIN_AGE_MINUTES,
  applyRenumber,
  buildPlan,
  loadInvoices,
  newestInvoiceAgeMinutes,
  parseInvoiceNo,
  scanTexts,
} from "../utils/invoiceRenumber.js";

// ADMIN ONLY. Renumber the sales invoices in order (sale day, then entry time) with no gaps — preview first,
// a backup file, then one all-or-nothing run; and a restore from that backup file.
//
//   GET  /api/invoice-renumber/preview?tz=      what would change (writes nothing)
//   GET  /api/invoice-renumber/backup?tz=&planHash=   the backup file for exactly that plan
//   POST /api/invoice-renumber/run              { tz, planHash, confirm: "RENUMBER", backupDownloaded: true }
//   POST /api/invoice-renumber/restore          { backup, confirm: "RESTORE", dryRun? }
//
// `onlyPrefix` (query / body) narrows everything to one numbering series — it can only make the job smaller.

const router = express.Router();
const prisma = new PrismaClient();

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, include: { role: true } });
    if (!user || !user.isActive) return res.status(401).json({ error: "User inactive or removed" });
    req.user = { ...decoded, roleName: user.role?.name || null };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

const adminOnly = (req, res, next) => {
  if (String(req.user?.roleName || "").toUpperCase() !== "ADMIN") {
    return res.status(403).json({ success: false, error: "Only an admin can renumber invoices" });
  }
  next();
};

const counterPlan = async (plan) => {
  const out = [];
  for (const g of plan.groups) {
    const doc = await prisma.invoiceCounter.findUnique({ where: { key: g.prefix }, select: { currentNumber: true } });
    if (doc) out.push({ key: g.prefix, before: doc.currentNumber, after: g.total });
  }
  return out;
};

// the plan + everything it would rewrite, from the database as it is right now
async function computeEverything(tz, onlyPrefix) {
  const invoices = await loadInvoices(prisma, onlyPrefix);
  const plan = buildPlan(invoices, tz);
  const texts = await scanTexts(prisma, plan);
  const counters = await counterPlan(plan);
  const blockedReasons = [];
  const age = newestInvoiceAgeMinutes(invoices);
  if (age < MIN_AGE_MINUTES) {
    blockedReasons.push(`An invoice was created ${Math.max(0, Math.floor(age))} minute(s) ago. Wait until nobody is creating invoices (at least ${MIN_AGE_MINUTES} minutes since the last one), then preview again.`);
  }
  return { invoices, plan, texts, counters, blockedReasons };
}

/* ----------------------------- PREVIEW (writes nothing) ----------------------------- */
router.get("/preview", authenticate, adminOnly, async (req, res) => {
  try {
    const { plan, texts, counters, blockedReasons } = await computeEverything(req.query.tz, req.query.onlyPrefix || null);
    const changedRows = plan.rows.filter((r) => r.changed);

    const byTarget = {};
    for (const t of texts.rows) {
      const k = `${t.model}.${t.field}`;
      byTarget[k] = (byTarget[k] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        tz: plan.tz,
        planHash: plan.hash,
        blocked: blockedReasons.length > 0,
        blockedReasons,
        nothingToDo: changedRows.length === 0,
        totals: { invoices: plan.rows.length, changed: changedRows.length, unchanged: plan.rows.length - changedRows.length },
        groups: plan.groups.map((g) => ({ ...g, counter: counters.find((c) => c.key === g.prefix) || null })),
        rows: plan.rows,
        skipped: plan.skipped,
        texts: {
          rewrite: texts.rows.length,
          byTarget: Object.entries(byTarget).map(([target, count]) => ({ target, count })),
          // numbers in some text that no invoice has any more (a deleted invoice) — left exactly as they are
          dangling: texts.dangling,
        },
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to build the preview" });
  }
});

/* ----------------------------- BACKUP FILE ----------------------------- */
router.get("/backup", authenticate, adminOnly, async (req, res) => {
  try {
    const { plan, texts, counters } = await computeEverything(req.query.tz, req.query.onlyPrefix || null);
    if (req.query.planHash !== plan.hash) {
      return res.status(409).json({ success: false, error: "The invoices changed since the preview — preview again" });
    }
    const backup = {
      type: "invoice-renumber-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      tz: plan.tz,
      planHash: plan.hash,
      note: "Old and new invoice numbers, the texts that mention them, and the counter — enough to put everything back.",
      counters,
      invoices: plan.rows.filter((r) => r.changed).map((r) => ({ id: r.id, oldNo: r.oldNo, newNo: r.newNo, changed: true })),
      texts: texts.rows,
    };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="renumber-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to make the backup file" });
  }
});

/* ----------------------------- RUN ----------------------------- */
router.post("/run", authenticate, adminOnly, async (req, res) => {
  try {
    const { tz, planHash, confirm, backupDownloaded, onlyPrefix } = req.body || {};
    if (confirm !== "RENUMBER") return res.status(400).json({ success: false, error: 'Type RENUMBER to confirm' });
    if (backupDownloaded !== true) return res.status(400).json({ success: false, error: "Download the backup file first" });

    const { plan, texts, counters, blockedReasons } = await computeEverything(tz, onlyPrefix || null);
    if (blockedReasons.length) return res.status(409).json({ success: false, error: blockedReasons[0] });
    if (planHash !== plan.hash) {
      return res.status(409).json({ success: false, error: "The invoices changed since the preview — preview again" });
    }
    if (!plan.rows.some((r) => r.changed)) return res.json({ success: true, message: "The invoices are already in order", data: { checks: [], invoicesRenamed: 0, textsRewritten: 0 } });

    const result = await applyRenumber(prisma, { plan, texts: texts.rows, counters, direction: "forward", onlyPrefix: onlyPrefix || null });
    res.json({ success: true, message: `Renumbered ${result.invoicesRenamed} invoice(s) and rewrote ${result.textsRewritten} text(s)`, data: result });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, error: err.message || "Failed to renumber" });
  }
});

/* ----------------------------- RESTORE FROM THE BACKUP FILE ----------------------------- */
router.post("/restore", authenticate, adminOnly, async (req, res) => {
  try {
    const { backup, confirm, dryRun, onlyPrefix } = req.body || {};
    if (!backup || backup.type !== "invoice-renumber-backup" || backup.version !== 1 || !Array.isArray(backup.invoices) || !Array.isArray(backup.texts)) {
      return res.status(400).json({ success: false, error: "This is not a renumber backup file" });
    }
    if (!dryRun && confirm !== "RESTORE") return res.status(400).json({ success: false, error: "Type RESTORE to confirm" });

    // the system must still be exactly as the run left it
    const current = await loadInvoices(prisma, onlyPrefix || null);
    const byId = new Map(current.map((i) => [i.id, i.invoiceNo]));
    const wrong = backup.invoices.filter((i) => byId.get(i.id) !== i.newNo);
    if (wrong.length) {
      return res.status(409).json({
        success: false,
        error: `${wrong.length} invoice(s) no longer have the number the run gave them (e.g. ${wrong[0].newNo}), so the backup can't be applied safely.`,
      });
    }
    const plan = {
      rows: backup.invoices.map((i) => ({ id: i.id, oldNo: i.oldNo, newNo: i.newNo, changed: true })),
      groups: [],
    };
    const counters = (backup.counters || []).map((c) => ({ key: c.key, before: c.before, after: c.after }));
    // the counter never goes below the highest number that exists now
    for (const c of counters) {
      const highest = Math.max(0, ...current.filter((i) => i.invoiceNo.startsWith(`${c.key}-`)).map((i) => parseInvoiceNo(i.invoiceNo)?.n || 0));
      c.before = Math.max(c.before, highest);
    }
    if (dryRun) {
      return res.json({ success: true, data: { restorable: true, invoices: backup.invoices.length, texts: backup.texts.length, createdAt: backup.createdAt } });
    }
    const result = await applyRenumber(prisma, { plan, texts: backup.texts, counters, direction: "restore", onlyPrefix: onlyPrefix || null });
    res.json({ success: true, message: `Restored ${result.invoicesRenamed} invoice number(s) and ${result.textsRewritten} text(s)`, data: result });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, error: err.message || "Failed to restore" });
  }
});

export default router;
