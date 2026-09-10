# 𓍢ִ໋🌷 MRS LONER ⟡ LILY — Pinterest Telegram Bot

A modular Node.js bot that searches Pinterest through the **official Pinterest API**, filters candidates, processes images, generates aesthetic captions, prevents duplicates, and publishes to a Telegram channel on a schedule.

## Important Pinterest/API note

This project deliberately does **not** scrape Pinterest HTML, automate a browser against Pinterest, bypass CAPTCHAs, evade rate limits, or use stolen cookies/session data.

The Pinterest integration targets the official API endpoint:

`GET /v5/search/partner/pins`

Access to that endpoint is subject to Pinterest's current developer approval/access model. If your Pinterest app does not have the required endpoint access, the search layer will fail cleanly instead of switching to an unofficial scraper.

## Rights/copyright

A Pinterest Pin is not automatically licensed for redistribution.

By default the bot requires a source link. You are responsible for only publishing content you have the necessary rights/permission to repost.

For a stricter setup, populate:

`LICENSED_SOURCE_DOMAINS=example.com,another-site.com`

Then only Pins whose source URL belongs to one of those domains are accepted.

## Requirements

- Node.js 20+
- A Telegram bot token from @BotFather
- The bot must be an administrator in your target channel with permission to post media
- A Pinterest developer app with an appropriate API access token and access to the required search endpoint

## Install

```bash
git clone <your-repository-url>
cd mrs-loner-lily-bot
npm install
copy .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env`.

## Telegram setup

1. Open Telegram and talk to `@BotFather`.
2. Create a bot with `/newbot`.
3. Copy the bot token.
4. Add the bot as an administrator to your channel.
5. Give it permission to post messages/media.
6. Set:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHANNEL_ID=@yourchannel
```

You can also use a numeric channel ID if you already know it.

## Pinterest setup

1. Create/sign in to your Pinterest developer application.
2. Complete the app setup/approval required by Pinterest.
3. Obtain an OAuth access token with the scopes/access required by the search endpoint.
4. Put the token in:

```env
PINTEREST_ACCESS_TOKEN=...
```

Do not commit `.env`.

## Run locally

```bash
npm install
npm start
```

For development:

```bash
npm run dev
```

The default schedule is once every hour.

The bot will log messages similar to:

```text
Pinterest search
20 candidates received
candidate filtering
image processing
caption generation
Telegram upload
database update
cleanup
```

## Test immediately

Set:

```env
RUN_ON_START=true
```

Then:

```bash
npm start
```

The bot performs one publishing cycle immediately and then continues on the normal schedule.

Set it back to:

```env
RUN_ON_START=false
```

after testing.

## Change posting interval

Default:

```env
POST_INTERVAL=3600
```

3600 seconds = 1 hour.

Examples:

```env
POST_INTERVAL=1800
```

30 minutes.

```env
POST_INTERVAL=7200
```

2 hours.

The scheduler accepts whole-minute intervals.

## Change images per post

```env
IMAGES_PER_POST=1
```

For albums:

```env
IMAGES_PER_POST=3
```

Telegram media groups support albums, and the bot automatically switches to an album when more than one image survives filtering.

Keep this at 1 if you want one clean post every hour.

## Change categories/searches

Edit:

`src/pinterest/queries.js`

Example:

```js
wallpapers: [
  "pink iphone wallpaper",
  "soft flower wallpaper",
  "dreamy night wallpaper"
]
```

The scheduler randomly chooses a category and query while avoiding the immediately previous category/query where possible.

## Caption style

Edit:

`src/captions/generator.js`

Each category has its own caption bank.

Categories currently include:

- wallpaper
- pfp
- couple
- movie
- sad
- nostalgic
- quote
- default

Captions use occasional symbols such as:

`♡ ୨୧ ✧ ⟡ 𓂃 ☾ ⋆`

without forcing the same branding line onto every post.

## Duplicate detection

SQLite stores:

- Pinterest Pin ID
- SHA-256 image hash
- source URL
- category
- search query
- generated caption
- Telegram message ID
- posting status
- timestamp

The bot skips a Pin ID that has already been posted.

It also calculates a SHA-256 hash after processing to catch exact duplicate files.

## Image processing

Images are:

1. downloaded with a size limit
2. validated with Sharp
3. checked for minimum dimensions
4. rotated according to EXIF orientation
5. resized without enlargement
6. converted to JPEG
7. metadata-stripped by default
8. compressed if necessary
9. uploaded
10. deleted from the temporary downloads directory

## Failure handling

A failed hour does not stop the scheduler.

The worker catches errors from:

- Pinterest
- HTTP downloads
- invalid image data
- image processing
- duplicate detection
- Telegram
- rate limiting

Retryable network/API errors use exponential backoff.

If Pinterest returns no usable candidates, the bot logs the result and waits for the next scheduled run.

## Deployment with Docker

Build:

```bash
docker build -t mrs-loner-lily-bot .
```

Run:

```bash
docker run -d \
  --name mrs-loner-lily \
  --restart unless-stopped \
  --env-file .env \
  -v mrs-loner-data:/app/data \
  mrs-loner-lily-bot
```

The persistent volume keeps the SQLite database when the container is recreated.

## VPS deployment

On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y git
```

Install Node.js 20+ using your preferred supported Node installation method.

Then:

```bash
git clone <your-repository-url>
cd mrs-loner-lily-bot
npm ci --omit=dev
cp .env.example .env
nano .env
npm start
```

For a long-running VPS process, use systemd, Docker, or another process supervisor.

### systemd example

Create:

```text
/etc/systemd/system/mrs-loner-lily.service
```

with:

```ini
[Unit]
Description=MRS LONER LILY Telegram Pinterest Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mrs-loner-lily-bot
ExecStart=/usr/bin/node /opt/mrs-loner-lily-bot/src/main.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/mrs-loner-lily-bot/.env

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable mrs-loner-lily
sudo systemctl start mrs-loner-lily
sudo systemctl status mrs-loner-lily
```

View logs:

```bash
journalctl -u mrs-loner-lily -f
```

## Security

Never commit:

```text
.env
Pinterest access tokens
Telegram bot tokens
database files
```

The included `.gitignore` protects these by default.

If a Telegram bot token or Pinterest token is accidentally exposed, rotate/revoke it immediately.

## Architecture

```text
Scheduler
   │
   ▼
Query rotation
   │
   ▼
Official Pinterest API
   │
   ▼
Candidate filtering
   │
   ├── source/right check
   ├── sponsored check
   ├── duplicate Pin check
   └── image URL check
   │
   ▼
Download
   │
   ▼
Sharp validation/processing
   │
   ├── dimensions
   ├── format normalization
   ├── resize
   └── compression
   │
   ▼
SHA-256 duplicate check
   │
   ▼
Caption generator
   │
   ▼
Telegram
   │
   ├── sendPhoto
   └── sendMediaGroup
   │
   ▼
SQLite history
   │
   ▼
Cleanup
```

## Production notes

This project intentionally avoids an unofficial Pinterest scraper. If Pinterest changes the official API or your application loses access to the partner-search endpoint, update only the Pinterest provider layer instead of replacing the whole application with a scraper.

For higher-quality visual classification, `src/images/classifier.js` can later be replaced with an authorized vision API/provider. The rest of the publishing pipeline does not need to change.
