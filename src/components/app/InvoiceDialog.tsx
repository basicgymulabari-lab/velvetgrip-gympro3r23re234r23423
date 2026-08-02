import { useState } from "react";
import { Printer } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { money, shortDate } from "@/lib/gym/selectors";
import type { Settings } from "@/lib/gym/types";

export type InvoiceData = {
  invoiceNo: string;
  date: string;
  billedTo: string;
  contact?: string;
  lines: Array<{ description: string; qty: number; rate: number }>;
  discount?: number;
  paid: number;
  method?: string;
};

export function InvoiceDialog({
  invoice,
  settings,
  onOpenChange,
}: {
  invoice: InvoiceData | null;
  settings: Settings;
  onOpenChange: (v: boolean) => void;
}) {
  if (!invoice) return null;
  const gross = invoice.lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const discount = Math.min(Math.max(0, invoice.discount ?? 0), gross);
  const total = gross - discount;
  const due = Math.max(0, total - invoice.paid);

  return (
    <Dialog open={Boolean(invoice)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="no-print">
          <DialogTitle className="font-display text-2xl tracking-wide">
            Invoice {invoice.invoiceNo}
          </DialogTitle>
        </DialogHeader>

        <div id="invoice-print" className="rounded-xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
            <div className="min-w-0">
              <p className="font-display text-2xl tracking-[0.16em] text-gradient-gold">
                {settings.gymName}
              </p>
              <p className="text-xs text-muted-foreground">{settings.tagline}</p>
              <p className="mt-2 max-w-xs text-xs text-muted-foreground">{settings.address}</p>
              <p className="text-xs text-muted-foreground">
                {settings.phone} · {settings.email}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Invoice</p>
              <p className="font-display text-xl">{invoice.invoiceNo}</p>
              <p className="text-xs text-muted-foreground">{shortDate(invoice.date)}</p>
            </div>
          </div>

          <div className="py-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Billed to</p>
            <p className="font-semibold">{invoice.billedTo}</p>
            {invoice.contact && <p className="text-xs text-muted-foreground">{invoice.contact}</p>}
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2">Description</th>
                <th className="py-2 text-center">Qty</th>
                <th className="py-2 text-right">Rate</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l, i) => (
                <tr key={i} className="border-b border-border/60">
                  <td className="py-2.5">{l.description}</td>
                  <td className="py-2.5 text-center">{l.qty}</td>
                  <td className="py-2.5 text-right">{money(l.rate, settings.currency)}</td>
                  <td className="py-2.5 text-right">{money(l.qty * l.rate, settings.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
            <Row label="Total" value={money(total, settings.currency)} />
            <Row label="Paid" value={money(invoice.paid, settings.currency)} />
            <div className="flex justify-between border-t border-border pt-2 font-display text-lg">
              <span>Balance due</span>
              <span className="text-gold">{money(due, settings.currency)}</span>
            </div>
            {invoice.method && (
              <p className="pt-1 text-xs text-muted-foreground">Payment method: {invoice.method}</p>
            )}
          </div>

          <p className="mt-6 text-center text-[11px] text-muted-foreground">
            Thank you for training with {settings.gymName}. This is a computer generated invoice.
          </p>
        </div>

        <div className="no-print flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" /> Print invoice
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

export function useInvoice() {
  return useState<InvoiceData | null>(null);
}
