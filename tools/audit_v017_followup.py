from pathlib import Path


def update(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise RuntimeError(f'expected text not found in {path}: {old!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8', newline='\n')


update(
    'src/commands.js',
    "if (!searchPickers.isCurrent(entry, isQueueRevisionCurrent(interaction.guildId, entry.revision) ? entry.revision : Number.NaN)) {",
    "if (!isQueueRevisionCurrent(interaction.guildId, entry.revision)) {",
)

update(
    'test/autostart.test.js',
    "  assert.match(index, /finally\\(\\(\\) => process\\.exit\\(exitCode\\)\\)/);",
    "  assert.match(index, /createShutdownCoordinator/);\n  assert.match(index, /shutdownCoordinator\\.isRunning\\(\\)/);\n  assert.match(index, /finally\\(\\(\\) => process\\.exit\\(requestedExitCode\\)\\)/);",
)

p = Path('test/library-recovery.test.js')
text = p.read_text(encoding='utf-8')
anchor = "const ui = fs.readFileSync('src/ui.js', 'utf8');"
if anchor not in text:
    raise RuntimeError('library-recovery import anchor not found')
text = text.replace(anchor, anchor + "\nconst searchPicker = fs.readFileSync('src/search-picker.js', 'utf8');", 1)
old = """  assert.match(commands, /SEARCH_PICKER_TTL_MS = 120_000/);
  assert.match(commands, /searchPickers = new Map\\(\\)/);
  assert.match(commands, /tracks\\.slice\\(0, 5\\)/);"""
new = """  assert.match(searchPicker, /SEARCH_PICKER_TTL_MS = 120_000/);
  assert.match(searchPicker, /SEARCH_PICKER_MAX = 32/);
  assert.match(searchPicker, /tracks: Array\\.isArray\\(tracks\\) \\? tracks\\.slice\\(0, 5\\)/);
  assert.match(searchPicker, /revision:/);
  assert.match(commands, /isQueueRevisionCurrent\\(interaction\\.guildId, entry\\.revision\\)/);"""
if old not in text:
    raise RuntimeError('library-recovery picker expectations not found')
p.write_text(text.replace(old, new, 1), encoding='utf-8', newline='\n')

update(
    'test/source-routing.test.js',
    "  assert.equal(pkg.version, '0.1.6');",
    "  assert.equal(pkg.version, '0.1.7');",
)

Path('tools/audit_v017_followup.py').unlink(missing_ok=True)
