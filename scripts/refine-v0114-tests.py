from pathlib import Path

for name in [
    'test/playback-fallback-v0113.test.js',
    'test/search-choices-v0111.test.js',
    'test/source-routing.test.js',
]:
    path = Path(name)
    text = path.read_text(encoding='utf-8')
    updated = text.replace("assert.equal(pkg.version, '0.1.13');", "assert.equal(pkg.version, '0.1.14');")
    path.write_text(updated, encoding='utf-8')

print('Refreshed legacy version assertions for v0.1.14')
