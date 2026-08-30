from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


for path in ['test/lean-runtime.test.js', 'test/queue-controls.test.js']:
    replace_once(path, r'/bufferDurationMs:\s*1000/', r'/bufferDurationMs:\s*2000/')
    replace_once(path, r'/frameBufferDurationMs:\s*10000/', r'/frameBufferDurationMs:\s*20000/')

replace_once("test/source-routing.test.js", "assert.equal(pkg.version, '0.1.4');", "assert.equal(pkg.version, '0.1.5');")
