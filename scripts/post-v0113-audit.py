from pathlib import Path


def patch(path, before, after, label):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if before not in text:
        raise RuntimeError(f'Missing audit target: {label}')
    p.write_text(text.replace(before, after, 1), encoding='utf-8')


patch(
    'src/music.js',
    "  function getSourceHealth(guildId) {\n    const state = playbackFailures.get(guildId);\n    if (!state) return {\n      status: playbackFallbackHolds.has(guildId) ? 'fallback' : 'healthy',",
    "  function getSourceHealth(guildId) {\n    const state = playbackFailures.get(guildId);\n    // A live alternate-source attempt is more actionable than an older healthy\n    // failure counter. Always surface it while the temporary queue hold exists.\n    if (playbackFallbackHolds.has(guildId)) return {\n      status: 'fallback',\n      failures: state?.times?.length || 0,\n      retryAt: 0,\n      lastError: state?.lastError || '',\n      held: getHeldQueueCount(guildId),\n    };\n    if (!state) return {\n      status: 'healthy',",
    'fallback health priority',
)

needle = "        releasePlaybackFallbackHold(player, state, { restore: true });\n        checkpointRecovery(player);\n        return true;"
replacement = "        releasePlaybackFallbackHold(player, state, { restore: true });\n        // A successful substitution is not a retry storm. Allow the same source\n        // item to fall back again immediately if it legitimately appears twice.\n        playbackFallbackAttempts.delete(guildId);\n        checkpointRecovery(player);\n        return true;"
# Both YouTube-alternative and SoundCloud success blocks intentionally share this
# exact tail; update each of them.
p = Path('src/music.js')
text = p.read_text(encoding='utf-8')
if text.count(needle) != 2:
    raise RuntimeError(f'Expected two fallback success tails, found {text.count(needle)}')
text = text.replace(needle, replacement, 2)
p.write_text(text, encoding='utf-8')

# Add static regression coverage for the two audit refinements.
p = Path('test/playback-fallback-v0113.test.js')
text = p.read_text(encoding='utf-8')
if "fallback status takes priority over an older failure counter" not in text:
    text += r'''

test('fallback status takes priority over an older failure counter and success clears retry fingerprint', () => {
  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const health = music.split('function getSourceHealth(guildId)')[1]?.split('function setHealthy')[0] || '';
  assert.ok(health.indexOf('playbackFallbackHolds.has(guildId)') < health.indexOf("if (!state) return"));
  const youtubeFallback = music.split('async function tryYoutubePlaybackFallback')[1]?.split('async function trySoundCloudPlaybackFallback')[0] || '';
  const soundcloudFallback = music.split('async function trySoundCloudPlaybackFallback')[1]?.split('async function finishPlaybackFallbackFailure')[0] || '';
  assert.match(youtubeFallback, /releasePlaybackFallbackHold[\s\S]*playbackFallbackAttempts\.delete\(guildId\)/);
  assert.match(soundcloudFallback, /releasePlaybackFallbackHold[\s\S]*playbackFallbackAttempts\.delete\(guildId\)/);
});
'''
p.write_text(text, encoding='utf-8')
