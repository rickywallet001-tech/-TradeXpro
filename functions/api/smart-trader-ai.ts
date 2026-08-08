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

const SYSTEM_PROMPT = `You are Smart Trader, the trading copilot inside TradeX Pro.

Help users understand the live scanner and their trading workflow. You receive live scanner context from the application; never invent market prices, signals, trades, balances, or performance.

You may explain statistical readings, trends, confidence scores, risk controls, AutoPilot configuration, and trading concepts. A scanner confidence score is NOT a probability of profit and is never a guarantee. Never promise profits, claim losses can be reduced by a fixed percentage, or encourage chasing losses, overtrading, or increasing stakes to recover losses.

When asked what to trade, give a cautious interpretation of the supplied scanner context and clearly distinguish observation from prediction. If context is weak, stale, disconnected, flat, or insufficient, say so and recommend waiting.

Do not execute trades and do not claim to have executed one. Actual execution is handled by TradeX Pro's deterministic trading controls after configured rules and/or confirmation are satisfied.

Keep answers concise and practical. When useful, structure as Current read, Why, Risk, and Next step.`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function extractText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function providerMessage(status: number, data: any): string {
  const message = typeof data?.error?.message === "string" ? data.error.message : "";
  if (status === 401) return "Smart Trader AI authentication failed. Check OPENAI_API_KEY in Cloudflare Production.";
  if (status === 403) return "Smart Trader AI access was denied. Check the OpenAI project and model permissions.";
  if (status === 404) return "Smart Trader AI model was not found. Check OPENAI_MODEL in Cloudflare or remove it to use the default model.";
  if (status === 429) return /quota|billing/i.test(message)
    ? "Smart Trader AI has reached the OpenAI API quota. Check OpenAI billing and usage limits."
    : "Smart Trader AI is temporarily rate-limited. Please try again in a moment.";
  if (status >= 500) return "Smart Trader AI's provider is temporarily unavailable. Please try again shortly.";
  return message ? `Smart Trader AI request was rejected: ${message}` : `Smart Trader AI request was rejected (HTTP ${status}).`;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    if (!env?.OPENAI_API_KEY) {
      return json({ error: "Smart Trader AI is not configured. Add OPENAI_API_KEY to Cloudflare Pages Production." }, 503);
    }

    let body: {
      question?: string;
      history?: ChatMessage[];
      marketContext?: MarketContext;
    };

    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request body." }, 400);
    }

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "A question is required." }, 400);
    if (question.length > 1200) return json({ error: "Question is too long." }, 400);

    const history = Array.isArray(body.history)
      ? body.history
          .filter((m): m is ChatMessage =>
            !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
          )
          .slice(-8)
          .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1600)}`)
          .join("\n")
      : "";

    const marketContext = body.marketContext ?? {};
    const prompt = [
      SYSTEM_PROMPT,
      history ? `RECENT CONVERSATION:\n${history}` : "",
      `LIVE SMART TRADER CONTEXT (observational data only):\n${JSON.stringify(marketContext)}`,
      `USER QUESTION:\n${question}`,
    ].filter(Boolean).join("\n\n");

    const model = env.OPENAI_MODEL?.trim() || "gpt-5-mini";

    let upstream: Response;
    try {
      upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: prompt,
          max_output_tokens: 500,
          store: false,
        }),
      });
    } catch (error) {
      console.error("Smart Trader AI network error", error);
      return json({ error: "Smart Trader AI could not reach its AI provider. Please try again shortly." }, 502);
    }

    const raw = await upstream.text();
    let data: any = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!upstream.ok) {
      console.error("Smart Trader AI provider error", {
        status: upstream.status,
        model,
        requestId: upstream.headers.get("x-request-id"),
        error: data?.error?.message,
      });
      return json({ error: providerMessage(upstream.status, data) }, 502);
    }

    const answer = extractText(data);
    if (!answer) {
      console.error("Smart Trader AI returned no text", { model, requestId: upstream.headers.get("x-request-id") });
      return json({ error: "The AI returned an empty response. Please try again." }, 502);
    }

    return json({ answer });
  } catch (error) {
    console.error("Smart Trader AI function error", error);
    return json({ error: "Unable to process your Smart Trader request." }, 500);
  }
};
