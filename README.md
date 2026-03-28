# Pure Sole

<!-- Single official project title: Pure Sole -->

Pure Sole is a premium black-and-white personal shopping storefront with a hidden `/admin` command center.

## Run locally

```bash
npm install
npm start
```

Open:
- Public storefront: `http://localhost:3000`
- Admin panel: `http://localhost:3000/admin`

Default admin password: `A@070610A@070610` (stored as a SHA-256 hash; change in Settings immediately).

Reset it anytime with:

```bash
npm run reset:admin-password -- "A@070610A@070610"
```

## Included capabilities

### Public storefront
- Pure Sole branding everywhere (no subtitle branding changes)
- Dismissible legal disclaimer banner (once per visit)
- 8 categories: Sneakers, Hoodies, Joggers, T-Shirts, Shorts, Hats, Socks, Full Outfits
- Premium black/white hero
- 4-step How It Works
- Final-sale policy text
- Empty-state "new drops" text when no visible products
- Payment methods and usernames displayed across storefront + checkout
- Checkout shipping notice + direct payment confirmation flow
- Mobile responsive layout

### Hidden admin panel (`/admin`)
- Secure login page with no public branding
- Password lockout after 3 failed attempts for 1 hour
- 30-minute inactivity session timeout and logout support
- Dashboard metrics (today/week/month/year, revenue, profit, tax withheld, spendable profit)
- Product CRUD with visibility toggles and image upload
- Order feed with status + tracking updates
- Revenue breakdowns
- Taxes section with quarterly reminders + PDF generation + document storage
- IRS Tax Envelope ledger (balance, reserve target, deposits/withdrawals, transaction history)
- Website content draft/publish editor
- AI Business Mentor + AI Tax Advisor chat interfaces with links
- AI Code Editor with file view/edit, auto backup, and revert
- Automation Center with toggleable workflows, run-now execution, and event feed
- Market intelligence dashboard scaffold
- The Blueprint and Financial Freedom expandable command-center cards
- Settings for password, payment handles, business info, and API keys
- CRM view for repeat customers and top spenders
- Payment provider + SMTP + hosted URL configuration in settings

## All-in-one payment operations included

- Payment checkout session endpoint scaffold (`/api/payments/create-checkout-session`) for Stripe/PayPal style flows
- Payment webhook endpoint (`/api/webhooks/payment`) to auto-mark orders paid
- Automated email queue and receipt/status email events
- Fraud guardrails: order rate limiting and email validation
- CRM endpoint (`/api/admin/crm`) for repeat customers and top spenders
- Hosted base URL setting for production-style checkout links
- Tax envelope endpoints:
  - `GET /api/admin/tax-envelope`
  - `POST /api/admin/tax-envelope/deposit`
  - `POST /api/admin/tax-envelope/withdraw`

## Storage

All data is file-backed in `data/store.json`.
Uploaded files are in `public/uploads/`.
Code editor backups are in `backups/`.

## Production polish included

- Security headers enabled (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`)
- Admin password verification supports hashed storage (`sha256:` format)
- Secure admin cookie in production (`NODE_ENV=production`)
- Payment webhook secret verification using `x-webhook-secret` header
- Input guardrails on quantity/size for order creation
- Health endpoint: `GET /healthz`

## Docker / hosted deployment quick start

```bash
docker build -t pure-sole .
docker run -p 3000:3000 -e NODE_ENV=production pure-sole
```
