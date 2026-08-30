import fs from 'node:fs';
import path from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { createMusic } from './music.js';
import { createInteractionHandler, registerGuildCommands } from './commands.js';
import { GeminiDJ } from './gemini.js';
import { closeStorage } from './storage.js';
import { createShutdownCoordinator } from './shutdown.js';

fs.mkdirSync('data', { recursive: true });
const pidFile = path.resolve('data', 'ez-music.pid');
const stopRequestFile = path.resolve('data', 'stop.requested');

function writePidFile() {
  fs.writeFileSync(pidFile, String(process.pid), { encoding: 'ascii' });
}

function removeOwnPidFile() {
  try {
    if (!fs.existsSync(pidFile)) return;
    const value = fs.readFileSync(pidFile, 'utf8').trim();
    if (value === String(process.pid)) fs.unlinkSync(pidFile);
  } catch (error) {
    console.warn('[shutdown] PID cleanup failed', error?.message || error);
  }
}

writePidFile();
process.once('exit', removeOwnPidFile);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  allowedMentions: { parse: [], repliedUser: false },
});
const gemini = new GeminiDJ(config.geminiApiKey, config.geminiModel);
const playerApi = createMusic(client, config, gemini);

client.once(Events.ClientReady, async () => {
  console.log(`[discord] logged in as ${client.user.tag}`);
  try { await registerGuildCommands(config); }
  catch (error) { console.error('[discord] command registration failed', error); }
  client.user.setActivity('raw music • /play');
  console.log(`[gemini] ${gemini.enabled ? `configured (${config.geminiModel})` : 'disabled'}`);
  const recovery = playerApi.getRecoverableSession(config.discordGuildId);
  if (recovery) console.log(`[recovery] saved session available: ${recovery.current?.title || 'queue'} + ${recovery.queue?.length || 0} upcoming; use /status to resume or discard`);
});

client.on('interactionCreate', createInteractionHandler({ client, gemini, ...playerApi }));
client.on('error', (error) => console.error('[discord]', error));

let requestedExitCode = 0;
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

// stop-bot.bat creates this marker first. Polling it lets hidden/task-scheduled
// instances close Discord + SQLite cleanly before stop-bot falls back to a
// forced process termination. It also closes the startup race where a stop is
// requested while Lavalink is still warming up and Node starts a moment later.
const stopWatcher = setInterval(() => {
  if (!shutdownCoordinator.isRunning() && fs.existsSync(stopRequestFile)) exitAfterShutdown('stop-requested', 0);
}, 500);
stopWatcher.unref?.();

process.once('SIGINT', () => exitAfterShutdown('SIGINT', 0));
process.once('SIGTERM', () => exitAfterShutdown('SIGTERM', 0));
process.once('uncaughtException', (error) => exitAfterShutdown('uncaughtException', 1, error));
process.once('unhandledRejection', (error) => exitAfterShutdown('unhandledRejection', 1, error));

try {
  await client.login(config.discordToken);
} catch (error) {
  console.error('[discord] login failed', error);
  await shutdown('login-failed', 1).catch(() => {});
  process.exit(1);
}
