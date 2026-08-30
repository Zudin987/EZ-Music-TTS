# EZ Music

A private, single-server Discord music bot built for a **maximum-feature free experience without changing the music**.

## Design rules

- Raw-song playback first.
- **No nightcore, karaoke, 8D, EQ, pitch, speed, bass boost, distortion, or other DSP effects.**
- Volume control is retained because it is a basic player control.
- One-server UX is prioritized over massive public-bot scaling.
- Music playback must keep working even if Gemini is unavailable or out of quota.
- Gemini is optional and only helps with natural-language recommendations / queue building.

## Current v0.1 features

- YouTube search/link playback through Lavalink's maintained YouTube plugin.
- SoundCloud, Bandcamp and direct HTTP sources supported by Lavalink.
- Playlists and queueing.
- Pause/resume, skip, previous, seek, volume, loop, shuffle, remove, clear, stop and disconnect.
- Now Playing card with buttons.
- Per-user favorites stored locally in SQLite.
- Server play history stored locally in SQLite.
- Optional Gemini AI DJ: `/ai request:"chill anime piano, no fast songs"`.
- Auto-disconnect after an idle timeout.
- Local-only Lavalink binding in Docker Compose.
- No DSP filters in Lavalink configuration.

## Requirements

- Node.js 22.9+
- Docker Desktop **or** another way to run Lavalink 4.2.2
- A Discord bot application
- Optional: a Gemini API key from Google AI Studio

> Your Gemini app subscription and the Gemini Developer API are separate products. The bot needs a Gemini API key. You can leave it blank and all normal music features still work.

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

The bot registers **guild-only slash commands**, so commands normally appear almost immediately in the configured server.

## Discord permissions

Invite the bot with the `bot` + `applications.commands` scopes. It needs at least:

- View Channels
- Send Messages
- Embed Links
- Connect
- Speak
- Use Voice Activity

No Message Content intent is required.

## Gemini AI DJ

The default model is `gemini-3.5-flash-lite` because this job is lightweight: interpret a music request and return concrete song searches. Change `GEMINI_MODEL` if desired.

Gemini never sits in the audio path:

```text
Discord request -> Gemini recommends searches -> Lavalink resolves/plays songs -> Discord voice
```

If Gemini fails, normal `/play`, queue controls, favorites, history and playback are unaffected.

## Sources / Spotify note

The included LavaSrc plugin is ready for future Spotify/Apple Music metadata resolving, but those sources are disabled by default because they require additional credentials/config and often mirror playback through another source. The first milestone keeps setup reliable and simple.

## Resource target

For one active server, target roughly a few hundred MB total for Node + Lavalink under normal playback. Lavalink is capped at a 512 MB Java heap in `docker-compose.yml`.

## Development

```powershell
npm run check
npm test
```

Development branch: `feature/initial-music-bot`.
