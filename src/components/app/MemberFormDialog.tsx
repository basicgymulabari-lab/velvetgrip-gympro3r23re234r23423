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
            paidNow: "",
          }
        : { ...empty, planId: state?.plans.filter((p) => !p.deletedAt)[0]?.id ?? "" },
    );
  }, [open, member, state]);

  if (!state) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = "Name must be at least 2 characters.";
    if (form.name.trim().length > 80) e.name = "Name is too long.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = "Enter a valid email address.";
    if (form.phone.trim().replace(/\D/g, "").length < 8) e.phone = "Enter a valid phone number.";
    if (!form.dob) e.dob = "Date of birth is required.";
    else if (new Date(form.dob) > new Date()) e.dob = "Date of birth cannot be in the future.";
    if (form.address.trim().length > 200) e.address = "Address is too long.";
    const paid = Number(form.paidNow || 0);
    if (form.paidNow && (Number.isNaN(paid) || paid < 0)) e.paidNow = "Enter a valid amount.";
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
        paidNow: Number(form.paidNow || 0),
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
              <Field label="Amount paid now" error={errors.paidNow}>
                <Input
                  type="number"
                  min={0}
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
