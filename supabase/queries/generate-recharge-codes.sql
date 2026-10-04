-- Run in Supabase SQL Editor as the project database owner.
-- Leave p_target_email null for first-come redemption, or enter an existing
-- gym owner's sign-in email to restrict this code to that Supabase account.
-- Plaintext is shown only once; only its SHA-256 hash is stored.
select *
from public.generate_recharge_codes(
  p_days := 90,
  p_count := 1,
  p_valid_days := 30,
  p_batch_label := 'Manual issue',
  p_target_email := 'owner@example.com'
);
