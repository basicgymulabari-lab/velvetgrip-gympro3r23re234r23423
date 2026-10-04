import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { invokeEdgeFunction } from "@/integrations/supabase/functions";

type RechargeCode = {
  id: string;
  duration_days: number;
  batch_label: string | null;
  valid_until: string | null;
  redeemed_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type CreatedCodes = {
  codes: string[];
  days: number;
  validUntil: string;
};

const dateLabel = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(value))
    : "No expiry";

export function RechargeCodeManager() {
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState("30");
  const [validDays, setValidDays] = useState("30");
  const [count, setCount] = useState("1");
  const [label, setLabel] = useState("");
  const [codes, setCodes] = useState<RechargeCode[]>([]);
  const [created, setCreated] = useState<CreatedCodes | null>(null);

  const loadCodes = useCallback(async () => {
    const response = await invokeEdgeFunction<{ codes: RechargeCode[] }>("recharge-codes", {
      body: { action: "list" },
    });
    setCodes(response.codes ?? []);
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadCodes()
      .then(() => {
        if (mounted) setAuthorized(true);
      })
      .catch(() => {
        if (mounted) setAuthorized(false);
      })
      .finally(() => {
        if (mounted) setChecking(false);
      });
    return () => {
      mounted = false;
    };
  }, [loadCodes]);

  if (checking || !authorized) return null;

  const createCodes = async () => {
    setBusy(true);
    try {
      const response = await invokeEdgeFunction<CreatedCodes>("recharge-codes", {
        body: {
          action: "create",
          days: Number(days),
          validDays: Number(validDays),
          count: Number(count),
          label,
        },
      });
      setCreated(response);
      await loadCodes();
      toast.success(`${response.codes.length} single-use code${response.codes.length === 1 ? "" : "s"} created.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create recharge codes.");
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.codes.join("\n"));
      toast.success("Codes copied. Save them now; they cannot be retrieved later.");
    } catch {
      toast.error("Clipboard access failed. Select and copy the codes shown below.");
    }
  };

  const revokeCode = async (codeId: string) => {
    setBusy(true);
    try {
      await invokeEdgeFunction("recharge-codes", { body: { action: "revoke", codeId } });
      await loadCodes();
      toast.success("Unused recharge code revoked.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke this code.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 rounded-2xl border border-gold/30 bg-gold/5 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gold/10 text-gold">
            <KeyRound className="h-5 w-5" />
          </span>
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              Recharge code manager <ShieldCheck className="h-4 w-4 text-success" />
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              Issue Pro access for a chosen duration. Each code can be redeemed by one account only;
              its full value is shown once, then only its hash remains in Supabase.
            </p>
          </div>
        </div>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void loadCodes()}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="recharge-days">Pro duration (days)</Label>
          <Input id="recharge-days" type="number" min={1} max={366} step={1} value={days} onChange={(event) => setDays(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="recharge-valid-days">Redeem within (days)</Label>
          <Input id="recharge-valid-days" type="number" min={1} max={366} step={1} value={validDays} onChange={(event) => setValidDays(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="recharge-count">Number of codes</Label>
          <Input id="recharge-count" type="number" min={1} max={50} step={1} value={count} onChange={(event) => setCount(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="recharge-label">Batch note (optional)</Label>
          <Input id="recharge-label" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. October launch" />
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="button" disabled={busy || !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 366 || !Number.isInteger(Number(validDays)) || Number(validDays) < 1 || Number(validDays) > 366 || !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 50} onClick={() => void createCodes()}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
          Generate codes
        </Button>
      </div>

      {created && (
        <div className="mt-4 rounded-xl border border-success/30 bg-success/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-success">
              {created.codes.length} code{created.codes.length === 1 ? "" : "s"} · {created.days} Pro days · redeem by {dateLabel(created.validUntil)}
            </p>
            <Button type="button" size="sm" variant="secondary" onClick={() => void copyCodes()}>
              <Copy className="mr-2 h-4 w-4" /> Copy codes
            </Button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {created.codes.map((code) => (
              <code key={code} className="select-all rounded-lg border border-border bg-background px-3 py-2 text-sm tracking-wide">{code}</code>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Save or share these now. For security, the original codes cannot be viewed again.</p>
        </div>
      )}

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recent codes</p>
          <span className="text-xs text-muted-foreground">Last {codes.length}</span>
        </div>
        {codes.length === 0 ? (
          <p className="rounded-xl border border-border bg-background/50 p-3 text-xs text-muted-foreground">No recharge codes have been issued yet.</p>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {codes.map((code) => {
              const status = code.revoked_at ? "Revoked" : code.redeemed_at ? "Redeemed" : code.valid_until && new Date(code.valid_until).getTime() < Date.now() ? "Expired" : "Unused";
              const canRevoke = status === "Unused";
              return (
                <div key={code.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background/50 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium">{code.duration_days} Pro days <span className="ml-2 text-xs text-muted-foreground">{code.batch_label ?? "Recharge"}</span></p>
                    <p className="mt-1 text-xs text-muted-foreground">Issued {dateLabel(code.created_at)} · redeem by {dateLabel(code.valid_until)} · {status}</p>
                  </div>
                  {canRevoke && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} aria-label="Revoke unused code" onClick={() => void revokeCode(code.id)}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                      <span className="ml-1">Revoke</span>
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
