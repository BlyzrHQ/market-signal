# Price-watch email delivery webhook

Market Signal keeps in-app alerts in its own database. Email is an optional,
server-side delivery adapter configured with:

- `MARKET_SIGNAL_EMAIL_WEBHOOK_URL`: an HTTPS endpoint with no embedded credentials.
- `MARKET_SIGNAL_EMAIL_WEBHOOK_TOKEN`: a dedicated random bearer token of at least 32 characters.

Never expose either value to browser code, logs, analytics, or committed environment files.

## Request

When one recipient has at least one price alert that has waited 15 minutes,
Market Signal sends one `POST` containing that recipient's bounded pending batch:

```json
{
  "to": "customer@example.com",
  "subject": "2 watched prices changed",
  "items": [
    {
      "productName": "Example product",
      "eventType": "price-decreased",
      "observedAt": "2026-08-24T12:00:00.000Z",
      "detail": {
        "previous": {},
        "current": {}
      }
    }
  ],
  "idempotencyKey": "sha256-hex-value"
}
```

Headers include `Authorization: Bearer <token>`, `Content-Type:
application/json`, and the same value in `Idempotency-Key`. The receiver must
deduplicate successful delivery by that key and return any `2xx` status only
after accepting responsibility for the message. A timeout or non-`2xx`
response leaves every outbox item pending for a later scheduler pass.

The adapter must not call back into Market Signal, run product search, or invoke
an AI provider. It only formats and delivers the supplied alert facts.
