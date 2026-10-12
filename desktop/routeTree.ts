import { Route as rootRoute } from "../src/routes/__root";
import { Route as dashboardRoute } from "../src/routes/index";
import { Route as expensesRoute } from "../src/routes/expenses";
import { Route as inquiriesRoute } from "../src/routes/inquiries";
import { Route as loginRoute } from "../src/routes/login";
import { Route as membershipsRoute } from "../src/routes/memberships";
import { Route as notificationsRoute } from "../src/routes/notifications";
import { Route as paymentsRoute } from "../src/routes/payments";
import { Route as productsRoute } from "../src/routes/products";
import { Route as reportsRoute } from "../src/routes/reports";
import { Route as settingsRoute } from "../src/routes/settings";
import { Route as trashRoute } from "../src/routes/trash";
import { Route as membersRoute } from "../src/routes/members.index";
import { Route as memberRoute } from "../src/routes/members.$memberId";

// The desktop app ships only the gym-management routes. Keeping the platform
// owner/CEO routes out of this tree also keeps their UI and privileged client
// code out of the Windows bundle.
const children = {
  DashboardRoute: dashboardRoute.update({
    id: "/",
    path: "/",
    getParentRoute: () => rootRoute,
  } as never),
  ExpensesRoute: expensesRoute.update({
    id: "/expenses",
    path: "/expenses",
    getParentRoute: () => rootRoute,
  } as never),
  InquiriesRoute: inquiriesRoute.update({
    id: "/inquiries",
    path: "/inquiries",
    getParentRoute: () => rootRoute,
  } as never),
  LoginRoute: loginRoute.update({
    id: "/login",
    path: "/login",
    getParentRoute: () => rootRoute,
  } as never),
  MembershipsRoute: membershipsRoute.update({
    id: "/memberships",
    path: "/memberships",
    getParentRoute: () => rootRoute,
  } as never),
  NotificationsRoute: notificationsRoute.update({
    id: "/notifications",
    path: "/notifications",
    getParentRoute: () => rootRoute,
  } as never),
  PaymentsRoute: paymentsRoute.update({
    id: "/payments",
    path: "/payments",
    getParentRoute: () => rootRoute,
  } as never),
  ProductsRoute: productsRoute.update({
    id: "/products",
    path: "/products",
    getParentRoute: () => rootRoute,
  } as never),
  ReportsRoute: reportsRoute.update({
    id: "/reports",
    path: "/reports",
    getParentRoute: () => rootRoute,
  } as never),
  SettingsRoute: settingsRoute.update({
    id: "/settings",
    path: "/settings",
    getParentRoute: () => rootRoute,
  } as never),
  TrashRoute: trashRoute.update({
    id: "/trash",
    path: "/trash",
    getParentRoute: () => rootRoute,
  } as never),
  MembersRoute: membersRoute.update({
    id: "/members/",
    path: "/members/",
    getParentRoute: () => rootRoute,
  } as never),
  MemberRoute: memberRoute.update({
    id: "/members/$memberId",
    path: "/members/$memberId",
    getParentRoute: () => rootRoute,
  } as never),
};

export const desktopRouteTree = rootRoute._addFileChildren(children as never);
