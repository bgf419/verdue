# Verdue

Verdue is a standalone public website for discovering verified class-action claim windows, separating those opportunities from government redress programs and proposed federal cases, and keeping a provenance-labeled personal claim history.

Public site: <https://bgf419.github.io/verdue/>

## What the catalog means

The catalog does **not** claim to contain every U.S. class action. No single source covers all federal and state courts. Every record identifies its source authority and participation mode:

- `settlement_claims_open`: a settlement administrator site was individually reviewed and currently publishes a claim destination.
- `government_redress`: a first-party agency page lists an ongoing redress or payment program; no public action is implied unless the agency explicitly states one.
- `potential_class_case`: federal docket metadata showing a putative class complaint; tracking only, with no apply CTA.

The production catalog does not reproduce a third-party publisher's listings. Its scheduled feeds are first-party agency pages and public federal docket metadata; the smaller claim-window set is manually checked against official settlement websites.

## Local development

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run government:refresh
npm run build:public
npm run test:all
```

Run the public build locally:

```bash
npx vite preview --config vite.public.config.ts --host 127.0.0.1 --port 4173
```

Then open <http://127.0.0.1:4173/verdue/>.

## Data pipeline

- `scripts/federal/` maintains the CourtListener federal putative-case feed.
- `scripts/government/` monitors first-party FTC, CFPB, and SEC redress pages and retains last-good data when a source blocks or fails.
- `scripts/duration/` builds Federal Judicial Center duration cohorts using right-censored survival analysis.
- `scripts/prepare-public-data.mjs` emits a compact, lazy-loaded federal index so the provenance-rich raw feed does not inflate the initial browser bundle.
- `.github/workflows/refresh-and-deploy.yml` refreshes, validates, and deploys the catalog daily. `.github/workflows/refresh-duration.yml` follows the quarterly FJC source cadence.

Failed source checks retain the last known records as stale rather than falsely removing them. Title similarity never automatically merges two legal matters.

## Personal data

The public catalog is anonymous. A dedicated Supabase project stores authenticated profiles, bookmarks, claim history, claim events, and outcomes. The schema under `supabase/migrations/` enables row-level security so every private row is restricted to its owner. Visitors sign in with a user-chosen Account ID and password; the public GitHub Pages build keeps the session in memory only, so users sign in again after a reload or new visit and no auth token is shared through origin-wide browser storage.

Deployments enable signed-in sync with these build variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

The anon key is intentionally public; row-level security is the authorization boundary. Do not expose a service-role key to the browser.

## Legal boundary

Verdue is not a law firm. A possible match is not an eligibility decision. Courts, agencies, settlement administrators, and counsel control legal status, claim validity, and payment.
