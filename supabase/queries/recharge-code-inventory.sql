-- Code inventory, assignee, redemption account, and status.
-- Plaintext is intentionally unavailable here; it is revealed only once at generation.
select
  code.batch_label,
  code.duration_days,
  code.created_at,
  code.valid_until as redeem_by,
  code.target_email as assigned_owner,
  issuer.email as issued_by,
  redeemer.email as redeemed_by,
  code.redeemed_at,
  code.revoked_at,
  revoker.email as revoked_by,
  case
    when code.revoked_at is not null then 'revoked'
    when code.redeemed_at is not null then 'redeemed'
    when code.valid_until is not null and code.valid_until < now() then 'expired unused'
    else 'unused'
  end as code_status
from public.recharge_codes code
left join auth.users issuer on issuer.id = code.created_by
left join auth.users redeemer on redeemer.id = code.redeemed_by
left join auth.users revoker on revoker.id = code.revoked_by
order by code.created_at desc;
