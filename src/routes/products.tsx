import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Plus, Search, Pencil, Trash2, Minus, ShoppingCart, PackageX, Boxes, Lock } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel, EmptyState } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adjustStock, trashProduct, saveProduct, sellProduct, useGym } from "@/lib/gym/store";
import { activeMembers, liveProducts, lowStock, money, profitOfSales, shortDate } from "@/lib/gym/selectors";
import type { Product, ProductCategory } from "@/lib/gym/types";

const CATEGORIES: ProductCategory[] = [
  "Supplements",
  "Apparel",
  "Accessories",
  "Equipment",
  "Beverages",
];

export const Route = createFileRoute("/products")({
  head: () => ({
    meta: [
      { title: "Products & Sales — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Manage supplements and gym merchandise, track stock levels, record sales and monitor low-stock alerts offline.",
      },
      { property: "og:title", content: "Products & Sales — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Inventory, stock alerts, sales recording and profit tracking for your gym store.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <ProductsPage />
    </AppShell>
  ),
});

function ProductsPage() {
  const state = useGym();
  const [q, setQ] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [sellFor, setSellFor] = useState<Product | null>(null);
  const [trashFor, setTrashFor] = useState<Product | null>(null);
  const [lockedFor, setLockedFor] = useState<Product | null>(null);

  const filtered = useMemo(() => {
    if (!state) return [];
    const t = q.trim().toLowerCase().slice(0, 60);
    return liveProducts(state).filter((p) => !t || `${p.name} ${p.category}`.toLowerCase().includes(t));
  }, [state, q]);

  if (!state) return null;
  const cur = state.settings.currency;
  const low = lowStock(state);
  const live = liveProducts(state);
  const stockValue = live.reduce((a, p) => a + p.stock * p.cost, 0);
  const recentSales = [...state.sales].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 8);

  return (
    <>
      <PageHeader
        title="Products & Sales"
        subtitle="Supplements, merchandise and in-gym store operations"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add Product
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Products", String(live.length), Boxes],
          ["Stock value", money(stockValue, cur), Boxes],
          ["Low stock", String(low.length), PackageX],
          ["Sales profit", money(profitOfSales(state), cur), ShoppingCart],
        ].map(([label, value, Icon]) => {
          const I = Icon as typeof Boxes;
          return (
            <div key={label as string} className="surface-panel flex items-center gap-4 rounded-2xl p-5">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-gold/35 bg-gold/10 text-gold">
                <I className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label as string}</p>
                <p className="truncate font-display text-2xl">{value as string}</p>
              </div>
            </div>
          );
        })}
      </div>

      {low.length > 0 && (
        <div className="mb-6 rounded-2xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-medium text-warning">Low stock alert</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {low.map((p) => `${p.name} (${p.stock} left)`).join(" · ")}
          </p>
        </div>
      )}

      <Panel className="mb-6">
        <div className="relative mb-5 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search products"
            value={q}
            maxLength={60}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No products found" hint="Try a different search or add a product." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-3">Product</th>
                  <th className="py-3">Category</th>
                  <th className="py-3">Cost</th>
                  <th className="py-3">Price</th>
                  <th className="py-3">Stock</th>
                  <th className="py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/40">
                    <td className="py-3 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {p.name}
                        {p.locked && <Lock className="h-3.5 w-3.5 text-gold" aria-label="Locked" />}
                      </span>
                    </td>
                    <td className="py-3 text-muted-foreground">{p.category}</td>
                    <td className="py-3 text-muted-foreground">{money(p.cost, cur)}</td>
                    <td className="py-3 text-gold">{money(p.price, cur)}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label="Decrease stock"
                          onClick={() => adjustStock(p.id, -1)}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </Button>
                        <span
                          className={`w-10 text-center font-medium ${
                            p.stock <= p.lowStockAt ? "text-warning" : ""
                          }`}
                        >
                          {p.stock}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label="Increase stock"
                          onClick={() => adjustStock(p.id, 1)}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                    <td className="py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="secondary" disabled={p.stock < 1} onClick={() => setSellFor(p)}>
                          <ShoppingCart className="mr-1.5 h-3.5 w-3.5" /> Sell
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Edit product"
                          onClick={() => {
                            setEditing(p);
                            setFormOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          aria-label="Delete product"
                          onClick={() => (p.locked ? setLockedFor(p) : setTrashFor(p))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent Sales">
        {recentSales.length === 0 ? (
          <EmptyState title="No sales yet" hint="Sales you record will appear here." />
        ) : (
          <ul className="divide-y divide-border/60">
            {recentSales.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {s.qty} × {state.products.find((p) => p.id === s.productId)?.name ?? "Product"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.buyer} · {shortDate(s.date)}
                  </p>
                </div>
                <p className="shrink-0 font-medium text-gold">{money(s.total, cur)}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ProductDialog open={formOpen} onOpenChange={setFormOpen} product={editing} />
      <SellDialog product={sellFor} onClose={() => setSellFor(null)} />

      <Dialog open={Boolean(trashFor)} onOpenChange={(v) => !v && setTrashFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide">
              Move this product to Trash?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This product will be moved to Trash. You can restore it within the next 30 days before it
              is permanently deleted.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTrashFor(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (trashFor) trashProduct(trashFor.id);
                  toast.success("Product moved to Trash");
                  setTrashFor(null);
                }}
              >
                Move to Trash
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(lockedFor)} onOpenChange={(v) => !v && setLockedFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide text-warning">
              This product is locked
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This product is protected and cannot be moved to Trash while it is locked. Please unlock
              the product first if you want to delete it.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => setLockedFor(null)}>OK</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProductDialog({
  open,
  onOpenChange,
  product,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  product: Product | null;
}) {
  const [form, setForm] = useState({
    name: "",
    category: "Supplements" as ProductCategory,
    sku: "",
    cost: "",
    price: "",
    stock: "",
    lowStockAt: "5",
    locked: false,
  });

  useMemo(() => {
    if (open) {
      setForm({
        name: product?.name ?? "",
        category: product?.category ?? "Supplements",
        sku: product?.sku ?? "",
        cost: product ? String(product.cost) : "",
        price: product ? String(product.price) : "",
        stock: product ? String(product.stock) : "",
        lowStockAt: product ? String(product.lowStockAt) : "5",
        locked: Boolean(product?.locked),
      });
    }
  }, [open, product]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">
            {product ? "Edit Product" : "Add Product"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                maxLength={60}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v as ProductCategory }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>SKU</Label>
              <Input
                value={form.sku}
                maxLength={24}
                onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>Cost price</Label>
              <Input
                type="number"
                min={0}
                value={form.cost}
                onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Selling price</Label>
              <Input
                type="number"
                min={0}
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Stock</Label>
              <Input
                type="number"
                min={0}
                value={form.stock}
                onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Low stock alert at</Label>
              <Input
                type="number"
                min={0}
                value={form.lowStockAt}
                onChange={(e) => setForm((f) => ({ ...f, lowStockAt: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border bg-secondary/30 p-4">
            <div>
              <Label className="text-sm">Lock this product</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Locked products cannot be moved to Trash.
              </p>
            </div>
            <Switch
              checked={form.locked}
              onCheckedChange={(v) => setForm((f) => ({ ...f, locked: v }))}
              aria-label="Lock this product"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (form.name.trim().length < 2) return toast.error("Enter a product name");
                if (Number(form.price) <= 0) return toast.error("Enter a valid selling price");
                saveProduct({
                  id: product?.id,
                  name: form.name.trim(),
                  category: form.category,
                  sku: form.sku.trim() || form.name.trim().slice(0, 6).toUpperCase(),
                  cost: Number(form.cost) || 0,
                  price: Number(form.price),
                  stock: Number(form.stock) || 0,
                  lowStockAt: Number(form.lowStockAt) || 0,
                  locked: form.locked,
                  deletedAt: product?.deletedAt ?? null,
                });
                toast.success(product ? "Product updated" : "Product added");
                onOpenChange(false);
              }}
            >
              Save product
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SellDialog({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const state = useGym();
  const [qty, setQty] = useState("1");
  const [memberId, setMemberId] = useState("walkin");
  const [discountType, setDiscountType] = useState<"none" | "percent" | "fixed">("none");
  const [discountValue, setDiscountValue] = useState("");
  const [walkName, setWalkName] = useState("");
  const [walkPhone, setWalkPhone] = useState("");
  const [walkEmail, setWalkEmail] = useState("");
  const [walkAddress, setWalkAddress] = useState("");

  if (!state || !product) return null;
  const cur = state.settings.currency;
  const n = Number(qty);
  const qtyValid = Number.isInteger(n) && n >= 1 && n <= product.stock;
  const gross = product.price * (qtyValid ? n : 0);
  const rawDiscount =
    discountType === "none"
      ? 0
      : discountType === "percent"
        ? (gross * (Number(discountValue) || 0)) / 100
        : Number(discountValue) || 0;
  const discountAmount = Math.min(Math.max(0, Math.round(rawDiscount)), gross);
  const discountValid =
    discountType === "none" ||
    (discountValue !== "" &&
      Number.isFinite(Number(discountValue)) &&
      Number(discountValue) >= 0 &&
      (discountType === "percent" ? Number(discountValue) <= 100 : Number(discountValue) <= gross));
  const total = gross - discountAmount;
  const isWalkIn = memberId === "walkin";
  const walkInValid =
    !isWalkIn || (walkName.trim().length >= 2 && walkPhone.trim().replace(/\D/g, "").length >= 8);

  const reset = () => {
    setQty("1");
    setDiscountType("none");
    setDiscountValue("");
    setMemberId("walkin");
    setWalkName("");
    setWalkPhone("");
    setWalkEmail("");
    setWalkAddress("");
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">Sell {product.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Quantity (in stock: {product.stock})</Label>
            <Input
              type="number"
              min={1}
              max={product.stock}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
            {!qtyValid && (
              <p className="text-xs text-destructive">
                Enter a whole quantity between 1 and {product.stock}.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Discount type</Label>
            <Select
              value={discountType}
              onValueChange={(v) => setDiscountType(v as "none" | "percent" | "fixed")}
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
          </div>
          {discountType !== "none" && (
            <div className="space-y-2">
              <Label>{discountType === "percent" ? "Discount (%)" : `Discount (${cur})`}</Label>
              <Input
                type="number"
                min={0}
                max={discountType === "percent" ? 100 : gross}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder="0"
              />
              {!discountValid && <p className="text-xs text-destructive">Enter a valid discount.</p>}
            </div>
          )}
          <div className="space-y-2">
            <Label>Buyer</Label>
            <Select value={memberId} onValueChange={setMemberId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                <SelectItem value="walkin">Walk-in customer</SelectItem>
                {activeMembers(state).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isWalkIn && (
            <div className="grid gap-4 rounded-xl border border-gold/25 bg-secondary/30 p-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Customer name</Label>
                <Input value={walkName} onChange={(e) => setWalkName(e.target.value)} maxLength={80} />
              </div>
              <div className="space-y-2">
                <Label>Mobile number</Label>
                <Input value={walkPhone} onChange={(e) => setWalkPhone(e.target.value)} maxLength={20} />
              </div>
              <div className="space-y-2">
                <Label>Email (optional)</Label>
                <Input value={walkEmail} onChange={(e) => setWalkEmail(e.target.value)} maxLength={120} />
              </div>
              <div className="space-y-2">
                <Label>Address (optional)</Label>
                <Input
                  value={walkAddress}
                  onChange={(e) => setWalkAddress(e.target.value)}
                  maxLength={200}
                />
              </div>
              {!walkInValid && (
                <p className="text-xs text-destructive sm:col-span-2">
                  Customer name and a valid mobile number are required.
                </p>
              )}
            </div>
          )}
          {discountAmount > 0 && (
            <p className="text-sm text-muted-foreground">
              Subtotal: {money(gross, cur)} · Discount: - {money(discountAmount, cur)}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Total: <span className="font-display text-xl text-gold">{money(total, cur)}</span>
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!qtyValid || !discountValid || !walkInValid}
              onClick={() => {
                if (!qtyValid) return toast.error("Enter a valid quantity");
                const member = isWalkIn ? null : activeMembers(state).find((m) => m.id === memberId);
                sellProduct(
                  product.id,
                  n,
                  member?.name ?? (walkName.trim() || "Walk-in customer"),
                  member?.id ?? null,
                  {
                    discount: discountAmount,
                    buyerPhone: member?.phone ?? walkPhone.trim() || undefined,
                    buyerEmail: member?.email ?? walkEmail.trim() || undefined,
                    buyerAddress: member?.address ?? walkAddress.trim() || undefined,
                  },
                );
                toast.success("Sale recorded");
                reset();
                onClose();
              }}
            >
              Complete sale
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
