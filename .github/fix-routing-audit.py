from pathlib import Path

path = Path('src/music.js')
text = path.read_text(encoding='utf-8')
old = """      return host === 'open.spotify.com' || host.endsWith('.open.spotify.com') || host === 'spotify.link' || host.endsWith('.spotify.link');
    } catch {
      return false;
    }
  }

  function hasExplicitSearchPrefix(value) {
"""
new = """      return host === 'open.spotify.com' || host.endsWith('.open.spotify.com');
    } catch {
      return false;
    }
  }

  function isSpotifyShortLink(value) {
    try {
      const url = new URL(String(value || '').trim());
      const host = url.hostname.toLowerCase();
      return host === 'spotify.link' || host.endsWith('.spotify.link');
    } catch {
      return false;
    }
  }

  function hasExplicitSearchPrefix(value) {
"""
if old not in text:
    raise SystemExit('Spotify host audit anchor missing')
text = text.replace(old, new, 1)
old = """    if (isSpotifyReference(clean)) {
      if (!spotifyConfigured) {
"""
new = """    if (isSpotifyShortLink(clean)) {
      throw new Error('Spotify short links (spotify.link) are not supported by the current LavaSrc source. Open the link in Spotify and paste the full open.spotify.com URL instead.');
    }

    if (isSpotifyReference(clean)) {
      if (!spotifyConfigured) {
"""
if old not in text:
    raise SystemExit('Spotify short-link guard anchor missing')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')

path = Path('test/source-routing.test.js')
text = path.read_text(encoding='utf-8')
old = """  assert.match(music, /Spotify URL support is not configured/);
});
"""
new = """  assert.match(music, /Spotify URL support is not configured/);
  assert.match(music, /Spotify short links \(spotify\.link\) are not supported/);
});
"""
if old not in text:
    raise SystemExit('source-routing test anchor missing')
path.write_text(text.replace(old, new, 1), encoding='utf-8')

path = Path('README.md')
text = path.read_text(encoding='utf-8')
needle = "Spotify links are metadata/mirroring only: LavaSrc resolves Spotify track/album/playlist metadata, then finds playable audio through YouTube Music first and normal YouTube second."
replacement = needle + " Use full `open.spotify.com` URLs; LavaSrc 4.8.3 does not document `spotify.link` short URLs, so EZ Music rejects those with a clear message instead of silently misrouting them."
if needle not in text:
    raise SystemExit('README Spotify note anchor missing')
path.write_text(text.replace(needle, replacement, 1), encoding='utf-8')

print('routing audit fixes applied')
