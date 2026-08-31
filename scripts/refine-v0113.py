from pathlib import Path


def patch(path, before, after, label):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if before not in text:
        raise RuntimeError(f'Missing refinement target: {label}')
    p.write_text(text.replace(before, after, 1), encoding='utf-8')


patch(
    'src/playback-fallback.js',
    "    .replace(/\\s*[|•]+\\s*/g, ' '));",
    "    .replace(/\\s*[|•]+\\s*/g, ' ')\n    .replace(/\\s+[&+]\\s*$/g, ' '));",
    'orphaned trailing conjunction after metadata cleanup',
)

patch(
    'test/search-playback-v0110.test.js',
    "  assert.ok(handler.indexOf('trySoundCloudPlaybackFallback') < handler.indexOf('recordPlaybackFailure'));",
    "  assert.ok(handler.indexOf('trySoundCloudPlaybackFallback') < handler.indexOf('finishPlaybackFallbackFailure'));",
    'legacy fallback ordering assertion',
)
