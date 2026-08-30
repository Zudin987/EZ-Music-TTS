import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const start = fs.readFileSync('start-bot.bat', 'utf8');
const stop = fs.readFileSync('stop-bot.bat', 'utf8');
const hidden = fs.readFileSync('start-hidden.vbs', 'utf8');
const installer = fs.readFileSync('install-autostart.ps1', 'utf8');
const index = fs.readFileSync('src/index.js', 'utf8');
const lavalink = fs.readFileSync('lavalink/application.yml', 'utf8');

test('hidden launcher waits for the bot and keeps a bounded log', () => {
  assert.match(hidden, /shell\.Run\(command, 0, True\)/i);
  assert.match(hidden, /launcher\.log/i);
  assert.match(hidden, /5242880/);
  assert.match(hidden, /start-bot\.bat/i);
  assert.match(hidden, /\/hidden/i);
});

test('scheduled task is current-user, limited, single-instance, and restartable', () => {
  assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn/i);
  assert.match(installer, /-LogonType Interactive/i);
  assert.match(installer, /-RunLevel Limited/i);
  assert.match(installer, /-MultipleInstances IgnoreNew/i);
  assert.match(installer, /-RestartCount 5/i);
  assert.match(installer, /wscript\.exe/i);
});

test('launcher and stop script track the Discord process safely', () => {
  assert.match(start, /BOT_PID_FILE/i);
  assert.match(start, /Not starting a duplicate Discord session/i);
  assert.match(start, /Get-CimInstance Win32_Process/i);
  assert.match(start, /\$isEzBot=/);
  assert.doesNotMatch(start, /\$matches=/i);
  assert.match(stop, /STOP_REQUEST/i);
  assert.match(stop, /src\\index\.js/i);
  assert.match(stop, /\$isEzBot=/);
  assert.doesNotMatch(stop, /\$matches=/i);
  assert.match(stop, /Graceful stop timed out/i);
  assert.match(stop, /Stop-Process/i);
});

test('node shutdown is deterministic and responds to the stop marker', () => {
  assert.match(index, /ez-music\.pid/);
  assert.match(index, /stop\.requested/);
  assert.match(index, /setInterval\([\s\S]*fs\.existsSync\(stopRequestFile\)/);
  assert.match(index, /exitAfterShutdown\('stop-requested', 0\)/);
  assert.match(index, /process\.once\('exit', removeOwnPidFile\)/);
  assert.match(index, /process\.once\('unhandledRejection'/);
  assert.match(index, /finally\(\(\) => process\.exit\(exitCode\)\)/);
});

test('generic Lavalink HTTP source is disabled', () => {
  assert.match(lavalink, /http:\s*false/i);
  assert.match(lavalink, /address:\s*127\.0\.0\.1/i);
});
