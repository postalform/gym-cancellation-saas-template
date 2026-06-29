# Repository Guidelines

This is a Stripe Projects build template for a Cloudflare Worker SaaS that uses Stripe Checkout and PostalForm mail.

## Commands

- `npm install` - install dependencies.
- `npm run setup` - pull Stripe Projects env and prepare `.dev.vars` for Wrangler.
- `npm run dev` - run the Worker locally.
- `npm run check` - syntax-check the Worker source.
- `npm run deploy:cloudflare` - sync Worker secrets and deploy to Cloudflare.

## Project Boundaries

- Do not commit `.env`, `.dev.vars`, `.projects/`, `.wrangler/`, or generated credentials.
- Do not read or print secret values from `.env`, `.dev.vars`, or `.projects/vault`.
- Keep the template stateless unless a database service is explicitly added to the registry manifest.
- PostalForm defaults to `POSTALFORM_MODE=test`; do not switch to live mail by default.

## Runtime

- Main Worker entrypoint: `src/index.js`.
- Cloudflare config: `wrangler.toml`.
- Template manifest draft: `registry/gym_cancellation_saas/cloudflare-postalform.yaml`.
