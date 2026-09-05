import { buildSeed } from "./seed";
import type { GymState } from "./types";

// Never copy browser data or demo records into a newly registered owner's account.
export function newWorkspace(email: string, name = "Gym Owner", gymName = "My Gym"): GymState {
  const defaults = buildSeed();
  return {
    ...defaults,
    auth: { email, passwordHash: "" },
    staff: {},
    settings: {
      ...defaults.settings,
      gymName,
      adminName: name,
      email,
      phone: "",
      address: "",
      tagline: "",
    },
    members: [],
    plans: [],
    memberships: [],
    payments: [],
    products: [],
    sales: [],
    activities: [],
    expenses: [],
    inquiries: [],
    readNotifications: [],
    invoiceSeq: 0,
  };
}
