import { createFileRoute, redirect } from "@tanstack/react-router";

// Retire old bookmarks without ever rendering the former public sample console.
export const Route = createFileRoute("/ceo/demo")({
  beforeLoad: () => {
    throw redirect({ to: "/ceo", replace: true });
  },
});
