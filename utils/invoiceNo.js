function pad(num, size = 4) {
  return String(num).padStart(size, "0");
}

function getInvoiceKey(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  return `INV-ALR${yy}`;
}

export async function generateNextSalesInvoiceNo(tx, date = new Date()) {
  const key = getInvoiceKey(date);

  const counter = await tx.invoiceCounter.upsert({
    where: { key },                 // ✅ now valid
    create: { key, currentNumber: 1 },
    update: { currentNumber: { increment: 1 } },
    select: { key: true, currentNumber: true },
  });

  return `${counter.key}-${pad(counter.currentNumber, 4)}`;
}
