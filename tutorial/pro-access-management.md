# Manage customer Pro access

The app now has a protected **Settings → Pro Access Manager** for the platform administrator. It lists gym-owner accounts, status, expiry, remaining days, recharge-code history, and the available grant/revoke actions.

## One-time setup

1. Apply the latest database migration, `supabase/migrations/20261004160000_platform_pro_admin.sql`, to the Supabase project used by the app.
2. In Supabase **SQL Editor**, open and run `supabase/queries/bootstrap-platform-admin.sql`. Replace `YOUR-ADMIN-EMAIL@example.com` with the verified sign-in email for your own platform-owner account. Do not add a customer or receptionist. This is the only step that grants platform-wide controls.
3. Sign into the app with that same account, then open **Settings**. The Pro Access Manager is shown only when Supabase confirms that account's admin record.

## Day-to-day use

- **Generate assigned code:** select the gym-owner account, set the number of Pro days and the redemption window, then generate. Copy and deliver the code privately. It is displayed only once and cannot be recovered later. The recipient must sign into that exact account; another account is rejected. A redeemed code cannot be reused.
- **Grant Pro:** this activates or extends manual access immediately for the selected account.
- **Revoke bonus access:** removes manual and recharge access. If a paid Stripe/Razorpay subscription is also active, that provider entitlement remains active; cancel it with that payment provider.
- **Revoke code:** blocks an unused code before redemption. Redeemed codes cannot be revoked as codes; use Revoke bonus access to remove their recharge entitlement.
- **Recent codes:** shows the assignee, duration, deadline, redemption account, and status. Plaintext codes and hashes are never shown in the history.

Every privileged action is checked in Postgres against `platform_admins`; changing browser state or calling the RPC directly does not bypass the check. `platform_admins` has RLS enabled and no browser-role table access. Grant, revoke, redemption, and code-issue actions are written to the audit log.

## Important

The platform-admin bootstrap query is intentionally a separate, deliberate step. Keep only accounts you trust in `platform_admins`. To remove platform access, use Supabase SQL Editor as the project owner:

```sql
update public.platform_admins
set enabled = false
where user_id = (
  select id from auth.users
  where lower(email) = lower(trim('YOUR-ADMIN-EMAIL@example.com'))
);
```

Disabling platform-admin access does not change any customer's plan. The database migration does not grant Pro to, revoke Pro from, or generate codes for any customer.
