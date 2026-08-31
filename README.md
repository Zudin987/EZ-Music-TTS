# EZ Music

Private single-server Discord music bot focused on raw/original playback, a clean text channel, a shared silent Now Playing JukeBox, private detailed controls, server radio, autoplay, and an optional Gemini AI DJ.

## Design rules

- Raw/original playback first.
- No nightcore, karaoke, 8D, EQ, pitch, speed, bass boost, distortion, or other DSP effects.
- Normal volume control is retained and saved persistently per server.
- `/nowplaying` is the only public response and uses Discord's suppress-notifications flag. All other slash-command replies, detailed menus, confirmations, and errors remain ephemeral/private.
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
- Async `/play`, `/ai`, radio, autoplay, and `select:true` picker actions are revision-guarded so an old request cannot silently refill/reconnect after you clear/stop/disconnect.
- The panel and `/status` label the count as **Up next** so it is not confused with the currently playing track.

## Shared Now Playing + private detailed UI

Run:

```text
/nowplaying
```

The response is public so everyone in the music channel can see the current player, but it is sent with Discord's **Suppress Notifications** flag. The player uses Discord Components V2: artwork, metadata, status, and control buttons live inside one colored JukeBox container instead of buttons floating below a legacy embed. Discord can still mark a channel unread for a new public message; the API does not provide a flag that guarantees a visible public message never affects unread state.

Buttons: Previous · Loop · Pause/Resume · Shuffle · Skip · Queue · Clear · Stop · Autoplay · Vol- · Vol+ · Favorite · More · Refresh

`Queue` opens a private Queue Manager with 25-track pages, a track selector, Remove, Move Next, Play Now, stronger duplicate cleanup, and refresh/back controls. `More` and personal Favorite confirmations also stay private even when opened from the public Now Playing panel. Clear/Remove/Dedupe keep one bounded **5-minute Undo** snapshot so accidental queue changes can be reversed without another service.

`Favorite` saves/removes the currently displayed song from your personal SQLite favorites. The button is fingerprinted to the displayed track, so an old private panel cannot accidentally favorite a different song after the track changes.

`More` opens private seek/replay controls (`-30s`, `-10s`, Replay, `+10s`, `+30s`, and exact seek), plus **Recent History** and **Favorites** browsers.

While the main `/nowplaying` JukeBox view is open, its progress/current-track/status display refreshes about every **10 seconds**. Public panels use one shared live lease per server, while private sub-views keep per-user leases so opening Queue/More never turns those details public or evicts the shared panel. Each interaction-backed lease retires after about **14 minutes** and leaves a notice telling you to press Refresh to resume. The registry is capped at 32 live panels and uses one lazy timer only while at least one live panel exists; it adds no service or audio-processing process.

For ambiguous text searches, `/play ... select:true` and `/playnext ... select:true` open a private top-5 result picker for 2 minutes. Direct URLs/playlists remain immediate. The picker is bounded in memory, has no background timer, and is tied to the queue revision that created it, so an old picker cannot resurrect playback after Clear/Stop/Disconnect.

The Discord voice-channel status is also updated to:

```text
Playing: Song Title • Artist
```

Grant the bot **Set Voice Channel Status** permission for this feature.

---


## Crash/restart recovery

Live sessions are checkpointed to the existing local SQLite database with no Redis/MongoDB or extra process. The snapshot contains the current track, saved position, up to 300 upcoming/preserved tracks, volume, loop/autoplay state, and paused state. Position-only checkpoints are throttled to roughly every 15 seconds so the bot does not constantly rewrite the whole queue.

Recovery is deliberately **opt-in**: after an unexpected bot/Windows restart, EZ Music never auto-joins a voice channel. Run `/status`; if a recent (under 24 hours) session exists, private **Resume Session** and **Discard Session** buttons appear. Join the voice channel where you want playback, then press Resume. The current track and an initial batch restore first; a larger saved queue resolves in guarded background batches.

A clean Discord `/stop`, `/disconnect`, natural completed queue, or 2-minute empty-room auto-leave clears obsolete recovery state. Active playback pauses immediately when the last human leaves; if a human returns during that 2-minute grace window, only that automatic pause is resumed. A manual `/pause` is never auto-resumed. Process shutdown/restart preserves a useful live session. During a prolonged source outage, held queue state remains recoverable instead of being discarded merely because the idle player later times out.

## Lightweight library and race safety

- **Recent History:** private browser over the existing bounded 5,000-entry server history, with Play / Play Next / Favorite actions.
- **Favorites:** personal per-user favorites stored in SQLite; no additional daemon or cache.
- **Stronger dedupe:** normalizes common upload labels such as Official Video/Audio, Lyrics, Topic and VEVO while keeping meaningful variants such as Live, Remix, Acoustic, Instrumental, Sped Up and Slowed distinct.
- **Per-guild operation serialization:** destructive queue/playback changes are serialized so rapid button/command bursts cannot mutate the same queue concurrently.
- **First-player creation guard:** simultaneous first-use commands share one voice-player creation promise, preventing duplicate Shoukaku/Kazagumo connection races.

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

Only the three Discord values are mandatory. Gemini is optional. Single Spotify **track** links also work without Spotify credentials through the official oEmbed metadata endpoint and are mirrored through the existing YTM/YouTube search path. Spotify album/playlist importing still needs working LavaSrc Spotify credentials.

```dotenv
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_server_id

# Optional Spotify album/playlist mirroring (Premium-owned developer app required)
# Single track links work without credentials via oEmbed -> YTM/YouTube
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_COUNTRY_CODE=MY

GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite

DEFAULT_VOLUME=80
AUTO_DISCONNECT_MINUTES=10
```

The bundled Lavalink connection is intentionally fixed to localhost (`127.0.0.1:2333`) with an internal local-only password so Node and `application.yml` cannot drift apart.

`DEFAULT_VOLUME` is only the first/default value. Once `/volume` is used, the saved server volume remains across disconnects, bot restarts, and Windows restarts until changed again.

## First setup

Double-click:

```text
setup.bat
```

It verifies Node/Java, downloads and verifies the pinned Lavalink 4.2.2 standalone jar if missing, preserves an existing `.env`, and installs the exact locked Node dependency tree with `npm ci`.

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

For hidden mode, the stop script first requests a graceful Node/Discord/SQLite shutdown. If the exact EZ Music process does not exit in time, it safely force-stops only that matching process. Lavalink is stopped using its recorded PID only after verifying both `Lavalink.jar` and an install-specific JVM marker, preventing a stale PID from targeting another Lavalink instance.

---

# Playback stability

Lavalink uses a single-server stability buffer profile:

```yaml
nonAllocatingFrameBuffer: true
bufferDurationMs: 2000
frameBufferDurationMs: 20000
youtubePlaylistLoadLimit: 3
```

These are buffering controls, not audio effects. They do not alter pitch, speed, EQ, or the source recording. The extra 2-second non-allocating buffer and 20-second frame buffer are intended to absorb short source/network/GC hiccups, especially near track startup, while staying comfortably within the existing 256 MB Lavalink heap cap for this single-server bot.

The low-memory launcher uses:

```text
Lavalink: -Xms64M -Xmx256M
Node: --max-old-space-size=128
```

Lavalink also enables `nonAllocatingFrameBuffer: true`, disables routine REST request logging, and limits YouTube playlist loading to 3 pages. The bot separately caps the live upcoming queue at **300 tracks** and a single playlist request at **250 tracks**. These controls are intended to keep the single-server stack comfortably lean; JVM heap limits are not identical to total Windows process working-set RAM.

---

## Lightweight reliability features

- **Queue ceiling:** maximum 300 upcoming tracks; a single playlist adds at most 250.
- **Empty-room auto-pause/leave:** when the last human listener leaves during active playback, EZ Music pauses immediately to stop unnecessary audio work. If a human returns within 2 minutes, playback resumes from that automatic pause; manual pauses stay paused. If the room remains empty for 2 minutes, the existing disconnect/reset cleanup runs.
- **Source circuit breaker:** three early playback/resolve failures inside 60 seconds pause automatic queue consumption, disable autoplay/loop, preserve remaining upcoming tracks in memory, and retry once after a cooldown instead of burning through the whole queue. A stable track for 20 seconds resets the failure window. Preserved tracks are also included in crash-recovery checkpoints.
- **Spotify track fallback is bounded:** oEmbed metadata lookup uses the existing Node process only, has a 2.5-second timeout and 64 KiB response ceiling, then reuses the normal YTM -> YouTube search path. It never enters the live Lavalink audio stream.
- **GC pause diagnostics:** Lavalink GC warnings are enabled so a future Java pause can be correlated with frame starvation without adding a monitor/service or changing the buffer profile.
- **No extra services:** no Docker, WSL, MongoDB, Redis, browser dashboard, FFmpeg sidecar, Python worker, or local AI process is introduced.

# Music sources

- YouTube through the maintained `youtube-source` plugin, pinned to the current August 2026 upstream playback-fix snapshot used by this bot. Client order is kept short and Opus-capable: `MUSIC` (search only) → `ANDROID_VR` → `WEB` → `WEBEMBEDDED`, matching the current upstream example and avoiding known failed/restricted/transcoding-prone clients before playback.
- Spotify single-track links through official oEmbed metadata -> YTM/YouTube audio; no Spotify credentials are required for this fallback. If working Spotify/LavaSrc credentials exist, direct metadata mirroring is tried first and a failed track lookup falls back automatically. Album/playlist importing still requires those credentials. `spotify.link` short links are canonicalized through oEmbed.
- SoundCloud
- Bandcamp

The built-in Lavalink YouTube source is disabled. Generic arbitrary HTTP-source playback is also disabled for host/LAN safety.

---

# Status and latency

`/ping` reports **Discord gateway** latency only.

`/status` separates:

- Discord gateway latency
- Lavalink availability
- voice-transport ping while connected, plus a lightweight local quality grade (`Excellent` <60 ms, `Good` <120 ms, `Elevated` <200 ms, otherwise `Poor`; this is an EZ Music diagnostic heuristic, not an official Discord grade)
- Gemini state
- Spotify URL mirror state
- autoplay
- saved volume
- player state
- current song
- Up Next count and loop mode
- Node RSS / heap usage
- Lavalink JVM memory and CPU stats
- live audio frame counters (`sent`, `nulled`, `deficit`) plus a smooth/frame-starvation indicator
- playback-source health / preserved-queue protection state
- recoverable-session controls when the bot is disconnected
- private Recent History and Favorites entry points

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
- SQLite startup, persistent volume, favorites, history paging, and crash-recovery round trips
- private/ephemeral interaction behavior
- hidden-launcher/autostart safety checks, including install-specific Lavalink PID identity
- durable queue-clear/stop race guards, queue undo, search-picker bounds, and per-guild operation serialization
- raw-audio filter policy
- standalone Java 17 Lavalink 4.2.2 startup
- YouTube plugin/source-manager loading through `/v4/info`



## Search/playback fallback reliability (v0.1.10)

Title-only searches that produce an exact but artist-ambiguous YouTube Music result now compare normal YouTube before choosing, preventing same-title uploads from unrelated channels from silently winning. Current youtube-source can still hit YouTube's credential/login/SABR block even for the correct video; when that known all-clients failure occurs, EZ Music now searches the already-enabled SoundCloud source for a relevance-checked standard version of the same title and replaces the failed YouTube item automatically. Other playback exceptions can still try one alternate normal-YouTube result before SoundCloud. The short upstream-recommended YouTube client chain is retained because live testing showed extra MWEB/ANDROID_MUSIC clients hit the same login block. No OAuth, poToken worker, yt-dlp, DSP, heap increase, or extra process is introduced.

## Search/start reliability (v0.1.9)

Plain-text YTM results now need to resemble the requested title/artist. Weak YTM matches fall through to normal YouTube instead of silently queueing an unrelated song; weak results from both sources are reported as no result. Idle queue starts use Lavalink's actual track state rather than only Kazagumo's wrapper playing flag, and a resolve failure can no longer be reported as a successful queue/start. `/nowplaying` also shows a queue-waiting panel when tracks exist but no current item is active.

## Search routing and Spotify URLs (v0.1.4)

Plain-text `/play` and `/playnext` searches now try **YouTube Music first** and fall back to normal **YouTube** only when YTM returns no usable result or errors. Direct URLs and explicit prefixes such as `ytsearch:` / `ytmsearch:` are never rewritten. `select:true` uses the same routing, so its private top-five picker is YTM-first too.

Spotify links are metadata/mirroring only: LavaSrc resolves Spotify track/album/playlist metadata, then finds playable audio through YouTube Music first and normal YouTube second. EZ Music now strictly accepts only Spotify **track, album, and playlist** references (including normal locale-prefixed `open.spotify.com` links) and rejects artist/episode/show/malformed objects before they reach Lavalink. Use full `open.spotify.com` URLs; LavaSrc 4.8.3 does not document `spotify.link` short URLs, so EZ Music rejects those with a clear message instead of silently misrouting them. EZ Music never streams Spotify audio directly. Add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to `.env` to enable this; leave both blank to keep Spotify disabled. The launcher passes those values only through the Lavalink child process environment, not on the Java command line.

Spotify's 2026 Web API Development Mode requires the developer-app owner to have Spotify Premium. Development Mode playlist contents are also restricted to playlists the app user owns or collaborates on, so arbitrary public Spotify playlist URLs may require Extended Quota Mode; individual track/album URLs are the safer personal-bot use case.

## Three-choice typed search (v0.1.11)

Typed `/play <song name>` and `/playnext <song name>` requests now stay private and show up to **3 choices before anything is queued**. EZ Music searches normal YouTube with a `lyrics` bias, YouTube Music, and normal YouTube concurrently, then relevance-filters and deduplicates exact media IDs. Lyrics and official-audio style uploads are preferred over M/V uploads when the user did not ask for a video, while cover/remix/karaoke/instrumental/etc. filtering remains active. The picker intentionally keeps distinct Lyrics/Audio/M/V uploads selectable instead of collapsing them as queue duplicates. Direct YouTube, Spotify, and SoundCloud URLs still resolve immediately without a picker. These are short metadata searches only; they do not add a process, cache service, DSP, playback buffer, or background polling.

## Ghost playback start fix (v0.1.12)

Playback start/recovery now verifies that Lavalink/Shoukaku's active encoded track is the **same encoded track as Kazagumo's current queue item**. A stale non-empty Shoukaku track from an earlier failed/replaced source can no longer make EZ Music show a new song at 0:00 without ever sending it to Lavalink. Typed picker choices, direct URLs and `/nowplaying` recovery all use the corrected start gate; `/status` only reports **Playing** for an exact active/current match. Manual pause protection remains intact. This fix does not change buffers, DSP, heap caps, source clients or add background polling.


## YouTube fallback race fix (v0.1.13)

When YouTube metadata/search works but playback is rejected by every anonymous playback client, EZ Music temporarily holds upcoming tracks before Kazagumo can auto-advance through them. It then tries a bounded SoundCloud fallback using up to three cleaned queries (for example, noisy `ADO - NEW GENESIS ... OST | Lirik & Terjemahan` metadata is reduced to `Ado New Genesis`). A successful fallback restores the held queue in its original order; a manual Skip cancels the pending fallback and continues safely. New queue additions made while fallback is running join the temporary hold instead of racing it.

Recent History now records a track only after Lavalink reports at least 2 seconds of real playback progress. A `TrackStart` immediately followed by YouTube login/SABR failure no longer appears as a successfully heard song.

This hotfix intentionally keeps the existing single-process Node + single local Lavalink architecture. It does not enable YouTube OAuth, add a remote poToken/webpo service, alter the YouTube client chain, enable DSP, or change the existing buffer/heap caps.


## Transport lifecycle hardening (v0.1.14)

EZ Music now treats Lavalink-node state, Discord voice-WebSocket state, and track-event identity as separate lifecycle signals instead of assuming a cached Kazagumo player is healthy. Shoukaku 4.3.0's multi-attempt reconnect bug is avoided by using one library reconnect attempt at a time plus a tiny event-driven local-node supervisor with bounded backoff. If the local Lavalink session is genuinely lost, live players are snapshotted to SQLite and retired rather than left as ghost players; `/status` exposes reconnecting/unavailable node state and `/play` refuses to queue into a dead node.

Discord voice-WebSocket closes are also watched: close codes that Discord says should not reconnect retire the stale player immediately, while other closes get a short recovery grace window and are retired only if no connected player update arrives. Lavalink v4's event-provided Track object is used to reject late TrackException/TrackStuck events from a previous song, preventing a stale event from skipping or source-fallbacking the new current song.

This hardening is event-driven and adds no polling service, audio filters, extra Lavalink node, buffer increase, or heap increase.
