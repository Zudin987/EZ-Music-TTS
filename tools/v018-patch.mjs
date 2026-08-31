import fs from 'node:fs';

const path = 'README.md';
let text = fs.readFileSync(path, 'utf8');

function replaceOnce(from, to, label) {
  if (!text.includes(from)) throw new Error(`README anchor missing: ${label}`);
  text = text.replace(from, to);
}

replaceOnce(
  'Only the three Discord values are mandatory. Gemini is optional.\n',
  'Only the three Discord values are mandatory. Gemini is optional. Single Spotify **track** links also work without Spotify credentials through the official oEmbed metadata endpoint and are mirrored through the existing YTM/YouTube search path. Spotify album/playlist importing still needs working LavaSrc Spotify credentials.\n',
  'env introduction',
);

replaceOnce(
  '# Optional Spotify URL metadata/mirroring (Spotify developer app required)\n',
  '# Optional Spotify album/playlist mirroring (Premium-owned developer app required)\n# Single track links work without credentials via oEmbed -> YTM/YouTube\n',
  'env Spotify comment',
);

replaceOnce(
  '- SoundCloud\n- Bandcamp\n',
  '- Spotify single-track links through official oEmbed metadata -> YTM/YouTube audio; no Spotify credentials are required for this fallback. If working Spotify/LavaSrc credentials exist, direct metadata mirroring is tried first and a failed track lookup falls back automatically. Album/playlist importing still requires those credentials. `spotify.link` short links are canonicalized through oEmbed.\n- SoundCloud\n- Bandcamp\n',
  'source list',
);

replaceOnce(
  '- **No extra services:** no Docker, WSL, MongoDB, Redis, browser dashboard, FFmpeg sidecar, Python worker, or local AI process is introduced.\n',
  '- **Spotify track fallback is bounded:** oEmbed metadata lookup uses the existing Node process only, has a 2.5-second timeout and 64 KiB response ceiling, then reuses the normal YTM -> YouTube search path. It never enters the live Lavalink audio stream.\n- **GC pause diagnostics:** Lavalink GC warnings are enabled so a future Java pause can be correlated with frame starvation without adding a monitor/service or changing the buffer profile.\n- **No extra services:** no Docker, WSL, MongoDB, Redis, browser dashboard, FFmpeg sidecar, Python worker, or local AI process is introduced.\n',
  'reliability list',
);

fs.writeFileSync(path, text);
