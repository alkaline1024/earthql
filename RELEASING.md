# Release EarthQL for macOS

The release workflow publishes a draft on [GitHub Releases](https://github.com/alkaline1024/earthql/releases) for Apple Silicon Macs. Users open the published `.dmg`, drag EarthQL to **Applications**, and launch it from there. Future versions can be installed using **Help → Check for Updates… → Download Update → Restart and Install**. An existing build without the updater needs a one-time manual install of a signed release with the updater included.

## Set up signing once

Use an Apple Developer Program account to create a **Developer ID Application** certificate. Export the certificate with its private key as a password-protected `.p12`, then create an app-specific password for notarization. Add these repository secrets in **Settings → Secrets and variables → Actions**. [Apple Developer ID](https://developer.apple.com/developer-id/) · [Apple app-specific passwords](https://support.apple.com/en-us/102654)

| GitHub Actions secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 of the `.p12` on one line, for example using `base64 -i certificate.p12 \| tr -d '\n'`. |
| `MAC_CSC_KEY_PASSWORD` | Password used to export the `.p12`. |
| `APPLE_ID` | Apple account email. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization. |
| `APPLE_TEAM_ID` | Apple Developer Team ID for the signing identity. |

If Feedback is configured in distributed builds, set the repository **Actions variable** `EARTHQL_FEEDBACK_URL` to the public Apps Script `/exec` URL. This is the CI equivalent of the local `.env` entry. The release workflow uses GitHub’s job token for publishing the draft.

## Ship a new version

1. Bump the desktop workspace version, for example `npm version 0.1.1 -w @earthql/desktop --no-git-tag-version`. Commit the desktop manifest and lockfile together with the release changes.
2. Push a matching tag such as `v0.1.1`. The workflow builds and verifies Developer ID signing and notarization before it creates a draft.
3. Review the draft on GitHub and choose **Publish release**. Keep the `.dmg`, `.zip`, `latest-mac.yml`, and generated blockmaps together on the release. The DMG is for the initial installation and the ZIP and update metadata are used by the app updater. [Electron Builder Auto Update](https://www.electron.build/v26/docs/features/auto-update/)
4. Smoke test using an older signed EarthQL installed in **Applications**. Confirm the app offers the new version, restarts after approval, and shows the new version once open. Keep the bundle ID and signing identity consistent across releases.

`npm run dist:mac` builds locally without uploading assets. Only publish a build that has been signed and notarized. Use a higher version to roll forward from a faulty release.
