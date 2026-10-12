from pathlib import Path
import shutil

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(r"C:\Users\HP\Downloads\gpt Test\velvetgrip-gympro3r23re234r23423")
DOWNLOADS = Path(r"C:\Users\HP\Downloads\Gym Management Application")
GUIDE_ASSETS = ROOT / "tutorial" / "screenshots" / "guide"
APP_IMAGES = GUIDE_ASSETS / "gym"
CEO_IMAGES = GUIDE_ASSETS / "ceo"
PUBLIC_GUIDES = ROOT / "public" / "guides"
GOLD = colors.HexColor("#bd9129")
INK = colors.HexColor("#171719")
MUTED = colors.HexColor("#526071")
PALE = colors.HexColor("#f5f1e8")
RED = colors.HexColor("#b42332")
PAGE_W, PAGE_H = A4
LEFT = RIGHT = 18 * mm
CONTENT_W = PAGE_W - LEFT - RIGHT

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="GuideCoverKicker", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=9, leading=13, textColor=GOLD, spaceAfter=10, tracking=1.8,
))
styles.add(ParagraphStyle(
    name="GuideCoverTitle", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=27, leading=32, textColor=INK, alignment=TA_LEFT, spaceAfter=11,
))
styles.add(ParagraphStyle(
    name="GuideCoverSub", parent=styles["Normal"], fontSize=12, leading=18,
    textColor=MUTED, spaceAfter=12,
))
styles.add(ParagraphStyle(
    name="GuideH1", parent=styles["Heading1"], fontName="Helvetica-Bold",
    fontSize=20, leading=24, textColor=INK, spaceBefore=0, spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="GuideIntro", parent=styles["Normal"], fontSize=10, leading=14,
    textColor=MUTED, spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="GuideBody", parent=styles["BodyText"], fontSize=9, leading=13,
    textColor=INK, spaceAfter=4,
))
styles.add(ParagraphStyle(
    name="GuideSmall", parent=styles["BodyText"], fontSize=8, leading=11,
    textColor=MUTED, spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="GuideCallout", parent=styles["BodyText"], fontName="Helvetica-Bold",
    fontSize=8.5, leading=12, textColor=RED,
))
styles.add(ParagraphStyle(
    name="GuideStep", parent=styles["BodyText"], fontSize=9, leading=12.5,
    textColor=INK, leftIndent=16, firstLineIndent=-16, spaceAfter=5,
))
styles.add(ParagraphStyle(
    name="GuideSection", parent=styles["Heading2"], fontName="Helvetica-Bold",
    fontSize=11, leading=14, textColor=GOLD, spaceBefore=3, spaceAfter=5,
))
styles.add(ParagraphStyle(
    name="GuideCaption", parent=styles["Normal"], fontSize=7.5, leading=10,
    textColor=MUTED, alignment=TA_CENTER, spaceBefore=4, spaceAfter=7,
))
styles.add(ParagraphStyle(
    name="GuideCoverList", parent=styles["BodyText"], fontSize=10, leading=15,
    textColor=INK, leftIndent=14, firstLineIndent=-10, spaceAfter=6,
))


def header_footer(canvas, doc, label):
    canvas.saveState()
    if doc.page > 1:
        canvas.setStrokeColor(colors.HexColor("#ddd6c7"))
        canvas.setLineWidth(0.6)
        canvas.line(LEFT, PAGE_H - 14 * mm, PAGE_W - RIGHT, PAGE_H - 14 * mm)
        canvas.setFillColor(GOLD)
        canvas.setFont("Helvetica-Bold", 7.5)
        canvas.drawString(LEFT, PAGE_H - 11 * mm, label.upper())
    canvas.setStrokeColor(colors.HexColor("#ddd6c7"))
    canvas.line(LEFT, 13 * mm, PAGE_W - RIGHT, 13 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(LEFT, 8.5 * mm, "Basic Gym - IRONVAULT - Examples are anonymized")
    canvas.drawRightString(PAGE_W - RIGHT, 8.5 * mm, f"{doc.page}")
    canvas.restoreState()


def note_box(text, title="IMPORTANT"):
    table = Table(
        [[Paragraph(f"<b>{title}</b><br/>{text}", styles["GuideCallout"])]],
        colWidths=[CONTENT_W],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff0ef")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#e7a4a6")),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def fit_image(path, max_height=285):
    image = Image(str(path))
    scale = min(CONTENT_W / image.imageWidth, (max_height * mm) / image.imageHeight)
    image.drawWidth = image.imageWidth * scale
    image.drawHeight = image.imageHeight * scale
    image.hAlign = "CENTER"
    return image


def numbered(text, index):
    return Paragraph(f"<b><font color='#bd9129'>{index}.</font></b> {text}", styles["GuideStep"])


def section_page(story, title, intro, steps, image=None, caption=None, notes=None, image_max=285):
    story.extend([
        Paragraph(title, styles["GuideH1"]),
        Paragraph(intro, styles["GuideIntro"]),
    ])
    if image:
        story.append(fit_image(image, image_max))
        if caption:
            story.append(Paragraph(caption, styles["GuideCaption"]))
    for i, step in enumerate(steps, 1):
        story.append(numbered(step, i))
    if notes:
        story.extend([Spacer(1, 5), note_box(notes)])
    story.append(PageBreak())


def cover(story, kicker, title, subtitle, points, warning=None):
    story.extend([
        Spacer(1, 28 * mm),
        Paragraph(kicker.upper(), styles["GuideCoverKicker"]),
        Paragraph(title, styles["GuideCoverTitle"]),
        Paragraph(subtitle, styles["GuideCoverSub"]),
        Spacer(1, 5 * mm),
    ])
    items = [[Paragraph(f"- &nbsp; {point}", styles["GuideCoverList"])] for point in points]
    table = Table(items, colWidths=[CONTENT_W])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#d8cda9")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(table)
    story.append(Spacer(1, 9 * mm))
    if warning:
        story.append(note_box(warning, "READ BEFORE YOU START"))
    story.extend([
        Spacer(1, 12 * mm),
        Paragraph("Quick route map", styles["GuideSection"]),
        Paragraph("Dashboard - Members - Memberships - Payments - Products - Expenses - Reports - Inquiries - Notifications - Trash - Settings", styles["GuideBody"]),
        Spacer(1, 15 * mm),
        Paragraph("Visual examples are redacted and use illustrative workspace data. Totals, names, dates, and labels can differ in your gym.", styles["GuideSmall"]),
        PageBreak(),
    ])


def gym_pdf(destination):
    story = []
    cover(
        story,
        "Basic Gym - User guide",
        "Run the gym from one workspace",
        "A practical guide to member records, memberships, payments, stock, reporting, staff access, and safe offline work.",
        [
            "A new owner or receptionist can use this guide alongside the in-app guided tour.",
            "Use the sidebar to move between the 11 management areas; use Ctrl/Command + K for global search.",
            "Record operational changes in the app and confirm the saved result on the relevant page.",
        ],
        "Set up Template Data and Reset all data replace live business records. Do not use either control in a gym workspace that contains real member or financial data.",
    )
    section_page(
        story, "1 - Sign in and choose your role",
        "The gym workspace has separate owner and receptionist sign-in modes. Staff only see pages and actions granted by the owner.",
        [
            "Open the gym sign-in page. Choose Gym owner or Receptionist before entering the matching credentials.",
            "Sign in with email/password or Google if enabled for the workspace. Use Forgot password for account recovery.",
            "If you are a receptionist and a page is missing, ask the owner to review Settings > Staff Access; do not use the owner login.",
        ],
        APP_IMAGES / "00-gym-sign-in.png",
        "Red callouts: (1) choose the correct role, (2) enter the account credentials, (3) use recovery or sign in.",
        "Never share passwords or reuse a staff password. The owner controls staff access and permissions.",
    )
    section_page(
        story, "2 - Dashboard and daily actions",
        "Use the dashboard as a daily overview. Its cards and charts are summaries; open the source page to investigate or change a record.",
        [
            "Review active members, today's revenue, pending dues, and expired members.",
            "Use Quick Actions to add a member, sell a product, record a payment, or add an expense.",
            "Choose Daily, Weekly, Monthly, or Yearly chart ranges; open Reports for the detailed period views.",
            "Check the cloud status in the top bar. 'Sync pending - retry' means changes still need confirmation by the server.",
        ],
        APP_IMAGES / "01-dashboard.png",
        "Red callouts show Add Member and the four common daily shortcuts. Example counts are not live promises.",
        "The notification bell badge may cap its display at 99+; open Notifications for the actual unread count.",
    )
    section_page(
        story, "3 - Member roster and member profiles",
        "Members is the searchable roster. A profile is the place to review a person's contact details, membership terms, due amount, and history.",
        [
            "Use the search box for name, phone, or email, then choose a status filter such as Active, Expiring, Expired, Frozen, Pending Due, or Walk-In Customers.",
            "Select Add Member and complete the profile. If adding a plan now, finish the membership step and confirm its dates and price before saving.",
            "Open the eye action to view a profile, the pencil to edit, and the trash action to move a record into recoverable Trash.",
            "Use the page controls to continue through a long roster; searches and filters update the matching count.",
        ],
        APP_IMAGES / "02-members.png",
        "Member rows are intentionally blurred. Red callouts point to search/status filters and Add Member.",
        "Check for a likely duplicate before adding a person. A profile without a saved membership term is not the same as an expired membership.",
    )
    section_page(
        story, "4 - Plans, renewals, freezes, and expiry",
        "A plan defines price and duration. A membership term assigns a plan to a member over real start and end dates.",
        [
            "Create or edit plans in Memberships. Set the name, duration, price, and any joining fee deliberately.",
            "Use All memberships to inspect terms, Renewal reminders to follow up soon, Expired for ended terms, and Frozen for paused terms.",
            "Assign plan starts a term for a member without one; Renew adds a new term to an existing member. Confirm dates, plan, and amount first.",
            "Freeze/Unfreeze applies to a saved membership term. If a profile shows No membership term recorded, assign the correct plan only when the member should begin or renew.",
        ],
        APP_IMAGES / "03-memberships.png",
        "Red callouts show Create Plan and membership status filters; member rows are blurred.",
        "Do not freeze a profile that has no membership term. The app cannot preserve or pause dates that were never recorded.",
    )
    section_page(
        story, "5 - Payments, balances, and receipts",
        "Payments are manual records; no card gateway is connected by this screen. Use it to record money actually received and to review balances.",
        [
            "Choose Manual Payment. Select a gym member for a member payment, or choose Walk-in / non-member customer and enter the customer details for a non-member payment.",
            "Enter the amount, method, and a clear note, then select Record payment. Confirm the payment appears in Payment History before handing over a receipt.",
            "Use Pending Payments to review balances and Payment History to find recorded transactions. Search by customer, phone, email, or invoice.",
            "Open an invoice/receipt from the saved payment. Export the filtered records to CSV when needed.",
        ],
        APP_IMAGES / "05-manual-payment-entry.png",
        "Red callouts: (1) select a member or walk-in customer, (2) record only after checking the amount and method.",
        "A walk-in customer payment does not create a gym member or membership. Never record a payment solely because a toast appeared - verify the saved row.",
    )
    section_page(
        story, "6 - Products, inventory, and sales",
        "Products tracks the catalogue, stock, product sales, and margin. The sale form validates quantity against current stock.",
        [
            "Create a product with its selling price, cost, current stock, and low-stock threshold. Review both price and cost before saving.",
            "Use Sell Product, choose a product and whole-number quantity within stock, then review any percentage or fixed discount.",
            "Choose a gym member or Walk-in customer as the buyer. Add customer details only when needed for the sale record.",
            "Check stock and sale history after saving. The app blocks quantities above available stock; low-stock warnings help plan restocking.",
        ],
        notes="Discounts reduce the sale total and can affect profit. Verify the final amount and buyer before confirming a sale.",
    )
    section_page(
        story, "7 - Expenses and finance",
        "Expenses records operating costs, categories, receipts, and profit context. Attachments are private workspace files.",
        [
            "Choose Add Expense, provide a clear title, date, category, and non-negative amount, and optionally attach a receipt image or PDF.",
            "Use the page's date range and category summaries to review spending. Edit a record if it needs correction.",
            "Some expenses can be locked against deletion. Open the expense, unlock it, save, and then move it to Trash if removal is genuinely required.",
            "Use the reports and dashboard together: revenue is not the same as net profit; expenses and product cost affect the result.",
        ],
        notes="Do not upload an unrelated customer document as an expense receipt. Keep receipts limited to the business transaction.",
    )
    section_page(
        story, "8 - Reports and exports",
        "Reports provide period-based business summaries for owners and appropriately authorized staff.",
        [
            "Choose the period or date range first and confirm the displayed totals match that range.",
            "Review income, dues, expenses, product activity, and other available charts or summary tables.",
            "Use CSV export for analysis in a spreadsheet. Treat exports as sensitive copies of gym business data and store them securely.",
        ],
        notes="The CEO platform overview is not the source for a gym's member-level reports. Open the Gym Management Application for gym operations.",
    )
    section_page(
        story, "9 - Inquiries and follow-up",
        "Inquiries is the lead tracker for prospective members who have not yet joined.",
        [
            "Add a prospect with the available contact details and their membership interest.",
            "Update the inquiry status and follow-up details after each conversation so staff can see the next step.",
            "When the person joins, create their member profile separately and verify any membership term; an inquiry is not a member record.",
        ],
        notes="Avoid entering health or identity information that is not needed for gym follow-up.",
    )
    section_page(
        story, "10 - Notifications and the unread count",
        "Notifications groups payment-due reminders, membership expiry, and other workspace alerts.",
        [
            "Open the bell for recent alerts or the Notifications page for the full list.",
            "Use Mark all read to mark visible generated notifications as read. This does not delete members or payments.",
            "The header badge is abbreviated at 99+; the Notifications page shows the actual unread total.",
            "Open the linked member or record to resolve the underlying issue; marking an alert read does not pay a balance or renew a membership.",
        ],
        notes="If an unread count looks stale, refresh the notification list and verify the record status; do not use Reset all data to clear notifications.",
    )
    section_page(
        story, "11 - Trash, settings, and staff access",
        "Trash provides recovery for supported deleted records. Settings controls workspace identity, billing context, backups, staff access, and danger-zone actions.",
        [
            "Restore an item from Trash when it was removed by mistake; items may be permanently removed after the recovery period.",
            "In Settings, update gym and invoice details, receipt presentation, reminders, and account security as needed.",
            "To enable receptionist access, set a separate login email and strong password, choose only the required permissions, and Save receptionist.",
            "The owner retains access to Settings, staff control, security, and data-reset controls; receptionist permissions cannot grant themselves more access.",
        ],
        APP_IMAGES / "06-staff-access.png",
        "Red callouts: (1) enable the separate receptionist account, (2) choose the least access needed and save.",
        "Use a unique password of at least 12 characters and share it securely. Turn off unused permissions.",
        image_max=150,
    )
    section_page(
        story, "12 - Backups, template data, and offline sync",
        "The app can preserve a device copy for offline use and synchronize changes when online. Workspace reset actions require special care.",
        [
            "Before using the app offline, sign in online on that same device so the account's workspace can be cached.",
            "When offline, changes are saved locally and queued for sync. On reconnect, watch the cloud status until it confirms Cloud synced.",
            "If the status says Sync pending - retry, use the retry control and verify the changed record on the server before closing or clearing site data.",
            "Use Settings > Backup & Restore to export a JSON backup and keep it in a protected location; check the gym identity before restoring.",
        ],
        APP_IMAGES / "04-template-data-warning.png",
        "The red callout shows Set Up Template Data in the Danger Zone.",
        "Set Up Template Data replaces business records with starter data; Reset all data deletes business records. Neither is a safe way to fix a single missing item.",
    )
    story.extend([
        Paragraph("Quick troubleshooting", styles["GuideH1"]),
        Paragraph("When a number or record looks wrong, trace it back to the source list before changing data.", styles["GuideIntro"]),
        Paragraph("- Dashboard expiry total differs from Memberships: check for profiles with no saved membership term; they are not the same as expired terms.", styles["GuideBody"]),
        Paragraph("- Cloud sync keeps retrying: confirm the device is online, retry, then verify the exact record in the workspace before signing out.", styles["GuideBody"]),
        Paragraph("- A receptionist cannot open a page: ask the owner to grant only the needed permission and save the staff account.", styles["GuideBody"]),
        Paragraph("- A walk-in payment is missing: use Manual Payment and choose Walk-in / non-member customer; this does not create a member.", styles["GuideBody"]),
        Spacer(1, 9),
        note_box("This guide describes current app workflows from the repository and available redacted screenshots. Live behavior, data totals, and some labels may vary by workspace and permissions.", "SCOPE"),
    ])
    doc = SimpleDocTemplate(str(destination), pagesize=A4, leftMargin=LEFT, rightMargin=RIGHT, topMargin=22 * mm, bottomMargin=19 * mm, title="Gym Management Application - User Guide", author="Basic Gym")
    doc.build(story, onFirstPage=lambda c, d: header_footer(c, d, "Gym Management Application"), onLaterPages=lambda c, d: header_footer(c, d, "Gym Management Application"))


def ceo_pdf(destination):
    story = []
    cover(
        story,
        "IRONVAULT - CEO guide",
        "Operate the platform safely",
        "A practical guide to the private CEO Control Center for gym accounts, invitations, owner subscriptions, member migration, backups, and audit history.",
        [
            "The CEO console is separate from every gym's member-management workspace.",
            "Only a platform-owner account authorized by the server can open privileged controls.",
            "Screenshots redact metrics and use placeholders; never copy passwords, assigned codes, or customer details into a guide.",
        ],
        "Do not use a live customer workspace for QA or tutorial screenshots. Take a fresh backup before any restore or migration operation.",
    )
    section_page(
        story, "1 - Sign in to the private CEO console",
        "Open the same app host and add /ceo. CEO sign-in is distinct from Gym owner or Receptionist sign-in.",
        [
            "Enter the platform-owner email and password that have server-side platform-admin access.",
            "No public CEO sign-up is provided. A gym-owner or receptionist account must not be used as a substitute.",
            "Use Forgot password only for account recovery. A reset link does not grant platform-admin rights.",
            "After sign-in, use Sign out when finished, especially on a shared computer.",
        ],
        CEO_IMAGES / "01-ceo-sign-in.png",
        "The sample email is a placeholder, not a credential. Red callouts show the email field and sign-in action.",
        "Never place a real password, reset link, or access token in documentation or a screenshot.",
    )
    section_page(
        story, "2 - Dashboard, gym accounts, backups, and audit",
        "Dashboard & gyms is a server-authorized platform view; it is not a gym's member-management screen.",
        [
            "Use Overview to check platform health and high-level account counts; metric values can change as gyms update.",
            "Use Gyms to select an account and inspect its platform-level status and workspace information.",
            "Use Backups to create a workspace snapshot, download it securely, or restore it. A restore first saves a pre-restore snapshot.",
            "Use Audit log to review privileged platform activity and its administrator/time context.",
            "The live status refreshes automatically; use Refresh data when you need an immediate recheck.",
        ],
        CEO_IMAGES / "02-ceo-overview.png",
        "Red callout identifies Subscriptions & codes; account metrics are blurred for privacy.",
        "Backups contain private gym business data. Store downloaded files in an access-controlled location; verify the selected gym before restoring.",
    )
    section_page(
        story, "3 - Gym invitations",
        "Invitations authorize a new gym-owner account under the platform's existing server-side sign-up controls.",
        [
            "Open Gym invitations, add the exact owner email, and verify it carefully before saving.",
            "Share the sign-up instructions with that owner through a private channel.",
            "Review pending, used, or revoked invitation status in the console. A revoked invitation blocks future signup, not an already existing session.",
        ],
        notes="An invitation is not an account-disable control. Do not promise that revoking an invite signs out an existing user.",
    )
    section_page(
        story, "4 - Subscriptions and assigned codes",
        "This area manages platform-level owner Pro access and one-time codes. Owner Pro and an individual gym member's membership are separate.",
        [
            "Select the correct authorized gym-owner account before generating a code.",
            "Choose the agreed access duration and redemption window, then review the confirmation before generating.",
            "Copy the one-time code immediately and share it privately with that owner. The code is account-bound and can be redeemed once.",
            "Manual or recharge Pro access can be adjusted or revoked in the console. Paid provider subscriptions are managed by the payment provider and are not shortened here.",
        ],
        CEO_IMAGES / "03-create-assigned-code.png",
        "Red callouts show recipient/duration fields and Generate assigned code. Example values are anonymized.",
        "A Pro grant changes workspace capacity/access. It does not create a member membership or change that member's plan.",
    )
    section_page(
        story, "5 - Member Migration Center",
        "The migration tool prepares records in one designated demo/source gym and transfers a reviewed selection into an active destination gym.",
        [
            "Confirm the designated source and destination names. The destination must be active, have a workspace, and satisfy its current membership capacity.",
            "Upload CSV or the first worksheet of an .xlsx file (up to 8 MB / 5,000 records), or enter a member manually. Map columns to the existing member fields.",
            "Review validation errors, missing required fields, and possible duplicates. Correct, remove, or explicitly resolve rows before import.",
            "For transfer, select members and inspect the source/destination, count, and duplicate warnings. Confirm by re-entering the destination gym name.",
            "The transfer copies member profiles and membership terms, retaining term dates, status, and price snapshots; existing plans are matched/copied automatically. Linked payment transfer is an explicit option.",
            "Review the actual operation result and Migration history. If a request fails, check history before retrying; do not assume a timeout means nothing committed.",
        ],
        notes="Source profiles are kept in source Trash for recovery. Do not move unrelated sales, invoices, or private photos unless the operation explicitly includes them. Use staging data for QA.",
    )
    section_page(
        story, "6 - Safety checklist and recovery",
        "Use this short checklist before any account-level change that can affect access or business data.",
        [
            "Verify the selected owner email, gym name, source/destination, and exact duration or member count.",
            "Create a fresh backup before restoring a workspace. Keep the backup in a protected location.",
            "For member migration, inspect the preview and plan/payment options, confirm the destination name, and wait for confirmed results.",
            "After the operation, refresh the destination gym and verify representative member profiles, membership dates, and the operation history.",
            "If an owner loses access, use the supported subscription or auth recovery control; do not edit customer records to work around a platform issue.",
        ],
        notes="This guide is based on current repository behavior and the safe screenshots available at creation time. Protected migration, invitation, backup, and audit screens still require staging credentials for a full screenshot/interaction verification pass.",
    )
    doc = SimpleDocTemplate(str(destination), pagesize=A4, leftMargin=LEFT, rightMargin=RIGHT, topMargin=22 * mm, bottomMargin=19 * mm, title="CEO Dashboard - User Guide", author="IRONVAULT")
    doc.build(story, onFirstPage=lambda c, d: header_footer(c, d, "CEO Dashboard"), onLaterPages=lambda c, d: header_footer(c, d, "CEO Dashboard"))


def main():
    PUBLIC_GUIDES.mkdir(parents=True, exist_ok=True)
    gym_public = PUBLIC_GUIDES / "gym-management-guide.pdf"
    ceo_public = PUBLIC_GUIDES / "ceo-dashboard-guide.pdf"
    gym_pdf(gym_public)
    ceo_pdf(ceo_public)
    gym_download = DOWNLOADS / "Gym Management Application - User Guide.pdf"
    ceo_download = CEO_IMAGES / "CEO Dashboard - User Guide.pdf"
    shutil.copy2(gym_public, gym_download)
    ceo_download = DOWNLOADS / "CEO Dashboard" / "CEO Dashboard - User Guide.pdf"
    ceo_download.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ceo_public, ceo_download)
    print(f"Created {gym_public}")
    print(f"Created {ceo_public}")
    print(f"Copied {gym_download}")
    print(f"Copied {ceo_download}")


if __name__ == "__main__":
    main()
