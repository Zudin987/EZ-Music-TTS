import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { createMusic } from './music.js';
import { createInteractionHandler, registerGuildCommands } from './commands.js';
import { GeminiDJ } from './gemini.js';
import { closeStorage } from './storage.js';

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

process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));

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
}

process.once('SIGINT', () => { shutdown('SIGINT').catch((error) => console.error('[shutdown]', error)); });
process.once('SIGTERM', () => { shutdown('SIGTERM').catch((error) => console.error('[shutdown]', error)); });
process.once('uncaughtException', (error) => {
  console.error('[uncaughtException]', error);
  shutdown('uncaughtException', 1)
    .catch((shutdownError) => console.error('[shutdown]', shutdownError))
    .finally(() => process.exit(1));
});

await client.login(config.discordToken);
