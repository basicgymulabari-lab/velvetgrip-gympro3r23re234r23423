# Inquiry Management Research Source

Audience: single-location gym administrators and front-desk staff
Date: 2 September 2026
Scope: an offline, lightweight inquiry/lead workflow integrated into the existing gym application.

## Executive answer

The highest-value inquiry workflow is a compact lead pipeline that records identity and contact
details, acquisition source, membership interest, lead priority, pipeline status, and a dated next
follow-up. The page should surface leads due today or overdue, allow fast status updates, and make
phone/email outreach immediate. Enterprise features such as ownership assignment, automated
campaigns, and multi-pipeline configuration are deliberately excluded because this application is
single-admin and offline.

## Evidence and design implications

- HubSpot separates lifecycle stage from lead sub-status and uses stages such as New, In Progress,
  Attempted to Contact, Connected, and Unqualified. This supports a concise gym-specific pipeline
  rather than one generic “lead” state. Source: “Use contact and company lifecycle stages,” HubSpot,
  updated 14 April 2026, https://knowledge.hubspot.com/records/use-lifecycle-stages
- HubSpot's current lead automation progresses leads when outreach is attempted or a connection is
  made and can create follow-up work at pipeline stages. This supports explicit Contacted,
  Follow-up, Trial, Converted, and Lost states. Source: “Set up lead pipeline automation,” HubSpot,
  updated 24 July 2026,
  https://knowledge.hubspot.com/object-settings/set-up-lead-pipeline-automation
- Salesforce identifies status, rating, created date, lead age, days since last activity, and lead
  source as core acquisition metrics, while highlighting prospects with no recent activity. This
  supports priority labels, source capture, created date, and an attention-first view. Source:
  “Customer Acquisition Dashboard,” Salesforce Help, accessed 2 September 2026,
  https://help.salesforce.com/s/articleView?id=ind.fsc_customer_acquisition_dashboard.htm&language=en_US&type=5
- Salesforce task guidance emphasizes due-today, overdue, and priority views for work linked to
  leads. This supports the “Needs attention” metric and follow-up sorting. Source: “Optimize Tasks
  as an Individual Contributor,” Salesforce Help, accessed 2 September 2026,
  https://help.salesforce.com/s/articleView?id=xcloud.essentials_ic_tasks.htm&language=en_US&type=5

## Resulting product decisions

The implemented page includes open-lead, attention, hot-lead, and conversion metrics; status and
attention filters; text search; contact shortcuts; membership interest; lead source; Hot/Warm/Cold
priority; next follow-up; notes; quick status changes; and add/edit/delete workflows. Two demo leads
show the intended workflow. Dates and phone country codes reuse the application's regional settings.

## Limitations

The application is offline, so follow-ups are surfaced inside the page rather than sent through
email/SMS automation. Conversion is represented as a pipeline status and does not automatically
create a member record, avoiding accidental duplicate member creation.

## Claim-to-source ledger

1. Lead stage/status design — HubSpot, “Use contact and company lifecycle stages,” 14 April 2026.
2. Outreach-driven progression and follow-up — HubSpot, “Set up lead pipeline automation,” 24 July 2026.
3. Lead source, rating, age, and activity prioritization — Salesforce, “Customer Acquisition Dashboard,” accessed 2 September 2026.
4. Due/overdue priority work views — Salesforce, “Optimize Tasks as an Individual Contributor,” accessed 2 September 2026.

Research stopped after official HubSpot and Salesforce documentation converged on the same core
fields and attention workflow; further enterprise CRM sources were unlikely to change the scoped
offline design.
