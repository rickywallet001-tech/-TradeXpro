interface Env {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type MarketContext = {
  topMarket?: {
    symbol?: string;
    label?: string;
    trend?: string;
    confidence?: number;
    connected?: boolean;
  } | null;
  markets?: Array<{
    symbol?: string;
    label?: string;
    trend?: string;
    confidence?: number;
    connected?: boolean;
  }>;
  capturedAt?: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const SYSTEM_PROMPT = `You are Smart Trader, the trading copilot inside TradeX Pro.

Your job is to help users understand the live scanner and their trading workflow. You receive live scanner context from the application; do not invent market prices, signals, trades, balances, or performance that are not provided.

You may explain statistical readings, trends, confidence scores, risk controls, AutoPilot configuration, and trading concepts. A scanner confidence score is NOT a probability of profit and is never a guarantee. Never promise profits, claim that losses can be reduced by a fixed percentage, or encourage users to chase losses, overtrade, or increase stakes to recover losses.

When the user asks what to trade, give a cautious, evidence-based interpretation of the supplied scanner context and clearly distinguish observation from prediction. If the supplied context is weak, stale, disconnected, flat, or insufficient, say so and recommend waiting rather than inventing a setup.

Do not execute trades and do not claim to have executed one. Actual execution is handled by TradeX Pro's deterministic trading controls after the user's configured rules and/or confirmation are satisfied.

Keep answers concise and practical. When useful, structure the response as: Current read, Why, Risk, and Next step. Never represent past performance as a guarantee of future results.`;

function extractText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  const parts: string[] = [];
  for (const item of data?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function upstreamError(status: number, data: any): string {
  const message = typeof data?.error?.message === "string" ? data.error.message.toLowerCase() : "";
  if (status === 401) return "Smart Trader AI authentication failed. Check the OPENAI_API_KEY secret in Cloudflare Production.";
  if (status === 403) return "Smart Trader AI access was denied. Check the OpenAI project permissions and model access.";
  if (status === 404) return "Smart Trader AI model was not found. Check the OPENAI_MODEL setting in Cloudflare, or remove it to use the default model.";
  if (status === 429) return message.includes("quota") || message.includes("billing")
    ? "Smart Trader AI has reached the OpenAI API quota. Check your OpenAI billing and usage limits."
    : "Smart Trader AI is rate-limited by OpenAI. Please try again in a moment.";
  if (status >= 500) return "Smart Trader AI's provider is temporarily unavailable. Please try again shortly.";
  return `Smart Trader AI request was rejected by the provider (HTTP ${status}).`;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  if (!context.env.OPENAI_API_KEY) {
    return json({ error: "Smart Trader AI is not configured. Add OPENAI_API_KEY to the Cloudflare Pages Production environment." }, 503);
  }

  try {
    const body = await context.request.json<{
      question?: string;
      history?: ChatMessage[];
      marketContext?: MarketContext;
    }>();

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "A question is required." }, 400);
    if (question.length > 1200) return json({ error: "Question is too long." }, 400);

    const history = Array.isArray(body.history)
      ? body.history
          .filter((m): m is ChatMessage =>
            !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
          )
          .slice(-8)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1600) }))
      : [];

    const marketContext = body.marketContext ?? {};
    const contextMessage = `LIVE SMART TRADER CONTEXT (observational data only):\n${JSON.stringify(marketContext)}`;
    const input = [...history, { role: "user", content: `${question}\n\n${contextMessage}` }];
    const model = context.env.OPENAI_MODEL || "gpt-5-mini";

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: SYSTEM_PROMPT,
        input,
        max_output_tokens: 500,
        store: false,
      }),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Smart Trader AI upstream error", {
        status: upstream.status,
        model,
        requestId: upstream.headers.get("x-request-id"),
        error: data?.error?.message,
      });
      return json({ error: upstreamError(upstream.status, data) }, 502);
    }

    const answer = extractText(data);
    if (!answer) return json({ error: "The AI returned an empty response. Please try again." }, 502);

    return json({ answer });
  } catch (error) {
    console.error("Smart Trader AI error:", error);
    return json({ error: "Unable to process your Smart Trader request." }, 500);
  }
};
