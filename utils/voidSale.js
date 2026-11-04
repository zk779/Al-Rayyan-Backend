// VOID sales: a ticket issued and cancelled with the vendor inside its void window.
// It is only ever between us and the vendor — no customer, no cash, no bank — so the
// whole thing is two entries on the vendor's ledger:
//
//   credit  = net + vendor service charges + vendor VAT   (what the vendor bills us)
//   debit   = credit - additional/void charges            (what the vendor gives back)
//
// The debit is stored as the sale's sellPrice. The vendor keeps `voidCharges`.
//
// Optionally we add our own service charge: it is the sale's profit and its 15% VAT
// goes in vatAmount (no ledger entry — nobody is paying it through this sale).
//
// Create is reached through the ordinary POST /api/sales (a line with status "VOID");
// edit and delete have their own routes so the normal-sale code is never touched.

const VAT_RATE = 0.15;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;

export const isVoidLine = (line) => String(line?.status || "").toUpperCase() === "VOID";

/** Validates one void line and works out every amount from it (the server is the single source). */
export function resolveVoidAmounts(line) {
  const net = num(line.netPrice);
  const vendorServiceCharge = num(line.vendorServiceCharge);
  const voidCharges = num(line.voidCharges);
  const companyServiceCharge = num(line.companyServiceCharge);

  if ([line.netPrice, line.vendorServiceCharge ?? 0, line.voidCharges ?? 0, line.companyServiceCharge ?? 0].some((v) => isNaN(Number(v))))
    throw new Error("Amounts must be numbers");
  if (net <= 0) throw new Error("Net amount must be greater than 0");
  if (vendorServiceCharge < 0 || voidCharges < 0 || companyServiceCharge < 0)
    throw new Error("Charges cannot be negative");

  const vendorVat = round2(vendorServiceCharge * VAT_RATE);
  if (line.vendorVat !== undefined && line.vendorVat !== null && line.vendorVat !== "" && Math.abs(num(line.vendorVat) - vendorVat) > 0.011)
    throw new Error(`Vendor VAT must be 15% of the vendor service charges (${vendorVat.toFixed(2)})`);

  const credit = round2(net + vendorServiceCharge + vendorVat);
  if (voidCharges > credit) throw new Error("Additional / void charges cannot be more than the vendor credit amount");
  const debit = round2(credit - voidCharges);

  const companyVat = round2(companyServiceCharge * VAT_RATE);

  return { net, vendorServiceCharge, vendorVat, voidCharges, credit, debit, companyServiceCharge, companyVat };
}

// The fields a void sale row stores for these amounts.
const saleFields = (a) => ({
  netPrice: a.net,
  sellPrice: a.debit, // the amount debited on the vendor ledger
  profit: a.companyServiceCharge, // only our own service charge is profit
  vatAmount: a.companyVat, // its 15%
  paxVat: 0,
  miscCharges: 0,
  vendorServiceCharge: a.vendorServiceCharge,
  vendorVat: a.vendorVat,
  voidCharges: a.voidCharges,
  companyServiceCharge: a.companyServiceCharge,
  // no customer is involved; these only keep the required columns sensible
  paymentType: "CREDIT",
  paymentStatus: "PAID",
  paidAmount: a.debit,
  status: "VOID",
});

// Balance change of the vendor's account for a void: the same direction as an ordinary
// sale for the credit, then the opposite for the debit — so only the retained charge is left.
//   DEBIT vendor  (we owe them):  +credit, -debit
//   CREDIT vendor (prepaid):      -credit, +debit
const balanceChange = (vendor, credit, debit) =>
  round2(vendor.category === "DEBIT" ? credit - debit : debit - credit);

async function postVendorLedger(tx, { vendor, saleId, invoiceId, invoiceNo, date, amounts }) {
  // two separate entries, created in order, so the ledger reads credit first, then debit
  await tx.ledgerEntry.create({
    data: {
      accountId: vendor.account.id,
      entryType: "SALE",
      debit: 0,
      credit: amounts.credit,
      transactionDate: date,
      saleId,
      invoiceId,
      remarks: `Void ticket cost (net ${amounts.net.toFixed(2)} + vendor charges ${amounts.vendorServiceCharge.toFixed(2)} + VAT ${amounts.vendorVat.toFixed(2)}) - Invoice ${invoiceNo}`,
    },
  });
  await tx.ledgerEntry.create({
    data: {
      accountId: vendor.account.id,
      entryType: "VOID",
      debit: amounts.debit,
      credit: 0,
      transactionDate: date,
      saleId,
      invoiceId,
      remarks: `Void amount returned by vendor (less void charges ${amounts.voidCharges.toFixed(2)}) - Invoice ${invoiceNo}`,
    },
  });
  await tx.account.update({
    where: { id: vendor.account.id },
    data: { balance: { increment: balanceChange(vendor, amounts.credit, amounts.debit) } },
  });
}

async function reverseVendorLedger(tx, sale, vendor) {
  const credit = round2(num(sale.netPrice) + num(sale.vendorServiceCharge) + num(sale.vendorVat));
  const debit = round2(num(sale.sellPrice));
  await tx.ledgerEntry.deleteMany({
    where: { saleId: sale.id, accountId: vendor.account.id, entryType: { in: ["SALE", "VOID"] } },
  });
  await tx.account.update({
    where: { id: vendor.account.id },
    data: { balance: { increment: -balanceChange(vendor, credit, debit) } },
  });
}

// A prepaid (CREDIT) vendor's balance goes down by the part the vendor keeps.
const assertVendorCanCover = (vendor, amounts) => {
  if (vendor.category === "CREDIT") {
    const balance = num(vendor.account?.balance);
    if (amounts.voidCharges > balance)
      throw new Error(
        `Insufficient balance for vendor "${vendor.vendorName}". Available: ${balance}, Required: ${amounts.voidCharges}`,
      );
  }
};

async function refreshInvoiceTotals(tx, invoiceId) {
  const totals = await tx.sale.aggregate({
    where: { invoiceId },
    _sum: { netPrice: true, sellPrice: true, profit: true },
  });
  await tx.salesInvoice.update({
    where: { id: invoiceId },
    data: {
      totalNet: totals._sum.netPrice || 0,
      totalSell: totals._sum.sellPrice || 0,
      totalProfit: totals._sum.profit || 0,
    },
  });
}

export function makeVoidHandlers({ prisma, generateNextSalesInvoiceNo }) {
  const requireIds = (line) => {
    if (!line.vendorId) throw new Error("Vendor is required");
    if (!line.airlineId) throw new Error("Airline is required");
  };

  // POST /api/sales with status VOID lines
  const create = async (req, res) => {
    try {
      const { saleDate, sales } = req.body;
      if (!sales.every(isVoidLine)) throw new Error("A void invoice cannot be mixed with ordinary sales");

      const amountsList = sales.map((s) => {
        requireIds(s);
        return resolveVoidAmounts(s);
      });

      const vendorIds = [...new Set(sales.map((s) => s.vendorId))];
      const vendors = await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, include: { account: true } });
      const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v]));
      sales.forEach((s, i) => {
        const vendor = vendorMap[s.vendorId];
        if (!vendor) throw new Error(`Vendor not found: ${s.vendorId}`);
        if (!vendor.account) throw new Error(`Vendor "${vendor.vendorName}" has no account`);
        assertVendorCanCover(vendor, amountsList[i]);
      });

      const businessDate = saleDate ? new Date(saleDate) : new Date();

      const invoice = await prisma.$transaction(
        async (tx) => {
          const invoiceNo = await generateNextSalesInvoiceNo(tx, businessDate);
          const inv = await tx.salesInvoice.create({
            data: { invoiceNo, saleDate: businessDate, userId: req.user.id, branchId: req.user.branchId || null },
          });

          for (let i = 0; i < sales.length; i++) {
            const s = sales[i];
            const amounts = amountsList[i];
            const sale = await tx.sale.create({
              data: {
                invoiceId: inv.id,
                airlineId: s.airlineId,
                vendorId: s.vendorId,
                documentNo: s.documentNo || null,
                pnr: s.pnr || null,
                paxName: s.paxName || null,
                saleType: "AIRLINE",
                tripType: s.tripType || "Oneway",
                remarks: s.remarks || null,
                ...saleFields(amounts),
              },
            });
            await postVendorLedger(tx, {
              vendor: vendorMap[s.vendorId],
              saleId: sale.id,
              invoiceId: inv.id,
              invoiceNo,
              date: businessDate,
              amounts,
            });
          }

          await refreshInvoiceTotals(tx, inv.id);
          return inv;
        },
        { timeout: 30000 },
      );

      return res.status(201).json({ success: true, message: "Void processed successfully", data: invoice });
    } catch (err) {
      console.error(err);
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  // PUT /api/sales/void/:saleId — body is one void line (+ optional saleDate)
  const update = async (req, res) => {
    const { saleId } = req.params;
    try {
      const line = req.body || {};
      requireIds(line);
      const amounts = resolveVoidAmounts(line);

      await prisma.$transaction(
        async (tx) => {
          const sale = await tx.sale.findUnique({
            where: { id: saleId },
            include: { invoice: true, vendor: { include: { account: true } } },
          });
          if (!sale) throw new Error("Void sale not found");
          if (sale.status !== "VOID") throw new Error("This is not a void sale");
          if (!sale.vendor?.account) throw new Error("Vendor account not found");

          // put the old vendor balance back first, then post the new figures
          await reverseVendorLedger(tx, sale, sale.vendor);

          const vendor = await tx.vendor.findUnique({ where: { id: line.vendorId }, include: { account: true } });
          if (!vendor) throw new Error(`Vendor not found: ${line.vendorId}`);
          if (!vendor.account) throw new Error(`Vendor "${vendor.vendorName}" has no account`);
          assertVendorCanCover(vendor, amounts);

          const businessDate = line.saleDate ? new Date(line.saleDate) : sale.invoice.saleDate;
          if (line.saleDate) {
            await tx.salesInvoice.update({ where: { id: sale.invoiceId }, data: { saleDate: businessDate } });
          }

          await tx.sale.update({
            where: { id: saleId },
            data: {
              airlineId: line.airlineId,
              vendorId: line.vendorId,
              documentNo: line.documentNo || null,
              pnr: line.pnr || null,
              paxName: line.paxName || null,
              remarks: line.remarks || null,
              ...saleFields(amounts),
            },
          });

          await postVendorLedger(tx, {
            vendor,
            saleId,
            invoiceId: sale.invoiceId,
            invoiceNo: sale.invoice.invoiceNo,
            date: businessDate,
            amounts,
          });
          await refreshInvoiceTotals(tx, sale.invoiceId);
        },
        { timeout: 30000 },
      );

      return res.json({ success: true, message: "Void updated successfully" });
    } catch (err) {
      console.error(err);
      return res.status(400).json({ success: false, error: err.message || "Failed to update void" });
    }
  };

  // DELETE /api/sales/void/:saleId
  const remove = async (req, res) => {
    const { saleId } = req.params;
    try {
      await prisma.$transaction(
        async (tx) => {
          const sale = await tx.sale.findUnique({
            where: { id: saleId },
            include: { vendor: { include: { account: true } } },
          });
          if (!sale) throw new Error("Void sale not found");
          if (sale.status !== "VOID") throw new Error("This is not a void sale");

          if (sale.vendor?.account) await reverseVendorLedger(tx, sale, sale.vendor);
          await tx.ledgerEntry.deleteMany({ where: { saleId } }); // safety net
          await tx.sale.delete({ where: { id: saleId } });

          const left = await tx.sale.count({ where: { invoiceId: sale.invoiceId } });
          if (left === 0) {
            await tx.ledgerEntry.deleteMany({ where: { invoiceId: sale.invoiceId } });
            await tx.salesInvoice.delete({ where: { id: sale.invoiceId } });
          } else {
            await refreshInvoiceTotals(tx, sale.invoiceId);
          }
        },
        { timeout: 30000 },
      );
      return res.json({ success: true, message: "Void deleted successfully" });
    } catch (err) {
      console.error(err);
      return res.status(400).json({ success: false, error: err.message || "Failed to delete void" });
    }
  };

  return { create, update, remove };
}
