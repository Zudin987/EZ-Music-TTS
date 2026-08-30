# EZ Music

Private single-server Discord music bot with raw/original playback, private controls, server radio, autoplay, persistent volume, and an optional Gemini AI DJ.

## Design rules

- Raw/original playback first.
- No nightcore, karaoke, 8D, EQ, pitch, speed, bass boost, distortion, or other DSP effects.
- Volume is the only audio control and is persisted locally until changed again.
- All slash-command replies and the `/nowplaying` control panel are private/ephemeral, so the music text channel can stay empty.
- Gemini is optional and never sits in the audio path.
- Lavalink runs natively on Windows; Docker and WSL are not required.
- Lavalink binds to `127.0.0.1` only.
- Generic Lavalink HTTP playback is disabled so Discord users cannot make the host fetch arbitrary URLs from the PC/LAN.
- Listening history stays local in `data/ez-music.sqlite` and is bounded to the newest 5,000 entries per server.

## Commands

`/play` · `/playnext` · `/pause` · `/resume` · `/skip` · `/previous` · `/stop` · `/disconnect` · `/volume` · `/nowplaying` · `/clear` · `/shuffle` · `/loop` · `/autoplay` · `/radio server` · `/ai` · `/help` · `/ping` · `/status`

There is deliberately no public `/queue` slash command. Queue viewing is a private button on the player panel.

`/volume 35` works even while the bot is disconnected. The value is saved in SQLite and becomes the volume for future sessions until another volume command/button changes it. `/status` always shows the saved volume.

## Private player UI

Run `/nowplaying` while music is playing to open your private JukeBox-style panel. It shows artwork, title, artist, duration, requester, Up Next, volume, loop, autoplay, and queue information.

Buttons: Previous · Loop · Pause/Resume · Shuffle · Skip · Queue · Clear · Stop · Autoplay · Vol- · Vol+

The bot also updates the Discord voice-channel status to:

```text
Playing: Song Title • Artist
```

Grant the bot **Set Voice Channel Status** permission for this feature.

---

# Windows setup — no Docker

## 1. Requirements

- Node.js **22.14.0 or newer**
- Java **17 or newer**

Check in Command Prompt:

```bat
node -v
java -version
```

## 2. Fill `.env`

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

Leave the Lavalink values unchanged for the normal local setup. `DEFAULT_VOLUME` is only the fallback until a saved `/volume` value exists.

## 3. Run setup once

Double-click:

```text
setup.bat
```

It verifies Node/Java, downloads and SHA-256 verifies Lavalink 4.2.2 when needed, preserves an existing `.env`, and installs Node dependencies.

## 4. Normal visible start

Double-click:

```text
start-bot.bat
```

Lavalink runs as a hidden Java process with `-Xms128M -Xmx512M`; the Discord bot runs in the visible console. The launcher refuses to start a duplicate Discord process and verifies that port `2333` is the expected local Lavalink service.

## 5. Hidden start

Double-click:

```text
start-hidden.vbs
```

No console window is shown. Output is written to:

```text
logs\launcher.log
```

The launcher log rotates at 5 MiB to `logs\launcher-old.log`. Lavalink keeps its own logs under `lavalink\`.

## 6. Automatic hidden startup with Task Scheduler

Double-click:

```text
install-autostart.bat
```

It creates a Task Scheduler task named **EZ Music Bot** for the current Windows user. The task:

- starts at Windows sign-in
- runs `start-hidden.vbs`
- uses **Limited** run level rather than Administrator
- stores no Windows password
- ignores duplicate task launches
- can restart the bot after an unexpected failure
- does not stop just because the laptop switches to battery power

If Task Scheduler returns Access Denied, right-click `install-autostart.bat` and choose **Run as administrator** once.

The task intentionally uses **At log on** instead of SYSTEM/boot startup. This is safer for a desktop bot because it inherits your normal Node/Java environment and requires no stored account password.

To remove the scheduled task:

```text
remove-autostart.bat
```

If you move the EZ Music folder later, rerun `install-autostart.bat` so Task Scheduler gets the new path.

## 7. Stop everything

For either visible or hidden mode, run:

```text
stop-bot.bat
```

It stops both the Discord Node process and Lavalink. PID/process checks verify the command lines before terminating them, so stale PID files should not kill unrelated programs. An intentional stop is marked so Task Scheduler does not immediately restart the bot as though it crashed.

---

# Music sources

- YouTube search/videos/playlists through the maintained `youtube-source` plugin.
- The repository currently pins an upstream August 2026 snapshot because formal release 1.18.2 predates recent YouTube Android/iOS/TV playback breakages.
- SoundCloud.
- Bandcamp.
- Generic direct HTTP playback is intentionally disabled for host/LAN safety.

The built-in Lavalink YouTube source remains disabled in favor of the plugin.

# First test

Join a voice channel and run:

```text
/status
/volume 35
/play mirrors justin timberlake
```

Expected: Discord Online, Lavalink Connected, saved volume shown, bot joins voice, music starts, and the voice status shows `Playing: ...`. The text channel itself stays clean because responses are private.

Important regression check:

```text
/loop track
/skip
```

The skip must move on instead of replaying the looped track.

For Gemini AI DJ:

```text
/ai request:chill anime songs, mostly piano, nothing fast
/ai autoplay:on
```

# Troubleshooting

### Hidden bot appears offline

Check:

```text
logs\launcher.log
lavalink\lavalink.log
lavalink\lavalink-error.log
```

### YouTube suddenly stops playing

YouTube regularly changes playback requirements. Check the Lavalink logs first; the pinned `youtube-source` snapshot may need to be advanced again.

### Voice-channel song status does not appear

Grant **Set Voice Channel Status** to the bot role.

### `/ai` says Gemini is not configured

Put a Google AI Studio API key in `GEMINI_API_KEY` and restart the bot.

# Development validation

GitHub Actions validates Node syntax/regression tests on Windows and Ubuntu, SQLite startup/migrations, standalone Lavalink 4.2.2 startup, the official Lavalink jar SHA-256, and loading of the configured YouTube plugin/source manager.

PR #1 remains Draft until real Discord voice playback and hidden-start behavior are accepted on the target Windows machine.
