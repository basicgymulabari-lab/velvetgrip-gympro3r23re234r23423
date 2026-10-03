import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, GraduationCap, Sparkles, Trophy, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export const APP_TOUR_REQUEST_KEY = "ironvault.app-tour.requested";

type TourStep = {
  title: string;
  description: string;
  target?: string;
};

const TOUR_STEPS: TourStep[] = [
  {
    title: "Welcome to IRONVAULT",
    description:
      "This short guided tour shows you where everything lives and how to handle the daily work of your gym. You can skip it at any time and replay it later.",
  },
  {
    title: "Your dashboard",
    description:
      "Start here for a quick health check of the gym: active members, revenue, pending dues, expired memberships, charts and items that need attention.",
    target: '[data-tour="dashboard-overview"]',
  },
  {
    title: "Members",
    description:
      "Add and manage member profiles, contact details and membership status. This is the main roster for everyone registered at your gym.",
    target: '[data-tour="nav-members"]',
  },
  {
    title: "Memberships",
    description:
      "Create, renew, freeze and review membership plans. Use this area to keep track of plan dates and member access.",
    target: '[data-tour="nav-memberships"]',
  },
  {
    title: "Payments",
    description:
      "Record collected payments, review outstanding balances and follow up on pending dues from memberships and product sales.",
    target: '[data-tour="nav-payments"]',
  },
  {
    title: "Products",
    description:
      "Manage products and inventory, record sales and keep an eye on low-stock items from one place.",
    target: '[data-tour="nav-products"]',
  },
  {
    title: "Expenses",
    description:
      "Log business expenses so your dashboard and financial reporting reflect the real operating cost of the gym.",
    target: '[data-tour="nav-expenses"]',
  },
  {
    title: "Reports",
    description:
      "Review performance and financial summaries when you need a clearer picture beyond the day-to-day dashboard.",
    target: '[data-tour="nav-reports"]',
  },
  {
    title: "Inquiries",
    description:
      "Track prospective members and follow-ups so new leads do not get lost before they become paying members.",
    target: '[data-tour="nav-inquiries"]',
  },
  {
    title: "Notifications",
    description:
      "Check reminders and important activity here. The bell in the top bar also gives you quick access to recent notifications.",
    target: '[data-tour="nav-notifications"]',
  },
  {
    title: "Trash",
    description:
      "Items that can be recovered are kept here before permanent removal, giving you a safer way to correct accidental deletions.",
    target: '[data-tour="nav-trash"]',
  },
  {
    title: "Settings",
    description:
      "Configure your gym profile, invoices, reminders, staff access, backups and other workspace preferences here.",
    target: '[data-tour="nav-settings"]',
  },
  {
    title: "Search the whole workspace",
    description:
      "Use global search to quickly find members, products and invoices. You can also open it from the keyboard with Ctrl/Command + K.",
    target: '[data-tour="global-search"]',
  },
  {
    title: "Fast daily actions",
    description:
      "Use these shortcuts for common jobs such as adding a member, selling a product, recording a payment or adding an expense.",
    target: '[data-tour="quick-actions"]',
  },
  {
    title: "Congratulations!",
    description:
      "You completed the IRONVAULT guided tour. You now know the core workflow and can replay this tour anytime from Settings → Guided App Tour.",
  },
];

type Rect = {
  top: number;
  left: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

function getVisibleRect(selector?: string): Rect | null {
  if (!selector || typeof document === "undefined") return null;
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight;
  if (!visible) return null;
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
}

export function OnboardingTour({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const step = TOUR_STEPS[stepIndex];

  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => setTargetRect(getVisibleRect(step.target));
    const target = step.target ? document.querySelector<HTMLElement>(step.target) : null;

    if (target) {
      const rect = target.getBoundingClientRect();
      const isOnScreen =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      if (isOnScreen) target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    update();
    const frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, step.target]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
      if (event.key === "ArrowRight" && stepIndex < TOUR_STEPS.length - 1)
        setStepIndex((current) => current + 1);
      if (event.key === "ArrowLeft" && stepIndex > 0) setStepIndex((current) => current - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onDismiss, stepIndex]);

  const cardStyle = useMemo(() => {
    if (!targetRect || typeof window === "undefined" || window.innerWidth < 640) return undefined;
    const cardWidth = Math.min(400, window.innerWidth - 32);
    const left = Math.max(
      16,
      Math.min(
        targetRect.left + targetRect.width / 2 - cardWidth / 2,
        window.innerWidth - cardWidth - 16,
      ),
    );
    const estimatedHeight = 275;
    const placeBelow = targetRect.bottom + estimatedHeight + 18 < window.innerHeight;
    const top = placeBelow
      ? targetRect.bottom + 14
      : Math.max(16, targetRect.top - estimatedHeight - 14);
    return { left, top, width: cardWidth };
  }, [targetRect]);

  if (!open) return null;

  const isLast = stepIndex === TOUR_STEPS.length - 1;
  const progress = Math.round(((stepIndex + 1) / TOUR_STEPS.length) * 100);
  const highlight = targetRect
    ? {
        top: Math.max(6, targetRect.top - 6),
        left: Math.max(6, targetRect.left - 6),
        width: Math.min(window.innerWidth - 12, targetRect.width + 12),
        height: Math.min(window.innerHeight - 12, targetRect.height + 12),
      }
    : null;

  return (
    <div
      className="fixed inset-0 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-label="Application tour"
    >
      {highlight ? (
        <div
          className="pointer-events-none fixed rounded-xl border-2 border-gold shadow-[0_0_0_9999px_rgba(0,0,0,0.72),0_0_32px_rgba(212,175,55,0.35)] transition-all duration-200"
          style={highlight}
        />
      ) : (
        <div className="pointer-events-none fixed inset-0 bg-black/75 backdrop-blur-[2px]" />
      )}

      {isLast && (
        <div
          className="tour-celebration-burst pointer-events-none fixed inset-0"
          aria-hidden="true"
        >
          {Array.from({ length: 16 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      )}

      <section
        className={
          isLast
            ? "fixed left-1/2 top-1/2 w-[calc(100%-24px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-gold/40 bg-card shadow-2xl"
            : "fixed bottom-3 left-3 right-3 overflow-hidden rounded-2xl border border-gold/30 bg-card shadow-2xl sm:bottom-auto sm:left-auto sm:right-auto sm:w-[400px]"
        }
        style={isLast ? undefined : cardStyle}
      >
        <div className="h-1 bg-secondary">
          <div
            className="h-full bg-[image:var(--gradient-gold)] transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className={isLast ? "relative p-6 text-center sm:p-8" : "p-5 sm:p-6"}>
          {isLast && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,var(--color-gold)_0%,transparent_68%)] opacity-15" />
              <div className="relative mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full border border-gold/40 bg-gold/10 text-gold tour-celebration-medal">
                <Trophy className="h-9 w-9" />
                <Sparkles className="absolute -right-2 -top-1 h-5 w-5 text-gold" />
              </div>
            </>
          )}
          <div className="flex items-start gap-3">
            {!isLast && (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gold/10 text-gold">
                <GraduationCap className="h-5 w-5" />
              </span>
            )}
            <div className={isLast ? "min-w-0 flex-1 text-center" : "min-w-0 flex-1"}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gold">
                {isLast
                  ? "Tour complete · 15 of 15"
                  : `Guided tour · ${stepIndex + 1} of ${TOUR_STEPS.length}`}
              </p>
              <h2
                className={
                  isLast
                    ? "mt-2 font-display text-3xl tracking-wide text-gradient-gold"
                    : "mt-1 font-display text-xl tracking-wide text-foreground"
                }
              >
                {step.title}
              </h2>
            </div>
            {!isLast && (
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label="Skip tour"
                title="Skip tour"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <p
            className={
              isLast
                ? "mx-auto mt-4 max-w-sm text-sm leading-6 text-muted-foreground"
                : "mt-4 text-sm leading-6 text-muted-foreground"
            }
          >
            {step.description}
          </p>

          <div
            className={
              isLast
                ? "mt-6 flex items-center justify-center gap-3"
                : "mt-5 flex items-center justify-between gap-3"
            }
          >
            {!isLast && (
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Skip tour
              </button>
            )}

            <div className="flex items-center gap-2">
              {stepIndex > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setStepIndex((current) => current - 1)}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" /> Back
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (isLast) onDismiss();
                  else setStepIndex((current) => current + 1);
                }}
              >
                {isLast ? (
                  <>
                    <Check className="mr-1 h-4 w-4" /> Finish
                  </>
                ) : (
                  <>
                    Next <ArrowRight className="ml-1 h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
