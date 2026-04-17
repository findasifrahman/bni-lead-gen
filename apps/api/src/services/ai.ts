import { env } from "../lib/env";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type WebsiteSignals = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  socialLinks: string[];
  source: "fetch" | "tavily";
};

type DraftMailResult = {
  subject: string;
  body: string;
};

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstMatch(html: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = stripTags(match[1]).trim();
      if (value) return value;
    }
  }
  return "";
}

function collectWebsiteSignalsFromHtml(url: string, html: string): WebsiteSignals {
  const title = extractFirstMatch(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);
  const description = extractFirstMatch(html, [/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i]);
  const headings = Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((match) => stripTags(match[1] ?? ""))
    .filter(Boolean)
    .slice(0, 8);
  const socialLinks = Array.from(html.matchAll(/href=["']([^"']+)["']/gi))
    .map((match) => match[1] ?? "")
    .filter((href) => /linkedin|facebook|instagram|x\.com|twitter|youtube/i.test(href))
    .slice(0, 10);
  return { url, title, description, headings, socialLinks, source: "fetch" };
}

function collectWebsiteSignalsFromTavilyResult(url: string, result: Record<string, unknown>): WebsiteSignals {
  const title = typeof result.title === "string" ? result.title : "";
  const description = typeof result.content === "string" ? result.content : typeof result.snippet === "string" ? result.snippet : "";
  const rawContent = typeof result.raw_content === "string" ? result.raw_content : "";
  const socialLinks = Array.isArray(result.images)
    ? []
    : [];
  return {
    url,
    title,
    description: description || rawContent.slice(0, 400),
    headings: [],
    socialLinks,
    source: "tavily",
  };
}

function extractResponseText(payload: Record<string, unknown>): string {
  const direct = typeof payload.output_text === "string" ? payload.output_text : "";
  if (direct.trim()) {
    return direct.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    if (item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return "";
}

async function collectWebsiteSignals(urls: string[]): Promise<WebsiteSignals[]> {
  const results: WebsiteSignals[] = [];
  for (const rawUrl of urls) {
    const url = normalizeUrl(rawUrl);
    if (!url) continue;
    try {
      const html = await fetchWithTimeout(url);
      results.push(collectWebsiteSignalsFromHtml(url, html));
    } catch {
      results.push({
        url,
        title: "",
        description: "",
        headings: [],
        socialLinks: [],
        source: "fetch",
      });
    }
  }
  return results;
}

async function collectWebsiteSignalsWithTavilyFallback(urls: string[]): Promise<WebsiteSignals[]> {
  const fetchResults = await collectWebsiteSignals(urls);
  const hasUsefulSignal = fetchResults.some((signal) => {
    return Boolean(signal.title || signal.description || signal.headings.length || signal.socialLinks.length);
  });
  if (hasUsefulSignal || !env.tavilyApiKey.trim()) {
    return fetchResults;
  }

  const query = urls.map((url) => `site:${new URL(normalizeUrl(url)).hostname}`).join(" OR ");
  if (!query.trim()) {
    return fetchResults;
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.tavilyApiKey.trim()}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: Math.max(3, urls.length * 2),
        include_answer: true,
        include_raw_content: true,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return fetchResults;
    }
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (!results.length) {
      return fetchResults;
    }
    const tavilySignals = results.slice(0, urls.length).map((result: Record<string, unknown>, index: number) => {
      const sourceUrl = typeof result.url === "string" ? result.url : urls[index] ?? "";
      return collectWebsiteSignalsFromTavilyResult(sourceUrl, result);
    });
    return tavilySignals.length ? tavilySignals : fetchResults;
  } catch {
    return fetchResults;
  }
}

export async function callZhipuChat(model: string, messages: ChatMessage[], temperature = 0.4): Promise<string> {
  if (!env.zhipuApiKey.trim()) {
    throw new Error("ZHIPU_LLM_API_KEY is not configured");
  }
  const base = env.zhipuApiBaseUrl.trim().replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.zhipuApiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream: false,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload === "object" && payload ? JSON.stringify(payload) : response.statusText;
    throw new Error(detail || "Zhipu request failed");
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Zhipu response missing content");
  }
  return content.trim();
}

export async function summarizeBusinessFromWebsites(input: {
  websites: string[];
  linkedIn?: string;
  instagram?: string;
  facebook?: string;
  phoneNumber?: string;
  customInstructions?: string;
}): Promise<string> {
  const signals = await collectWebsiteSignalsWithTavilyFallback(input.websites);
  const rawSummary = [
    ...signals.map((signal) =>
      [
        `URL: ${signal.url}`,
        signal.title ? `Title: ${signal.title}` : "",
        signal.description ? `Description: ${signal.description}` : "",
        signal.headings.length ? `Headings: ${signal.headings.join(" | ")}` : "",
        signal.socialLinks.length ? `Social links: ${signal.socialLinks.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    ),
    input.linkedIn ? `LinkedIn: ${input.linkedIn}` : "",
    input.instagram ? `Instagram: ${input.instagram}` : "",
    input.facebook ? `Facebook: ${input.facebook}` : "",
    input.phoneNumber ? `Phone: ${input.phoneNumber}` : "",
    input.customInstructions ? `Custom notes: ${input.customInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!rawSummary) {
    return "No website details were provided.";
  }

  if (!env.zhipuApiKey.trim()) {
    return rawSummary.slice(0, 1200);
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a sharp B2B business analyst. Read the website and social signals closely, then produce a practical summary that captures the real offer, who the company serves, what makes it different, and what sales angle would matter most. Use concrete service names, industries, target customer types, and proof points when available. Avoid generic filler. Return 4 to 6 concise bullet points.",
    },
    {
      role: "user",
      content: `Analyze the following source information and produce a short service summary for email outreach:\n\n${rawSummary}`,
    },
  ];

  try {
    return await callZhipuChat(env.zhipuModelNameSmall, messages, 0.2);
  } catch {
    return rawSummary.slice(0, 1200);
  }
}

async function callOpenAiResponsesJson<T>(input: {
  model: string;
  instructions: string;
  payload: Record<string, unknown>;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<T> {
  if (!env.openaiApiKey.trim()) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const base = "https://api.openai.com/v1";
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      instructions: input.instructions,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(input.payload, null, 2),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: input.schemaName,
          strict: true,
          schema: input.schema,
        },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload === "object" && payload ? JSON.stringify(payload) : response.statusText;
    throw new Error(detail || "OpenAI request failed");
  }

  const text = extractResponseText(payload as Record<string, unknown>);
  if (!text) {
    throw new Error("OpenAI response missing text");
  }

  return JSON.parse(text) as T;
}

export async function draftPersonalizedMail(input: {
  senderCompanySummary: string;
  senderEmail: string;
  customInstructions?: string;
  recipient: {
    name: string;
    company?: string | null;
    email: string;
    city?: string | null;
    country?: string | null;
    professionalDetails?: string | null;
    website?: string | null;
  };
  currentDraft?: {
    subject: string;
    body: string;
  } | null;
  chatInstruction?: string;
}): Promise<DraftMailResult> {
  const fallbackSubject = input.currentDraft?.subject?.trim() || `A quick idea for ${input.recipient.company || input.recipient.name}`;
  const fallbackBody = [
    `Hi ${input.recipient.name},`,
    "",
    input.currentDraft?.body?.trim() ||
      `I came across your profile${input.recipient.company ? ` at ${input.recipient.company}` : ""} and thought it may be worth reaching out.`,
    `Based on the information we have, we believe there could be a useful fit between your work and our services.`,
    "",
    "If it makes sense, I would be glad to share a short, tailored overview and see whether a brief meeting would be useful.",
    "",
    "Best regards,",
    input.senderEmail,
  ].join("\n");

  const prompt = {
    senderCompanySummary: input.senderCompanySummary,
    senderEmail: input.senderEmail,
    senderNotes: input.customInstructions ?? "",
    recipient: input.recipient,
    currentDraft: input.currentDraft ?? null,
    chatInstruction: input.chatInstruction ?? "",
    rules: [
      "Write one highly personalized B2B outreach email for this exact recipient.",
      "Use at least two concrete facts from the sender company summary.",
      "Treat senderNotes as high-priority instructions. If they mention role, origin, relationship, brand names, or tone, reflect them in the email naturally.",
      "Reference the recipient company, role, city, country, website, or professional details when relevant.",
      "If there are multiple possible services, choose the one most relevant to the recipient and explain why.",
      "Make the message sound like a real business development note, not a template.",
      "Avoid spammy words and hype such as free, guarantee, urgent, limited time, discount, no risk, act now, and similar phrases.",
      "If the sender notes mention a BNI relationship, fellow member relationship, or the sender's name/title, include that context once in a natural, non-forced way.",
      "Do not append internal research bullets or explanations after the sign-off.",
      "Keep the subject short and specific.",
      "Return only JSON with subject and body.",
    ],
  };

  try {
    if (env.openaiApiKey.trim()) {
      const parsed = await callOpenAiResponsesJson<DraftMailResult>({
        model: env.openaiModelName.trim() || "gpt-5.4-nano",
        instructions:
          "You write highly personalized, respectful cold outreach emails. Be specific and concrete. Use the research summary, sender notes, and recipient context to create a compelling, human-sounding message. Treat sender notes as important requirements, especially relationship context, sender identity, and tone. Return only valid JSON with keys subject and body.",
        payload: prompt,
        schemaName: "mail_draft",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["subject", "body"],
          properties: {
            subject: { type: "string", minLength: 1 },
            body: { type: "string", minLength: 1 },
          },
        },
      });
      const subject = parsed.subject.trim() || fallbackSubject;
      const body = parsed.body.trim() || fallbackBody;
      return { subject, body };
    }
  } catch {
    // Fall back to Zhipu below.
  }

  if (!env.zhipuApiKey.trim()) {
    return { subject: fallbackSubject, body: fallbackBody };
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You write highly personalized, respectful cold outreach emails. Use the researched business summary, sender notes, website signals, and any draft context to mention concrete services, capabilities, relationship context, and differentiators. Do not be generic. Avoid spammy wording, hype, or promises. If the sender notes mention a BNI relationship, fellow member relationship, sender name/title, or preferred tone, include that naturally and faithfully. Do not append internal research bullets or explanations after the sign-off. Keep the message professional, specific, and concise. Output JSON only with keys subject and body. The body must be plain text with paragraph breaks and should feel like a human wrote it for this specific recipient.",
    },
    {
      role: "user",
      content: JSON.stringify(prompt, null, 2),
    },
  ];

  try {
    const content = await callZhipuChat(env.zhipuModelNameGeneral, messages, 0.35);
    const parsed = JSON.parse(content) as { subject?: string; body?: string };
    const subject = typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : fallbackSubject;
    const body = typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim() : fallbackBody;
    return { subject, body };
  } catch {
    return { subject: fallbackSubject, body: fallbackBody };
  }
}

export async function reviseCampaignDraft(input: {
  senderCompanySummary: string;
  senderEmail: string;
  customInstructions?: string;
  recipient: {
    name: string;
    company?: string | null;
    email: string;
    city?: string | null;
    country?: string | null;
    professionalDetails?: string | null;
    website?: string | null;
  };
  currentDraft: { subject: string; body: string } | null;
  userInstruction: string;
  conversation: Array<{ role: "USER" | "ASSISTANT"; content: string }>;
}): Promise<{ subject: string; body: string }> {
  const base = input.currentDraft ?? (await draftPersonalizedMail({
    senderCompanySummary: input.senderCompanySummary,
    senderEmail: input.senderEmail,
    customInstructions: input.customInstructions,
    recipient: input.recipient,
  }));

  if (!env.zhipuApiKey.trim()) {
    return {
      subject: base.subject,
      body: `${base.body}\n\n${input.userInstruction}`.trim(),
    };
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are editing a high-conversion B2B outreach email. Keep it personal, specific, and concise. Use the researched company summary, sender notes, and previous chat context. Preserve useful facts, avoid spam language, and return JSON only with keys subject and body. If the user asks to mention or remove a specific business relationship, sender identity, tone, or service, apply it faithfully. The body must remain plain text with paragraph breaks.",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          senderCompanySummary: input.senderCompanySummary,
          senderEmail: input.senderEmail,
          senderNotes: input.customInstructions ?? "",
          recipient: input.recipient,
          currentDraft: base,
          userInstruction: input.userInstruction,
          conversation: input.conversation,
        },
        null,
        2
      ),
    },
  ];

  try {
    const content = await callZhipuChat(env.zhipuModelNameGeneral, messages, 0.35);
    const parsed = JSON.parse(content) as { subject?: string; body?: string };
    const subject = typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : base.subject;
    const body = typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim() : base.body;
    return { subject, body };
  } catch {
    return {
      subject: base.subject,
      body: `${base.body}\n\n${input.userInstruction}`.trim(),
    };
  }
}
