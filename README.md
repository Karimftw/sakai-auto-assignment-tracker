# Sakai → Notion Assignment Sync

Syncs upcoming Sakai assignments into a Notion database.

## What it does

- logs into Sakai using a saved Playwright session
- scans your **pinned Sakai courses**
- opens each course's **Assignments** tool
- extracts upcoming assignments only
- creates rows in your Notion database
- avoids duplicates in two ways:
  - local cache: `seen-assignments.json`
  - Notion-side lookup by **Name + Course + When**

## Current behavior

- **Assignments only** are synced
- **Tests & Quizzes** are intentionally excluded
- past-due assignments are skipped
- if the Sakai login session expires, you need to refresh it manually

## Files

- `sakai-sync.js` — main sync script
- `sakai-login.js` — one-time/manual Sakai session capture
- `run-sync.sh` — simple runner script
- `package.json` — Node package metadata
- `seen-assignments.json` — local dedupe cache (gitignored)
- `storage-state.json` — saved authenticated browser session (gitignored)
- `launchd.out.log` / `launchd.err.log` — scheduled job logs

## Requirements

- macOS
- Node.js
- Playwright / Chromium
- Notion integration token saved at:
  - `~/.config/notion/api_key`
- a Notion database shared with the integration
- a valid Sakai login session captured locally

## Notion setup

Set these values in `sakai-sync.js` for your own workspace:

- `NOTION_DATABASE_ID`
- `NOTION_DATA_SOURCE_ID`

Expected Notion properties:

- `Name` (title)
- `Course` (select)
- `When` (date)
- `Status` (status)
- `Notes` (rich text)

## Sakai setup

Set your Sakai portal URL in `sakai-sync.js`:

- `SAKAI_URL`

This project was built against a Sakai deployment that exposes course work from pinned sites in the standard **Assignments** tool.

## Install

From the project directory:

```bash
npm install
```

## First-time Sakai login capture

Run:

```bash
npm run login
```

Then:

1. complete your Sakai / SSO sign-in flow
2. complete any MFA/phone verification
3. wait until your real Sakai home with pinned classes is visible
4. go back to the terminal and press **Enter**

This saves:

- `storage-state.json`
- `.browser-profile/`

## Run manually

```bash
./run-sync.sh
```

Typical success output:

```json
{
  "pinnedCourses": ["COMP 348", "COMP 349", "ANTH 208"],
  "found": 4,
  "created": 0,
  "skipped": 4,
  "errors": []
}
```

## Scheduled daily run

This project uses macOS `launchd`.

LaunchAgent file:

- `~/Library/LaunchAgents/com.reem.sakai-sync.plist`

Current schedule:

- every **24 hours** via `StartInterval = 86400`

### Example LaunchAgent

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.reem.sakai-sync</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>/ABSOLUTE/PATH/TO/run-sync.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/ABSOLUTE/PATH/TO/PROJECT</string>

    <key>StartInterval</key>
    <integer>86400</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/ABSOLUTE/PATH/TO/launchd.out.log</string>

    <key>StandardErrorPath</key>
    <string>/ABSOLUTE/PATH/TO/launchd.err.log</string>
  </dict>
</plist>
```

### Load / reload the job

```bash
launchctl unload ~/Library/LaunchAgents/com.reem.sakai-sync.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.reem.sakai-sync.plist
```

### Check status

```bash
launchctl list | grep com.reem.sakai-sync
```

### Logs

```bash
cat /ABSOLUTE/PATH/TO/launchd.out.log
cat /ABSOLUTE/PATH/TO/launchd.err.log
```

## Useful commands

### Refresh Sakai session

```bash
npm run login
```

### Run sync now

```bash
./run-sync.sh
```

### Clear local dedupe cache

Use this only if you know what you're doing. Notion duplicate checks should still prevent most duplicate rows.

```bash
printf '{}' > seen-assignments.json
```

### Stop daily automation

```bash
launchctl unload ~/Library/LaunchAgents/com.reem.sakai-sync.plist
```

### Start daily automation again

```bash
launchctl load ~/Library/LaunchAgents/com.reem.sakai-sync.plist
```

## Duplicate protection

Duplicates are prevented by:

1. `seen-assignments.json`
2. a Notion query before create using:
   - assignment name
   - normalized course
   - due date

That means the script should skip assignments already present in Notion, even if the local cache is reset.

## Troubleshooting

### Sakai session expired

Symptoms:

- sync fails with login/authentication errors
- scheduled run stops importing

Fix:

```bash
npm run login
```

### Nothing new imported

Possible reasons:

- there are no new upcoming assignments
- the assignments are already in Notion
- Sakai session expired

Run manually and inspect the JSON summary:

```bash
./run-sync.sh
```

### Duplicate rows in Notion

This should be rare now. If it happens, check:

- whether the assignment title changed in Sakai
- whether the due date changed in Sakai
- whether a row was manually edited in Notion in a way that breaks matching

## Privacy / safety

Do **not** commit these files to Git:

- `storage-state.json`
- `.browser-profile/`
- `seen-assignments.json`
- `launchd.out.log`
- `launchd.err.log`

They may contain session state, local runtime data, or noisy logs.
