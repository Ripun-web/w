# RB WhatsApp Connector + OTP Service

Ubuntu/Linux-first Node.js service by RB Developments.

## Included

- WhatsApp Web connection using QR or pairing code
- Connection status and health endpoints
- Send a text message
- WhatsApp-delivered 6-digit OTP request and verification
- OTP expires after 5 minutes by default
- Cooldown, per-number hourly limit, and limited verification attempts
- Bearer token protection for API endpoints when `CONNECTOR_API_TOKEN` is configured
- No AI features, no macOS scripts, no bulk-campaign tooling

> This uses WhatsApp Web through Baileys; it is not the official WhatsApp Business Platform. No implementation can guarantee that an account will never be restricted. Use only for recipients who requested verification, respect WhatsApp rules, and avoid unsolicited messages.

## Ubuntu setup

Requires Node.js 20 or newer.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
# Install Node.js 20+ using your preferred trusted package source.
git clone https://github.com/Ripun-web/w.git
cd w
npm install
cp .env.example .env
nano .env
npm start
```

Set unique random values for `CONNECTOR_API_TOKEN` and `OTP_PEPPER`. Keep `.env` and `auth_info/` private. Never commit session credentials or secrets.

Railway can deploy from this repository using `npm start`. Configure the same environment variables in Railway's Variables panel.

## Authentication

When `CONNECTOR_API_TOKEN` is non-empty, send:
```
Authorization: Bearer YOUR_CONNECTOR_API_TOKEN
Content-Type: application/json
```

The `/` and `/health` endpoints are public health/info endpoints. All other routes require the token.

## Endpoints

### Start and inspect connection

`POST /connect`

`GET /qr` — returns a QR string and a `dataUrl` image when available.

`GET /status`

`GET /health`

Pairing code:
```json
{ "number": "919876543210" }
```
Send this to `POST /pair`, then enter the code in WhatsApp > Linked devices.

### Send a message

`POST /send-message`
```json
{ "to": "919876543210", "message": "Hello" }
```

### Request OTP

`POST /otp/request` (alias: `POST /send-otp`)
```json
{ "to": "919876543210" }
```

The service sends a 6-digit code to that WhatsApp number. Response contains expiry duration only; the OTP is never returned by the API.

### Verify OTP

`POST /otp/verify` (alias: `POST /verify-otp`)
```json
{ "to": "919876543210", "otp": "123456" }
```

A successful response includes `"verified": true`. Store the verification result in your own application; this service keeps OTPs in memory, so pending OTPs are cleared when the process restarts.

### Disconnect

`POST /disconnect`

## Example with curl

```bash
curl -X POST https://YOUR-HOST/connect \
  -H "Authorization: Bearer YOUR_TOKEN"
curl https://YOUR-HOST/status -H "Authorization: Bearer YOUR_TOKEN"
curl -X POST https://YOUR-HOST/otp/request \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"919876543210"}'
curl -X POST https://YOUR-HOST/otp/verify \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"919876543210","otp":"123456"}'
```

## Notes

- Use international format (country code + number). A 10-digit Indian number is prefixed with `DEFAULT_COUNTRY=91`.
- Keep only one running instance per auth directory.
- OTP storage is in-memory and intended for a simple single-instance deployment; use persistent storage and shared rate limits before running multiple instances.
- Do not expose `auth_info/`, environment variables, or QR/pairing codes publicly.
