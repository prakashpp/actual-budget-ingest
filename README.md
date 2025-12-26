# Finance

Personal finance setup with Actual Budget, Ollama for transaction categorization, and an API service.

## Setup

### 1. Start services

```bash
docker compose up -d
```

### 2. Pull Mistral model

After containers are running, pull the Mistral model into Ollama:

```bash
docker exec -it ollama ollama pull mistral
```

### 3. Expose via Tailscale

Serve Actual Budget UI (port 443):

```bash
sudo tailscale serve --https=443 --bg http://127.0.0.1:5006
```

Serve API (port 444):

```bash
sudo tailscale serve --https=444 --bg http://127.0.0.1:8787
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

- `ACTUAL_PASSWORD` - Actual Budget password
- `ACTUAL_BUDGET_ID` - Budget ID
- `API_TOKEN` - Token for API authentication
