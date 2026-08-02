import { useSyncExternalStore } from "react";
import { buildSeed, uid, iso } from "./seed";
import type {
  Activity,
  ActivityType,
  GymState,
  Member,
  Membership,
  Payment,
  Plan,
  Product,
  Sale,
  Settings,
} from "./types";

const DB_KEY = "ironvault.db.v1";
const SESSION_KEY = "ironvault.session.v1";

let state: GymState | null = null;
const listeners = new Set<() => void>();

const isBrowser = () => typeof window !== "undefined";

function persist() {
  if (!isBrowser() || !state) return;
  try {
    window.localStorage.setItem(DB_KEY, JSON.stringify(state));
  } catch {
    /* storage full or unavailable — keep in-memory state */
  }
}

function emit() {
  listeners.forEach((l) => l());
}

function init() {
  if (state || !isBrowser()) return;
  try {
    const raw = window.localStorage.getItem(DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GymState;
      if (parsed && parsed.version === 1) {
        state = parsed;
        purgeOldTrash();
        return;
      }
    }
  } catch {
    /* corrupt payload — fall through to a fresh seed */
  }
  state = buildSeed();
  persist();
}

function setState(updater: (s: GymState) => GymState) {
  if (!state) init();
  if (!state) return;
  state = updater(state);
  persist();
  emit();
}

function subscribe(listener: () => void) {
  init();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGym(): GymState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}

export function getState(): GymState {
  if (!state) init();
  return state ?? buildSeed();
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function login(email: string, password: string) {
  const s = getState();
  const hash = await sha256(password);
  const ok = email.trim().toLowerCase() === s.auth.email.toLowerCase() && hash === s.auth.passwordHash;
  if (ok && isBrowser()) {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ at: Date.now(), email }));
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ at: Date.now(), email }));
    emit();
  }
  return ok;
}

export function logout() {
  if (!isBrowser()) return;
  window.sessionStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(SESSION_KEY);
  emit();
}

export function isLoggedIn() {
  if (!isBrowser()) return false;
  return Boolean(
    window.sessionStorage.getItem(SESSION_KEY) || window.localStorage.getItem(SESSION_KEY),
  );
}

export async function changePassword(current: string, next: string) {
  const s = getState();
  if ((await sha256(current)) !== s.auth.passwordHash) return false;
  const hash = await sha256(next);
  setState((st) => ({ ...st, auth: { ...st.auth, passwordHash: hash } }));
  return true;
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

function log(st: GymState, type: ActivityType, title: string, description: string): GymState {
  const activity: Activity = {
    id: uid("act"),
    type,
    title,
    description,
    date: iso(new Date()),
  };
  return { ...st, activities: [activity, ...st.activities].slice(0, 300) };
}

function nextInvoice(st: GymState): [GymState, string] {
  const seq = st.invoiceSeq + 1;
  return [{ ...st, invoiceSeq: seq }, `${st.settings.invoicePrefix}-${seq}`];
}

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

export type NewMemberInput = Omit<
  Member,
  "id" | "notes" | "measurements" | "deletedAt" | "deletedBy" | "joinDate"
> & { joinDate?: string; planId?: string; startDate?: string; paidNow?: number; discount?: number };

export function addMember(input: NewMemberInput) {
  setState((st) => {
    const id = uid("mem");
    const member: Member = {
      id,
      name: input.name,
      email: input.email,
      phone: input.phone,
      gender: input.gender,
      dob: input.dob,
      address: input.address,
      photo: input.photo ?? null,
      emergencyContact: input.emergencyContact,
      joinDate: input.joinDate ?? iso(new Date()),
      notes: [],
      measurements: [],
      deletedAt: null,
      deletedBy: null,
    };
    let next: GymState = { ...st, members: [member, ...st.members] };
    next = log(next, "member_added", "New member registered", `${member.name} was added`);

    if (input.planId) {
      const plan = next.plans.find((p) => p.id === input.planId);
      if (plan) {
        const start = input.startDate ? new Date(input.startDate) : new Date();
        const end = new Date(start);
        end.setDate(end.getDate() + plan.durationDays);
        const membership: Membership = {
          id: uid("mship"),
          memberId: id,
          planId: plan.id,
          startDate: iso(start),
          endDate: iso(end),
          price: plan.price,
          discount: Math.min(Math.max(0, Math.round(input.discount ?? 0)), plan.price),
          frozen: false,
          createdAt: iso(new Date()),
        };
        next = { ...next, memberships: [membership, ...next.memberships] };
        if (input.paidNow && input.paidNow > 0) {
          const [withSeq, invoiceNo] = nextInvoice(next);
          const payment: Payment = {
            id: uid("pay"),
            invoiceNo,
            memberId: id,
            membershipId: membership.id,
            kind: "membership",
            amount: input.paidNow,
            method: "cash",
            date: iso(new Date()),
            note: `${plan.name} — joining payment`,
          };
          next = { ...withSeq, payments: [payment, ...withSeq.payments] };
          next = log(
            next,
            "payment_received",
            "Payment received",
            `₹${input.paidNow.toLocaleString("en-IN")} from ${member.name}`,
          );
          next = log(next, "invoice_generated", "Invoice generated", `${invoiceNo} for ${member.name}`);
        }
      }
    }
    return next;
  });
}

export function updateMember(id: string, patch: Partial<Member>) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  }));
}

export function trashMember(id: string, by: string) {
  setState((st) => {
    const member = st.members.find((m) => m.id === id);
    const next = {
      ...st,
      members: st.members.map((m) =>
        m.id === id ? { ...m, deletedAt: iso(new Date()), deletedBy: by } : m,
      ),
    };
    return log(next, "member_trashed", "Member moved to trash", `${member?.name ?? "Member"} moved to trash`);
  });
}

export function restoreMember(id: string) {
  setState((st) => {
    const member = st.members.find((m) => m.id === id);
    const next = {
      ...st,
      members: st.members.map((m) => (m.id === id ? { ...m, deletedAt: null, deletedBy: null } : m)),
    };
    return log(next, "member_restored", "Member restored", `${member?.name ?? "Member"} restored from trash`);
  });
}

export function deleteMemberPermanently(id: string) {
  setState((st) => {
    const member = st.members.find((m) => m.id === id);
    const next: GymState = {
      ...st,
      members: st.members.filter((m) => m.id !== id),
      memberships: st.memberships.filter((m) => m.memberId !== id),
    };
    return log(
      next,
      "member_deleted",
      "Member permanently deleted",
      `${member?.name ?? "Member"} was permanently removed`,
    );
  });
}

function purgeOldTrash() {
  if (!state) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const expired = state.members.filter((m) => m.deletedAt && new Date(m.deletedAt).getTime() < cutoff);
  if (expired.length === 0) {
    purgeOldTrashedPlans();
    return;
  }
  const ids = new Set(expired.map((m) => m.id));
  state = {
    ...state,
    members: state.members.filter((m) => !ids.has(m.id)),
    memberships: state.memberships.filter((m) => !ids.has(m.memberId)),
  };
  purgeOldTrashedPlans();
  persist();
}

function purgeOldTrashedPlans() {
  if (!state) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const keep = state.plans.filter((p) => !(p.deletedAt && new Date(p.deletedAt).getTime() < cutoff));
  const keepProducts = state.products.filter(
    (p) => !(p.deletedAt && new Date(p.deletedAt).getTime() < cutoff),
  );
  if (keep.length === state.plans.length && keepProducts.length === state.products.length) return;
  state = { ...state, plans: keep, products: keepProducts };
  persist();
}

export function addNote(memberId: string, title: string, note: string) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? { ...m, notes: [{ id: uid("note"), date: iso(new Date()), title, note }, ...m.notes] }
        : m,
    ),
  }));
}

export function addMeasurement(
  memberId: string,
  data: Omit<Member["measurements"][number], "id" | "date">,
) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? {
            ...m,
            measurements: [{ id: uid("msr"), date: iso(new Date()), ...data }, ...m.measurements],
          }
        : m,
    ),
  }));
}

/* ------------------------------------------------------------------ */
/* Plans & memberships                                                 */
/* ------------------------------------------------------------------ */

export function savePlan(plan: Omit<Plan, "id"> & { id?: string }) {
  setState((st) =>
    plan.id
      ? { ...st, plans: st.plans.map((p) => (p.id === plan.id ? ({ ...p, ...plan } as Plan) : p)) }
      : { ...st, plans: [...st.plans, { ...plan, id: uid("plan") } as Plan] },
  );
}

export function deletePlan(id: string) {
  trashPlan(id);
}

export function trashPlan(id: string) {
  setState((st) => ({
    ...st,
    plans: st.plans.map((p) =>
      p.id === id && !p.locked ? { ...p, deletedAt: iso(new Date()) } : p,
    ),
  }));
}

export function restorePlan(id: string) {
  setState((st) => ({
    ...st,
    plans: st.plans.map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
  }));
}

export function deletePlanPermanently(id: string) {
  setState((st) => ({ ...st, plans: st.plans.filter((p) => p.id !== id) }));
}

export function renewMembership(
  memberId: string,
  planId: string,
  paidNow: number,
  discount = 0,
) {
  setState((st) => {
    const plan = st.plans.find((p) => p.id === planId);
    const member = st.members.find((m) => m.id === memberId);
    if (!plan || !member) return st;
    const current = st.memberships
      .filter((m) => m.memberId === memberId)
      .sort((a, b) => +new Date(b.endDate) - +new Date(a.endDate))[0];
    const base = current && new Date(current.endDate) > new Date() ? new Date(current.endDate) : new Date();
    const end = new Date(base);
    end.setDate(end.getDate() + plan.durationDays);
    const membership: Membership = {
      id: uid("mship"),
      memberId,
      planId,
      startDate: iso(base),
      endDate: iso(end),
      price: plan.price,
      discount: Math.min(Math.max(0, Math.round(discount)), plan.price),
      frozen: false,
      createdAt: iso(new Date()),
    };
    let next: GymState = { ...st, memberships: [membership, ...st.memberships] };
    next = log(next, "membership_renewed", "Membership renewed", `${member.name} renewed ${plan.name}`);
    if (paidNow > 0) {
      const [withSeq, invoiceNo] = nextInvoice(next);
      next = {
        ...withSeq,
        payments: [
          {
            id: uid("pay"),
            invoiceNo,
            memberId,
            membershipId: membership.id,
            kind: "membership",
            amount: paidNow,
            method: "cash",
            date: iso(new Date()),
            note: `${plan.name} — renewal payment`,
          },
          ...withSeq.payments,
        ],
      };
      next = log(
        next,
        "payment_received",
        "Payment received",
        `₹${paidNow.toLocaleString("en-IN")} from ${member.name}`,
      );
    }
    return next;
  });
}

export function toggleFreeze(membershipId: string) {
  setState((st) => ({
    ...st,
    memberships: st.memberships.map((m) =>
      m.id === membershipId
        ? { ...m, frozen: !m.frozen, frozenAt: !m.frozen ? iso(new Date()) : null }
        : m,
    ),
  }));
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export function addPayment(input: {
  memberId: string;
  membershipId?: string | null;
  amount: number;
  method: Payment["method"];
  date?: string;
  note?: string;
}) {
  setState((st) => {
    const member = st.members.find((m) => m.id === input.memberId);
    const [withSeq, invoiceNo] = nextInvoice(st);
    const payment: Payment = {
      id: uid("pay"),
      invoiceNo,
      memberId: input.memberId,
      membershipId: input.membershipId ?? null,
      kind: "membership",
      amount: input.amount,
      method: input.method,
      date: input.date ?? iso(new Date()),
      note: input.note ?? "Manual payment entry",
    };
    let next: GymState = { ...withSeq, payments: [payment, ...withSeq.payments] };
    next = log(
      next,
      "payment_received",
      "Payment received",
      `₹${input.amount.toLocaleString("en-IN")} from ${member?.name ?? "member"}`,
    );
    next = log(next, "invoice_generated", "Invoice generated", `${invoiceNo} created`);
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Products & sales                                                    */
/* ------------------------------------------------------------------ */

export function saveProduct(product: Omit<Product, "id" | "createdAt"> & { id?: string }) {
  setState((st) => {
    if (product.id) {
      return {
        ...st,
        products: st.products.map((p) => (p.id === product.id ? ({ ...p, ...product } as Product) : p)),
      };
    }
    const created: Product = { ...product, id: uid("prd"), createdAt: iso(new Date()) } as Product;
    const next = { ...st, products: [created, ...st.products] };
    return log(next, "product_added", "Product added", `${created.name} added to inventory`);
  });
}

export function deleteProduct(id: string) {
  trashProduct(id);
}

export function trashProduct(id: string) {
  setState((st) => ({
    ...st,
    products: st.products.map((p) =>
      p.id === id && !p.locked ? { ...p, deletedAt: iso(new Date()) } : p,
    ),
  }));
}

export function restoreProduct(id: string) {
  setState((st) => ({
    ...st,
    products: st.products.map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
  }));
}

export function deleteProductPermanently(id: string) {
  setState((st) => ({ ...st, products: st.products.filter((p) => p.id !== id) }));
}

export function adjustStock(id: string, delta: number) {
  setState((st) => ({
    ...st,
    products: st.products.map((p) => (p.id === id ? { ...p, stock: Math.max(0, p.stock + delta) } : p)),
  }));
}

export function sellProduct(
  productId: string,
  qty: number,
  buyer: string,
  memberId?: string | null,
  extra?: {
    discount?: number;
    buyerPhone?: string;
    buyerEmail?: string;
    buyerAddress?: string;
  },
) {
  setState((st) => {
    const product = st.products.find((p) => p.id === productId);
    if (!product || qty <= 0 || !Number.isInteger(qty) || product.stock < qty) return st;
    const gross = product.price * qty;
    const discount = Math.min(Math.max(0, Math.round(extra?.discount ?? 0)), gross);
    const [withSeq, invoiceNo] = nextInvoice(st);
    const sale: Sale = {
      id: uid("sale"),
      invoiceNo,
      productId,
      productName: product.name,
      qty,
      unitPrice: product.price,
      unitCost: product.cost,
      discount,
      total: gross - discount,
      buyer: buyer || "Walk-in customer",
      buyerPhone: extra?.buyerPhone,
      buyerEmail: extra?.buyerEmail,
      buyerAddress: extra?.buyerAddress,
      memberId: memberId ?? null,
      date: iso(new Date()),
    };
    let next: GymState = {
      ...withSeq,
      sales: [sale, ...withSeq.sales],
      products: withSeq.products.map((p) => (p.id === productId ? { ...p, stock: p.stock - qty } : p)),
      payments: [
        {
          id: uid("pay"),
          invoiceNo,
          saleId: sale.id,
          memberId: memberId ?? null,
          kind: "product",
          amount: sale.total,
          method: "cash",
          date: sale.date,
          note: `${product.name} × ${qty}`,
        },
        ...withSeq.payments,
      ],
    };
    next = log(
      next,
      "product_sold",
      "Product sold",
      `${product.name} × ${qty} sold to ${sale.buyer}`,
    );
    next = log(next, "invoice_generated", "Invoice generated", `${invoiceNo} for ${sale.buyer}`);
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Settings, notifications, backup                                     */
/* ------------------------------------------------------------------ */

export function updateSettings(patch: Partial<Settings>) {
  setState((st) => ({ ...st, settings: { ...st.settings, ...patch } }));
}

export function markNotificationsRead(ids: string[]) {
  setState((st) => ({
    ...st,
    readNotifications: Array.from(new Set([...st.readNotifications, ...ids])).slice(-500),
  }));
}

export function exportBackup() {
  return JSON.stringify(getState(), null, 2);
}

export function restoreBackup(json: string) {
  const parsed = JSON.parse(json) as GymState;
  if (!parsed || !Array.isArray(parsed.members)) throw new Error("Invalid backup file");
  setState(() => ({ ...parsed, version: 1 }));
}

export function resetData() {
  setState(() => buildSeed());
}
