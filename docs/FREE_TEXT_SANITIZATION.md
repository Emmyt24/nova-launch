# Free-Text Field Sanitization

Issue: #2210 · Code: `backend/src/middleware/freeTextSanitization.ts`

User-supplied free text — token descriptions, proposal titles, stream notes —
is canonicalised by `createFreeTextSanitizationMiddleware()`, which runs on
every request right after body parsing (`backend/src/index.ts`).

## What happens on input

For each configured key, at any depth in `req.body`:

1. **Control characters are stripped** — C0/C1 controls, DEL, lone UTF-16
   surrogates, zero-width characters (U+200B–U+200F, U+2060–U+2064, U+FEFF)
   and bidi embeddings/overrides/isolates (U+202A–U+202E, U+2066–U+2069, the
   "Trojan Source" class).
2. **Line breaks are normalised** — `\r\n`, `\r`, U+2028 and U+2029 become
   `\n`. Single-line fields collapse newlines and tabs to one space, which
   also blocks CRLF header injection.
3. **Unicode is normalised to NFC**, so visually identical strings compare,
   index and deduplicate identically.
4. **Whitespace is trimmed.**
5. **Length limits are enforced** in code points (an emoji counts as one),
   measured *after* steps 1–4 so invisible padding cannot bypass them.

Over-long input is rejected — never truncated — with:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more text fields exceed their maximum length",
    "details": [{ "field": "metadata.description", "maxLength": 2000, "actualLength": 2417 }]
  }
}
```

Input is **not** HTML-encoded: raw text is stored and returned as JSON, so
encoding at input would double-encode in every client.

## Field limits

| Key           | Max code points | Multiline |
|---------------|-----------------|-----------|
| `description` | 2000            | yes       |
| `summary`     | 1000            | yes       |
| `notes`       | 2000            | yes       |
| `bio`         | 1000            | yes       |
| `reason`      | 1000            | yes       |
| `title`       | 200             | no        |
| `name`        | 100             | no        |

Change `DEFAULT_FREE_TEXT_RULES`, or pass custom rules to the factory for a
single router:

```ts
router.use(createFreeTextSanitizationMiddleware({ memo: { maxLength: 28 } }));
```

## Escaping on output

Any code that builds HTML from stored text must escape it with `escapeHtml()`
(`& < > " ' \``). The notification email renderer
(`renderTemplate` in `backend/src/services/notificationService.ts`) does this
for every template variable, so a token named `<img src=x onerror=…>` renders
as text in the email. JSON responses are not escaped — the frontend's
framework escaping covers them.

## Tests

`backend/src/middleware/freeTextSanitization.test.ts` covers hostile payloads:
NUL/ANSI/C1 smuggling, bidi overrides, zero-width spoofing, lone surrogates,
decomposed-Unicode tricks, invisible padding against limits, CRLF injection,
`__proto__` keys, and script/attribute-breakout markup at the output boundary.
