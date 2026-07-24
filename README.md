# 💊 Pharma Contact Extractor

A small web app that signs in to a Gmail account (**read-only**), scans the whole
mailbox — inbox, sent, archive, and optionally spam/trash — for pharma-related
conversations, and builds a contact list:

| Column | Meaning |
|---|---|
| Email | The contact's address |
| Name | Best display name seen on any email |
| Company (domain) | Their email domain (blank for Gmail/Yahoo/etc.) |
| Direction | `Sent to` / `Received from` / `Both` / `On shared thread` |
| First / Last seen | Date range of correspondence |
| Messages | How many emails they appeared on |
| Last subject | Subject of the most recent email |

Everything is shown live in the browser and downloadable as a **CSV** (opens in
Excel / Google Sheets). Nothing is stored server-side after you disconnect.

> There is also a Google Apps Script version (runs inside a Google Sheet with
> automatic background batching) in [`apps-script/`](apps-script/PharmaContactExtractor.gs).

---

## Setup overview

You need two free accounts: **Google Cloud** (for the "Sign in with Google"
credentials) and **Render** (for hosting). About 15 minutes total.

### 1. Create the Google OAuth credentials

1. Go to <https://console.cloud.google.com/> and create a new project
   (e.g. `pharma-extractor`).
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - Fill in the app name and your email; skip optional fields.
   - Scopes: you can skip this page (the app requests scopes at sign-in).
   - **Test users: add the Gmail address you want to scan.** While the app is
     in "Testing" mode only these addresses can sign in — perfect for
     personal/company use, and you avoid Google's app-verification process.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs — add BOTH (you'll know the Render URL after step 2;
     come back and add it):
     - `http://localhost:3000/oauth2callback`
     - `https://YOUR-SERVICE.onrender.com/oauth2callback`
   - Save the **Client ID** and **Client secret**.

### 2. Deploy on Render

1. Push this repository to your GitHub account (or fork it).
2. On <https://dashboard.render.com> → **New → Blueprint** → connect the repo.
   Render reads [`render.yaml`](render.yaml) and creates the web service.
3. When prompted for environment variables, set:
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from step 1
   - `APP_URL` — your service URL, e.g. `https://pharma-contact-extractor.onrender.com`
     (no trailing slash; shown on the service page)
4. Go back to the Google Cloud **Credentials** page and make sure the redirect
   URI `https://YOUR-SERVICE.onrender.com/oauth2callback` is listed.
5. Open the app URL → **Connect Gmail** → approve → **Start scan**.

### 3. Run locally (optional)

```bash
npm install
cp .env.example .env   # fill in your Google credentials
npm start              # open http://localhost:3000
```

---

## Things worth knowing

- **Read-only**: the app requests only `gmail.readonly` — it can never send,
  modify or delete mail.
- **Testing-mode sign-in**: Google shows an "unverified app" warning and limits
  sign-in to the test users you added. Sign-ins expire after ~7 days in testing
  mode — just click Connect Gmail again.
- **Keep the tab open during a scan.** The scan runs on the server, but Render's
  free tier puts the server to sleep when no one is connected, and results live
  in memory. Scan → wait for "Finished" → **Download CSV**. A large mailbox
  (50k+ matching emails) takes on the order of 30–60 minutes.
- **Free-tier cold start**: the first page load after idle time takes ~30–60s
  while Render wakes the service. That's normal.
- **Use exports responsibly**: bulk cold-emailing harvested addresses can
  violate anti-spam / privacy laws (GDPR, CAN-SPAM, etc.). Fine for CRM and
  reference use.

## Project layout

```
server.js            Express backend: OAuth flow + Gmail API scanner + CSV export
public/index.html    The whole UI (single page)
render.yaml          One-click Render deployment blueprint
apps-script/         Alternative version that runs inside a Google Sheet
```
