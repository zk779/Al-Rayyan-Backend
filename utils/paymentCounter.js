function pad(num, size = 4) {
  return String(num).padStart(size, "0");
}

function getPvKey(branchCode, date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  return `PV-${branchCode}${yy}`; // e.g. PV-AMD26
}

export async function generateNextPvNo(tx, branchCode, date = new Date()) {
  const key = getPvKey(branchCode, date);

  const counter = await tx.paymentVoucherCounter.upsert({
    where: { key },
    create: { key, currentNumber: 1 },
    update: { currentNumber: { increment: 1 } },
    select: { key: true, currentNumber: true },
  });

  return `${counter.key}-${pad(counter.currentNumber, 4)}`; // e.g. PV-AMD26-0001
}