// Invoice numbers for "Other Services" (transportation, Umrah visa, NADRA …): their own series,
// counted separately from sales invoices, e.g. SRV-AMD26-0001 (one counter per year).

function pad(num, size = 4) {
  return String(num).padStart(size, "0");
}

export function getOtherServiceKey(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  return `SRV-AMD${yy}`;
}

/** Takes the next number — call inside the transaction that creates the invoice. */
export async function generateNextOtherServiceNo(tx, date = new Date()) {
  const key = getOtherServiceKey(date);

  const counter = await tx.otherServiceCounter.upsert({
    where: { key },
    create: { key, currentNumber: 1 },
    update: { currentNumber: { increment: 1 } },
    select: { key: true, currentNumber: true },
  });

  return `${counter.key}-${pad(counter.currentNumber, 4)}`;
}

/** What the next invoice will be called, without taking it (for showing on the form). */
export async function previewNextOtherServiceNo(prisma, date = new Date()) {
  const key = getOtherServiceKey(date);
  const counter = await prisma.otherServiceCounter.findUnique({ where: { key }, select: { currentNumber: true } });
  const lastNumber = counter?.currentNumber || 0;
  return { key, lastNumber, invoiceNo: `${key}-${pad(lastNumber + 1, 4)}` };
}
