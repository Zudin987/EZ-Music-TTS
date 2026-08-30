# EZ Music

Private single-server Discord music bot with raw/original playback, a JukeBox-style player panel, server radio, autoplay, and an optional Gemini AI DJ.

## Important design rules

- Raw/original playback first.
- No nightcore, karaoke, 8D, EQ, pitch, speed, bass boost, distortion, or other DSP effects.
- Normal volume control is retained.
- Gemini is optional and never sits in the audio path; normal music still works if Gemini is unavailable.
- Lavalink runs **natively on Windows**. Docker and WSL are not required.
- Lavalink binds to `127.0.0.1` only and is not exposed to your LAN.
- Listening history stays local in `data/ez-music.sqlite` and is bounded to the newest 5,000 entries per server.

## Commands

`/play` · `/playnext` · `/pause` · `/resume` · `/skip` · `/previous` · `/stop` · `/disconnect` · `/volume` · `/nowplaying` · `/clear` · `/shuffle` · `/loop` · `/autoplay` · `/radio server` · `/ai` · `/help` · `/ping` · `/status`

There is deliberately no public `/queue` slash command. Queue viewing is a private button on the player panel.

## Player UI

The persistent Now Playing panel is edited as tracks change instead of posting a new control panel every song. It shows artwork, title, artist, duration, requester, Up Next, volume, loop, autoplay, and queue summary.

Buttons: Previous · Loop · Pause/Resume · Shuffle · Skip · Queue · Clear · Stop · Autoplay · Vol- · Vol+

The voice-channel status is updated to:

```text
Playing: Song Title • Artist
```

Grant the bot **Set Voice Channel Status** permission for this feature.

---

# Windows setup — no Docker

## 1. Install Node.js

Install **Node.js 22.14.0 or newer**. A current Node 22 LTS or newer release is recommended.

Check in Command Prompt:

```bat
node -v
```

## 2. Install Java

Lavalink 4 requires **Java 17 or newer**. A normal JRE is enough; you do not need a full development environment.

Recommended: Eclipse Temurin 17 JRE.

After installing Java, close and reopen Command Prompt/File Explorer windows if necessary, then check:

```bat
java -version
```

You should see version 17 or newer.

## 3. Fill `.env`

Only the three Discord values are mandatory. Gemini is optional.

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

Leave the Lavalink values unchanged for the normal local setup.

## 4. Run `setup.bat` once

Double-click:

```text
setup.bat
```

It will:

- verify Node.js 22.14+
- verify Java 17+
- download the pinned **Lavalink 4.2.2** standalone jar (~100 MB) if missing
- verify the official jar with its SHA-256 digest
- preserve an existing `.env`
- run `npm install`

No Docker Desktop, Docker daemon, Hyper-V, or WSL is needed.

## 5. Start the bot

Double-click:

```text
start-bot.bat
```

The launcher starts Lavalink as a hidden native Java process with:

```text
-Xms128M -Xmx512M
```

It waits until `http://127.0.0.1:2333` is actually ready, then starts the Discord bot in the visible console.

If port `2333` is already occupied by another program, the launcher stops instead of silently connecting to an unknown service.

## 6. First Discord test

Join the voice channel and run:

```text
/status
/play mirrors justin timberlake
```

Expected:

- Discord: Online
- Lavalink: Connected
- bot joins your voice channel
- music starts
- JukeBox-style Now Playing panel appears
- voice-channel status changes to `Playing: ...`

Then test:

```text
/playnext another song
/shuffle
/loop track
/skip
/volume 50
/autoplay on
```

Important regression check: `/loop track` followed by `/skip` must actually skip instead of restarting the same track.

For Gemini AI DJ:

```text
/ai request:chill anime songs, mostly piano, nothing fast
/ai autoplay:on
```

For server radio, play several songs first so there is listening history, then:

```text
/radio server
```

## 7. Stop everything

Normally press **Ctrl+C** in the bot console. The launcher attempts to stop the Lavalink process that it started when the Node process exits.

If Lavalink remains running, double-click:

```text
stop-bot.bat
```

The stop script checks that the saved PID still belongs to a Java command running `Lavalink.jar` before it kills anything, so a stale PID file cannot kill an unrelated process.

---

# Resource use

This native setup avoids Docker/WSL overhead. Lavalink is launched with a 512 MB maximum Java heap. The actual Java process normally uses less than that when lightly loaded, while the Node bot adds its own smaller memory footprint.

The 512 MB value is a **maximum heap cap**, not guaranteed constant RAM use.

---

# Music sources

Default Lavalink sources:

- YouTube search/videos/playlists through `youtube-source` 1.18.2
- SoundCloud
- Bandcamp
- direct HTTP audio supported by Lavalink

The built-in Lavalink YouTube source is disabled in favor of the maintained plugin.

# Troubleshooting

### `setup.bat` says Java is missing

Install Java 17+ and then run `setup.bat` again. `java -version` must work from a new Command Prompt.

### Lavalink does not become ready

Look at:

```text
lavalink\lavalink.log
lavalink\lavalink-error.log
```

The launcher prints the most recent lines automatically when startup times out.

### Bot joins but cannot play YouTube

Check the Lavalink logs. YouTube changes occasionally require a newer `youtube-source` plugin.

### Voice-channel song status does not appear

Grant **Set Voice Channel Status** to the bot role and reconnect/restart playback.

### `/ai` says Gemini is not configured

Put a Google AI Studio API key in `GEMINI_API_KEY` and restart the bot. The key may be the same one used by another local project, but quotas are shared by Google project/model as applicable.

# Development validation

GitHub Actions validates:

- Node syntax and regression tests on Ubuntu and Windows using Node 22.14.0
- SQLite startup
- standalone Java 17 Lavalink 4.2.2 startup
- official Lavalink jar SHA-256
- YouTube plugin/source-manager loading through `/v4/info`

PR #1 remains Draft until real Discord voice playback is tested on the target server.
