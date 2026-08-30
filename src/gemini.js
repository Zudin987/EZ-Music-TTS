import { GoogleGenAI } from '@google/genai';

export class GeminiDJ {
  constructor(apiKey, model) {
    this.enabled = Boolean(apiKey);
    this.model = model;
    this.client = this.enabled ? new GoogleGenAI({ apiKey }) : null;
  }

  async makeQueue(request, context = {}) {
    if (!this.enabled) throw new Error('Gemini is not configured. Add GEMINI_API_KEY to .env.');

    const recent = (context.recent || []).slice(0, 12).map((x) => `${x.title} — ${x.author}`).join('\n');
    const prompt = `You are the recommendation brain for a private Discord music bot.\n\nUser request: ${request}\n\nRecent tracks:\n${recent || '(none)'}\n\nReturn ONLY valid JSON with this exact shape:\n{"summary":"short explanation","queries":["search query 1","search query 2"]}\n\nRules:\n- Return 1 to 10 concrete song search queries, usually \"artist - title\".\n- Respect requested mood, genre, language, era and exclusions.\n- Avoid duplicates and avoid repeating recent tracks unless explicitly requested.\n- Do not include URLs.\n- Do not suggest audio effects, nightcore, karaoke, 8D, EQ, pitch or speed changes.\n- Prefer original/raw songs unless the user explicitly asks for a cover/remix/live version.`;

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
    });

    const raw = String(response.text || '').trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const data = JSON.parse(raw);
    const queries = Array.isArray(data.queries) ? data.queries.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 10) : [];
    if (!queries.length) throw new Error('Gemini returned no usable song suggestions.');
    return { summary: String(data.summary || 'AI queue ready.'), queries };
  }
}
