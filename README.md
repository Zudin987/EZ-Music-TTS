# EZ Music

Private single-server Discord music bot focused on raw/original playback, a clean text channel, a private JukeBox-style player panel, server radio, autoplay, and an optional Gemini AI DJ.

## Design rules

- Raw/original playback first.
- No nightcore, karaoke, 8D, EQ, pitch, speed, bass boost, distortion, or other DSP effects.
- Normal volume control is retained and saved persistently per server.
- All slash-command replies and the player panel are ephemeral/private to the person using them, so the music text channel can stay empty.
- Gemini is optional and never sits in the audio path; normal music still works if Gemini is unavailable.
- Lavalink runs natively on Windows. Docker and WSL are not required.
- Lavalink binds to `127.0.0.1` only and generic HTTP-source playback is disabled.
- Listening history stays local in `data/ez-music.sqlite` and is bounded to the newest 5,000 entries per server.

## Commands

`/play` · `/playnext` · `/pause` · `/resume` · `/skip` · `/previous` · `/stop` · `/disconnect` · `/volume` · `/nowplaying` · `/clear` · `/shuffle` · `/loop` · `/autoplay` · `/radio server` · `/ai` · `/help` · `/ping` · `/status`

There is deliberately no public `/queue` slash command. Queue viewing is a private button on the player panel.

### Queue behavior

- `/clear` keeps the current song playing, removes every upcoming track, cancels stale in-flight queue work, and turns loop/autoplay off so the queue stays clear.
- `/stop` stops the current track, clears the upcoming queue and previous-track state, turns loop/autoplay off, and resets a stale paused state.
- Async `/play`, `/ai`, radio, and autoplay work is revision-guarded so an old request cannot silently refill a queue after you clear/stop/disconnect.
- The panel and `/status` label the count as **Up next** so it is not confused with the currently playing track.

## Private player UI

Run:

```text
/nowplaying
```

The response is visible only to you. It shows artwork, title, artist, duration, requester, Up Next, saved volume, loop, autoplay, and upcoming count.

Buttons: Previous · Loop · Pause/Resume · Shuffle · Skip · Queue · Clear · Stop · Autoplay · Vol- · Vol+ · Refresh

`Refresh` updates your private snapshot after another command or a track change.

The Discord voice-channel status is also updated to:

```text
Playing: Song Title • Artist
```

Grant the bot **Set Voice Channel Status** permission for this feature.

---

# Windows setup — no Docker

## Requirements

- Node.js **22.14.0 or newer**
- Java **17 or newer**

Check:

```bat
node -v
java -version
```

## `.env`

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

`DEFAULT_VOLUME` is only the first/default value. Once `/volume` is used, the saved server volume remains across disconnects, bot restarts, and Windows restarts until changed again.

## First setup

Double-click:

```text
setup.bat
```

It verifies Node/Java, downloads and verifies the pinned Lavalink 4.2.2 standalone jar if missing, preserves an existing `.env`, and installs Node dependencies.

## Visible/manual start

```text
start-bot.bat
```

The launcher starts Lavalink as a hidden Java process with a bounded heap, waits for localhost port 2333 to become healthy, then runs the Discord bot in the visible console.

## Fully hidden start

```text
start-hidden.vbs
```

No console window is shown. Launcher output is written to:

```text
logs\launcher.log
```

The hidden log rotates at 5 MiB so unattended operation does not grow it forever.

## Automatic start with Task Scheduler

Double-click:

```text
install-autostart.bat
```

This creates a task named **EZ Music Bot** that:

- runs when the current Windows user signs in
- launches through `start-hidden.vbs`
- uses limited/current-user privileges, not SYSTEM
- stores no Windows password
- ignores duplicate starts
- can restart after unexpected failures

If Windows reports Access Denied, run `install-autostart.bat` as administrator once.

Remove it later with:

```text
remove-autostart.bat
```

## Stop everything

```text
stop-bot.bat
```

For hidden mode, the stop script first requests a graceful Node/Discord/SQLite shutdown. If the exact EZ Music process does not exit in time, it safely force-stops only that matching process. Lavalink is stopped using its recorded PID only after verifying that the PID still belongs to `Lavalink.jar`.

---

# Playback stability

Lavalink uses a single-server stability buffer profile:

```yaml
bufferDurationMs: 1000
frameBufferDurationMs: 10000
```

These are buffering controls, not audio effects. They do not alter pitch, speed, EQ, or the source recording. The extra headroom is intended to absorb short source/network/GC hiccups, especially near track startup.

The Java launcher uses:

```text
-Xms128M -Xmx512M
```

The 512 MB value is a maximum Java heap cap, not guaranteed constant RAM use.

---

# Music sources

- YouTube through the maintained `youtube-source` plugin, pinned to the current August 2026 upstream playback-fix snapshot used by this bot
- SoundCloud
- Bandcamp

The built-in Lavalink YouTube source is disabled. Generic arbitrary HTTP-source playback is also disabled for host/LAN safety.

---

# Status and latency

`/ping` reports **Discord gateway** latency only.

`/status` separates:

- Discord gateway latency
- Lavalink availability
- voice-transport ping while connected
- Gemini state
- autoplay
- saved volume
- player state
- current song
- Up Next count and loop mode

This avoids treating gateway ping as if it were the actual audio/voice latency.

---

# Troubleshooting

### Lavalink does not become ready

Check:

```text
lavalink\lavalink.log
lavalink\lavalink-error.log
```

### Hidden bot is not responding

Check:

```text
logs\launcher.log
```

### Bot joins but cannot play YouTube

YouTube changes periodically. Check the Lavalink logs first; the repository pins a newer upstream `youtube-source` snapshot when the latest formal release is behind YouTube changes.

### Voice-channel song status does not appear

Grant **Set Voice Channel Status** to the bot role and reconnect/restart playback.

### `/ai` says Gemini is not configured

Put a Google AI Studio API key in `GEMINI_API_KEY` and restart the bot.

---

# Development validation

GitHub Actions validates:

- syntax and regression tests on Windows and Ubuntu using Node 22.14.0
- SQLite startup and persistent volume behavior
- private/ephemeral interaction behavior
- hidden-launcher/autostart safety checks
- durable queue-clear/stop race guards
- raw-audio filter policy
- standalone Java 17 Lavalink 4.2.2 startup
- YouTube plugin/source-manager loading through `/v4/info`

PR #1 remains Draft until the real Discord voice/audio/UI acceptance pass is complete.
