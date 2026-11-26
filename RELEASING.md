# Release EarthQL for macOS

EarthQL team releases support Apple Silicon. The build uses macOS ad-hoc signing. The update manifests are signed with a separate EarthQL Ed25519 key. The public key is embedded in each release, and only the release workflow needs the private key. Apple Developer Program membership and notarization credentials are unnecessary for this workflow.

## Set up the release key once

With GitHub CLI signed in to an account that can manage this repository’s Actions secrets and variables, run this from the repo root. It generates the key pair in memory and uploads each key directly to the matching GitHub setting.

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const args = ['--repo', 'alkaline1024/earthql'];
execFileSync('gh', ['secret', 'set', 'EARTHQL_UPDATE_PRIVATE_KEY', ...args], {
  input: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') + '\n',
});
execFileSync('gh', ['variable', 'set', 'EARTHQL_UPDATE_PUBLIC_KEY', ...args], {
  input: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') + '\n',
});
NODE
```

Run this only for initial setup. Installed versions trust the embedded public key. If the key changes, the team must manually install a new build with the replacement key. Leave the existing repository Actions variable `EARTHQL_FEEDBACK_URL` configured if you want feedback submission in distributed builds.

## Ship a version

1. Run `npm run version:desktop` and choose the next stable desktop version. Choose **No** to review and commit the manifest and lockfile with your release changes, then create the matching tag. Choose **Yes** from a clean working tree to commit the version bump and create the tag locally.
2. Push the matching tag, such as `v0.1.1`. The workflow builds the app, verifies ad-hoc signing, signs the update manifest, and creates a draft.
3. Review and publish the draft on [GitHub Releases](https://github.com/alkaline1024/earthql/releases). Keep the DMG, ZIP and `earthql-update.json` together. The updater reads public release assets, so team members need no GitHub token. Roll forward with a higher version if a published build needs a fix.

## Install and update

Download the DMG, drag EarthQL to **Applications**, and launch from there. If macOS blocks the first launch, go to **System Settings → Privacy & Security → Open Anyway** after trying to open the app, if permitted by your organization. Approval can be needed again on a new build, depending on macOS and device policy. [Apple’s instructions](https://support.apple.com/en-us/102445)

Existing users need to install the first release that contains the new updater once. The app silently checks for updates at launch and every 30 minutes, showing an **Update** button when one is available. Alternatively, use **Help → Check for Updates…**. Choose **Download Update** to see download progress, then **Restart and Install**. The updater checks the signed manifest, verifies the ZIP against its signed size and SHA-256, and validates the app’s macOS signature, bundle identifier and version before quitting. It needs a writable Applications folder. If the system Applications folder is read-only for your account, install into `~/Applications`.

`npm run dist:mac` builds locally without publishing. Local builds enable the update menu only when built with `EARTHQL_UPDATE_PUBLIC_KEY` in the shell environment or an ignored root `.env`.
