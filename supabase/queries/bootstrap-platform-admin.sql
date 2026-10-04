-- ONE TIME ONLY: run in Supabase SQL Editor as the project owner.
-- Replace the email with the verified sign-in email for your own platform account.
-- This grants global Pro-management access to that account, so never use a customer email.
insert into public.platform_admins (user_id, created_by, enabled)
select account.id, account.id, true
from auth.users account
where lower(account.email) = lower(trim('YOUR-ADMIN-EMAIL@example.com'))
  and account.email_confirmed_at is not null
on conflict (user_id) do update set enabled = true
returning user_id, enabled, created_at;

