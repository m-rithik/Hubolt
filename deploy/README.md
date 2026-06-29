# Hubolt deployment (No Docker)

Deploy the Hubolt server to a single Ubuntu server with Bitbucket for source
hosting and CI/CD. Postgres and Redis are installed natively via apt. The Node
app runs under systemd. Bitbucket Pipelines tests and builds on every push, then
SSHes into the server to pull, build, migrate, and restart.

```
Bitbucket repo (code + Pipelines CI)
      |  push to main
      v
Pipelines: npm ci, typecheck, test, build
      |  ssh (deploy key)
      v
Server (Ubuntu): git pull  ->  npm ci  ->  build  ->  prisma migrate deploy  ->  systemctl restart
      |
      +-- PostgreSQL (apt, systemd)   <- application data lives here
      +-- Redis (apt, systemd)        <- job queue / cache
      +-- hubolt-server (systemd)     <- node dist/server/index.js on 127.0.0.1:3000
```

Important: Bitbucket stores code and runs CI only. It is NOT a database. The
application database is PostgreSQL on the server (see step 3).

---

## 1. Provision the server (run once)

On a fresh Ubuntu 22.04 or 24.04 server, as a sudo-capable user:

```bash
# App user and directory
sudo adduser --disabled-password --gecos "" hubolt
sudo mkdir -p /opt/hubolt
sudo chown hubolt:hubolt /opt/hubolt

# Node.js 20 (project requires >= 20.19)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git curl

# PostgreSQL 16 (matches the dev image). On Ubuntu 24.04 the default repo
# already has 16; the PGDG step below guarantees 16 on 22.04 too.
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get install -y postgresql-16
sudo systemctl enable --now postgresql

# Redis
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server

# Firewall: SSH only. The app stays on localhost (reverse proxy is optional, step 11).
sudo ufw allow OpenSSH
sudo ufw --force enable
```

---

## 2. Server -> Bitbucket: read-only access key (so the server can pull code)

Generate a key as the `hubolt` user and register the public half with Bitbucket
as a repository Access key (read-only).

```bash
sudo -u hubolt ssh-keygen -t ed25519 -C "hubolt-server-deploy" -f /opt/hubolt/.ssh/id_ed25519 -N ""
sudo -u hubolt cat /opt/hubolt/.ssh/id_ed25519.pub
```

In Bitbucket: Repository settings > Access keys > Add key. Paste the public key.
Access keys are read-only, which is exactly what the server needs.

Then clone the repo into the app directory:

```bash
sudo -u hubolt git clone git@bitbucket.org:WORKSPACE/REPO.git /opt/hubolt
```

(Replace `WORKSPACE/REPO`. If the directory is not empty, clone elsewhere and move
the contents in.)

---

## 3. Create the database

```bash
sudo -u postgres psql -c "CREATE USER hubolt WITH PASSWORD 'CHOOSE_A_STRONG_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE hubolt_db OWNER hubolt;"
```

Use the same password in `DATABASE_URL` below.

Need a managed database instead later? PostgreSQL is the right engine for this
app (the schema and 17 migrations are Postgres). To switch to a managed Postgres
(e.g. a cloud provider's managed Postgres, Supabase, RDS), only `DATABASE_URL`
changes; nothing in the app code does. Redis can likewise move to a managed
Redis by changing `REDIS_URL`.

---

## 4. Configure environment (secrets stay on the server)

```bash
cd /opt/hubolt
sudo -u hubolt cp deploy/env.example .env
sudo -u hubolt nano .env          # fill in real values
sudo -u hubolt chmod 600 .env     # owner-only
```

`.env` is git-ignored and never leaves the server. Fill in `DATABASE_URL`
(with the password from step 3), the LLM keys you use, and `CREDENTIAL_MASTER_KEY`
(`openssl rand -base64 32`).

---

## 5. Install the systemd service

```bash
sudo cp /opt/hubolt/deploy/hubolt-server.service /etc/systemd/system/
# REQUIRED for GitHub reviews: the worker consumes queued PR jobs. Without it the
# webhook returns 202 but no review ever runs.
sudo cp /opt/hubolt/deploy/hubolt-worker.service /etc/systemd/system/
sudo systemctl daemon-reload

# Allow the hubolt user to restart only its own services without a password
# (needed so deploy.sh can restart over SSH).
echo 'hubolt ALL=(root) NOPASSWD: /bin/systemctl restart hubolt-server, /bin/systemctl status hubolt-server, /bin/systemctl restart hubolt-worker, /bin/systemctl status hubolt-worker' \
  | sudo tee /etc/sudoers.d/hubolt-server
sudo chmod 440 /etc/sudoers.d/hubolt-server
```

---

## 6. First build and start

```bash
cd /opt/hubolt
sudo -u hubolt bash -c 'npm ci && npm run build'
sudo -u hubolt bash -c 'set -a; . ./.env; set +a; npx prisma migrate deploy'
sudo systemctl enable --now hubolt-server
# Start the worker too (required for GitHub PR reviews to be processed).
sudo systemctl enable --now hubolt-worker

# Verify
systemctl status hubolt-server --no-pager
curl -fsS http://127.0.0.1:3000/health
```

---

## 7. Bitbucket Pipelines -> server: deploy SSH key

This is the second SSH relationship (the first was server -> Bitbucket in step 2).

1. Bitbucket: Repository settings > Pipelines > SSH keys > Generate keys.
2. Copy the generated public key and add it to the server's `hubolt` user:

   ```bash
   sudo -u hubolt bash -c 'echo "PASTE_PIPELINES_PUBLIC_KEY" >> /opt/hubolt/.ssh/authorized_keys'
   sudo -u hubolt chmod 600 /opt/hubolt/.ssh/authorized_keys
   ```

3. On the same Bitbucket page, under "Known hosts", enter your server's host or
   IP and click Fetch, then Add. This lets the pipeline verify the server.

The private key never leaves Bitbucket and is never stored in the repo.

---

## 8. Bitbucket repository variables

Repository settings > Pipelines > Repository variables (or Deployments >
production for environment-scoped). Add:

| Name          | Value                         | Secured |
|---------------|-------------------------------|---------|
| `DEPLOY_USER` | `hubolt`                      | no      |
| `DEPLOY_HOST` | your server's IP or hostname  | no      |

No API keys, passwords, or `.env` contents go here. The pipeline only needs to
know where to SSH; the deploy SSH key is the one from step 7.

---

## 9. How CI/CD runs

Defined in `bitbucket-pipelines.yml` at the repo root:

- Every pull request and every push to `main`: `npm ci`, `npm run typecheck`,
  `npm test`, `npm run build`. Tests are fully mocked, so no database is needed
  in CI.
- On `main`, after a green build, a manual "Deploy to server" step SSHes in and
  runs `deploy/deploy.sh`. Remove `trigger: manual` from the file to deploy
  automatically on every green main build.

---

## 10. Deploy an update

Push to `main`, then click "Deploy to server" in the Pipelines run (or it runs
automatically if you removed `trigger: manual`).

`deploy/deploy.sh` on the server: records the current commit, pulls `origin/main`,
`npm ci`, `npm run build`, `prisma migrate deploy`, restarts the service, and
health-checks `http://127.0.0.1:3000/health`. If the health check fails it rolls
back automatically.

Manual deploy from the server is identical:

```bash
cd /opt/hubolt && bash deploy/deploy.sh
```

Note: the running copy of `deploy.sh` does the pull, so a change to `deploy.sh`
itself takes effect on the next deploy.

---

## 11. Rollback

Automatic on a failed post-deploy health check. To roll back manually:

```bash
cd /opt/hubolt && bash deploy/rollback.sh
```

It returns to the commit saved in `.last_deploy`, rebuilds, and restarts.

Database caveat: rollback reverts code only. Prisma has no automatic
down-migrations. Additive migrations stay compatible with older code; a
destructive migration (dropped or renamed column) must be reversed by hand from
a backup. Take a backup before deploys that include destructive migrations:

```bash
sudo -u postgres pg_dump hubolt_db > /opt/hubolt/backups/hubolt_db_$(date +%F_%H%M).sql
```

---

## 12. Secrets hygiene

- `.env`, `*.pem`, `*.key` are git-ignored; the real `.env` lives only on the
  server with `chmod 600`.
- Bitbucket holds only `DEPLOY_USER` / `DEPLOY_HOST` and SSH keys, never app
  secrets.
- Two separate SSH keys: server -> Bitbucket (read-only access key, step 2) and
  Bitbucket -> server (Pipelines deploy key, step 7). Neither private key is in
  the repo.
- Rotate a leaked key by removing it from the relevant Bitbucket page / the
  server's `authorized_keys` and generating a new one.

---

## 13. Optional: reverse proxy + TLS

The app binds to `127.0.0.1:3000` and is not reachable from outside. To serve it
on a domain over HTTPS, put nginx in front:

```bash
sudo apt-get install -y nginx
sudo ufw allow 'Nginx Full'
```

`/etc/nginx/sites-available/hubolt` (then symlink into `sites-enabled` and reload):

```nginx
server {
    listen 80;
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then add TLS with certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com
```

Without a domain, you can instead expose the port directly with
`sudo ufw allow 3000` and set `HOST=0.0.0.0` in the service, but a reverse proxy
with TLS is the recommended production setup.

---

## 14. Optional: background worker

If you use GitHub webhook reviews, run the worker as a second service. The repo
ships `deploy/hubolt-worker.service`; copy it to `/etc/systemd/system/`, then
enable it. Skip this only if you do not use the GitHub webhook queue.
