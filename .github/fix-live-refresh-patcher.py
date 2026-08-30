from pathlib import Path

path = Path('.github/apply-live-refresh.py')
text = path.read_text(encoding='utf-8')

old = "    'component api wiring',\n)"
new = "    'component api wiring',\n    expected=2,\n)"
if text.count(old) != 1:
    raise SystemExit(f'component api marker count: {text.count(old)}')
text = text.replace(old, new, 1)

marker = "    'button api wiring',"
index = text.find(marker)
if index < 0:
    raise SystemExit('button api wiring marker not found')
start = text.rfind('commands = replace_exact(', 0, index)
if start < 0:
    raise SystemExit('button api wiring block start not found')
end = text.find('\n\ncommands = replace_exact(', index)
if end < 0:
    raise SystemExit('button api wiring block end not found')
text = text[:start] + text[end + 2:]

old_assert = "if 'interaction.editReply(panelPayload(' in commands:\n    raise SystemExit('unconverted direct player edit remains')"
new_assert = "if 'interaction.editReply(panelPayload(' in commands:\n    leftovers = [line.strip() for line in commands.splitlines() if 'interaction.editReply(panelPayload(' in line]\n    raise SystemExit('unconverted direct player edit remains: ' + ' || '.join(leftovers))"
if text.count(old_assert) != 1:
    raise SystemExit(f'assert marker count: {text.count(old_assert)}')
text = text.replace(old_assert, new_assert, 1)

path.write_text(text, encoding='utf-8')
