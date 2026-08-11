# Twilio Setup

## Phone number webhooks

In **Twilio Console → Phone Numbers → Manage → Active numbers → +18444846554**, configure:

- **A message comes in:** Webhook, `POST https://app.trymantra.ai/api/webhooks/twilio/sms`
- **A call comes in:** Webhook, `POST https://app.trymantra.ai/api/webhooks/twilio/voice`

Do not use Twilio's demo SMS webhook. Do not configure a fallback webhook or Messaging Service for the initial one-number release.

Mantra validates every callback with Twilio's Node SDK using the exact public request URL, the complete form payload, `X-Twilio-Signature`, and `TWILIO_AUTH_TOKEN`. The configured number must match the active durable owner binding before an inbound SMS is accepted.

## SMS compliance

The account-creation checkbox is optional and unchecked. Mantra records the phone number, disclosure version, source, timestamp, and later STOP/START/HELP state changes. Every outbound SMS crosses the canonical consent boundary and fails closed unless the latest durable state is opted in.
