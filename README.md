# Finance

Self-hosted personal finance automation. Automatically categorize and import bank transaction SMS into [Actual Budget](https://actualbudget.org/) using a local LLM.

## How It Works

1. Your phone receives a bank SMS (debit/credit alerts)
2. An automation (Apple Shortcuts, Tasker, etc.) sends the SMS text to the API
3. The API uses Ollama to parse the transaction details (amount, merchant, account, category)
4. Transaction gets imported into Actual Budget

All services run on your own hardware and communicate over Tailscale, keeping everything private.

## Requirements

- Docker
- Tailscale (for secure remote access)

## Setup

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 2. Start services

```bash
docker compose up -d
```

### 3. Pull the LLM model

```bash
docker exec -it ollama ollama pull mistral
```

### 4. Expose via Tailscale

```bash
# Actual Budget UI on port 443
sudo tailscale serve --https=443 --bg http://127.0.0.1:5006

# API on port 444
sudo tailscale serve --https=444 --bg http://127.0.0.1:8787
```

Services are now accessible at `https://<your-machine>.<tailnet>.ts.net` from any device on your Tailscale network.

## API

All endpoints require `x-api-token` header (or `Authorization: Bearer <token>`).

### POST /ingest

Parse and import a transaction SMS.

```bash
curl -X POST https://<host>:444/ingest \
  -H "Content-Type: application/json" \
  -H "x-api-token: YOUR_TOKEN" \
  -d '{"sms": "Rs.500 debited from A/c XX1234 for Amazon"}'
```

Returns parsed transaction details and import status. Non-transaction messages (OTPs, reminders) are ignored.

### GET /budget

Get current month's budget summary.

```bash
curl https://<host>:444/budget -H "x-api-token: YOUR_TOKEN"
```

### GET /health

Health check (no auth required).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ACTUAL_PASSWORD` | Actual Budget server password |
| `ACTUAL_BUDGET_ID` | Budget ID from Actual |
| `ACTUAL_FILE_PASSWORD` | Budget file encryption password (if E2E encryption enabled) |
| `API_TOKEN` | Token for API authentication |
