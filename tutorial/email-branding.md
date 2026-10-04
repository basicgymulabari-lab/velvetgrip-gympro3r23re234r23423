# Branded account-confirmation email

The app's confirmation email source is [`../supabase/templates/confirmation.html`](../supabase/templates/confirmation.html). The local Supabase configuration sets the subject to “Confirm your IRONVAULT gym account” and the sender display name to “IRONVAULT”.

## Why the email you received still says Supabase Auth

This Supabase project was created on August 4, 2026. Supabase's current policy says new Free-plan projects using its built-in email service cannot customize Auth email templates. The local template does not automatically update the hosted project. A custom SMTP provider is needed to use a custom template on this project; configure it in the Supabase Dashboard under **Authentication → SMTP Settings** (menu labels can vary).

Supabase includes custom SMTP configuration on Free, but the SMTP provider may have its own sending limits or charges. Never place its SMTP password or API key in this repository or the browser app. Enter it only in Supabase's SMTP settings.

Supabase lists **Remove Supabase branding from emails** as unavailable on Free. The template in this repository omits the “Powered by Supabase” footer, but I have not claimed or applied a way around that plan restriction. If Supabase injects its branding for this project, removing it requires an eligible paid Supabase plan.

## To activate the template after SMTP is configured

1. In Supabase, open **Authentication → SMTP Settings** and configure the SMTP host, port, username, password, verified sender email, and sender name `IRONVAULT` from your mail provider.
2. Keep email confirmations enabled.
3. Open **Authentication → Email Templates → Confirm signup**. Set the subject to `Confirm your IRONVAULT gym account` and paste the contents of `supabase/templates/confirmation.html` into the message body.
4. Save, then use Supabase's email preview/test feature with an address you control. Verify that the confirmation button and fallback URL both work before sharing the app.

The confirmation URL variable `{{ .ConfirmationURL }}` must remain intact in both links. This task updated the repository template only; it did not change hosted SMTP settings or send a test message.

## Official references

- [Supabase Auth email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase pricing](https://supabase.com/pricing)
- [Free-tier email-template change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier)
