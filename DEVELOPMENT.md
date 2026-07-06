# Development vs Production Guide

This repo runs as **two separate Shopify apps from one codebase** so features can
be built and tested on a staging store + staging database without touching the
live app, live store, or live data.

## Overview

| | **Dev (staging)** | **Prod (live)** |
|---|---|---|
| Shopify app | b2b-partial-pay (Dev) | b2b-partial-pay |
| `client_id` | `1df03e4e7fea7a203011bc27e8575877` | `3cbdcaf4ce72d5015d404c520de51502` |
| Config file | `shopify.app.dev.toml` | `shopify.app.toml` |
| Host (Render) | `mco-b2b-partial-payment-dev.onrender.com` | `mco-b2b-partial-payment.onrender.com` |
| Render branch | `develop` | `main` |
| Database | dev Postgres (`mco-b2b-partial-payment-db-dev`) | prod Postgres |
| Store | `avon-dev.myshopify.com` | `avon-prod.myshopify.com` |

Each app has its own `client_id`, installs, API keys, OAuth, **and its own
Postgres database** — so nothing done in dev can affect prod. Sessions are stored
in Postgres (`PrismaSessionStorage`), so installing the app writes its session to
the **dev** DB; there is no access token to copy around.

> **Note on the store:** `avon-dev` is Avon's real Plus store in a *different org*,
> not an MCO Partner dev store — so `shopify app dev` (local tunnel) can't boot it.
> Dev testing runs on the **deployed** dev service. The app installs on avon-dev
> across orgs because the Dev app is set to **public distribution** (Partners →
> app → Distribution). If you want local hot-reload, use a Partner dev store
> (e.g. `mco-b2b-test`) instead — that's a separate store from avon-dev.

## Branch flow

```
GRIT-#### feature branch
      │  PR
      ▼
   develop  ──auto-deploys──▶ mco-b2b-partial-payment-dev   ──▶ avon-dev   (test here)
      │  PR once validated
      ▼
    main   ──auto-deploys──▶ mco-b2b-partial-payment (prod)  ──▶ avon-prod  (live)
```

## Two things deploy separately ⚠️

1. **App code** (routes, components, server logic) → deployed by **Render**,
   automatically on every git push to that environment's branch.
2. **App config** (access scopes, webhooks, app URLs) → deployed with
   **`shopify app deploy`** via the npm scripts below (`include_config_on_deploy`
   is on, so a deploy keeps scopes/webhooks/URLs in sync).

A code-only change just needs a git push. A change to scopes or webhooks **also**
needs a `shopify app deploy` to the matching app.

## Everyday workflow

```bash
# 1. Branch off develop
git checkout develop && git pull
git checkout -b GRIT-1234-my-feature

# 2. …make your changes…

# 3. PR into develop, merge → Render auto-deploys to avon-dev
git push origin GRIT-1234-my-feature

# 4. ONLY if you changed scopes / webhooks — keep BOTH tomls aligned, then:
npm run deploy:dev        # = shopify app config use shopify.app.dev.toml && shopify app deploy

# 5. Verify on avon-dev.

# 6. Release: PR develop → main, merge → Render auto-deploys to avon-prod.

# 7. Again, ONLY if config changed:
npm run deploy:prod       # = shopify app config use shopify.app.toml && shopify app deploy
```

**Golden rule:** changes land on `develop` → verified on `avon-dev` → promoted to
`main`/prod. The prod Render service only builds `main`, so nothing reaches
avon-prod until you merge there. Never run `shopify app deploy` with the prod
config active unless you intend to ship to the live app — the `deploy:dev` /
`deploy:prod` scripts pin the config explicitly to prevent that.

### If you change scopes or webhooks
Edit **both** `shopify.app.toml` and `shopify.app.dev.toml` identically (and, since
`SCOPES` is read from env, update the dev Render service's `SCOPES` var to match),
then `npm run deploy:dev` (and `deploy:prod` on release), and re-auth the app so the
new scopes take effect.

### Database migrations
Migrations live in `prisma/migrations`. The dev service runs `prisma migrate deploy`
at startup (via `docker-start`), so pushing a migration to `develop` applies it to
the **dev** DB on deploy. On release to `main`, the prod service applies it to prod.
Never point dev at the prod `DATABASE_URL`.

## One-time setup (already-done items ✓)

- [x] Create the `b2b-partial-pay (Dev)` app in Partners (`shopify app config link --config dev`)
- [x] `shopify.app.dev.toml`, `render-dev.yaml`, deploy scripts, this doc
- [ ] Merge `dev-setup` → `develop`
- [ ] **Create the Render dev service + dev Postgres** from `render-dev.yaml`
      (Render → New → Blueprint). Match prod's plan/region.
- [ ] Set **`SHOPIFY_API_SECRET`** (Dev app secret) in the dev service env.
      (`SHOPIFY_API_KEY`, `SHOPIFY_APP_URL`, `SCOPES`, `DATABASE_URL` come from the blueprint.)
- [ ] Confirm the Dev app is **public distribution** (Partners → app → Distribution).
- [ ] `npm run deploy:dev` — push scopes/webhooks/URLs to the Dev app.
- [ ] Install on avon-dev:
      `https://mco-b2b-partial-payment-dev.onrender.com/api/auth?shop=avon-dev.myshopify.com`
      → OAuth writes the session to the dev DB.
- [ ] Verify the app in the avon-dev admin.

## Env vars (dev Render service)

| Key | Value | Source |
|---|---|---|
| `SHOPIFY_API_KEY` | `1df03e4e7fea7a203011bc27e8575877` (dev client_id) | blueprint |
| `SHOPIFY_API_SECRET` | dev app secret | **you (secret)** |
| `SHOPIFY_APP_URL` | `https://mco-b2b-partial-payment-dev.onrender.com` | blueprint |
| `SCOPES` | same list as prod (see `shopify.app.dev.toml`) | blueprint |
| `DATABASE_URL` | dev Postgres connection string | blueprint (fromDatabase) |
| `NODE_ENV` / `NODE_VERSION` | `production` / `20` | blueprint |

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Cannot find module '.../build/server/index.js'` | Build Command isn't running `npm run build` — set it to the blueprint's `buildCommand`. |
| `redirect_uri is not whitelisted` on install | App config URLs not pushed — run `npm run deploy:dev`. |
| `This app can't be installed yet … distribution` | Set the Dev app's Distribution to **public** in Partners. |
| Prisma `self-signed certificate` on boot | Add `PGSSLMODE=no-verify` (Render Postgres cert is self-signed). |
| Deploy builds a stale commit | Render service is tracking the wrong branch — set it to `develop`. |
