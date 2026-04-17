# BNI Lead Gen Platform

BNI Lead Gen is a credit-based lead-generation platform with:

- a React dashboard for users and admins
- a Node/Express API with JWT auth
- Prisma + PostgreSQL persistence
- the existing Python scraper as the lead engine
- Cloudflare R2 for generated files
- chat-style AI mail drafting and campaign management

The production app is designed so users never touch the command line. They log in, configure their filters and outreach settings, run jobs, review campaigns, and download files from the dashboard.

## Repo Layout

```text
BNI_extract/
  main.py                     # Python scraper entry point
  src/                        # Python scraper support code
  apps/
    api/                      # Express + Prisma backend
    web/                      # React/Vite frontend
  debug/                      # local debug artifacts
  output/                     # local scraper output
  .env                        # private local/server config
  .env.example                # sample env file
  package.json                # workspace scripts
```

## What The App Does

- User login, forgot password, reset password
- Credit-based lead generation
- Country/category/keyword filters
- CSV generation and generated-leads history
- Send Mail workspace with AI draft editing and campaign history
- Per-user BNI credentials stored securely in Postgres
- Admin user management and credit approval

## Environment

Use `.env` at the repo root. Do not commit it.

Important variables:

```env
DATABASE_URL=postgresql://...
JWT_SECRET=change-me
APP_ENCRYPTION_KEY=change-me-too
WEB_ORIGIN=http://localhost:4000
API_PORT=4000
PYTHON_BIN=python
SCRAPER_ENTRY=main.py
HEADLESS=true

MAX_GLOBAL_SCRAPE_CONCURRENCY=2
MAX_GLOBAL_SCRAPE_QUEUE_SIZE=10
MAX_PROFILE_CONCURRENCY=1
MAX_COUNTRY_PROFILES=360
REQUEST_DELAY_MIN=3.5
REQUEST_DELAY_MAX=6.5

GOOGLE_SENDER_EMAIL=info@malishagroup.com
GOOGLE_APP_PASSWORD=your-google-app-password

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=bni-lead-gen
R2_PUBLIC_BASE_URL=
R2_ENDPOINT=

ZHIPU_LLM_API_KEY=
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/paas/v4
ZHIPU_MODEL_NAME_GENERAL=GLM-4.7
ZHIPU_MODEL_NAME_SMALL=GLM-4.7-Flash

OPENAI_API_KEY=
OPENAI_MODEL_NAME=gpt-5.4-nano

TAVILY_API_KEY=
```

## Local Development

Install dependencies:

```bash
npm install
```

Generate Prisma client and build:

```bash
npm run prisma:generate
npm run build
```

Run the development servers:

```bash
npm run dev:api
npm run dev:web
```

The API serves the React build automatically when `apps/web/dist` exists.

## Database Bootstrap

Apply migrations:

```bash
npm run migrate:deploy
```

Seed the first admin user:

```bash
npm run seed
```

Seeded admin:

- Email: `findasifrahman@gmail.com`
- Password: `Asif@10018`

## Production Deployment

This project is a single git repository with both backend and frontend in it.
For production, you deploy one Node process on the VPS. That Node process serves:

- the API
- the built frontend from `apps/web/dist`

So there is no separate frontend server in production.

This guide assumes:

- VPS: DWHOST
- Database: Railway Postgres
- Port 80 is already occupied
- You will deploy by SSH or GitHub Actions

Use one custom port, for example `4000` or `4001`.

### 1. Create Railway Postgres

1. Create a Postgres database in Railway.
2. Copy the connection string.
3. Put it into `DATABASE_URL` on the VPS `.env`.

### 2. Prepare the VPS

SSH into the VPS and install:

- Node.js 20+
- npm
- Python 3.11+
- Chromium dependencies for Playwright
- Git

Create a dedicated Python virtualenv for the scraper and install its dependencies:

```bash
cd /opt/bni-lead-gen
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
```

If you prefer not to use a virtualenv, install the Python packages into your system Python and make sure `PYTHON_BIN` points to that interpreter.

### 3. Clone the repo

```bash
git clone <your-repo-url> /opt/bni-lead-gen
cd /opt/bni-lead-gen
```

### 4. Create the server `.env`

Create the root `.env` file on the VPS. This file stays only on the server and must not be committed to git:

```bash
nano /opt/bni-lead-gen/.env
```

Example production values:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/railwaydb?schema=public
JWT_SECRET=use-a-long-random-secret
APP_ENCRYPTION_KEY=use-a-32-byte-base64-or-similar-secret
WEB_ORIGIN=http://YOUR_VPS_IP:4000
API_PORT=4000
PYTHON_BIN=/opt/bni-lead-gen/.venv/bin/python
SCRAPER_ENTRY=main.py
HEADLESS=true

GOOGLE_SENDER_EMAIL=info@malishagroup.com
GOOGLE_APP_PASSWORD=your-google-app-password

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=bni-lead-gen
R2_PUBLIC_BASE_URL=https://pub-...
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

ZHIPU_LLM_API_KEY=...
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/paas/v4
ZHIPU_MODEL_NAME_GENERAL=GLM-4.7
ZHIPU_MODEL_NAME_SMALL=GLM-4.7-Flash

OPENAI_API_KEY=...
OPENAI_MODEL_NAME=gpt-5.4-nano

TAVILY_API_KEY=...
MAX_GLOBAL_SCRAPE_CONCURRENCY=2
MAX_GLOBAL_SCRAPE_QUEUE_SIZE=10
MAX_PROFILE_CONCURRENCY=1
MAX_COUNTRY_PROFILES=360
REQUEST_DELAY_MIN=3.5
REQUEST_DELAY_MAX=6.5
```

Lock it down:

```bash
chmod 600 /opt/bni-lead-gen/.env
```

### 5. Install and build

From the repo root:

```bash
npm install
npm run prisma:generate
npm run build
```

### 6. Apply migrations

```bash
npm run migrate:deploy
```

If this is the first deployment, seed the initial admin:

```bash
npm run seed
```

### 7. Start the production server

The API serves the built frontend from `apps/web/dist`, so the production process is just the API server.

You can start it manually:

```bash
node apps/api/dist/server.js
```

Or use a `systemd` service.

Example `/etc/systemd/system/bni-lead-gen.service`:

```ini
[Unit]
Description=BNI Lead Gen API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/bni-lead-gen
EnvironmentFile=/opt/bni-lead-gen/.env
ExecStart=/usr/bin/node /opt/bni-lead-gen/apps/api/dist/server.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable bni-lead-gen
sudo systemctl start bni-lead-gen
sudo systemctl status bni-lead-gen
```

If you do not want `systemd`, PM2 also works:

```bash
npx pm2 start apps/api/dist/server.js --name bni-lead-gen
npx pm2 save
```

## GitHub CI/CD

Recommended flow:

1. Push to `main`
2. GitHub Actions SSHes into the VPS
3. The VPS pulls the latest code
4. Install dependencies
5. Build frontend and API
6. Run Prisma migrations
7. Restart the service

Example workflow outline:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/bni-lead-gen
            git pull origin main
            npm install
            npm run prisma:generate
            npm run build
            npm run migrate:deploy
            sudo systemctl restart bni-lead-gen
```

Store these as GitHub repo secrets:

- `VPS_HOST`: the public IP or domain name of your VPS
- `VPS_USER`: the SSH username on the VPS, often `root` or a deploy user
- `VPS_SSH_KEY`: the **contents of the private key file**, not the file path

To create `VPS_SSH_KEY`, generate a key pair on your local machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy"
```

Then:

- add the **public** key to `/root/.ssh/authorized_keys` or the deploy user's `~/.ssh/authorized_keys` on the VPS
- copy the **private** key file contents from `/root/.ssh/id_ed25519` into the GitHub secret `VPS_SSH_KEY`

The secret value should start with:

```text
-----BEGIN OPENSSH PRIVATE KEY-----
```

If your VPS uses a non-default SSH port, add `VPS_PORT` as another GitHub secret.

## Port and Access

If port 80 is already used, run the app on another port such as `4000` or `4001`.

- `API_PORT=4000`
- `WEB_ORIGIN=http://YOUR_VPS_IP:4000`

There is no separate frontend port in the default production setup because the API serves the built frontend.

### About `VITE_API_URL`

You do not need to set `VITE_API_URL` for the normal VPS deployment described above.

- In local development, the frontend uses `http://localhost:4000`.
- In production, the frontend uses the same origin as the browser URL.
- Only set `VITE_API_URL` if you deliberately split the frontend and backend onto different origins.

## Troubleshooting

- If Prisma complains about missing columns, run `npm run migrate:deploy`
- If the API starts but the UI does not load, confirm `apps/web/dist` exists and `npm run build` completed
- If headless scraping fails, make sure Chromium is installed on the VPS and `HEADLESS=true`
- If emails do not send, verify `sending_email` and `app_password` are set in the user settings
- Never commit `.env`; keep secrets only on the VPS and in GitHub Secrets

## Exact VPS Run Order

If you want the shortest possible checklist, do this on the VPS:

```bash
cd /opt/bni-lead-gen
npm install
npm run prisma:generate
npm run build
npm run migrate:deploy
node apps/api/dist/server.js
```

If this is the first deployment, also run:

```bash
npm run seed
```

Then open:

```text
http://97.64.27.223:4000
```

If the browser shows a blank page, first confirm:

1. `apps/web/dist/index.html` exists
2. `node apps/api/dist/server.js` is running
3. your VPS firewall allows the chosen port
4. `WEB_ORIGIN` matches the URL you are using in the browser
5. you rebuilt after changing the server or web source files
