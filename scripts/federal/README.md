# Federal complaint feed

This feed uses CourtListener's public REST v4 search endpoint with `type=r` and the bounded query:

```text
description:(Class Action Complaint) AND dateFiled:[START TO END]
```

It is a discovery feed for federal dockets whose indexed filing descriptions identify a class-action complaint. Every record is deliberately labeled `potential_class_case`, `putative`, and `no_current_action`. The only permitted CTA is `View CourtListener docket`; the feed never treats a complaint as a claim form or invitation to join.

Initial backfill (three years by default):

```sh
npm run federal:refresh -- --mode full --max-requests 450
```

The full mode persists a cursor in `data/federal-cases.json`. If a bounded run stops with `coverage.backfill.status` set to `in_progress`, run the same command again without `--restart` to resume. Use `--restart` only to deliberately begin the date window from page one while retaining stable records.

Daily incremental refresh:

```sh
npm run federal:refresh
```

Incremental mode searches the most recent seven days by default and merges by `docket_id`. Absence from an incremental response never deactivates an older record. A returned termination date is retained and is never cleared by a later null value.

The scheduled deployment runs the incremental query first, then advances an unfinished full-backfill cursor with a separate bounded request budget. Once the backfill state is complete, scheduled runs stop restarting it.

The source cache lives in `scripts/federal/.cache/` and expires after ten minutes. Network requests default to 13 seconds apart with bounded retry/backoff. Free Law Project recommends authenticated API access for deployed programmatic use; this implementation follows the requested unauthenticated public-access mode and reports throttling as degraded coverage without deleting prior records.

Coverage is inherently incomplete. CourtListener documents the RECAP archive's sources and gaps at <https://www.courtlistener.com/help/coverage/recap/> and the search API at <https://wiki.free.law/c/courtlistener/help/api/rest/v4/search>.
