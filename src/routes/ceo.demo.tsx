import { useMemo, useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BadgeCheck,
  Building2,
  ChartNoAxesCombined,
  CircleDollarSign,
  Dumbbell,
  KeyRound,
  LogOut,
  MailPlus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DEMO_EMAIL = "demo@ironvault.local";
const DEMO_PASSWORD = "DemoOnly!2026";

type Gym = {
  id: string;
  name: string;
  owner: string;
  email: string;
  members: number;
  memberLimit: number;
  proDays: number;
};

const initialGyms: Gym[] = [
  {
    id: "gym-1",
    name: "Northstar Fitness",
    owner: "Aarav Sharma",
    email: "aarav@example.test",
    members: 84,
    memberLimit: 100,
    proDays: 52,
  },
  {
    id: "gym-2",
    name: "Pulse Training Club",
    owner: "Maya Rai",
    email: "maya@example.test",
    members: 27,
    memberLimit: 50,
    proDays: 0,
  },
  {
    id: "gym-3",
    name: "Foundry Strength",
    owner: "Kabir Thapa",
    email: "kabir@example.test",
    members: 9,
    memberLimit: 10,
    proDays: 12,
  },
];

export const Route = createFileRoute("/ceo/demo")({
  head: () => ({
    meta: [
      { title: "CEO Hub Demo — IRONVAULT" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "description", content: "Read-only sample experience for the IRONVAULT platform owner console." },
    ],
  }),
  component: CeoDemoPage,
});

function CeoDemoPage() {
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [loginError, setLoginError] = useState("");
  const [gyms, setGyms] = useState(initialGyms);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invites, setInvites] = useState<string[]>(["hello@samplegym.test"]);
  const [notice, setNotice] = useState("");

  const totals = useMemo(() => {
    const members = gyms.reduce((sum, gym) => sum + gym.members, 0);
    const capacity = gyms.reduce((sum, gym) => sum + gym.memberLimit, 0);
    return {
      members,
      capacity,
      pro: gyms.filter((gym) => gym.proDays > 0).length,
      renewals: gyms.filter((gym) => gym.proDays > 0 && gym.proDays <= 30).length,
    };
  }, [gyms]);

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (email.trim().toLowerCase() !== DEMO_EMAIL || password !== DEMO_PASSWORD) {
      setLoginError("Those demo credentials don’t match. Use the sample credentials shown here.");
      return;
    }
    setLoginError("");
    setSignedIn(true);
  };

  const togglePro = (gymId: string) => {
    setGyms((current) =>
      current.map((gym) =>
        gym.id === gymId ? { ...gym, proDays: gym.proDays > 0 ? 0 : 30 } : gym,
      ),
    );
    setNotice("Demo updated only. No customer account or subscription was changed.");
  };

  const addInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = inviteEmail.trim().toLowerCase();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      setNotice("Enter a valid sample email address.");
      return;
    }
    if (invites.includes(normalized)) {
      setNotice("That sample invitation is already listed.");
      return;
    }
    setInvites((current) => [normalized, ...current]);
    setInviteEmail("");
    setNotice("Sample invite added locally. No email was sent and no backend was changed.");
  };

  if (!signedIn) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4 py-8">
        <section className="surface-panel w-full max-w-lg rounded-3xl border border-border p-6 sm:p-9">
          <div className="flex items-center gap-3 text-gold">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gold/15">
              <Dumbbell className="h-6 w-6" />
            </span>
            <div>
              <p className="font-display tracking-[0.18em]">IRONVAULT</p>
              <p className="text-xs text-muted-foreground">Platform Owner Console · Demo</p>
            </div>
          </div>
          <div className="mt-8 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-6 text-muted-foreground">
            <p className="font-semibold text-foreground">Safe, sample-only demo</p>
            <p>
              This separate CEO experience uses fictional gyms and local-only actions. It cannot
              access or change live customer data.
            </p>
          </div>
          <form className="mt-6 space-y-4" onSubmit={signIn}>
            <div className="space-y-2">
              <Label htmlFor="ceo-demo-email">Demo email</Label>
              <Input
                id="ceo-demo-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ceo-demo-password">Demo password</Label>
              <Input
                id="ceo-demo-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {loginError && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                {loginError}
              </p>
            )}
            <Button className="w-full" type="submit">Enter demo</Button>
          </form>
          <p className="mt-4 rounded-lg bg-secondary/40 p-3 text-xs text-muted-foreground">
            Email: <span className="font-medium text-foreground">{DEMO_EMAIL}</span>
            <br />
            Password: <span className="font-medium text-foreground">{DEMO_PASSWORD}</span>
          </p>
          <Link className="mt-5 inline-flex text-sm text-gold hover:underline" to="/ceo">
            Back to secure platform-owner sign in
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
          <div className="flex items-center gap-3 text-gold">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gold/15">
              <Dumbbell className="h-6 w-6" />
            </span>
            <div>
              <p className="font-display tracking-[0.18em]">IRONVAULT</p>
              <p className="text-xs text-muted-foreground">CEO Control Center · Demo</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">
              SAMPLE DATA ONLY
            </span>
            <Button type="button" variant="secondary" onClick={() => setSignedIn(false)}>
              <LogOut className="mr-2 h-4 w-4" /> Exit demo
            </Button>
          </div>
        </header>

        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gold">Platform administration</p>
            <h1 className="mt-1 font-display text-3xl sm:text-4xl">CEO Control Center</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              View gym accounts, member capacity, subscription status, and invitations.
            </p>
          </div>
          <Link className="text-sm text-gold hover:underline" to="/ceo">
            Live administrator sign in
          </Link>
        </div>

        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-6 text-muted-foreground">
          <strong className="text-foreground">Interactive demo:</strong> Changes on this page are
          temporary and stay in this browser session only. Live management requires an authorized
          Supabase platform-admin account.
        </div>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Platform summary">
          <Metric icon={<Building2 />} label="Gym accounts" value={String(gyms.length)} detail="Sample workspaces" />
          <Metric icon={<BadgeCheck />} label="Pro subscriptions" value={String(totals.pro)} detail={`of ${gyms.length} gyms`} />
          <Metric icon={<Users />} label="Member capacity" value={`${totals.members} / ${totals.capacity}`} detail="Members across all sample gyms" />
          <Metric icon={<ChartNoAxesCombined />} label="Renewals soon" value={String(totals.renewals)} detail="Within the next 30 days" />
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.8fr)]">
          <div className="surface-panel overflow-hidden rounded-2xl border border-border">
            <div className="border-b border-border px-5 py-4">
              <h2 className="font-display text-xl">Gyms & subscriptions</h2>
              <p className="text-sm text-muted-foreground">Demo controls only — no real accounts are affected.</p>
            </div>
            <div className="divide-y divide-border">
              {gyms.map((gym) => (
                <article className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center" key={gym.id}>
                  <div className="min-w-0">
                    <h3 className="font-semibold">{gym.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{gym.owner} · {gym.email}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> {gym.members} / {gym.memberLimit} members</span>
                      <span className="inline-flex items-center gap-1.5"><CircleDollarSign className="h-3.5 w-3.5" /> {gym.proDays > 0 ? `Pro · ${gym.proDays} days left` : "Free plan"}</span>
                    </div>
                    <div className="mt-2 h-1.5 max-w-md overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-gold" style={{ width: `${Math.min(100, (gym.members / gym.memberLimit) * 100)}%` }} />
                    </div>
                  </div>
                  <Button type="button" variant={gym.proDays > 0 ? "secondary" : "default"} onClick={() => togglePro(gym.id)}>
                    <KeyRound className="mr-2 h-4 w-4" /> {gym.proDays > 0 ? "Revoke demo Pro" : "Grant 30 demo days"}
                  </Button>
                </article>
              ))}
            </div>
          </div>

          <div className="surface-panel rounded-2xl border border-border p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-gold" />
              <h2 className="font-display text-xl">Invite a gym owner</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Preview the invite workflow. Demo invitations are not sent and do not authorize sign-up.
            </p>
            <form className="mt-4 space-y-3" onSubmit={addInvite}>
              <Label htmlFor="demo-invite-email">Owner email</Label>
              <Input
                id="demo-invite-email"
                type="email"
                placeholder="owner@example.com"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                required
              />
              <Button type="submit" variant="secondary" className="w-full">
                <MailPlus className="mr-2 h-4 w-4" /> Add sample invitation
              </Button>
            </form>
            {notice && <p className="mt-3 text-xs text-muted-foreground" role="status">{notice}</p>}
            <div className="mt-5 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sample invites</p>
              <ul className="mt-2 space-y-2 text-sm">
                {invites.map((invite) => <li className="break-all rounded-lg bg-secondary/40 px-3 py-2" key={invite}>{invite}</li>)}
              </ul>
            </div>
          </div>
        </section>

        <footer className="mt-8 flex items-start gap-2 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          The real CEO console uses Supabase authorization on every operation. This public demo has no
          connection to customer records, billing, or the production database.
        </footer>
      </div>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="surface-panel rounded-2xl border border-border p-5">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        <span className="text-gold">{icon}</span>{label}
      </div>
      <p className="mt-4 font-display text-3xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </article>
  );
}
