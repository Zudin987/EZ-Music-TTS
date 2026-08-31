import fs from 'node:fs';

const path = 'src/commands.js';
let text = fs.readFileSync(path, 'utf8');
const oldLine = "          `Spotify URL mirror: **${isSpotifyConfigured() ? 'Configured' : 'Not configured'}**`,";
const newLine = "          `Spotify: **Tracks: oEmbed fallback${isSpotifyConfigured() ? ' + LavaSrc' : ''} • Albums/playlists: ${isSpotifyConfigured() ? 'Configured' : 'Not configured'}**`,";

if (text.includes(oldLine)) {
  text = text.replace(oldLine, newLine);
} else if (!text.includes(newLine)) {
  throw new Error('Spotify status anchor was not found.');
}

fs.writeFileSync(path, text);
