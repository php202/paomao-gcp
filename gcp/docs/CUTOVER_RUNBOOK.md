# Staged Cutover Runbook

This runbook documents the operational steps to cut traffic from GAS Web Apps/triggers to the GCP Cloud Run service + jobs, with rollback.

## Preconditions

- Cloud Run service deployed with endpoints:
  - `POST /line-webhook` (staff bot)
  - `POST /store-line-webhook` (store bots)
  - `POST /paopao-line-webhook` (PAOPAO bot)
  - `GET/POST /core`
  - `GET/POST /stores`
  - `GET/POST /admin`
- Cloud Run Jobs + Cloud Scheduler configured via `gcp/setup-jobs-and-scheduler.sh`
- Env vars set on Cloud Run service:
  - `PAO_CAT_SECRET_KEY` (or `ADMIN_KEY`)
  - `LINE_*` secrets/tokens
  - `LINE_STORE_SS_ID`, `LINE_STAFF_SS_ID`, and `INTEGRATED_SHEET_SS_ID` (if different)
  - Legacy fallbacks (during migration): `LEGACY_GAS_CORE_API_URL`, `LEGACY_GAS_STORES_API_URL`
- For the initial cutover window: set `FORWARD_UNKNOWN_TO_GAS=1`

## Stage 0: Smoke Test (no traffic change)

- `GET /health`
- `GET /core?action=getLineSayDouInfoMap&key=...`
- `GET /stores?action=getSlots&botId=...`

## Stage 1: Chrome Extension + Embedded Pages

1. Update clients to use the Cloud Run base URL:
   - Old: GAS `.../exec?action=...`
   - New: Cloud Run `.../stores?action=...`
2. Verify:
   - `getList` loads messages
   - `replyMessage` works (replyToken present)
   - `getSlots` works
3. Rollback:
   - Revert client base URL to GAS web app.

## Stage 2: Store LINE Webhook

1. LINE Developers console:
   - Change the store channel webhook URL to Cloud Run `.../store-line-webhook`
2. Verify:
   - Incoming messages append rows to `'訊息一覽'`
   - Chrome extension `getList` shows new messages
3. Rollback:
   - Repoint webhook URL back to GAS store webhook.

## Stage 3: PAOPAO LINE Webhook

1. LINE Developers console:
   - Change the PAOPAO channel webhook URL to Cloud Run `.../paopao-line-webhook`
2. Verify:
   - Messages append rows to `PAOPAO_STORE_SS_ID` `'訊息一覽'`
3. Rollback:
   - Repoint webhook URL back to GAS PAOPAO webhook.

## Stage 4: Staff Channel Finalization

1. Keep `FORWARD_UNKNOWN_TO_GAS=1` until all staff commands are confirmed working.
2. When ready:
   - Set `FORWARD_UNKNOWN_TO_GAS=0`
3. Rollback:
   - Set `FORWARD_UNKNOWN_TO_GAS=1` (temporary)
   - Or repoint staff webhook URL back to GAS.

## Stage 5: Disable GAS Triggers

After Scheduler jobs run stably for a few days:
- Disable/uninstall the old GAS triggers in `各店訊息一覽表`.

