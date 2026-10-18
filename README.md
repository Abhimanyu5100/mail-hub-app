# Mail Hub

One inbox for the College, Main and Personal Google accounts, installable on a
phone, a tablet and a laptop.

## How it fits together

1. The three **exporter** scripts (one per account) write
   `YYYY-MM-DD_<label>.json` into the Mail Hub Drive folder every 15 minutes,
   and copy each new attachment (up to 10 MB) into `attachments/<label>/`
   once. Copies are moved to the trash after 14 days.
2. **`apps-script/mail_hub_api.gs`** runs in the main account as a web app. It
   hands those files to the app and keeps done / seen marks in
   `mailhub_state.json` in the same folder.
3. **This app** (GitHub Pages) shows the combined inbox, saves mail on the
   device for offline use, and sends your marks back to the script.
4. **Tasks** are one list shared with Pocket Ledger, kept in
   `mailhub_tasks.json`. Mail Hub sends task changes with each sync. Pocket
   Ledger writes `mailhub-taskops_*.json` files into the folder; the script
   merges them (on every sync and every 10 minutes) and moves them to the trash.

Claude reads the same Drive folder (the exports, `mailhub_state.json` and `mailhub_tasks.json`)
through the Google Drive connector, so it sees what you've marked done.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install and offline support |
| `fonts/` | Atkinson Hyperlegible Next (SIL OFL, see `fonts/OFL.txt`) |
| `apps-script/mail_hub_api.gs` | The web app script for the main account |
| `apps-script/mail_hub_exporter.gs` | The exporter, one copy per account (set `ACCOUNT_LABEL`) |

No mail, keys or addresses are stored in this repo. The device key lives only
in the script's properties and on each connected device.

## Updating the app

After changing any app file, bump `VERSION` in `sw.js` so installed copies pick
up the change on their next launch.

## Trying it without your mail

Open the site with `?demo` at the end of the address to see invented sample
mail. Nothing is sent or saved in that mode.
