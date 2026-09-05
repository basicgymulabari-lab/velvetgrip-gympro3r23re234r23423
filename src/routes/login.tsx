import { createFileRoute } from "@tanstack/react-router";
import { Dumbbell } from "lucide-react";
import { AccountForm } from "@/components/app/AccountForm";
export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign In & Sign Up — IRONVAULT Gym Management" },
      { name: "description", content: "Create your gym account or sign in securely to IRONVAULT." },
    ],
  }),
  component: LoginPage,
});
function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-border lg:grid-cols-2">
        <section className="hidden flex-col justify-between gap-12 bg-[image:var(--gradient-surface)] p-10 lg:flex">
          <div className="flex items-center gap-3 text-gold">
            <Dumbbell className="h-8 w-8" />
            <p className="font-display text-2xl tracking-[0.22em]">IRONVAULT</p>
          </div>
          <div>
            <h2 className="font-display text-5xl leading-tight">
              Run your gym like a <span className="text-gradient-gold">premium brand.</span>
            </h2>
            <p className="mt-4 text-sm text-muted-foreground">
              Members, memberships, payments, inventory and reports — together in your own gym
              workspace.
            </p>
          </div>
          <p className="border-t border-border pt-6 text-sm text-muted-foreground">
            Sign in with Google or your owner email and password.
          </p>
        </section>
        <section className="min-w-0 bg-card p-6 sm:p-10 lg:min-h-[560px]">
          <AccountForm />
        </section>
      </div>
    </main>
  );
}
