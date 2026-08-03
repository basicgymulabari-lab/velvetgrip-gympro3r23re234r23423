import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addMember, updateMember, useGym } from "@/lib/gym/store";
import type { Member } from "@/lib/gym/types";

type FormState = {
  name: string;
  email: string;
  phone: string;
  gender: Member["gender"];
  dob: string;
  address: string;
  emergencyContact: string;
  photo: string | null;
  planId: string;
  discountType: "none" | "percent" | "fixed";
  discountValue: string;
  paidNow: string;
};

const empty: FormState = {
  name: "",
  email: "",
  phone: "",
  gender: "male",
  dob: "",
  address: "",
  emergencyContact: "",
  photo: null,
  planId: "",
  discountType: "none",
  discountValue: "",
  paidNow: "",
};

export function MemberFormDialog({
  open,
  onOpenChange,
  member,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  member?: Member | null;
}) {
  const state = useGym();
  const [form, setForm] = useState<FormState>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      member
        ? {
            name: member.name,
            email: member.email,
            phone: member.phone,
            gender: member.gender,
            dob: member.dob ? member.dob.slice(0, 10) : "",
            address: member.address,
            emergencyContact: member.emergencyContact,
            photo: member.photo ?? null,
            planId: "",
            discountType: "none",
            discountValue: "",
            paidNow: "",
          }
        : { ...empty, planId: state?.plans.filter((p) => !p.deletedAt)[0]?.id ?? "" },
    );
  }, [open, member, state]);

  if (!state) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const selectedPlan = state.plans.find((p) => p.id === form.planId && !p.deletedAt) ?? null;
  const originalPrice = selectedPlan?.price ?? 0;
  const rawDiscount =
    form.discountType === "none"
      ? 0
      : form.discountType === "percent"
        ? (originalPrice * (Number(form.discountValue) || 0)) / 100
        : Number(form.discountValue) || 0;
  const discountAmount = Math.min(Math.max(0, Math.round(rawDiscount)), originalPrice);
  const finalPrice = originalPrice - discountAmount;
  const paidNowNum = Number(form.paidNow || 0);
  const remainingBalance = Math.max(0, finalPrice - (Number.isFinite(paidNowNum) ? paidNowNum : 0));
  const cur = state.settings.currency;

  // Live (auto-updating) validation for discount + amount paid.
  let liveDiscountError = "";
  if (!member && form.discountType !== "none") {
    const dv = Number(form.discountValue);
    if (form.discountValue === "" || Number.isNaN(dv) || !Number.isFinite(dv) || dv < 0)
      liveDiscountError = "Enter a valid discount.";
    else if (form.discountType === "percent" && dv > 100)
      liveDiscountError = "Discount cannot exceed 100%.";
    else if (form.discountType === "fixed" && dv > originalPrice)
      liveDiscountError = "Discount cannot exceed the membership price.";
  }
  let livePaidError = "";
  if (!member && form.paidNow !== "") {
    const paid = Number(form.paidNow);
    if (Number.isNaN(paid) || !Number.isFinite(paid)) livePaidError = "Enter a valid amount.";
    else if (paid < 0) livePaidError = "Amount cannot be negative.";
    else if (form.planId && paid > finalPrice)
      livePaidError = "Amount paid cannot exceed the final payable amount.";
  }

  const validate = () => {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = "Name must be at least 2 characters.";
    if (form.name.trim().length > 80) e.name = "Name is too long.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = "Enter a valid email address.";
    if (form.phone.trim().replace(/\D/g, "").length < 8) e.phone = "Enter a valid phone number.";
    if (!form.dob) e.dob = "Date of birth is required.";
    else if (new Date(form.dob) > new Date()) e.dob = "Date of birth cannot be in the future.";
    if (form.address.trim().length > 200) e.address = "Address is too long.";
    if (liveDiscountError) e.discount = liveDiscountError;
    if (livePaidError) e.paidNow = livePaidError;
    setErrors(e);
    return Object.keys(e).length === 0;
  };


  const onFile = (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be smaller than 2MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set("photo", String(reader.result));
    reader.readAsDataURL(file);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      gender: form.gender,
      dob: new Date(form.dob).toISOString(),
      address: form.address.trim(),
      emergencyContact: form.emergencyContact.trim(),
      photo: form.photo,
    };
    if (member) {
      updateMember(member.id, payload);
      toast.success(`${payload.name} updated`);
    } else {
      addMember({
        ...payload,
        planId: form.planId || undefined,
        discount: form.planId ? discountAmount : 0,
        paidNow: Math.min(Number(form.paidNow || 0), form.planId ? finalPrice : 0),
      });
      toast.success(`${payload.name} added to the roster`);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">
            {member ? "Edit Member" : "Add New Member"}
          </DialogTitle>
          <DialogDescription>
            {member
              ? "Update contact details and personal information."
              : "Register a new member and optionally start their first membership."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-gold/30 bg-secondary text-gold">
              {form.photo ? (
                <img src={form.photo} alt="Member" className="h-full w-full object-cover" />
              ) : (
                <span className="font-display text-xl">
                  {(form.name || "?").slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" /> Upload photo
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">Stored locally, max 2MB.</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" error={errors.name}>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
            </Field>
            <Field label="Phone" error={errors.phone}>
              <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={20} />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={120} />
            </Field>
            <Field label="Date of birth" error={errors.dob}>
              <Input type="date" value={form.dob} onChange={(e) => set("dob", e.target.value)} />
            </Field>
            <Field label="Gender">
              <Select value={form.gender} onValueChange={(v) => set("gender", v as Member["gender"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">Male</SelectItem>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Emergency contact">
              <Input
                value={form.emergencyContact}
                onChange={(e) => set("emergencyContact", e.target.value)}
                maxLength={20}
              />
            </Field>
          </div>

          <Field label="Address" error={errors.address}>
            <Textarea
              rows={2}
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              maxLength={200}
            />
          </Field>

          {!member && (
            <div className="grid gap-4 rounded-xl border border-gold/25 bg-secondary/30 p-4 sm:grid-cols-2">
              <Field label="Membership plan">
                <Select value={form.planId} onValueChange={(v) => set("planId", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {state.plans.filter((p) => !p.deletedAt).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} — {state.settings.currency}
                        {p.price.toLocaleString("en-IN")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Discount type">
                <Select
                  value={form.discountType}
                  onValueChange={(v) => set("discountType", v as FormState["discountType"])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No discount</SelectItem>
                    <SelectItem value="percent">Percentage (%)</SelectItem>
                    <SelectItem value="fixed">Fixed amount ({cur})</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {form.discountType !== "none" && (
                <Field
                  label={form.discountType === "percent" ? "Discount (%)" : `Discount (${cur})`}
                  error={errors.discount}
                >
                  <Input
                    type="number"
                    min={0}
                    max={form.discountType === "percent" ? 100 : originalPrice}
                    value={form.discountValue}
                    onChange={(e) => set("discountValue", e.target.value)}
                    placeholder="0"
                  />
                </Field>
              )}
              {form.planId && (
                <div className="space-y-1 rounded-lg border border-border bg-background/40 p-3 text-sm sm:col-span-2">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Original price</span>
                    <span className="text-foreground">
                      {cur}
                      {originalPrice.toLocaleString("en-IN")}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Discount</span>
                    <span className="text-foreground">
                      - {cur}
                      {discountAmount.toLocaleString("en-IN")}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <span>Final payable</span>
                    <span className="text-gold">
                      {cur}
                      {finalPrice.toLocaleString("en-IN")}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Remaining balance</span>
                    <span className="text-foreground">
                      {cur}
                      {remainingBalance.toLocaleString("en-IN")}
                    </span>
                  </div>
                </div>
              )}
              <Field label="Amount paid now" error={errors.paidNow}>
                <Input
                  type="number"
                  min={0}
                  max={finalPrice}
                  step="1"
                  value={form.paidNow}
                  onChange={(e) => set("paidNow", e.target.value)}
                  placeholder="0"
                />
              </Field>

            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{member ? "Save changes" : "Add member"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
