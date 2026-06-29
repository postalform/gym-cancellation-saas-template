# Gym Cancellation SaaS Template

A Stripe Projects build template for a small SaaS that charges for a gym cancellation letter, verifies the hosted Stripe Checkout success page, generates a PDF cancellation letter, and submits it through PostalForm.

## Stack

- Cloudflare Workers for the public app and API routes
- Stripe Checkout for one-time payment
- PostalForm Projects for PDF upload, quoting, and mail submission
- No database required: the template stores the cancellation payload in Checkout Session metadata and fulfills only after Checkout reports `payment_status=paid`

## Stripe Projects services

This template is intended for `stripe projects build` with:

```text
cloudflare/workers
postalform/mail
```

The build template registry entry should point at this repo and pin a commit hash. After the CLI provisions services, run the setup command below to pull credentials into local development files.

## Local development

```bash
npm install
npm run setup
npm run dev
```

`npm run setup` runs `stripe projects env --pull` when project state is available and writes `.dev.vars` for Wrangler local development. If `STRIPE_SECRET_KEY` is not provided by Projects, the setup script tries to use the active Stripe CLI test secret key. It never prints secret values.

Open the local Wrangler URL, fill out the cancellation form, and use a Stripe test card in Checkout.

## Required environment

Wrangler local development reads `.dev.vars`. Cloudflare deployment uses Worker secrets.

Required:

```text
STRIPE_SECRET_KEY
POSTALFORM_TEST_API_KEY
```

Optional:

```text
POSTALFORM_LIVE_API_KEY
POSTALFORM_API_KEY
POSTALFORM_API_BASE
POSTALFORM_MODE
CHECKOUT_AMOUNT_CENTS
CHECKOUT_CURRENCY
CHECKOUT_DISPLAY_NAME
STRIPE_API_VERSION
```

For template safety, `POSTALFORM_MODE` defaults to `test`, so PostalForm uses mock provider mail and does not send real physical mail. Switch to `POSTALFORM_MODE=live` only after PostalForm is provisioned on a live billing tier and the app is ready to send mail.

## Deploy

After `stripe projects build` provisions Cloudflare Workers and PostalForm:

```bash
npm run setup
npm run deploy:cloudflare
```

`npm run deploy:cloudflare` expects these values from the Cloudflare Projects resource:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_WORKER_NAME
```

The deploy script syncs non-Cloudflare env values as Worker secrets, updates `wrangler.toml` to the provisioned Worker name when available, and runs `wrangler deploy`.

## Routes

- `GET /` - cancellation form
- `POST /api/checkout` - creates a hosted Stripe Checkout Session
- `GET /success?session_id=...` - verifies Checkout and sends the letter through PostalForm
- `GET /cancel` - Checkout cancellation page

## Manual Projects fallback

If you are not using `stripe projects build` yet, provision the services manually:

```bash
stripe projects init gym-cancellation-saas
stripe projects add cloudflare/workers --accept-tos --yes
stripe projects add postalform/mail --accept-tos --confirm-paid-service --yes --config '{"workspace_name":"Gym Cancellation SaaS"}'
stripe projects env --pull
npm run setup
```

## Template registry

Publish this repository publicly and submit a manifest to `stripe/projects-template-registry` that pins the exact commit to copy. The manifest should declare `cloudflare/workers` and `postalform/mail` so `stripe projects build` provisions both resources before showing the next steps above.
