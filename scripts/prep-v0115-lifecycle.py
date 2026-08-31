from pathlib import Path

path = Path('src/lavalink-lifecycle.js')
text = path.read_text(encoding='utf-8')

old = '''const VOICE_CLOSE_IMMEDIATE_RETIRE = new Set([
  4006, // session no longer valid
  4009, // session timed out
  4014, // disconnected; Discord says do not reconnect
  4017, // DAVE required
  4021, // rate limited; do not reconnect
  4022, // call terminated; do not reconnect
]);

export const VOICE_CLOSE_RECOVERY_GRACE_MS = 5_000;
'''
new = '''const VOICE_CLOSE_IMMEDIATE_RETIRE = new Set([
  4006,
  4009,
  4014,
  4017,
  4021,
  4022,
]);

export const VOICE_CLOSE_RECOVERY_GRACE_MS = 5_000;
'''
if old not in text:
    raise SystemExit('expected commented v0.1.14 close-code block not found')
text = text.replace(old, new, 1)

old = '''export function voiceCloseDisposition(code) {
  const value = Number(code || 0);
  if (VOICE_CLOSE_IMMEDIATE_RETIRE.has(value)) return 'retire';
  return 'watch';
}
'''
new = '''export function voiceCloseDisposition(code) {
  if (VOICE_CLOSE_IMMEDIATE_RETIRE.has(Number(code || 0))) return 'retire';
  return 'watch';
}
'''
if old not in text:
    raise SystemExit('expected v0.1.14 voiceCloseDisposition block not found')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('Normalized v0.1.14 lifecycle formatting for v0.1.15 patch')
