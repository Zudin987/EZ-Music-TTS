import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { createMusic } from './music.js';
import { createInteractionHandler, registerGuildCommands } from './commands.js';
import { GeminiDJ } from './gemini.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const { music, ensurePlayer } = createMusic(client, config);
const gemini = new GeminiDJ(config.geminiApiKey, config.geminiModel);

client.once('ready', async () => {
  console.log(`[discord] logged in as ${client.user.tag}`);
  try { await registerGuildCommands(config); }
  catch (error) { console.error('[discord] command registration failed', error); }
  client.user.setActivity('raw music • /play');
  console.log(`[gemini] ${gemini.enabled ? `enabled (${config.geminiModel})` : 'disabled'}`);
});

client.on('interactionCreate', createInteractionHandler({ music, ensurePlayer, gemini }));
client.on('error', (error) => console.error('[discord]', error));

process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));
process.on('uncaughtException', (error) => console.error('[uncaughtException]', error));

await client.login(config.discordToken);
