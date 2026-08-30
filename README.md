# EZ Music

A private, single-server Discord music bot focused on a polished **raw-song** experience with an optional Gemini AI DJ.

## Design rules

- Raw/original playback first.
- **No nightcore, karaoke, 8D, EQ, pitch, speed, bass boost, distortion, or other DSP effects.**
- Normal volume control is retained.
- One-server UX is prioritized over public-bot scale.
- Gemini never sits in the audio path; normal music still works if Gemini is unavailable or out of quota.
- The Now Playing panel is intentionally JukeBox-like: compact status, artwork, Up Next, and the controls people actually use.
- Song metadata cannot ping server members/roles because Discord mentions are disabled globally for bot output.
- Listening history stays local in `data/ez-music.sqlite` and is bounded to the newest 5,000 entries per server.

## Slash commands

- `/play <song/url>`
- `/playnext <song/url>`
- `/pause`
- `/resume`
- `/skip`
- `/previous`
- `/stop`
- `/disconnect`
- `/volume <0-100>`
- `/nowplaying`
- `/clear`
- `/shuffle`
- `/loop off|track|queue`
- `/autoplay on|off`
- `/radio server`
- `/ai request:<natural language request>`
- `/ai autoplay:on|off`
- `/help`
- `/ping`
- `/status`

There is deliberately no public `/queue` command. The Now Playing panel has a **Queue** button that shows the queue privately without adding another slash command.

## Player panel

The persistent player panel is edited as playback changes instead of posting a wall of control messages. It includes:

- title, artist, duration, requester and artwork
- Up Next
- volume, loop, autoplay and queue summary
- Previous / Loop / Pause-Resume / Shuffle / Skip
- Queue / Clear / Stop / Autoplay
- Volume down / Volume up

The Autoplay button cycles **Off → standard autoplay → AI autoplay → Off** when Gemini is configured. Without Gemini it cycles **Off ↔ standard autoplay**.

When track-loop is enabled, pressing Skip intentionally turns track-loop off first so the same song cannot immediately restart.

## Voice channel status

While a track is playing, the bot sets the Discord voice-channel status to:

```text
Playing: Song Title • Artist
```

It clears the status when playback stops or the bot leaves. Give the bot the **Set Voice Channel Status** permission.

## Autoplay and radio

- Standard autoplay tries source recommendations and then a search-based fallback.
- AI autoplay asks Gemini for a small continuation queue based on recent server listening history.
- If AI autoplay cannot get usable Gemini results, it falls back to standard recommendations instead of immediately leaving the channel silent.
- `/radio server` builds a longer queue from server listening history and can use Gemini as an optional enhancement.
- Server radio prefers older listening-history tracks as its last-resort fallback instead of failing just because recommendations are temporarily unavailable.
- AI/search resolution uses small parallel batches to avoid making every lookup wait for the previous one.
- Autoplay modes are mutually exclusive: enabling standard autoplay disables AI autoplay and vice versa.
- If Gemini is removed from `.env`, a previously saved AI-autoplay state is reset to Off on restart.
- If Gemini fails, times out, or reaches quota, the playback engine remains independent.

## Music sources

The default Lavalink setup supports:

- YouTube search, videos and playlists through the maintained `youtube-source` plugin
- SoundCloud
- Bandcamp
- direct HTTP audio URLs supported by Lavalink

The project intentionally does not ship unused source plugins. This reduces startup failures, memory use, and maintenance surface. Extra services can be added later without changing the Discord command set.

---

# Windows setup guide

## 1. Install prerequisites

Install:

1. **Node.js 22.14.0 or newer**
2. **Docker Desktop** with Docker Compose v2
3. **Git** (recommended, but downloading the repository ZIP also works)

Node 22 releases older than 22.14 are intentionally blocked because the bundled SQLite runtime can crash on those older patch releases. A current Node 22 LTS or newer release is recommended.

Start Docker Desktop before running the bot. `setup.bat` and `start-bot.bat` check the Node and Docker requirements and stop with a useful error instead of continuing on an unsupported setup.

## 2. Create the Discord bot

Go to the Discord Developer Portal and create an application, then create its Bot user.

You need three values:

- `DISCORD_TOKEN` — Bot page → Reset/Copy Token
- `DISCORD_CLIENT_ID` — General Information → Application ID
- `DISCORD_GUILD_ID` — your Discord server ID

To copy the server ID, enable Discord **Developer Mode**, right-click the server, and choose **Copy Server ID**.

**Never commit or post your bot token.** `.env` is ignored by Git.

### Bot invite

Use the OAuth2 URL Generator with these scopes:

- `bot`
- `applications.commands`

Give the bot at least these permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Connect
- Speak
- Use Voice Activity
- **Set Voice Channel Status**

No Message Content privileged intent is required.

## 3. Optional Gemini AI DJ

If you want `/ai` and AI autoplay, create a Gemini Developer API key in **Google AI Studio** and put it in `GEMINI_API_KEY`.

Your Gemini web/app subscription and the Gemini Developer API are separate. A Gemini subscription is not a substitute for an API key.

The default model is:

```text
GEMINI_MODEL=gemini-3.5-flash-lite
```

Leave `GEMINI_API_KEY` empty if you do not want AI features. Everything else still works.

## 4. One-time setup

Double-click:

```text
setup.bat
```

It checks Node.js/Docker, creates `.env` if needed, and installs Node dependencies.

Then open `.env` in Notepad and fill it in:

```dotenv
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_server_id

LAVALINK_URL=localhost:2333
LAVALINK_PASSWORD=ezmusic-local-only
LAVALINK_SECURE=false

GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite

DEFAULT_VOLUME=80
AUTO_DISCONNECT_MINUTES=10
```

Do not add quotes around ordinary token/ID values.

## 5. Normal daily start

For normal use later:

1. Start **Docker Desktop**.
2. Double-click `start-bot.bat`.
3. Wait until the window says `Lavalink is ready.` and then shows the Discord login/registration logs.
4. Join a Discord voice channel and use `/play`.

`start-bot.bat` now waits up to 45 seconds for Lavalink to actually accept connections before launching the Discord process. If Lavalink does not become ready, it prints the recent Lavalink logs instead of starting the bot into a broken state.

Or do it manually from PowerShell in the project folder:

```powershell
docker compose up -d
npm install
npm start
```

The batch launcher is preferred because it performs prerequisite/readiness checks automatically.

Guild-only slash commands are registered on startup and normally appear in the configured server very quickly.

## 6. First test

Join the voice channel where you want the bot, then try:

```text
/status
/play mirrors justin timberlake
```

Expected result:

- Discord says Online
- Lavalink says Connected
- the bot joins your voice channel
- the song starts
- a compact Now Playing panel appears
- the voice-channel status changes to `Playing: ...`
- panel buttons work for users in the same voice channel

Then test:

```text
/playnext another song
/shuffle
/loop track
/skip
/volume 50
/autoplay on
```

`/skip` while track-loop is active deliberately exits track-loop so it really skips instead of restarting the same song.

For Gemini:

```text
/ai request:chill anime songs, mostly piano, nothing fast
/ai autoplay:on
```

For server radio, first build a little listening history by playing several tracks, then:

```text
/radio server
```

The first real Discord test should also check a playlist URL, Previous, Queue button, Stop, Disconnect, and at least one full song transition into autoplay.

## 7. Stop the bot

In the bot console, press:

```text
Ctrl+C
```

That stops the Discord bot cleanly and closes its local SQLite database. Lavalink runs separately in Docker. To stop Lavalink too, double-click:

```text
stop-bot.bat
```

or run:

```powershell
docker compose down
```

---

# Troubleshooting

### `start-bot.bat` says Lavalink did not become ready

The launcher already prints the latest Lavalink logs. You can also run:

```powershell
docker compose logs --tail 100 lavalink
```

If Docker Desktop was still starting, wait until Docker reports that its engine is running and try again.

### `/status` says Lavalink unavailable

Make sure Docker Desktop is running, then:

```powershell
docker compose up -d
docker compose logs --tail 100 lavalink
```

The CI pipeline boots the real Lavalink container and verifies that the YouTube plugin/source manager actually loaded.

### Bot joins but cannot play

Check Lavalink logs first:

```powershell
docker compose logs -f lavalink
```

YouTube changes occasionally require an updated `youtube-source` plugin. Do not enable random YouTube OAuth workarounds with your primary Google account.

### Voice-channel song status does not appear

Grant the bot role **Set Voice Channel Status**, then reconnect/restart playback.

### `/ai` says Gemini is not configured

Put your Google AI Studio API key in `GEMINI_API_KEY`, save `.env`, and restart the bot.

### Gemini fails or times out

Normal `/play` and all ordinary controls still work. AI requests have a timeout, and AI autoplay can fall back to normal source recommendations.

### Buttons say to join the bot's voice channel

Playback-changing buttons are intentionally restricted to users in the same voice channel as the bot. The Queue button is read-only and can be viewed privately without joining.

### Commands do not appear

Verify `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID`, restart the bot, and look for:

```text
[discord] registered 19 guild commands
```

### Update the project later

If you cloned with Git:

```powershell
git pull
npm install
docker compose pull
docker compose up -d
```

Then restart with `start-bot.bat`.

---

## Development validation

GitHub Actions runs:

- Node syntax checks
- a real SQLite-storage startup smoke test
- unit/regression tests on **Ubuntu and Windows** using the minimum safe Node 22.14.0 baseline
- a real **Lavalink Docker startup smoke test**
- a Lavalink `/v4/info` check confirming that the YouTube plugin/source manager loaded

The pull request stays Draft until real playback is also tested in the target Discord server.
