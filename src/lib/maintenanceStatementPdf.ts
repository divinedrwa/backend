import PDFDocument from "pdfkit";

export type FyStatementCycleRow = {
  cycleKey: string;
  title: string;
  month: number;
  year: number;
  expectedAmount: number;
  paidAmount: number;
  remainingDue: number;
  status: string;
};

export type FyStatementPaymentRow = {
  paymentDate: Date;
  amount: number;
  paymentMode: string;
  receiptNumber: string | null;
  cycleKey: string | null;
};

export function buildFyMaintenanceStatementPdf(params: {
  societyName: string;
  villaNumber: string;
  ownerName: string;
  financialYearLabel: string;
  periodStart: Date;
  periodEnd: Date;
  cycles: FyStatementCycleRow[];
  payments: FyStatementPaymentRow[];
}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const totalExpected = params.cycles.reduce((s, r) => s + r.expectedAmount, 0);
    const totalPaid = params.cycles.reduce((s, r) => s + r.paidAmount, 0);
    const totalPending = params.cycles.reduce((s, r) => s + r.remainingDue, 0);
    const cashInFy = params.payments.reduce((s, p) => s + p.amount, 0);

    doc.fontSize(18).text("Financial Year Maintenance Statement", { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11).text(params.societyName);
    doc.text(`Villa ${params.villaNumber} · ${params.ownerName}`);
    doc.text(`Financial year: ${params.financialYearLabel}`);
    doc.text(
      `Period: ${params.periodStart.toLocaleDateString()} — ${params.periodEnd.toLocaleDateString()}`,
    );
    doc.text(`Generated: ${new Date().toLocaleString()}`);
    doc.moveDown();

    doc.fontSize(13).text("Summary");
    doc.moveDown(0.3);
    doc.fontSize(11);
    doc.text(`Total billed (cycles in FY): Rs. ${totalExpected.toFixed(2)}`);
    doc.text(`Total settled on ledger: Rs. ${totalPaid.toFixed(2)}`);
    doc.text(`Outstanding at period end: Rs. ${totalPending.toFixed(2)}`);
    doc.text(`Cash payments recorded in FY: Rs. ${cashInFy.toFixed(2)}`);
    doc.moveDown();

    doc.fontSize(13).text("Billing cycles");
    doc.moveDown(0.3);
    doc.fontSize(9);
    doc.text("Cycle", 40, doc.y, { continued: true, width: 90 });
    doc.text("Expected", { continued: true, width: 70, align: "right" });
    doc.text("Paid", { continued: true, width: 70, align: "right" });
    doc.text("Due", { continued: true, width: 70, align: "right" });
    doc.text("Status", { width: 60 });
    doc.moveDown(0.15);

    for (const row of params.cycles) {
      doc.fontSize(9).text(row.cycleKey, 40, doc.y, { continued: true, width: 90 });
      doc.text(row.expectedAmount.toFixed(2), { continued: true, width: 70, align: "right" });
      doc.text(row.paidAmount.toFixed(2), { continued: true, width: 70, align: "right" });
      doc.text(row.remainingDue.toFixed(2), { continued: true, width: 70, align: "right" });
      doc.text(row.status, { width: 60 });
    }

    doc.moveDown();
    doc.fontSize(13).text("Payment history (FY)");
    doc.moveDown(0.3);
    if (params.payments.length === 0) {
      doc.fontSize(10).text("No payments recorded in this financial year.");
    } else {
      doc.fontSize(9);
      doc.text("Date", 40, doc.y, { continued: true, width: 80 });
      doc.text("Amount", { continued: true, width: 70, align: "right" });
      doc.text("Mode", { continued: true, width: 80 });
      doc.text("Cycle", { continued: true, width: 70 });
      doc.text("Receipt", { width: 80 });
      doc.moveDown(0.15);
      for (const p of params.payments) {
        doc.fontSize(9).text(p.paymentDate.toLocaleDateString(), 40, doc.y, {
          continued: true,
          width: 80,
        });
        doc.text(p.amount.toFixed(2), { continued: true, width: 70, align: "right" });
        doc.text(p.paymentMode, { continued: true, width: 80 });
        doc.text(p.cycleKey ?? "—", { continued: true, width: 70 });
        doc.text(p.receiptNumber ?? "—", { width: 80 });
      }
    }

    doc.end();
  });
}

/** True when calendar month (1–12) + year falls within FY inclusive bounds. */
export function monthYearWithinFinancialYear(
  month: number,
  year: number,
  fyStart: Date,
  fyEnd: Date,
): boolean {
  const mid = new Date(Date.UTC(year, month - 1, 15));
  const start = new Date(fyStart);
  const end = new Date(fyEnd);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(23, 59, 59, 999);
  return mid.getTime() >= start.getTime() && mid.getTime() <= end.getTime();
}
