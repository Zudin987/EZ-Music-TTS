from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8', newline='')


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

# package version
p = read('package.json')
p = replace_once(p, '"version": "0.1.2"', '"version": "0.1.3"', 'package version')
write('package.json', p)

# optional Spotify credentials; no new Node dependency is required
env = read('.env.example')
env = replace_once(
    env,
    '# Optional Gemini AI DJ. Get an API key from Google AI Studio.\n',
    '# Optional Spotify URL metadata/mirroring via LavaSrc. Spotify Web API now requires\n# a Premium-owned developer app in Development Mode. Leave blank to disable.\nSPOTIFY_CLIENT_ID=\nSPOTIFY_CLIENT_SECRET=\nSPOTIFY_COUNTRY_CODE=MY\n\n# Optional Gemini AI DJ. Get an API key from Google AI Studio.\n',
    'env spotify block',
)
write('.env.example', env)

# Node-side config only uses these values to show a friendly status/error. Lavalink
# gets the same values from start-bot.bat without ever putting the secret on the command line.
cfg = read('src/config.js')
cfg = replace_once(
    cfg,
    "  lavalinkSecure: (process.env.LAVALINK_SECURE ?? 'false').toLowerCase() === 'true',\n",
    "  lavalinkSecure: (process.env.LAVALINK_SECURE ?? 'false').toLowerCase() === 'true',\n  spotifyClientId: process.env.SPOTIFY_CLIENT_ID?.trim() || '',\n  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET?.trim() || '',\n",
    'config spotify fields',
)
write('src/config.js', cfg)

# Lavalink: YouTube plugin remains the playback source. LavaSrc only resolves Spotify
# metadata and mirrors it through YTM/YouTube; Spotify audio is never streamed directly.
yml = read('lavalink/application.yml')
yml = replace_once(
    yml,
    '    - dependency: "dev.lavalink.youtube:youtube-plugin:f45bbb7aebfcbc1c553769e04af6cd43afa8b7c3"\n      snapshot: true\n',
    '    - dependency: "dev.lavalink.youtube:youtube-plugin:f45bbb7aebfcbc1c553769e04af6cd43afa8b7c3"\n      snapshot: true\n    - dependency: "com.github.topi314.lavasrc:lavasrc-plugin:4.8.3"\n      repository: "https://maven.lavalink.dev/releases"\n      snapshot: false\n',
    'lavasrc dependency',
)
yml = replace_once(
    yml,
    'plugins:\n  youtube:\n',
    '''plugins:\n  lavasrc:\n    # Spotify is metadata-only/mirrored. It is enabled at launch only when both\n    # SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET exist in .env.\n    providers:\n      - 'ytmsearch:"%ISRC%"'\n      - 'ytmsearch:%QUERY%'\n      - 'ytsearch:"%ISRC%"'\n      - 'ytsearch:%QUERY%'\n    sources:\n      spotify: ${SPOTIFY_ENABLED:false}\n      applemusic: false\n      deezer: false\n      yandexmusic: false\n      flowerytts: false\n      youtube: false\n      vkmusic: false\n      tidal: false\n      qobuz: false\n      ytdlp: false\n      jiosaavn: false\n    lyrics-sources:\n      spotify: false\n      deezer: false\n      youtube: false\n      yandexmusic: false\n      vkmusic: false\n      lrcLib: false\n    spotify:\n      clientId: "${SPOTIFY_CLIENT_ID:}"\n      clientSecret: "${SPOTIFY_CLIENT_SECRET:}"\n      countryCode: "${SPOTIFY_COUNTRY_CODE:MY}"\n      # Keep source responses bounded to the bot's own 300-upcoming queue ceiling.\n      playlistLoadLimit: 3\n      albumLoadLimit: 2\n      resolveArtistsInSearch: false\n      localFiles: false\n      preferPartnerApi: false\n\n  youtube:\n''',
    'lavasrc root config',
)
write('lavalink/application.yml', yml)

# Load only the three Spotify-related .env values into the PowerShell process that
# launches Java. Java inherits them; secrets never appear in the Java command line.
start = read('start-bot.bat')
pattern = re.compile(r'^powershell -NoProfile -ExecutionPolicy Bypass -Command "\$work=\$env:LAVALINK_WORK;.*?Write-Host \(\'Lavalink PID: \'\+\$p.Id\)"$', re.M)
replacement = r'''powershell -NoProfile -ExecutionPolicy Bypass -Command "$work=$env:LAVALINK_WORK; if([string]::IsNullOrWhiteSpace($work)){throw 'LAVALINK_WORK is not set'}; $envFile=Join-Path $env:EZ_MUSIC_ROOT '.env'; $cid=$env:SPOTIFY_CLIENT_ID; $secret=$env:SPOTIFY_CLIENT_SECRET; $country=$env:SPOTIFY_COUNTRY_CODE; if(Test-Path -LiteralPath $envFile){foreach($line in Get-Content -LiteralPath $envFile){if($line -match '^\s*(SPOTIFY_CLIENT_ID|SPOTIFY_CLIENT_SECRET|SPOTIFY_COUNTRY_CODE)\s*=\s*(.*)$'){$name=$matches[1]; $value=$matches[2].Trim(); if($value.Length -ge 2 -and (($value[0] -eq [char]34 -and $value[$value.Length-1] -eq [char]34) -or ($value[0] -eq [char]39 -and $value[$value.Length-1] -eq [char]39))){$value=$value.Substring(1,$value.Length-2)}; if($name -eq 'SPOTIFY_CLIENT_ID'){$cid=$value}elseif($name -eq 'SPOTIFY_CLIENT_SECRET'){$secret=$value}else{$country=$value}}}}; $env:SPOTIFY_CLIENT_ID=[string]$cid; $env:SPOTIFY_CLIENT_SECRET=[string]$secret; if(-not [string]::IsNullOrWhiteSpace($country)){$env:SPOTIFY_COUNTRY_CODE=$country}; if(-not [string]::IsNullOrWhiteSpace($cid) -and -not [string]::IsNullOrWhiteSpace($secret)){$env:SPOTIFY_ENABLED='true'; Write-Host 'Spotify URL mirroring: enabled'}else{$env:SPOTIFY_ENABLED='false'; if((-not [string]::IsNullOrWhiteSpace($cid)) -or (-not [string]::IsNullOrWhiteSpace($secret))){Write-Host '[WARN] Spotify URL mirroring disabled: both SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required.'}}; $out=$env:LAVALINK_LOG; $err=$env:LAVALINK_ERROR_LOG; $pidFile=$env:LAVALINK_PID; $p=Start-Process -FilePath 'java' -ArgumentList '-Xms64M','-Xmx256M','-jar','Lavalink.jar' -WorkingDirectory $work -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru; Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ascii; Write-Host ('Lavalink PID: '+$p.Id)"'''
start, count = pattern.subn(replacement, start, count=1)
if count != 1:
    raise SystemExit('missing patch anchor: start-bot Lavalink command')
write('start-bot.bat', start)

# Music routing: direct URLs/explicit prefixes stay exact; Spotify references go to
# LavaSrc; every other plain text query tries YouTube Music first and normal YouTube
# only when YTM fails or returns no tracks.
music = read('src/music.js')
music = replace_once(
    music,
    '  const recoveryResumes = new Set();\n',
    '''  const recoveryResumes = new Set();\n  const spotifyConfigured = Boolean(config.spotifyClientId && config.spotifyClientSecret);\n\n  function isHttpUrl(value) {\n    try {\n      const url = new URL(String(value || '').trim());\n      return url.protocol === 'http:' || url.protocol === 'https:';\n    } catch {\n      return false;\n    }\n  }\n\n  function isSpotifyReference(value) {\n    const text = String(value || '').trim();\n    if (/^spotify:(track|album|playlist|artist):/i.test(text)) return true;\n    try {\n      const url = new URL(text);\n      const host = url.hostname.toLowerCase();\n      return host === 'open.spotify.com' || host.endsWith('.open.spotify.com') || host === 'spotify.link' || host.endsWith('.spotify.link');\n    } catch {\n      return false;\n    }\n  }\n\n  function hasExplicitSearchPrefix(value) {\n    return /^(?:ytmsearch|ytsearch|scsearch|spsearch):/i.test(String(value || '').trim());\n  }\n\n  async function searchPreferred(target, query, requester) {\n    const clean = String(query || '').trim();\n    if (!clean) throw new Error('Search query is empty.');\n\n    if (isSpotifyReference(clean)) {\n      if (!spotifyConfigured) {\n        throw new Error('Spotify URL support is not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env, then restart EZ Music.');\n      }\n      return target.search(clean, { requester });\n    }\n\n    // Never rewrite direct URLs or an explicitly requested search prefix.\n    if (isHttpUrl(clean) || hasExplicitSearchPrefix(clean)) return target.search(clean, { requester });\n\n    let ytmError = null;\n    try {\n      const ytm = await target.search(clean, { requester, source: 'ytmsearch:' });\n      if (ytm?.tracks?.length) return ytm;\n    } catch (error) {\n      ytmError = error;\n    }\n\n    try {\n      return await target.search(clean, { requester, source: 'ytsearch:' });\n    } catch (error) {\n      throw error || ytmError || new Error(`No results for: ${clean}`);\n    }\n  }\n''',
    'music search router',
)
music = music.replace('result = await player.search(primary, { requester }).catch(() => null);', 'result = await searchPreferred(player, primary, requester).catch(() => null);')
music = music.replace("result = await player.search(`${row.author || ''} ${row.title}`.trim(), { requester }).catch(() => null);", "result = await searchPreferred(player, `${row.author || ''} ${row.title}`.trim(), requester).catch(() => null);")
music = music.replace('batch.map((query) => player.search(query, { requester }).catch(() => null))', 'batch.map((query) => searchPreferred(player, query, requester).catch(() => null))')
music = music.replace('const fallback = await player.search(fallbackQuery, { requester }).catch(() => null);', 'const fallback = await searchPreferred(player, fallbackQuery, requester).catch(() => null);')
music = replace_once(
    music,
    '    getGuildAutoplay: getAutoplayMode,\n',
    '    getGuildAutoplay: getAutoplayMode,\n    searchPreferred,\n    isSpotifyConfigured: () => spotifyConfigured,\n',
    'music API exports',
)
write('src/music.js', music)

# Command paths: /play, /playnext, select:true, saved-library replay, and AI query
# resolution all use the same router. This prevents hidden paths from silently
# reverting to normal YouTube-first behavior.
commands = read('src/commands.js')
commands = replace_once(
    commands,
    'async function searchTracks(player, query, requester) {\n  const result = await player.search(query, { requester });\n',
    'async function searchTracks(player, query, requester, searchPreferred) {\n  const result = await searchPreferred(player, query, requester);\n',
    'commands searchTracks',
)
commands = replace_once(
    commands,
    'async function searchAndQueue(player, query, requester, next, guard, queueTracks, queueLimit, mutate = async (task) => task()) {\n  const { tracks, result } = await searchTracks(player, query, requester);\n',
    'async function searchAndQueue(player, query, requester, next, guard, queueTracks, queueLimit, searchPreferred, mutate = async (task) => task()) {\n  const { tracks, result } = await searchTracks(player, query, requester, searchPreferred);\n',
    'commands searchAndQueue',
)
commands = replace_once(
    commands,
    'async function resolveSearchQueries(player, queries, requester, seen = new Set(), limit = 10, concurrency = 3, guard = () => {}) {\n',
    'async function resolveSearchQueries(player, queries, requester, seen = new Set(), limit = 10, concurrency = 3, guard = () => {}, searchPreferred = null) {\n',
    'resolveSearchQueries signature',
)
commands = replace_once(
    commands,
    '    const results = await Promise.all(batch.map((query) => player.search(query, { requester }).catch(() => null)));\n',
    "    const results = await Promise.all(batch.map((query) => (searchPreferred ? searchPreferred(player, query, requester) : player.search(query, { requester })).catch(() => null)));\n",
    'resolveSearchQueries router',
)
commands = replace_once(
    commands,
    '  resumeRecoverySession,\n}) {\n',
    '  resumeRecoverySession,\n  searchPreferred,\n  isSpotifyConfigured,\n}) {\n',
    'handler routing args',
)
commands = replace_once(
    commands,
    "          `Gemini: **${gemini.enabled ? `Configured (${gemini.model})` : 'Not configured'}**`,\n",
    "          `Gemini: **${gemini.enabled ? `Configured (${gemini.model})` : 'Not configured'}**`,\n          `Spotify URL mirror: **${isSpotifyConfigured() ? 'Configured' : 'Not configured'}**`,\n",
    'status spotify line',
)
commands = replace_once(
    commands,
    "          const result = await music.search(query, { requester: interaction.user });\n",
    "          const result = await searchPreferred(music, query, interaction.user);\n",
    'select search router',
)
commands = replace_once(
    commands,
    '        const queued = await searchAndQueue(player, query, interaction.user, next, guard, queueTracks, queueLimit, (task) => withGuildOperation(interaction.guildId, task));\n',
    '        const queued = await searchAndQueue(player, query, interaction.user, next, guard, queueTracks, queueLimit, searchPreferred, (task) => withGuildOperation(interaction.guildId, task));\n',
    'normal play router',
)
commands = replace_once(
    commands,
    '    const result = await player.search(query, { requester: interaction.user });\n',
    '    const result = await searchPreferred(player, query, interaction.user);\n',
    'library router',
)
commands = replace_once(
    commands,
    '        const resolved = await resolveSearchQueries(player, plan.queries, interaction.user, seen, 10, 3, guard);\n',
    '        const resolved = await resolveSearchQueries(player, plan.queries, interaction.user, seen, 10, 3, guard, searchPreferred);\n',
    'AI router',
)
commands = replace_once(
    commands,
    "    'More: seek/replay plus Favorites and Recent History. `/play select:true` privately lets you choose an exact search result.',\n",
    "    'More: seek/replay plus Favorites and Recent History. `/play select:true` privately lets you choose an exact search result.',\n    'Plain-text song searches try YouTube Music first, then normal YouTube. Spotify URLs work when optional Spotify app credentials are configured.',\n",
    'help routing text',
)
write('src/commands.js', commands)

# setup wording only; credentials remain optional and setup never asks for secrets.
setup = read('setup.bat')
setup = replace_once(
    setup,
    'echo Edit .env with your Discord token, client ID, guild ID, and optional Gemini API key.\n',
    'echo Edit .env with your Discord token, client ID, guild ID, optional Gemini API key, and optional Spotify app credentials.\n',
    'setup wording',
)
write('setup.bat', setup)

# CI smoke: plugin compatibility is checked even without private Spotify credentials.
ci = read('.github/workflows/ci.yml')
ci = replace_once(
    ci,
    "          assert any('youtube' in name for name in plugins), f'YouTube plugin missing: {plugins}'\n          assert any('youtube' in name for name in sources), f'YouTube source manager missing: {sources}'\n          print('Standalone Lavalink and YouTube source manager loaded.')\n",
    "          assert any('youtube' in name for name in plugins), f'YouTube plugin missing: {plugins}'\n          assert any('lavasrc' in name for name in plugins), f'LavaSrc plugin missing: {plugins}'\n          assert any('youtube' in name for name in sources), f'YouTube source manager missing: {sources}'\n          print('Standalone Lavalink, YouTube source manager, and LavaSrc plugin loaded.')\n",
    'CI LavaSrc smoke',
)
write('.github/workflows/ci.yml', ci)

# README: append concise behavior/credential notes. Spotify's current Development
# Mode restrictions are important enough to document rather than hide behind errors.
readme = read('README.md')
readme += '''\n\n## Search routing and Spotify URLs (v0.1.3)\n\nPlain-text `/play` and `/playnext` searches now try **YouTube Music first** and fall back to normal **YouTube** only when YTM returns no usable result or errors. Direct URLs and explicit prefixes such as `ytsearch:` / `ytmsearch:` are never rewritten. `select:true` uses the same routing, so its private top-five picker is YTM-first too.\n\nSpotify links are metadata/mirroring only: LavaSrc resolves Spotify track/album/playlist metadata, then finds playable audio through YouTube Music first and normal YouTube second. EZ Music never streams Spotify audio directly. Add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to `.env` to enable this; leave both blank to keep Spotify disabled. The launcher passes those values only through the Lavalink child process environment, not on the Java command line.\n\nSpotify's 2026 Web API Development Mode requires the developer-app owner to have Spotify Premium. Development Mode playlist contents are also restricted to playlists the app user owns or collaborates on, so arbitrary public Spotify playlist URLs may require Extended Quota Mode; individual track/album URLs are the safer personal-bot use case.\n'''
write('README.md', readme)

# Static regression tests for routing/security/lean-runtime invariants.
test = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const music = fs.readFileSync('src/music.js', 'utf8');
const commands = fs.readFileSync('src/commands.js', 'utf8');
const config = fs.readFileSync('src/config.js', 'utf8');
const envExample = fs.readFileSync('.env.example', 'utf8');
const lavalink = fs.readFileSync('lavalink/application.yml', 'utf8');
const launcher = fs.readFileSync('start-bot.bat', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('plain text routing is YTM-first with normal YouTube fallback', () => {
  const ytm = music.indexOf("source: 'ytmsearch:'");
  const yt = music.indexOf("source: 'ytsearch:'");
  assert.ok(ytm >= 0, 'ytmsearch route missing');
  assert.ok(yt > ytm, 'ytsearch fallback must come after ytmsearch');
  assert.match(music, /isHttpUrl\(clean\) \|\| hasExplicitSearchPrefix\(clean\)/);
  assert.match(commands, /searchPreferred\(music, query, interaction\.user\)/);
  assert.match(commands, /searchAndQueue\([^\n]+searchPreferred/);
});

test('Spotify is optional, credential-gated, and mirrored YTM before YouTube', () => {
  assert.equal(pkg.version, '0.1.3');
  assert.match(envExample, /SPOTIFY_CLIENT_ID=/);
  assert.match(envExample, /SPOTIFY_CLIENT_SECRET=/);
  assert.match(config, /spotifyClientId/);
  assert.match(config, /spotifyClientSecret/);
  assert.match(lavalink, /lavasrc-plugin:4\.8\.3/);
  assert.match(lavalink, /spotify:\s*\$\{SPOTIFY_ENABLED:false\}/);
  const ytmProvider = lavalink.indexOf("ytmsearch:%QUERY%");
  const ytProvider = lavalink.indexOf("ytsearch:%QUERY%");
  assert.ok(ytmProvider >= 0 && ytProvider > ytmProvider, 'Spotify mirroring must prefer YTM before YouTube');
  assert.match(music, /Spotify URL support is not configured/);
});

test('launcher passes Spotify secrets via child environment, not Java arguments', () => {
  assert.match(launcher, /SPOTIFY_CLIENT_ID/);
  assert.match(launcher, /SPOTIFY_CLIENT_SECRET/);
  assert.match(launcher, /SPOTIFY_ENABLED='true'/);
  assert.doesNotMatch(launcher, /-DSPOTIFY_CLIENT_SECRET|--plugins\.lavasrc\.spotify\.clientSecret/i);
});

test('new source support does not enable DSP or generic HTTP/local playback', () => {
  assert.match(lavalink, /http:\s*false/);
  assert.match(lavalink, /local:\s*false/);
  for (const filter of ['equalizer', 'karaoke', 'timescale', 'tremolo', 'vibrato', 'distortion', 'rotation', 'channelMix', 'lowPass']) {
    assert.match(lavalink, new RegExp(`${filter}:\\s*false`, 'i'));
  }
});
'''
write('test/source-routing.test.js', test)

print('source routing patch applied')
