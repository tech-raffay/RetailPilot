# RetailPilot

RetailPilot is a working retail management application for independent shops. The default workspace is Northline Outfitters, a fictional two-location retailer with 90 days of sample orders. Each new demo session has its own business data. Demo sessions expire at UTC midnight. Expired demos are removed in batches when a new demo opens.

## Run locally

Open `/welcome.html` for the demo and pricing page. Choose Owner to open a fresh sample dashboard or Cashier to open a fresh register. The root URL opens the workspace. Pricing and workspace limits use the same plan definitions.

Open `/case-study.html` to follow a £119.98 London jacket sale through checkout, inventory and a restocked return in a fresh owner demo.

Install Node.js 22.13 or later. The application uses the built-in SQLite driver and has no runtime npm dependencies.

```sh
npm start
```

Open http://127.0.0.1:4173. Run `npm test` for the acceptance tests or `npm run build` for a single-module Cloudflare Worker build. The local server stores data under `.retailpilot/retail.sqlite`. Set `RETAILPILOT_DATA_DIR` to use a different directory. Stop the process before backing up or restoring the entire data directory. Serve a production installation behind HTTPS and set `RETAILPILOT_HTTPS=1`.

## Back up and restore local records

Run `npm run backup` while the local app is running. It writes a consistent, checked SQLite snapshot under the data directory's `backups` folder. Set `RETAILPILOT_BACKUP_DIR` to save snapshots to another private location. Snapshots include local accounts and shop records. Keep the destination access-controlled.

To restore, create a fresh directory and copy one completed snapshot into it as `retail.sqlite`. Set `RETAILPILOT_DATA_DIR` to that directory and start the app on a free port, for example with `npm start -- --port 4186`. Sign in and verify the workspace before using the restored copy. Keep Stripe settings separately in your local environment.

## Payment monitoring and hosted recovery

Run `npm run monitor:payments` to check local pending Stripe orders against the assigned sandbox merchant's Checkout Sessions. Each alert includes the order ID and session ID. Exit status 0 means the scan completed without alerts, 2 means it found a mismatch, and 1 means it could not complete verification. Use `npm run monitor:payments -- --watch` to repeat every minute while the process is running. Investigate the matching webhook delivery before retrying a payment or changing any stock.

To rehearse recovery from a full Cloudflare D1 SQL export, keep the export outside the repository and run `python scripts/check-d1-export.py PATH_TO_EXPORT.sql`. The script imports the SQL into a fresh in-memory SQLite database, checks the schema and integrity, and prints the workspace revisions, order counts and fingerprints of orders and per-variant stock. Pass `--baseline PATH_TO_SUMMARY.json` to compare with independently recorded values for the same source revision. This local rehearsal covers the logical export. Cloudflare Time Travel recovery requires access to the hosted database's management controls.

## Try the sale and return

To check the register and trial signup in Chromium, run the following from the repository root. The browser suite starts a separate server on port 4174 with a temporary in-memory database. GitHub Actions runs the application tests, Worker build and browser tests on pushes and pull requests.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

1. Open Point of sale and select London.
2. Search for JKT-001 or scan 5051100000000. Add two medium Canvas Field Jackets.
3. Confirm a cash payment of £119.98. The printable receipt shows the VAT and any change.
4. Open Inventory. London stock for JKT-001 falls from 10 to 8, which triggers the threshold of 9. The movement is linked to the order.
5. Open the order, select Return order, enter a reason, and enable restocking. London stock returns to 10. The refunded sale is excluded from sales and profit.

A demo card can return an approval or a decline. Neither action moves money. Seeded historical card orders represent sample transactions. Refunds are full-order refunds.

## Sales reports

Owners and managers can open **Reports**, select a store and choose the last 7, 30 or 90 days. **Print / Save PDF** opens the browser print dialog. Choose **Save as PDF** to save the totals and product table with the workspace, store and UTC date range. **Export CSV** downloads the product rows.

## Online pickup storefront

In **Settings → Edit storefront**, the owner selects a pickup location and enables the shop. **Open storefront** gives the shopper link. The catalog shows variants, prices and stock at that location. Guest checkout shares inventory with POS. Demo shops simulate payment and expire at UTC midnight. Business shops use their connected Stripe test merchant. A closed shop stops accepting new orders.

The shopper can bookmark the order page to check payment status and retrieve the pickup code. Staff open the order and choose **Collect order** to confirm handover with that code. A signed Stripe payment event confirms the order, and checkout expiry releases reserved stock. The pilot supports pickup at one selected location per shop.

## Stock transfers

Run `npm run check:stock` to check local business workspaces. It replays stock movements for each variant and store, compares each recorded balance with the running total, checks both sides of transfers, and compares the result with current inventory. Demo workspaces have preloaded stock and are skipped. The check opens SQLite read-only. Exit code 0 means the scan finished without alerts, 2 identifies discrepancies, and 1 means the scan was incomplete. The output identifies the workspace revision and affected records for investigation.

In a workspace with at least two stores, owners and managers can open Inventory, select **Transfer stock**, choose a variant and move available units to another store. Confirmation deducts and receives stock immediately. The Movements tab shows both entries with the same searchable transfer reference.

## Catalog CSV import

In Products, an owner or manager can choose **Import CSV**, download the sample, select the store for opening stock and preview a UTF-8 comma-separated file. Confirm to add all valid rows together. Existing products can be edited in Products. Re-uploading the same file for the same store reports the completed import. A different file containing an existing SKU or barcode shows a conflict.

Use one row per variant, up to 500 rows and 256 KiB per file. Required headings are `sku`, `name`, `category` and `price`. Optional headings are `cost`, `barcode`, `size`, `color`, `quantity`, `threshold`, `tax` and `image_url`. Use decimal GBP amounts for price and cost, whole units for quantity and threshold, and a whole percentage for VAT. Blank optional numbers default to zero cost, zero units, threshold 5 and the workspace VAT rate. Format barcodes as text in spreadsheets to preserve leading zeros. Put fields containing commas or line breaks inside double quotes and double any quotes inside a quoted field.

## Workspaces and staff

Owners can enable customer loyalty under **Settings → Edit loyalty program**. Business workspaces start with loyalty off and demos start with it on. Once enabled, each new paid sale linked to a customer earns one point per whole £1 of the final total. In POS, select the customer and choose **Use 100 points for 10% off** to redeem one reward. A manual discount and a reward cannot be combined. The balance covers all stores in that business.

Pending Stripe orders reserve redeemed points until payment or expiry. A full refund restores the redeemed points and reverses the points earned on that sale. Returning a purchase after spending its points can leave a negative balance, which future earnings offset. Pausing the program keeps existing balances. Earlier sales retain their original terms.

In **Customers**, owners and managers can open a profile and choose **Edit profile** to correct contact details or update marketing consent. The profile keeps its purchase history. If two people edit the same profile, the second save prompts them to refresh and review the latest details.

Use the workspace selector to open a fresh Owner or Cashier demo or create a business. Business workspaces start empty with a 14-day Starter trial. A business owner can create an invitation link for a specific staff email. Managers can operate the catalog, inventory and reports. Cashiers can ring up sales and return orders worth up to £100. The invitation recipient signs in to accept the link. Share invitation links manually, or configure RESEND_API_KEY and RETAILPILOT_FROM_EMAIL to deliver them by email. Owners can change staff roles or revoke access to active sessions.

Hosted business identity comes from the Sites authentication gateway. Local installations provide a separate email/password sign-in, salted scrypt hashes, HTTP-only cookies, and one-time password recovery codes. Save the recovery code when setting up a local account. The local adapter discards inbound identity headers.

## Architecture and consistency

The browser, API, payment adapter, seed catalog, and server-side business rules are separate modules. Both the local SQLite adapter and the hosted D1 binding use the schema in drizzle/. Organization membership and sessions live in relational tables. The retail document of each organization is versioned. Each write reads the tenant from the session, checks the role, validates the operation, then uses a conditional update against the revision. Conflicting writes reread and retry. Stock adjustments, order items, payment state and inventory movement are committed together. Checkout keys deduplicate retries.

The initial storage model suits demos and small pilot datasets. High-volume production use requires partitioning sales and stock movements into indexed tables to avoid document size and contention limits. Production operations also need scheduled backups, restore drills, retention enforcement, monitoring, and a deployment-specific access review.

## Transactional email

For business workspaces, configure `RESEND_API_KEY` and `RETAILPILOT_FROM_EMAIL` (a sender on your verified Resend domain) in the server environment. Locally, put them in the Git-ignored `.env.local` and restart the app. Use a reachable app origin for staff invitation links. Demo workspaces suppress email.

At checkout, select a customer with an email address and tick **Email receipt**. Cash sales queue the receipt on confirmation. Stripe sales queue it when the signed paid webhook settles the order. A stock reduction crossing from above the threshold to the threshold or below queues an owner alert, including quantities reserved for Stripe checkout. Restocking above the threshold allows a later crossing to alert again.

Owners can open **Settings → Email delivery** for queued, provider-accepted and failed counts. A provider acceptance records submission to Resend. Staff invitations also return a shareable link. Local delivery checks the durable queue every five seconds while the server is running. The Worker drains it on API traffic and supports a scheduled handler for deployments with a cron trigger. Transient errors retry with backoff and a stable provider idempotency key for up to 23 hours after the first attempt. Completed and failed jobs discard the email payload.

## Stripe test integration

For local testing, save sandbox settings in `.env.local` in the repository root. Both `npm start` and `npm run dev` load this Git-ignored file on startup. Restart the local server after changing it.

All secrets stay on the server. Only Stripe test keys are accepted. Set STRIPE_TEST_KEY and STRIPE_WEBHOOK_SECRET. Configure the platform and connected-account event destinations using /api/stripe/webhook with the matching signing secrets (use STRIPE_CONNECT_WEBHOOK_SECRET when the connected-account endpoint has a different secret). For subscriptions, set STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH, and STRIPE_PRICE_BUSINESS to test recurring GBP prices. The billing portal must be enabled in Stripe.

For a merchant direct charge, assign the connected test account in STRIPE_ACCOUNTS as an org-id=acct_id pair (comma-separated for multiple accounts), then enter the assigned account in Store settings. Get the relevant org ID from the authenticated /api/identity response. The provider account needs to exist and be eligible for the chosen flow.

Retail uses Stripe Checkout Sessions with a Stripe-Account header. Billing uses platform Checkout Sessions. The retail redirect does not settle an order. Signature-verified completion settles pending sales, expiry releases reserved inventory, and provider event IDs deduplicate retries. Test refused payments and delivery retries in your own authorized Stripe sandbox before commercial use. Live charging, physical payment terminals, and provider onboarding are outside this build.

On 23 November 2026, a £1.00 GBP card sale through hosted Stripe Checkout was verified against a connected sandbox merchant using an isolated local database. Stock fell from 2 to 1 at checkout. RetailPilot accepted the signed payment webhook, marked the order paid and queued one receipt. A full refund through RetailPilot restored stock to 2, and Stripe independently reported the £1.00 refund as succeeded. This run covered receipt generation and queueing. Inbox delivery was tested separately.

## Included operations

Catalog and variants, barcode lookup, store inventory, adjustments, low-stock alerts, POS discounts and configurable VAT, cash and test-card checkout, printed receipts, orders and full returns, store-specific dashboard periods, reports and CSV exports, customer history, suppliers and purchase-order receiving, role-based staff invitations, subscription limits and workspace settings.

WhatsApp delivery, offline queue, AI forecasts, platform super-admin, custom domains, and production monitoring are later milestones.
