import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { desktopRouteTree } from "./routeTree";
import type { routeTree as generatedRouteTree } from "../src/routeTree.gen";
import "../src/styles.css";

const queryClient = new QueryClient();
const router = createRouter({
  // The generated route type describes all web routes; the desktop runtime
  // tree deliberately omits CEO routes but shares every gym-management path.
  routeTree: desktopRouteTree as unknown as typeof generatedRouteTree,
  context: { queryClient },
  history: createHashHistory(),
  scrollRestoration: true,
  defaultPreloadStaleTime: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Desktop application root was not found.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
