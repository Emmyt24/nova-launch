# Email notification templates

HTML templates for transactional email notifications. Each file is a
self-contained HTML document (all CSS inlined in a `<head>` `<style>` block, no
external assets) with `{{variable}}` placeholders that are substituted at send
time.

| Template file          | Notification / event | Purpose                                                        |
| ---------------------- | -------------------- | ------------------------------------------------------------- |
| `token-deployed.html`  | `TOKEN_DEPLOYED`     | Confirms a token contract is live on Stellar.                 |
| `vault-matured.html`   | `VAULT_MATURED`      | Alerts a vault manager that a lock has reached maturity.      |
| `proposal-passed.html` | `PROPOSAL_PASSED`    | Tells a participant that a governance proposal has passed.    |

## Who renders these, and how

**`src/services/notificationService.ts`** owns rendering — no other service
compiles these templates.

- `renderTemplate(key, vars)` (the `Template loader` section of that file) reads
  the file named in `TEMPLATE_FILES[key]`, caches the raw HTML for the process
  lifetime, then for **each entry in `vars`** runs a global
  `html.replace(/\{\{key\}\}/g, value ?? "")`.
- `EmailTemplateKey` (`"TOKEN_DEPLOYED" | "VAULT_MATURED" | "PROPOSAL_PASSED"`)
  maps 1:1 to the files via `TEMPLATE_FILES`.
- The call site is `NotificationService.sendEmailNotification(...)`. It renders a
  template only when `payload.metadata.templateKey` is set; otherwise the email
  body is the plain-text `payload.message`. The rendered HTML is used **only on
  the SendGrid delivery path** (`sendViaSendGrid`); the legacy
  `NOTIFICATION_EMAIL_API_URL` path (`sendViaEmailApi`) sends plain text only.

### How each variable is supplied

`sendEmailNotification` builds the `vars` object passed to `renderTemplate` as:

| Variable         | Source in `sendEmailNotification`                                             |
| ---------------- | --------------------------------------------------------------------------- |
| `message`        | `payload.message` — always present (`NotificationService.send` rejects a payload without it). |
| `tokenAddress`   | `payload.tokenAddress` — added only when truthy.                            |
| `unsubscribeUrl` | Hard-coded `https://nova-launch.app/unsubscribe`.                          |
| `actionUrl`      | Hard-coded `https://nova-launch.app`.                                      |
| _everything else_ | Spread from `payload.metadata` (which also carries `templateKey`). The caller that triggers the notification is responsible for putting `tokenName`, `vaultId`, `proposalId`, vote counts, etc. on `payload.metadata`. Keys in `payload.metadata` override the four rows above. |

> **Gotcha:** `renderTemplate` only iterates the keys it is *given*. A
> placeholder with no matching entry in `vars` (e.g. a caller that forgets
> `tokenName`) is left in the output verbatim as the literal text
> `{{tokenName}}`. Supply every variable listed for a template.

## Variables per template

Types are the post-substitution string form (every value is stringified by the
`value ?? ""` replace). "Source" is where `sendEmailNotification` gets it:
**direct** = set explicitly in `sendEmailNotification`; **`payload.metadata`** =
must be provided by the caller on the notification payload.

### `token-deployed.html`

| Placeholder      | Type / format                     | Source           | Example                                                     |
| ---------------- | --------------------------------- | ---------------- | --------------------------------------------------------- |
| `tokenName`      | string                            | `payload.metadata` | `Nova Reward Token`                                       |
| `tokenSymbol`    | string (ticker)                   | `payload.metadata` | `NRT`                                                     |
| `tokenAddress`   | string (Stellar contract address) | direct (`payload.tokenAddress`) | `C**************************************************` (56 chars) |
| `initialSupply`  | string (integer, human units)     | `payload.metadata` | `1000000`                                                 |
| `decimals`       | string (integer)                  | `payload.metadata` | `7`                                                       |
| `message`        | string (free text, one paragraph) | direct (`payload.message`) | `Your token was deployed in ledger 51234567.`     |
| `unsubscribeUrl` | string (absolute URL)             | direct (constant) | `https://nova-launch.app/unsubscribe`                     |

_Status badge text (`DEPLOYED`) is hard-coded in the markup — not a variable.
This template has no `{{actionUrl}}` / CTA button._

### `vault-matured.html`

| Placeholder      | Type / format                     | Source           | Example                                              |
| ---------------- | --------------------------------- | ---------------- | -------------------------------------------------- |
| `vaultId`        | string (identifier)               | `payload.metadata` | `vault_8842`                                       |
| `tokenAddress`   | string (Stellar contract address) | direct (`payload.tokenAddress`) | `C************...` (56 chars)          |
| `lockedAmount`   | string (amount, human units)      | `payload.metadata` | `25000.0000000`                                    |
| `maturityDate`   | string (display date)             | `payload.metadata` | `2026-09-01T00:00:00Z`                             |
| `message`        | string (free text, one paragraph) | direct (`payload.message`) | `Your vault has matured and tokens are claimable.` |
| `actionUrl`      | string (absolute URL, CTA target) | direct (constant) | `https://nova-launch.app`                          |
| `unsubscribeUrl` | string (absolute URL)             | direct (constant) | `https://nova-launch.app/unsubscribe`             |

_Status badge text (`MATURED`) is hard-coded. `{{actionUrl}}` is the href of the
"Claim Tokens" CTA button._

### `proposal-passed.html`

| Placeholder      | Type / format                     | Source           | Example                                        |
| ---------------- | --------------------------------- | ---------------- | -------------------------------------------- |
| `proposalTitle`  | string (free text)                | `payload.metadata` | `Increase staking rewards to 12% APR`         |
| `proposalId`     | string (identifier)               | `payload.metadata` | `42`                                          |
| `tokenAddress`   | string (Stellar contract address) | direct (`payload.tokenAddress`) | `C************...` (56 chars)     |
| `votesFor`       | string (integer / weight)         | `payload.metadata` | `1875000`                                     |
| `votesAgainst`   | string (integer / weight)         | `payload.metadata` | `240000`                                      |
| `quorumReached`  | string (`Yes` / `No`, or percent) | `payload.metadata` | `Yes`                                         |
| `message`        | string (free text, one paragraph) | direct (`payload.message`) | `The proposal passed and is queued for execution.` |
| `actionUrl`      | string (absolute URL, CTA target) | direct (constant) | `https://nova-launch.app`                     |
| `unsubscribeUrl` | string (absolute URL)             | direct (constant) | `https://nova-launch.app/unsubscribe`         |

_Status badge text (`PASSED`) is hard-coded. `{{actionUrl}}` is the href of the
"View Proposal" CTA button._

## Shared layout / branding (follow this in a new template)

All three templates share the same structure and CSS class names. A new
notification template should keep them consistent:

- **Document shell:** `<!DOCTYPE html>`, `<html lang="en">`, `charset` +
  `viewport` meta, `<title>… — Nova Launch</title>`, all CSS inlined in a single
  `<head>` `<style>` block. No external stylesheets, fonts, or images.
- **`.container`** — `max-width: 600px`, centered, white card, `border-radius: 8px`.
- **`.header`** — background `#1a1a2e`; `<h1>` in gold `#e2c97e` (leading emoji +
  short title); `<p>` in muted `#a0aec0` reading `Nova Launch · <Section>`
  (e.g. `Stellar Token Factory`, `Vault Management`, `Governance`).
- **`.body`** — `<h2>` one-line summary, then a stack of **`.detail-row`**s, each
  with a **`.detail-label`** (`#718096`) and **`.detail-value`** (`#2d3748`;
  add `font-family: monospace` for addresses / hashes / IDs).
- **`.badge`** — final detail row is a status pill: green
  (`background:#d4edda; color:#155724`) for success states, amber
  (`background:#fff3cd; color:#856404`) for warnings/maturity. Badge text is
  hard-coded per template, not a variable.
- **`{{message}}`** — a free-text paragraph after the detail rows (`#4a5568`).
- **`.cta`** (optional) — a single call-to-action button linking `{{actionUrl}}`;
  include it only when there is a clear next action (present in `vault-matured`
  and `proposal-passed`, absent in `token-deployed`).
- **`.footer`** — light-grey band: `Nova Launch · nova-launch.app` link, a
  one-line "why you received this" sentence, and an `{{unsubscribeUrl}}` link.
  Link color `#667eea`.
- Always include `{{message}}` and `{{unsubscribeUrl}}`. Include `{{actionUrl}}`
  whenever the template has a `.cta`.

## Keeping this doc and the code in sync

There is no code change required for this document, but if you change a
template's placeholders:

1. Update the matching table above.
2. Make sure `sendEmailNotification` in `src/services/notificationService.ts`
   supplies the variable — either directly or by ensuring callers put it on
   `payload.metadata`.
3. If you add a brand-new template, add a row to the top table, add its
   `EmailTemplateKey` + `TEMPLATE_FILES` entry in `notificationService.ts`, and
   follow the shared layout section above.
