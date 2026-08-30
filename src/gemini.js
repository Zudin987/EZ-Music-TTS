import { GoogleGenAI } from '@google/genai';

export class GeminiDJ {
  constructor(apiKey, model) {
    this.enabled = Boolean(apiKey);
    this.model = model;
    this.client = this.enabled ? new GoogleGenAI({ apiKey }) : null;
  }

  async makeQueue(request, context = {}) {
    if (!this.enabled) throw new Error('Gemini is not configured. Add GEMINI_API_KEY to .env.');

    const maxSongs = Math.max(1, Math.min(20, Number(context.maxSongs || 10)));
    const recent = (context.recent || []).slice(0, 25).map((x) => `${x.title} — ${x.author}`).join('\n');
    const prompt = `You are the recommendation brain for a private Discord music bot.\n\nUser request: ${request}\n\nRecent server listening history:\n${recent || '(none)'}\n\nReturn ONLY valid JSON with this exact shape:\n{"summary":"short explanation","queries":["search query 1","search query 2"]}\n\nRules:\n- Return 1 to ${maxSongs} concrete song search queries, usually \"artist - title\".\n- Respect requested mood, genre, language, era and exclusions.\n- Avoid duplicates and recent exact repeats unless explicitly requested.\n- Do not include URLs.\n- Never suggest audio effects, nightcore, karaoke, 8D, EQ, bass boost, pitch, speed or other altered versions.\n- Prefer original/raw studio songs unless the user explicitly asks for a cover, remix or live version.`;

    const response = await this.client.models.generateContent({ model: this.model, contents: prompt });
    const raw = String(response.text || '').trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const data = JSON.parse(raw);
    const queries = Array.isArray(data.queries)
      ? data.queries.map(String).map((x) => x.trim()).filter(Boolean).slice(0, maxSongs)
      : [];
    if (!queries.length) throw new Error('Gemini returned no usable song suggestions.');
    return { summary: String(data.summary || 'AI queue ready.'), queries };
  }
}
