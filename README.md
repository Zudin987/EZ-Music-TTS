# EZ Music

A private, single-server Discord music bot focused on a polished **raw-song** experience with an optional Gemini AI DJ.

## Design rules

- Raw/original playback first.
- **No nightcore, karaoke, 8D, EQ, pitch, speed, bass boost, distortion, or other DSP effects.**
- Normal volume control is retained.
- One-server UX is prioritized over public-bot scale.
- Gemini never sits in the audio path; music still works if Gemini is unavailable.
- The Now Playing panel is intentionally JukeBox-like: compact status, artwork, Up Next, and the controls people actually use.

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

## Voice channel status

While a track is playing, the bot sets the Discord voice-channel status to:

```text
Playing: Song Title • Artist
```

It clears the status when playback stops or the bot leaves. Discord requires the bot role to have **Set Voice Channel Status** permission. When the bot is connected to that voice channel, `Manage Channels` is not required for this operation.

## Autoplay and radio

- Standard autoplay uses source recommendations when available, with a search fallback.
- AI autoplay asks Gemini for a small continuation queue based on recent server listening history.
- `/radio server` builds a longer queue from server listening history, using source recommendations first and Gemini as an optional enhancement/fallback.
- Autoplay modes are mutually exclusive: enabling standard autoplay disables AI autoplay and vice versa.

## Requirements

- Node.js 22.9+
- Docker Desktop **or** another way to run Lavalink 4.2.2
- A Discord bot application
- Optional: a Gemini API key from Google AI Studio

> The Gemini app subscription and Gemini Developer API are separate products. The bot needs a Gemini API key. Leave it blank if you do not want AI features.

## Quick start (Windows)

1. Copy `.env.example` to `.env`.
2. Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID`.
3. Optional: put a Google AI Studio key in `GEMINI_API_KEY`.
4. Start Lavalink:

```powershell
docker compose up -d
```

5. Install and start the bot:

```powershell
npm install
npm start
```

Guild-only slash commands normally appear almost immediately.

## Discord permissions

Invite the bot with the `bot` + `applications.commands` scopes. It needs at least:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Connect
- Speak
- Use Voice Activity
- **Set Voice Channel Status**

No Message Content intent is required.

## Gemini AI DJ

The default model is `gemini-3.5-flash-lite` because the task is lightweight: interpret a music request and return concrete song searches. Change `GEMINI_MODEL` if desired.

```text
Discord request -> Gemini recommends searches -> Lavalink resolves/plays songs -> Discord voice
```
