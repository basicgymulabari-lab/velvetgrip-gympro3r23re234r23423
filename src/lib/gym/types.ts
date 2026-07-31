export type ID = string;

export type Gender = "male" | "female" | "other";

export type ProgressNote = {
  id: ID;
  date: string;
  title: string;
  note: string;
};

export type Measurement = {
  id: ID;
  date: string;
  weightKg: number;
  heightCm: number;
  chestCm: number;
  waistCm: number;
  armsCm: number;
  bodyFat: number;
};

export type Member = {
  id: ID;
  name: string;
  email: string;
  phone: string;
  gender: Gender;
  dob: string;
  address: string;
  photo?: string | null;
  joinDate: string;
  emergencyContact: string;
  notes: ProgressNote[];
  measurements: Measurement[];
  deletedAt?: string | null;
  deletedBy?: string | null;
};

export type Plan = {
  id: ID;
  name: string;
  price: number;
  durationDays: number;
  description: string;
  active: boolean;
};

/** One membership term for a member. Drives status + dues. */
export type Membership = {
  id: ID;
  memberId: ID;
  planId: ID;
  startDate: string;
  endDate: string;
  price: number;
  discount: number;
  frozen: boolean;
  frozenAt?: string | null;
  createdAt: string;
};

export type PaymentMethod = "cash" | "card" | "bank" | "cheque" | "other";

export type Payment = {
  id: ID;
  invoiceNo: string;
  memberId?: ID | null;
  membershipId?: ID | null;
  saleId?: ID | null;
  kind: "membership" | "product";
  amount: number;
  method: PaymentMethod;
  date: string;
  note: string;
};

export type ProductCategory =
  | "Supplements"
  | "Apparel"
  | "Accessories"
  | "Equipment"
  | "Beverages";

export type Product = {
  id: ID;
  name: string;
  category: ProductCategory;
  sku: string;
  cost: number;
  price: number;
  stock: number;
  lowStockAt: number;
  createdAt: string;
};

export type Sale = {
  id: ID;
  invoiceNo: string;
  productId: ID;
  productName: string;
  qty: number;
  unitPrice: number;
  unitCost: number;
  total: number;
  buyer: string;
  memberId?: ID | null;
  date: string;
};

export type ActivityType =
  | "member_added"
  | "membership_renewed"
  | "membership_expired"
  | "payment_received"
  | "product_sold"
  | "product_added"
  | "invoice_generated"
  | "member_trashed"
  | "member_restored"
  | "member_deleted";

export type Activity = {
  id: ID;
  type: ActivityType;
  title: string;
  description: string;
  date: string;
};

export type Settings = {
  gymName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  currency: string;
  invoicePrefix: string;
  lowStockAlerts: boolean;
  expiryReminderDays: number;
  adminName: string;
  revenueCardMetric?: "today" | "weekly" | "monthly" | "yearly" | "total";
};

export type GymState = {
  version: number;
  auth: { passwordHash: string; email: string };
  settings: Settings;
  members: Member[];
  plans: Plan[];
  memberships: Membership[];
  payments: Payment[];
  products: Product[];
  sales: Sale[];
  activities: Activity[];
  readNotifications: string[];
  invoiceSeq: number;
};

export type MemberStatus = "active" | "expired" | "frozen" | "expiring";
