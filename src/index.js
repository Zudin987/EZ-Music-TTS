import fs from 'node:fs';
import path from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { createMusic } from './music.js';
import { createInteractionHandler, registerGuildCommands } from './commands.js';
import { GeminiDJ } from './gemini.js';
import { closeStorage } from './storage.js';

fs.mkdirSync('data', { recursive: true });
const pidFile = path.resolve('data', 'ez-music.pid');

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
});

client.on('interactionCreate', createInteractionHandler({ client, gemini, ...playerApi }));
client.on('error', (error) => console.error('[discord]', error));

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  console.log(`[shutdown] ${signal}`);

  await Promise.allSettled([...playerApi.music.players.values()].map((player) => player.destroy()));
  client.destroy();
  try { closeStorage(); }
  catch (error) { console.warn('[shutdown] storage close failed', error?.message || error); }
  removeOwnPidFile();
}

function exitAfterShutdown(signal, exitCode, error) {
  if (error) console.error(`[${signal}]`, error);
  shutdown(signal, exitCode)
    .catch((shutdownError) => console.error('[shutdown]', shutdownError))
    .finally(() => process.exit(exitCode));
}

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
