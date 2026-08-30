from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(text, encoding='utf-8', newline='\n')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)

# package.json: version + syntax checks for new tiny guard modules.
p = read('package.json')
p = replace_once(p, '"version": "0.1.6"', '"version": "0.1.7"', 'package version')
p = replace_once(
    p,
    'node --check src/live-panel.js && node --check src/performance.js',
    'node --check src/live-panel.js && node --check src/performance.js && node --check src/search-picker.js && node --check src/shutdown.js',
    'package check script',
)
write('package.json', p)

# Local Lavalink is intentionally fixed. Do not advertise env knobs that the bundled server does not consume.
p = read('src/config.js')
p = replace_once(p, "  lavalinkUrl: process.env.LAVALINK_URL?.trim() || 'localhost:2333',\n  lavalinkPassword: process.env.LAVALINK_PASSWORD?.trim() || 'ezmusic-local-only',\n  lavalinkSecure: (process.env.LAVALINK_SECURE ?? 'false').toLowerCase() === 'true',", "  // Bundled Lavalink is a fixed localhost-only service. Keeping one source of\n  // truth avoids a misleading .env value that would desync Node from application.yml.\n  lavalinkUrl: 'localhost:2333',\n  lavalinkPassword: 'ezmusic-local-only',\n  lavalinkSecure: false,", 'fixed lavalink config')
write('src/config.js', p)

p = read('.env.example')
p = replace_once(p, "\n# Local Lavalink\nLAVALINK_URL=localhost:2333\nLAVALINK_PASSWORD=ezmusic-local-only\nLAVALINK_SECURE=false\n", "\n# Bundled Lavalink is intentionally fixed to 127.0.0.1:2333 with a local-only\n# internal password, so there are no user-editable Lavalink connection values.\n", 'env lavalink section')
write('.env.example', p)

# Search picker registry: bounded, owner-scoped, revision-aware.
write('src/search-picker.js', """import { randomBytes } from 'node:crypto';

export const SEARCH_PICKER_TTL_MS = 120_000;
export const SEARCH_PICKER_MAX = 32;

export function createSearchPickerRegistry({
  ttlMs = SEARCH_PICKER_TTL_MS,
  maxEntries = SEARCH_PICKER_MAX,
  now = () => Date.now(),
  tokenFactory = () => randomBytes(6).toString('base64url'),
} = {}) {
  const entries = new Map();
  const safeTtl = Math.max(1, Number(ttlMs) || SEARCH_PICKER_TTL_MS);
  const safeMax = Math.max(1, Math.floor(Number(maxEntries) || SEARCH_PICKER_MAX));

  function purge() {
    const current = Number(now());
    const safeNow = Number.isFinite(current) ? current : Date.now();
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= safeNow) entries.delete(token);
    }
    while (entries.size > safeMax) entries.delete(entries.keys().next().value);
  }

  function create({ guildId, userId, tracks, next = false, revision = 0 }) {
    purge();
    const token = String(tokenFactory());
    const current = Number(now());
    const safeNow = Number.isFinite(current) ? current : Date.now();
    entries.set(token, {
      guildId: String(guildId || ''),
      userId: String(userId || ''),
      tracks: Array.isArray(tracks) ? tracks.slice(0, 5) : [],
      next: Boolean(next),
      revision: Number(revision) || 0,
      expiresAt: safeNow + safeTtl,
    });
    purge();
    return token;
  }

  function getOwned({ guildId, userId, token }) {
    purge();
    const entry = entries.get(String(token || ''));
    if (!entry || entry.guildId !== String(guildId || '') || entry.userId !== String(userId || '')) return null;
    return entry;
  }

  function isCurrent(entry, revision) {
    return Boolean(entry && Number(entry.revision) === Number(revision));
  }

  return {
    create,
    getOwned,
    isCurrent,
    delete: (token) => entries.delete(String(token || '')),
    size: () => { purge(); return entries.size; },
  };
}
""")

# Shared shutdown promise: every signal waits for the same cleanup instead of a second signal exiting early.
write('src/shutdown.js', """export function createShutdownCoordinator(cleanup) {
  if (typeof cleanup !== 'function') throw new TypeError('Shutdown coordinator requires a cleanup function.');
  let activePromise = null;

  return {
    run(signal) {
      if (!activePromise) activePromise = Promise.resolve().then(() => cleanup(signal));
      return activePromise;
    },
    isRunning() {
      return activePromise !== null;
    },
  };
}
""")

# commands.js: move picker storage into revision-aware registry and reject stale picker before ensurePlayer().
p = read('src/commands.js')
p = replace_once(p, "import { randomBytes } from 'node:crypto';\n", '', 'remove randomBytes import')
p = replace_once(p, "import { voiceTransportQuality } from './performance.js';\n", "import { voiceTransportQuality } from './performance.js';\nimport { createSearchPickerRegistry } from './search-picker.js';\n", 'search picker import')
p = replace_once(p, "const SEARCH_PICKER_TTL_MS = 120_000;\n", '', 'remove picker ttl constant')
p = replace_once(p, "const searchPickers = new Map();\n", "const searchPickers = createSearchPickerRegistry();\n", 'picker registry init')
old = """function purgeTemporaryState() {
  const now = Date.now();
  for (const [token, entry] of searchPickers) if (entry.expiresAt <= now) searchPickers.delete(token);
  for (const [guildId, entry] of undoSnapshots) if (entry.expiresAt <= now) undoSnapshots.delete(guildId);
  while (searchPickers.size > 32) searchPickers.delete(searchPickers.keys().next().value);
}

function createSearchPicker(interaction, tracks, next) {
  purgeTemporaryState();
  const token = randomBytes(6).toString('base64url');
  searchPickers.set(token, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    tracks: tracks.slice(0, 5),
    next: Boolean(next),
    expiresAt: Date.now() + SEARCH_PICKER_TTL_MS,
  });
  return token;
}

function getSearchPicker(interaction, token) {
  purgeTemporaryState();
  const entry = searchPickers.get(token);
  if (!entry || entry.guildId !== interaction.guildId || entry.userId !== interaction.user.id) return null;
  return entry;
}
"""
new = """function purgeTemporaryState() {
  const now = Date.now();
  for (const [guildId, entry] of undoSnapshots) if (entry.expiresAt <= now) undoSnapshots.delete(guildId);
}

function createSearchPicker(interaction, tracks, next, revision) {
  return searchPickers.create({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    tracks,
    next,
    revision,
  });
}

function getSearchPicker(interaction, token) {
  return searchPickers.getOwned({ guildId: interaction.guildId, userId: interaction.user.id, token });
}
"""
p = replace_once(p, old, new, 'picker helper block')
p = replace_once(p, "const token = createSearchPicker(interaction, result.tracks, next);", "const token = createSearchPicker(interaction, result.tracks, next, getQueueRevision(interaction.guildId));", 'picker revision capture')
p = replace_once(p, "    music, gemini, ensurePlayer, queueTracks, queueLimit, setGuildAutoplay, getGuildAutoplay, setGuildVolume,\n    invalidateQueueWork, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession,", "    music, gemini, ensurePlayer, queueTracks, queueLimit, setGuildAutoplay, getGuildAutoplay, setGuildVolume,\n    invalidateQueueWork, isQueueRevisionCurrent, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession,", 'component api revision guard')
old = """async function handleSearchSelect(interaction, { ensurePlayer, queueTracks, queueLimit, withGuildOperation, checkpointRecovery }) {
  const token = interaction.customId.split(':')[2] || '';
  const entry = getSearchPicker(interaction, token);
  if (!entry) throw expectedError('That search picker expired. Run the command again.');
  const index = Number.parseInt(interaction.values?.[0], 10);
  const track = Number.isInteger(index) ? entry.tracks[index] : null;
  if (!track) throw expectedError('That search result is no longer available.');
  await interaction.deferUpdate();
  const player = await ensurePlayer(interaction);
  await withGuildOperation(interaction.guildId, async () => {
    const queued = queueTracks(player, [track], { next: entry.next, perRequestLimit: 1 });
    if (!queued.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
    if (!player.playing && !player.paused) await player.play();
    checkpointRecovery(player);
  });
  searchPickers.delete(token);
  return interaction.editReply({ content: `${entry.next ? 'Queued next' : 'Queued'} **${safeTitle(track)}**.`, embeds: [], components: [] });
}
"""
new = """async function handleSearchSelect(interaction, { music, ensurePlayer, queueTracks, queueLimit, withGuildOperation, checkpointRecovery, isQueueRevisionCurrent }) {
  const token = interaction.customId.split(':')[2] || '';
  const entry = getSearchPicker(interaction, token);
  if (!entry) throw expectedError('That search picker expired. Run the command again.');
  if (!searchPickers.isCurrent(entry, isQueueRevisionCurrent(interaction.guildId, entry.revision) ? entry.revision : Number.NaN)) {
    searchPickers.delete(token);
    throw expectedError('That search picker is stale because the queue changed. Run `/play` again.');
  }
  const index = Number.parseInt(interaction.values?.[0], 10);
  const track = Number.isInteger(index) ? entry.tracks[index] : null;
  if (!track) throw expectedError('That search result is no longer available.');
  await interaction.deferUpdate();
  const player = await ensurePlayer(interaction);
  await withGuildOperation(interaction.guildId, async () => {
    if (!isQueueRevisionCurrent(interaction.guildId, entry.revision) || music.players.get(interaction.guildId) !== player) {
      searchPickers.delete(token);
      throw expectedError('That search picker is stale because the queue changed. Run `/play` again.');
    }
    const queued = queueTracks(player, [track], { next: entry.next, perRequestLimit: 1 });
    if (!queued.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
    if (!player.playing && !player.paused) await player.play();
    checkpointRecovery(player);
  });
  searchPickers.delete(token);
  return interaction.editReply({ content: `${entry.next ? 'Queued next' : 'Queued'} **${safeTitle(track)}**.`, embeds: [], components: [] });
}
"""
p = replace_once(p, old, new, 'search select handler')
write('src/commands.js', p)

# index.js: one shared shutdown promise; subsequent stop/signal requests await the same cleanup.
p = read('src/index.js')
p = replace_once(p, "import { closeStorage } from './storage.js';\n", "import { closeStorage } from './storage.js';\nimport { createShutdownCoordinator } from './shutdown.js';\n", 'shutdown import')
pattern = re.compile(r"let shuttingDown = false;\nasync function shutdown\(signal, exitCode = 0\) \{[\s\S]*?\n\}\n\nfunction exitAfterShutdown\(signal, exitCode, error\) \{[\s\S]*?\n\}\n", re.M)
match = pattern.search(p)
if not match:
    raise RuntimeError('shutdown block not found')
replacement = """let requestedExitCode = 0;
const shutdownCoordinator = createShutdownCoordinator(async (signal) => {
  console.log(`[shutdown] ${signal}`);

  // Preserve a lightweight session snapshot before intentional process shutdown.
  // Explicit Discord /stop or /disconnect clears recovery itself; this path is
  // for restarts, Windows shutdowns and crashes where offering Resume is useful.
  try { playerApi.checkpointAllRecoveries(); }
  catch (error) { console.warn('[shutdown] recovery checkpoint failed', error?.message || error); }
  await Promise.allSettled([...playerApi.music.players.values()].map((player) => player.destroy()));
  client.destroy();
  try { closeStorage(); }
  catch (error) { console.warn('[shutdown] storage close failed', error?.message || error); }
  removeOwnPidFile();
});

function shutdown(signal, exitCode = 0) {
  const code = Number(exitCode) || 0;
  if (!shutdownCoordinator.isRunning() || code !== 0) requestedExitCode = code;
  process.exitCode = requestedExitCode;
  return shutdownCoordinator.run(signal);
}

function exitAfterShutdown(signal, exitCode, error) {
  if (error) console.error(`[${signal}]`, error);
  shutdown(signal, exitCode)
    .catch((shutdownError) => console.error('[shutdown]', shutdownError))
    .finally(() => process.exit(requestedExitCode));
}
"""
p = p[:match.start()] + replacement + p[match.end():]
p = replace_once(p, "  if (!shuttingDown && fs.existsSync(stopRequestFile)) exitAfterShutdown('stop-requested', 0);", "  if (!shutdownCoordinator.isRunning() && fs.existsSync(stopRequestFile)) exitAfterShutdown('stop-requested', 0);", 'stop watcher shutdown guard')
write('src/index.js', p)

# Reproducible installs.
for path in ['setup.bat', 'start-bot.bat']:
    p = read(path)
    p = p.replace('call npm install', 'call npm ci')
    write(path, p)

p = read('.github/workflows/ci.yml')
p = replace_once(p, '      - run: npm install\n', '      - run: npm ci\n', 'CI npm ci')
p = replace_once(p, '          java -Xms128M -Xmx512M -jar Lavalink.jar', '          java -Xms64M -Xmx256M -jar Lavalink.jar', 'CI production heap')
write('.github/workflows/ci.yml', p)

# Stronger Lavalink PID identity: stable marker derived from this install root.
p = read('start-bot.bat')
old = "$out=$env:LAVALINK_LOG; $err=$env:LAVALINK_ERROR_LOG; $pidFile=$env:LAVALINK_PID; $p=Start-Process -FilePath 'java' -ArgumentList '-Xms64M','-Xmx256M','-jar','Lavalink.jar'"
new = "$sha=[System.Security.Cryptography.SHA256]::Create(); try{$hash=$sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($env:EZ_MUSIC_ROOT.ToLowerInvariant()))}finally{$sha.Dispose()}; $instance=([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant().Substring(0,16); $marker='-Dezmusic.instance='+$instance; $out=$env:LAVALINK_LOG; $err=$env:LAVALINK_ERROR_LOG; $pidFile=$env:LAVALINK_PID; $p=Start-Process -FilePath 'java' -ArgumentList '-Xms64M','-Xmx256M',$marker,'-jar','Lavalink.jar'"
p = replace_once(p, old, new, 'Lavalink instance marker launch')
write('start-bot.bat', p)

p = read('stop-bot.bat')
old = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$targetPid=[int]$env:TARGET_PID; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$targetPid) -ErrorAction SilentlyContinue; if(-not $p){exit 2}; if([string]$p.CommandLine -notmatch 'Lavalink\\.jar'){Write-Host '[WARN] PID now belongs to another process; refusing to kill it.'; exit 3}; Stop-Process -Id $targetPid -Force -ErrorAction Stop; exit 0\""
new = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$targetPid=[int]$env:TARGET_PID; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$targetPid) -ErrorAction SilentlyContinue; if(-not $p){exit 2}; $sha=[System.Security.Cryptography.SHA256]::Create(); try{$hash=$sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($env:EZ_MUSIC_ROOT.ToLowerInvariant()))}finally{$sha.Dispose()}; $instance=([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant().Substring(0,16); $marker='-Dezmusic.instance='+$instance; $cmd=[string]$p.CommandLine; if($cmd -notmatch 'Lavalink\\.jar' -or $cmd.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase) -lt 0){Write-Host '[WARN] PID does not match this EZ Music Lavalink instance; refusing to kill it.'; exit 3}; Stop-Process -Id $targetPid -Force -ErrorAction Stop; exit 0\""
p = replace_once(p, old, new, 'Lavalink PID identity guard')
p = p.replace('echo Lavalink PID was stale; no unrelated process was killed.', 'echo Lavalink PID was stale or belonged to another instance; no unrelated process was killed.')
write('stop-bot.bat', p)

# README reflects fixed local Lavalink, revision-aware picker, lockfile install, and instance marker.
p = read('README.md')
p = replace_once(p, '- Async `/play`, `/ai`, radio, and autoplay work is revision-guarded so an old request cannot silently refill a queue after you clear/stop/disconnect.', '- Async `/play`, `/ai`, radio, autoplay, and `select:true` picker actions are revision-guarded so an old request cannot silently refill/reconnect after you clear/stop/disconnect.', 'README queue guard')
p = replace_once(p, 'For ambiguous text searches, `/play ... select:true` and `/playnext ... select:true` open a private top-5 result picker for 2 minutes. Direct URLs/playlists remain immediate. The picker is bounded in memory and has no background timer.', 'For ambiguous text searches, `/play ... select:true` and `/playnext ... select:true` open a private top-5 result picker for 2 minutes. Direct URLs/playlists remain immediate. The picker is bounded in memory, has no background timer, and is tied to the queue revision that created it, so an old picker cannot resurrect playback after Clear/Stop/Disconnect.', 'README picker behavior')
p = replace_once(p, 'LAVALINK_URL=localhost:2333\nLAVALINK_PASSWORD=ezmusic-local-only\nLAVALINK_SECURE=false\n\n', '', 'README remove lavalink env')
p = replace_once(p, '`DEFAULT_VOLUME` is only the first/default value.', 'The bundled Lavalink connection is intentionally fixed to localhost (`127.0.0.1:2333`) with an internal local-only password so Node and `application.yml` cannot drift apart.\n\n`DEFAULT_VOLUME` is only the first/default value.', 'README fixed lavalink note')
p = replace_once(p, 'and installs Node dependencies.', 'and installs the exact locked Node dependency tree with `npm ci`.', 'README npm ci')
p = replace_once(p, 'Lavalink is stopped using its recorded PID only after verifying that the PID still belongs to `Lavalink.jar`.', 'Lavalink is stopped using its recorded PID only after verifying both `Lavalink.jar` and an install-specific JVM marker, preventing a stale PID from targeting another Lavalink instance.', 'README pid marker')
p = replace_once(p, '- hidden-launcher/autostart safety checks\n', '- hidden-launcher/autostart safety checks, including install-specific Lavalink PID identity\n', 'README dev validation')
write('README.md', p)

# Behavioral tests for the two audit races plus source-of-truth/memory/reproducibility invariants.
write('test/audit-v017.test.js', """import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSearchPickerRegistry } from '../src/search-picker.js';
import { createShutdownCoordinator } from '../src/shutdown.js';

test('search picker becomes stale after queue revision changes', () => {
  let now = 1_000;
  const registry = createSearchPickerRegistry({ now: () => now, tokenFactory: () => 'picker-token' });
  const token = registry.create({ guildId: 'g', userId: 'u', tracks: [{ title: 'A' }], revision: 7 });
  const entry = registry.getOwned({ guildId: 'g', userId: 'u', token });
  assert.equal(registry.isCurrent(entry, 7), true);
  assert.equal(registry.isCurrent(entry, 8), false);
  now += 121_000;
  assert.equal(registry.getOwned({ guildId: 'g', userId: 'u', token }), null);
});

test('shutdown coordinator runs cleanup once and every caller waits for the same promise', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = createShutdownCoordinator(async () => { calls += 1; await gate; return 'done'; });
  const first = coordinator.run('SIGTERM');
  const second = coordinator.run('stop-requested');
  assert.strictEqual(first, second);
  assert.equal(coordinator.isRunning(), true);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await second, 'done');
  assert.equal(calls, 1);
});

test('stale picker guard is evaluated before ensurePlayer can reconnect', () => {
  const commands = fs.readFileSync('src/commands.js', 'utf8');
  const handler = commands.match(/async function handleSearchSelect[\\s\\S]*?\\n}\\n/)?.[0] || '';
  const staleCheck = handler.indexOf('isQueueRevisionCurrent(interaction.guildId, entry.revision)');
  const ensure = handler.indexOf('await ensurePlayer(interaction)');
  assert.ok(staleCheck >= 0 && ensure >= 0 && staleCheck < ensure);
  assert.match(handler, /music\\.players\\.get\\(interaction\\.guildId\\) !== player/);
});

test('production and CI use the same low-memory Lavalink heap and locked npm install', () => {
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const setup = fs.readFileSync('setup.bat', 'utf8');
  const start = fs.readFileSync('start-bot.bat', 'utf8');
  assert.match(ci, /java -Xms64M -Xmx256M -jar Lavalink\\.jar/);
  assert.match(ci, /- run: npm ci/);
  assert.match(setup, /call npm ci/);
  assert.match(start, /call npm ci/);
  assert.match(start, /-Dezmusic\\.instance=/);
});

test('bundled Lavalink connection has one fixed source of truth', () => {
  const config = fs.readFileSync('src/config.js', 'utf8');
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.doesNotMatch(config, /process\\.env\\.LAVALINK_/);
  assert.doesNotMatch(env, /^LAVALINK_(?:URL|PASSWORD|SECURE)=/m);
  assert.match(config, /lavalinkUrl: 'localhost:2333'/);
  assert.match(config, /lavalinkPassword: 'ezmusic-local-only'/);
});
""")

# Remove temporary patch machinery from the resulting product commit.
Path('tools/audit_v017_patch.py').unlink(missing_ok=True)
Path('.github/workflows/audit-v017-patch.yml').unlink(missing_ok=True)
