import fetch from 'node-fetch';

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

const AI_CRM_SYSTEM_PROMPT =
  '你是「泡泡貓」(PAO PAO MAO) 美容中心的資深店長與 CRM 助手。' +
  '請根據傳入的客人資料，產出一份給美容師看的「接待戰報」。\n\n' +
  '輸出結構請依序包含：\n' +
  '1. 【⚡️ 秒懂摘要】一行。\n' +
  '2. 【週期與護理建議】\n' +
  '3. 【今日重點】\n' +
  '4. 【專屬話題攻略】\n\n' +
  '注意：若資料不足，請明確寫「資料不足」並提出可詢問的問題，勿虛構。';

async function callGemini(userContent, apiKey) {
  const model = String(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  const combined =
    AI_CRM_SYSTEM_PROMPT +
    '\n\n---\n\n' +
    '請根據以下客人資料，依上述格式產出「接待戰報」。\n\n' +
    String(userContent || '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: combined }] }],
      generationConfig: { maxOutputTokens: 1500, temperature: 0.5 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(text || '').slice(0, 200)}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  return String(out || '').trim();
}

async function callOpenAI(userContent, apiKey) {
  const model = String(process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: AI_CRM_SYSTEM_PROMPT },
        { role: 'user', content: String(userContent || '') },
      ],
      max_tokens: 1500,
      temperature: 0.5,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(text || '').slice(0, 200)}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return String(json?.choices?.[0]?.message?.content || '').trim();
}

export async function callAIForCustomerProfile(userContent) {
  const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const openaiKey = String(process.env.OPENAI_API_KEY || '').trim();

  if (geminiKey) {
    try {
      const out = await callGemini(userContent, geminiKey);
      if (out) return out;
    } catch (e) {
      // Fallback to OpenAI below.
      console.warn('[ai-crm] Gemini failed, fallback to OpenAI:', e?.message || e);
    }
  }
  if (openaiKey) {
    return await callOpenAI(userContent, openaiKey);
  }
  throw new Error('Missing GEMINI_API_KEY / OPENAI_API_KEY');
}

