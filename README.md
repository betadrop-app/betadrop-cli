<img src="https://betadrop.app/images/logo/BetaDropLogo.png" width="56" alt="BetaDrop" />

# @betadrop/cli

<!-- Absolute URLs only. npm renders this file on its own domain, so a relative
     src or href (the License badge used to point at `LICENSE`) resolves against
     npmjs.com and 404s — and the tarball ships only dist/, package.json and this
     README, so there is no LICENSE file to reach even when a repository is set.
     The retired CI badge pointed at a private ImmersiveMobileDesigns repo and
     rendered as a red "repo or workflow not found" error at the top of the page;
     do not reintroduce a badge for a workflow the public cannot see. -->

[![npm version](https://img.shields.io/npm/v/@betadrop/cli?color=0b64fc&label=npm)](https://www.npmjs.com/package/@betadrop/cli)
[![Node](https://img.shields.io/node/v/@betadrop/cli?color=0b64fc)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/@betadrop/cli?color=0b64fc)](https://opensource.org/licenses/MIT)

**Ship a build to a tester in one command.** `betadrop publish app.ipa` uploads an iOS `.ipa` or
Android `.apk` to [BetaDrop](https://betadrop.app) and prints an over-the-air install link plus a
scannable QR code — no TestFlight review wait, no Play track, no tester accounts. Your tester opens
the link on their phone and installs from the browser.

```bash
npm install -g @betadrop/cli
betadrop login
betadrop publish ./build/MyApp.ipa
```

```
Uploading MyApp.ipa…
  ████████████████████ 100% · 24.3/24.3 MB

✓ Published to BetaDrop

  MyApp  v1.2.0 (ios)
  Install link  https://betadrop.app/install/?i=abc123

  Scan with your phone:
  [compact QR code printed here]
```

Hand over the link, or hold up the QR code. That is the whole loop.

## When this is the right tool

| Instead of | What changes |
| --- | --- |
| **TestFlight external testing** | No Beta App Review between your build and a tester's phone, and no TestFlight app or invite to accept. Ad-hoc signing rules still apply — see [Troubleshooting](#troubleshooting). |
| **Play internal testing** | No Play Console upload, no track, no tester list to keep in sync — you hand out a URL. |
| **Diawi / similar OTA services** | Same idea, scriptable: one command, a QR code in your terminal, and a standing link that never changes. |
| **Firebase App Distribution** | No Firebase project, no tester SDK, no invite acceptance — the link works in a plain mobile browser. |

Both platforms, one command, one account.

---

## Quick Start

Get up and running in under 2 minutes.

### Option A — Browser login (recommended)

```bash
betadrop login
# → Choose "Continue with Google" or "Continue with Email"
# → A browser tab opens — approve the request
# → A QR code is printed so you can open the approval page on your phone instead
```

### Option B — API token

```bash
# 1. Create a token: betadrop.app → Settings → Developer → API tokens → Create token
# 2. Log in with the token
betadrop login --token bd_live_xxxxxxxxxxxxxxxxxxxx

# 3. Publish — the install link and QR code print instantly
betadrop publish ./build/MyApp.ipa
```

> The install link and a scannable QR code are printed in the terminal after every
> successful `betadrop publish`. QR codes are suppressed in `--ci` and `--json` modes.


## Commands

| Command | Description |
|---------|-------------|
| `betadrop login` | Authenticate interactively (browser or API token). Already logged in? You'll be asked what to do. |
| `betadrop login --token bd_live_…` | Non-interactive token login. |
| `betadrop whoami` | Show the authenticated user, active token name, expiry, and last-used date. `--json` for machine output. |
| `betadrop logout` | Revoke the stored token server-side and remove local credentials. No-op when `BETADROP_TOKEN` is set — see [Configuration](#configuration). |
| `betadrop publish <file>` | Upload an `.ipa` or `.apk` and print its install link + QR code. |

> **Tip:** You can use `bd` and `betadrop` interchangeably for all commands (e.g. `betadrop login`, `betadrop publish`).

### `betadrop publish` options

| Flag | Description |
|------|-------------|
| `--name <name>` | Override the build name. |
| `--notes <notes>` | Release notes for this build. |
| `--standing-link <slug>` | Point a [standing link](https://betadrop.app/standing-links/) at this build the moment it is live, so that one URL — and any "Download from BetaDrop" button embedded with it — serves the new build with nothing to click. Pro and Studio plans; the name must already be claimed on your account. A name that cannot be used fails the command **before** anything is uploaded. |
| `--channel <slug>` | Deprecated alias for `--standing-link`, accepted permanently and hidden from `--help`. If both are given, `--standing-link` wins. |
| `--ci` | Non-interactive: no spinner/progress/QR code; the install URL is the **last line of stdout**. With a standing link, the line above it is `channel-url=<url>` — that key is unchanged, because released GitHub Action versions parse it. |
| `--json` | Output `{ id, short_id, install_url }` as JSON (no QR code). With a standing link, adds `channel: { id, slug, label, url }` — the key keeps its old name so existing parsers keep working. |

> If the build uploads but the standing link could not be moved (it was released mid-publish,
> say), the install URL is still printed, a `warning:` goes to stderr, and the command exits
> non-zero — a pipeline that asked for one must not go green when it did not move.

### One link that never changes

Every publish mints a new install link, which means re-sending it to everyone. A **standing link**
is a fixed URL you re-point at each new build:

```bash
betadrop publish ./build/MyApp.ipa --standing-link acmebeta
```

Send it once. Every later publish swaps what it installs, and nobody has to be told again.
Standing links are a Pro and Studio feature — claim the name in the dashboard first.

### Put a download button on your README

Every build's install link can be wrapped in a "Download from BetaDrop" button — one
Markdown image link, no script:

```markdown
[![Download MyApp from BetaDrop](https://betadrop.app/badge/download-dark.svg)](https://betadrop.app/install/acmebeta?ref=badge)
```

Copy it from the embed panel under the install link (post-upload screen or the build's
Share tab). Point it at a standing link and `betadrop publish --standing-link acmebeta`
keeps the button current on every publish. Details: <https://betadrop.app/download-button/>.

### Already logged in?

Running `betadrop login` when a session exists shows a prompt:

```
You are already logged in as alex@example.com.
? What would you like to do?
❯ Continue as alex@example.com
  Sign in with a different account
  Log out and sign in again
```

Choosing **"Sign in with a different account"** starts a fresh login flow and replaces the session.  
Choosing **"Log out and sign in again"** revokes the current token first, then logs in fresh.

---

## Configuration

Set these environment variables to override the defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `BETADROP_TOKEN` | _(none)_ | API token to authenticate with. Wins over the stored credentials file — use it in CI. |
| `BETADROP_API_URL` | `https://api.betadrop.app` | API server URL (for self-hosted). |
| `BETADROP_APP_URL` | `https://betadrop.app` | Frontend host used to build install links. |

### CI usage (no login required)

```bash
BETADROP_TOKEN=bd_live_xxxxxxxxxxxxxxxxxxxx betadrop publish ./build/MyApp.ipa --ci
```

To keep one link current across every CI publish, claim a standing link once in the dashboard and
pass it each time:

```bash
BETADROP_TOKEN=bd_live_xxxxxxxxxxxxxxxxxxxx betadrop publish ./build/MyApp.ipa --ci --standing-link acmebeta
# stdout:
#   channel-url=https://betadrop.app/install/?i=acmebeta
#   https://betadrop.app/install/?i=Ab3xYz
```

> With `BETADROP_TOKEN` set, `betadrop login` does nothing but print a notice, and
> `betadrop logout` cannot revoke the token server-side — it only tells you to revoke it
> in the dashboard. Rotate CI tokens at
> betadrop.app → Settings → Developer → API tokens.

On GitHub Actions, skip the install step entirely and use
[`betadrop-app/upload-action`](https://github.com/betadrop-app/upload-action) — it wraps this
same CLI and puts the link on the run summary and the pull request.

---

## Troubleshooting

**`betadrop: command not found`** (or **`bd: command not found`**)  
Run `npm install -g @betadrop/cli` and make sure your npm global bin directory is in `PATH`
(`npm prefix -g` shows the path — the bin directory is `<prefix>/bin`, or the prefix itself on Windows).

**`Your token is invalid, expired, or was revoked`**  
Run `betadrop login` to authenticate again. If you are in CI, rotate the secret and update `BETADROP_TOKEN`.

**`Could not reach BetaDrop`**  
Check your internet connection. If `BETADROP_API_URL` is set, verify it points at a running server.

**`Upload stalled — no data for 60s`**  
Your connection dropped mid-upload. The CLI will retry automatically on server errors. Check your network and run again.

**QR code looks garbled**  
Use a modern terminal that renders Unicode block characters: iTerm2, Windows Terminal, Alacritty, or Ghostty. If your terminal can't render them, use the printed URL directly — they carry the same link.

**The iOS build downloads on the phone but will not open**  
An ad-hoc `.ipa` only installs on devices that were in the provisioning profile when it was
signed — publishing it does not change that. Send the tester the
[UDID checker](https://betadrop.app/udid-checker/), which reads the UDID off the iPhone itself
(no Mac, no cable), then add the device in the Apple Developer portal and re-sign.

---

## Also from BetaDrop

The same publish step, on the other two surfaces — one account, one set of API tokens:

| | |
|---|---|
| **[`betadrop-app/upload-action`](https://github.com/betadrop-app/upload-action)** | Publish from a GitHub Actions workflow. The install link lands on the run summary and, optionally, in a pull-request comment that updates itself on every push. |
| **[`@betadrop/mcp`](https://www.npmjs.com/package/@betadrop/mcp)**<br><sub>[source](https://github.com/betadrop-app/betadrop-mcp)</sub> | MCP server — publish builds, list history and manage tokens by asking Claude, Cursor or Copilot, without leaving the editor. |

---

## Requirements

- **Node.js 18+**
- A [BetaDrop](https://betadrop.app) account — the free tier needs no card. Retention and
  file-size ceilings by plan are on the [pricing page](https://betadrop.app/pricing/).

## Development

```bash
npm install
npm run build      # bundle to dist/bd.js
npm run typecheck  # type-check without emitting
node dist/bd.js --help
```

Issues and pull requests: <https://github.com/betadrop-app/betadrop-cli>. If this saved you a
TestFlight round-trip, a ⭐ helps other mobile teams find it.

## License

MIT
