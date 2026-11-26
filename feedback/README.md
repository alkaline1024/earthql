# Set up EarthQL Feedback

EarthQL sends reports to a Google Apps Script web app you control. The script adds one row to a `Feedback` tab and saves an optional JPEG in a private Drive folder. A distributed build uses a built-in inbox. Builds without an inbox can be configured locally with a submission key.

## Set up Google Sheets and Drive

1. Create a Google Sheet for the inbox and a dedicated **restricted** folder in Google Drive for screenshots. Give inbox reviewers access to the Sheet and the folder separately. Copy the URL of the Sheet and the URL from inside the Drive folder.
2. Open the Sheet and choose **Extensions → Apps Script**. Replace the editor contents with [Code.gs](google-apps-script/Code.gs). Under **Services → +**, add **Google Sheets API** with identifier `Sheets`. If the script uses a standard Google Cloud project, also enable the Google Sheets API in that project. [Google advanced services](https://developers.google.com/apps-script/guides/services/advanced)
3. In Apps Script, open **Project Settings → Script properties** and add the properties for your mode.

   | Property | Value |
   | --- | --- |
   | `FEEDBACK_SHEET_ID` | Your Google Sheet URL (`https://docs.google.com/spreadsheets/d/SHEET_ID/edit`) or just `SHEET_ID`. |
   | `FEEDBACK_FOLDER_ID` | Your restricted Drive folder URL (`https://drive.google.com/drive/folders/FOLDER_ID`) or just `FOLDER_ID`. |
   | `FEEDBACK_PUBLIC_SUBMISSIONS` | `true` for a distributed app where people can send feedback without setup. Omit for a private inbox. |
   | `FEEDBACK_KEY` | Optional in public mode. Required in private mode. Generate a 64-character submission key with `openssl rand -hex 32` and keep it private. |

4. In the Apps Script editor, select **`setupFeedback`** and click **Run**. Authorize the script with the Google account that owns or can write the inbox and folder. Check that the `Feedback` tab now has its headers.
5. Choose **Deploy → New deployment → Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then deploy and copy the **Web app URL** ending in `/exec`. This lets the desktop app reach the endpoint without a Google sign-in. The Sheet and Drive folder stay restricted. If your Workspace policy does not allow **Anyone**, this deployment needs an approved endpoint or a Google sign-in flow. [Apps Script web apps](https://developers.google.com/apps-script/guides/web)

## Build EarthQL for distribution

Set `FEEDBACK_PUBLIC_SUBMISSIONS=true` on the deployment you want to use. In the repository root, add this line to `.env`, substituting your deployed URL.

```dotenv
EARTHQL_FEEDBACK_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
```

Run `npm run dist:mac`. The build embeds only that URL in the main process. On a clean install, **Help → Send Feedback…** opens the report form directly. The `.env` file is ignored by Git and stays on the build machine. Treat the embedded URL as public. Keep Sheet and Drive IDs in Script properties, and keep private submission keys out of distributed builds.

The public endpoint only accepts report submissions. It applies existing text and image size limits and allows up to 10 new write attempts per UTC minute and 100 per UTC day across all anonymous senders. People who obtain the URL can still submit directly and exhaust those limits. Set `FEEDBACK_PUBLIC_SUBMISSIONS` to `false` to disable anonymous submission. For a wider rollout that requires per-user controls or stronger spam protection, use an authenticated gateway.

To change the embedded URL, rebuild and redistribute. To update `Code.gs` while keeping the URL, edit the existing Apps Script deployment to point to a new script version.

## Connect a private inbox manually

1. Build or run the updated app. Open **Help → Send Feedback… → Feedback Settings** and enter your `/exec` URL and submission key. Choose **Save Settings**. The URL goes into EarthQL's local settings and the key goes into macOS Keychain.
2. Send a short test report without an attachment. You should receive an `ID`, and the Sheet should contain a matching row with status `New`.
3. Send another test with **Attach screenshot** selected. The `Screenshot` column should link to a JPEG in the restricted folder. Review the preview and use **Crop**, **Black out area**, or **Remove screenshot** before submitting real data.

To rotate a key, generate a new one, change `FEEDBACK_KEY` in Script properties, and save the new key in Feedback Settings on each authorized Mac. When changing `Code.gs`, update the existing deployment to a new script version so the `/exec` URL can stay the same.

## API contract

The `/exec` endpoint accepts an HTTPS `POST` with `Content-Type: application/json`. The private mode carries the submission key in the body. For public submissions from a distributed build, omit `key`. Keep any private key out of URLs and shared request examples. Google returns the JSON via a one-time redirect, which EarthQL follows with a separate GET. [Apps Script Content Service](https://developers.google.com/apps-script/guides/content#redirects)

```json
{
  "key": "<your submission key>",
  "report": {
    "id": "de305d54-75b4-431b-adb2-eb6b9e546014",
    "kind": "bug",
    "title": "CSV dialog stays open",
    "description": "The export finishes, but the dialog is still open.",
    "appVersion": "0.1.0",
    "osVersion": "15.0.0"
  }
}
```

`kind` is `bug` or `suggestion`. Title and description are required and limited to 120 and 4,000 characters. Optional `report.screenshot` is raw base64 JPEG data up to 1,500,000 bytes decoded. The row also contains a UTC timestamp and a `New` status. Sheets stores the supplied text literally, including strings that start with `=`.

Success returns `{"ok":true,"id":"…"}`. Reusing a successfully stored `id` returns the same receipt. Failures return `{"ok":false,"code":"…"}` with `INVALID`, `UNAUTHORIZED`, `SETUP`, `BUSY`, `RATE_LIMIT`, or `STORAGE`. Inspect the JSON envelope because Apps Script can return it with HTTP 200. EarthQL keeps the report open on failure so the user can retry with the same ID.

`npm test` includes a local HTTP simulation of the Apps Script receiver with Sheets and Drive stand-ins. Use the two test reports above to verify your own Google deployment.

## App activity

Replace the deployed Apps Script project's `Code.gs` with [the current script](google-apps-script/Code.gs). Save it and set `ACTIVITY_ENABLED` to `true` in **Project Settings → Script properties**. Run `setupActivity` in the editor and open the spreadsheet URL printed in the execution log. **Activity Log** is a tab inside that spreadsheet. If the tab is missing, the deployed receiver also creates it on the first valid activity event.

Update the existing web app deployment to a new version so its `/exec` URL stays the same. The release uses the existing `EARTHQL_FEEDBACK_URL` build variable. If the editor does not list `setupActivity`, check that the updated `Code.gs` has been saved in the deployment's project.

Activity sharing is on by default in installed builds with the feedback endpoint configured. Users can turn it off under **Settings → General → Privacy → Share app activity**. EarthQL sends an `open` event at launch, then a `heartbeat` every hour it remains open. Enabling sharing while the app is open starts a new session immediately. The sheet stores the server's receipt time, event type, a random per-session ID, app version, and a random installation ID kept in the local app profile. Use Installation ID to group activity across launches. The macOS Version and Model columns show the system version and Mac model identifier (such as `Mac14,3`). The Username column contains the computer account username by default. In **Settings → General → Privacy**, turn on **Randomize username** to send a stable label derived from the random installation ID in future events. Turning on randomization leaves earlier rows as recorded. After updating the receiver, older clients can still submit activity and leave fields they do not send blank. Heartbeats indicate the app is open, including when idle. Requests are best-effort and are dropped when offline. The public endpoint applies separate activity rate limits.

To preview the setting with `npm run dev`, set `EARTHQL_DEV_ACTIVITY_PREVIEW=true` in the repository root `.env` and restart the dev app. The preview sends no activity and keeps toggle changes in memory.

To send real activity from `npm run dev`, set `EARTHQL_DEV_ACTIVITY_SEND=true` and `EARTHQL_FEEDBACK_URL` in the root `.env` and restart. The receiver must have `ACTIVITY_ENABLED=true`. Dev toggle changes last until the app restarts.

The dev terminal prints whether the receiver acknowledged each event. An `INVALID` response to a normal activity event can indicate that the `/exec` URL still runs the old Feedback-only code. Saving `Code.gs` and running `setupActivity` in the editor uses the latest editor code. In **Deploy → Manage deployments**, edit the deployment used by `EARTHQL_FEEDBACK_URL`, choose **New version**, then click **Deploy** to publish the updated receiver to that URL.
