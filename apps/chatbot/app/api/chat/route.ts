import { randomUUID } from 'node:crypto';
import type { MetricsSummary, Provider } from '@obs/shared';
import {
  availableProviders,
  defaultSelectableProvider,
  isAllowedModel,
  isOllamaReachable,
  providerConfig,
  serverConfig,
} from '@/lib/config';
import { createConversation, getMetrics, postMessage } from '@/lib/ingestion-client';
import { getLLM } from '@/lib/llm';
import { extractIntent } from '@/lib/intent';
import { checkPrompt, refusalMessage } from '@/lib/guardrails';
import { chatRequests, chatTotalDuration, chatTtft, guardrailBlocks } from '@/lib/telemetry';

// SDK needs node:crypto, so not edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ChatBody {
  conversationId: string;
  sessionId: string;
  provider?: Provider;
  model?: string;
  windowMinutes?: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const ALLOWED_WINDOWS = new Set([15, 60, 360, 1440, 60 * 24 * 7, 60 * 24 * 30, 60 * 24 * 365]);

function windowLabel(min: number): string {
  if (min < 60) return `last ${min} minutes`;
  const h = min / 60;
  if (h < 24) return h === 1 ? 'last hour' : `last ${h} hours`;
  const d = h / 24;
  if (d < 30) return d === 1 ? 'last 24 hours' : `last ${Math.round(d)} days`;
  if (d < 365) return `last ${Math.round(d / 30)} months`;
  return `last ${Math.round(d / 365)} year`;
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}...` : clean || 'New conversation';
}

function formatMetrics(m: MetricsSummary): string {
  // Zero-fill silent providers so the LLM doesn't pretend they don't exist.
  const fromTelemetry = new Map(
    m.byProvider.map((p) => [p.provider, p] as const),
  );
  const lines = availableProviders().map((p) => {
    const stat = fromTelemetry.get(p);
    if (stat) {
      return `  - ${p}/${stat.model}: ${stat.requests} req, ${(stat.errorRate * 100).toFixed(1)}% err, ${stat.avgLatencyMs}ms avg latency`;
    }
    const { model } = providerConfig(p);
    return `  - ${p}/${model}: 0 req (no traffic in this window, but the provider is configured)`;
  });

  return [
    `Live observability metrics (${windowLabel(m.windowMinutes)}):`,
    `- Total requests: ${m.totalRequests} (${m.throughputPerMin}/min)`,
    `- Failed: ${m.failedRequests} (error rate ${(m.errorRate * 100).toFixed(1)}%)`,
    `- Latency ms: p50 ${m.latency.p50}, p95 ${m.latency.p95}, p99 ${m.latency.p99}, avg ${m.latency.avg}`,
    `- Time to first token ms: p50 ${m.ttft.p50}, p95 ${m.ttft.p95}`,
    `- Tokens: ${m.tokens.total} total (${m.tokens.completion} completion)`,
    `- Estimated cost: $${m.estimatedCostUsd.toFixed(4)}`,
    `- By provider:`,
    ...lines,
  ].join('\n');
}

interface PromptHints {
  uiWindow: number;
  overridden: boolean;
  mentionedProviders: Provider[];
}

function buildSystemPrompt(metricsBlock: string, windowMinutes: number, hints: PromptHints): string {
  const windowLine = hints.overridden
    ? `The metrics shown reflect the ${windowLabel(windowMinutes)} — the user asked about`
      + ` this window explicitly. (Their dashboard selector is on ${windowLabel(hints.uiWindow)},`
      + ` but we honored the phrase in their message instead.)`
    : `The metrics shown reflect the ${windowLabel(windowMinutes)} (the user's current`
      + ` selection in the dashboard).`;

  const providerFocus = hints.mentionedProviders.length
    ? `The user specifically asked about: ${hints.mentionedProviders.join(', ')}. Center`
      + ' your answer on those providers but still mention the others briefly if relevant.'
    : '';

  return [
    serverConfig.systemPrompt,
    '',
    'You are a general-purpose helpful assistant. Answer any question the user',
    'asks — coding, general knowledge, world events, casual chat — using your',
    "own knowledge. You also happen to have access to this app's own live",
    'telemetry, summarised below. ONLY consult the telemetry block when the',
    'user asks about THIS app — stats, latency, errors, throughput, tokens,',
    'cost, providers, requests. For those questions specifically, use the',
    'EXACT NUMBERS shown — never invent, estimate or round. If a relevant',
    "metric is 0 or missing, say so plainly (e.g. 'no requests have been",
    "logged yet'). For every other kind of question, the telemetry block is",
    'irrelevant — just answer normally.',
    '',
    windowLine,
    'If the user asks about a different time range than what is shown, tell them',
    'you only have data for this window and suggest they restate the window or',
    'change the dashboard selector — do not fabricate numbers.',
    '',
    'When the user asks "per provider" or "by provider", mention EVERY provider',
    'listed in the "By provider" block — including ones with 0 requests. Say',
    'something like "groq and openrouter had no traffic in this window" rather',
    'than omitting them.',
    '',
    'EXPLAIN VS. REPORT. Pay attention to the verb the user used:',
    '- "what IS the p95 latency", "how many requests", "what is the error rate"',
    '  → REPORT the number from the telemetry block, one short sentence.',
    '- "what DRIVES p95 latency", "WHY are errors high", "what CAUSES error',
    '  spikes", "what makes throughput differ by provider"',
    '  → EXPLAIN the contributing factors. Cite the live numbers as evidence,',
    '    but spend most of the answer on the WHY. Likely drivers in this',
    '    system include: provider/model choice (Groq is much faster than HF;',
    '    bigger models are slower), output length, time-to-first-token, cold',
    '    starts, network distance, concurrent load, rate-limit retries (429',
    "    backoffs), and the chosen window. Anchor each factor in the user's",
    '    actual data when possible (e.g. "your p95 of 842ms is dominated by',
    '    hf/Qwen at 6.5s; gemini-flash is averaging 1.2s").',
    'Never answer a "why" question with just the metric value.',
    providerFocus,
    '',
    metricsBlock || 'No telemetry has been recorded yet - report this honestly.',
    '',
    'CHART RENDERING — append a chart directive whenever the question is about',
    'one of the tracked observability series and a picture would help the answer',
    'land. That includes:',
    '  • explicit asks ("plot/chart/graph/visualise X")',
    '  • comparisons or breakdowns ("compare/contrast/differ between providers",',
    '    "by provider", "across providers")',
    '  • "why/what drives/what causes" questions about latency, errors,',
    '    throughput/requests, or per-provider behaviour — chart the relevant',
    '    series alongside the explanation',
    '  • trend questions ("trend", "over time", "spikes", "recently")',
    'Give the prose answer first, then append the directive as the LAST lines of',
    'your reply, exactly in this form (a fenced block tagged `chart`):',
    '```chart',
    '{"title":"<short title>","type":"<type>","series":"<series>"}',
    '```',
    'Allowed series (use exactly one): requests, errors, latency, providers.',
    'Allowed types: line, area, bar, pie. Choose the type that fits the data —',
    '  pie/bar work for the categorical `providers` series; line/area/bar work',
    '  for time-series (requests, errors, latency). The user can still toggle.',
    'Pick series by topic: latency→latency, errors/failures→errors,',
    '  throughput/volume/requests→requests, anything "by provider" or comparing',
    '  providers→providers.',
    'Reject (no directive!) for: questions unrelated to telemetry, series we do',
    'not track (memory, cpu, weather, stock prices, tokens-as-a-series, etc.),',
    'or when no data has been logged. Plain prose in those cases.',
    'Never put data points in the directive — the app draws the chart from the',
    'real metrics block above.',
  ].join('\n');
}

export async function POST(req: Request): Promise<Response> {
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { conversationId, sessionId, messages } = body;
  if (!conversationId || !sessionId || !Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'conversationId, sessionId and messages are required' }, { status: 400 });
  }

  const available = availableProviders();
  const provider: Provider =
    body.provider && available.includes(body.provider) ? body.provider : defaultSelectableProvider();

  // No local daemon on the hosted demo; don't let the SDK time out.
  if (provider === 'ollama' && !isOllamaReachable()) {
    return Response.json(
      {
        error:
          "Ollama runs against a local daemon on the server (localhost:11434), and this hosted demo doesn't have one. Clone the repo and run `npm run dev` with `ollama serve` to try it, or pick a different provider above.",
      },
      { status: 409 },
    );
  }
  const model =
    body.model && isAllowedModel(provider, body.model) ? body.model : providerConfig(provider).model;

  const userMsg = messages[messages.length - 1]!;

  // send() strips dangling pairs from aborted retries, so length===1 means first turn.
  const isFirstTurn = messages.length === 1;
  const persistTurn = async (asst: {
    id: string;
    content: string;
    tokenCount?: number;
    inferenceEventId?: string;
    metricsWindowMinutes?: number;
  }): Promise<void> => {
    if (isFirstTurn) {
      try {
        await createConversation({ id: conversationId, title: deriveTitle(userMsg.content), provider, model });
      } catch (err) {
        console.warn('[chat] createConversation failed:', err instanceof Error ? err.message : err);
      }
    }
    try {
      await postMessage(conversationId, { role: 'user', content: userMsg.content });
      await postMessage(conversationId, {
        id: asst.id,
        role: 'assistant',
        content: asst.content,
        tokenCount: asst.tokenCount,
        inferenceEventId: asst.inferenceEventId,
        metricsWindowMinutes: asst.metricsWindowMinutes,
      });
    } catch (err) {
      console.warn('[chat] postMessage failed:', err instanceof Error ? err.message : err);
    }
  };

  // Refusal is streamed like a normal reply and tagged safetyBlocked for the dashboard.
  const verdict = checkPrompt(userMsg.content);
  if (!verdict.allowed) {
    const refusal = refusalMessage(verdict);
    const refusalId = randomUUID();
    guardrailBlocks.add(1, { category: verdict.block?.category ?? 'unknown' });
    chatRequests.add(1, { provider: 'guardrails', model: 'pattern-v1', outcome: 'guardrail_block' });
    void persistTurn({ id: refusalId, content: refusal });

    const encoder = new TextEncoder();
    const refusalStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'meta', assistantMessageId: refusalId, provider: 'guardrails', model: 'pattern-v1', safetyBlocked: true, safetyCategory: verdict.block?.category })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: refusal })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', text: refusal })}\n\n`));
        controller.close();
      },
    });
    return new Response(refusalStream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  }

  const intent = extractIntent(userMsg.content);
  const uiWindow = body.windowMinutes && ALLOWED_WINDOWS.has(body.windowMinutes) ? body.windowMinutes : 60;
  // Message wins over the UI selector.
  const effectiveWindow = intent.windowMinutes ?? uiWindow;
  const windowWasOverridden = intent.windowMinutes !== null && intent.windowMinutes !== uiWindow;

  let metricsBlock = '';
  try {
    const { metrics } = await getMetrics(effectiveWindow);
    metricsBlock = formatMetrics(metrics);
  } catch (err) {
    console.warn('[chat] getMetrics failed, answering without telemetry:', err instanceof Error ? err.message : err);
  }
  const systemPrompt = buildSystemPrompt(metricsBlock, effectiveWindow, {
    uiWindow,
    overridden: windowWasOverridden,
    mentionedProviders: intent.mentionedProviders,
  });

  const assistantId = randomUUID();
  const llm = getLLM(provider);
  const encoder = new TextEncoder();
  const requestStartMs = performance.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (obj: unknown): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          open = false;
        }
      };

      let fullText = '';
      let completionTokens: number | undefined;
      let eventId: string | undefined;
      let outcome: 'ok' | 'cancelled' | 'error' = 'ok';
      let ttftRecorded = false;
      // Lets the finally block write a marker turn if the model errors before any text.
      let failureMessage: string | null = null;

      send({ type: 'meta', assistantMessageId: assistantId, provider, model, metricsWindowMinutes: effectiveWindow });

      try {
        for await (const ev of llm.chatStream({
          conversationId,
          sessionId,
          messageId: assistantId,
          model,
          systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          signal: req.signal,
        })) {
          if (ev.type === 'delta') {
            if (!ttftRecorded) {
              chatTtft.record(performance.now() - requestStartMs, { provider });
              ttftRecorded = true;
            }
            fullText += ev.text;
            send({ type: 'delta', text: ev.text });
          } else {
            completionTokens = ev.usage?.completionTokens;
            eventId = ev.log.eventId;
          }
        }
        send({ type: 'done', text: fullText });
      } catch (err) {
        const aborted = req.signal.aborted || (err instanceof Error && err.name === 'AbortError');
        const message = err instanceof Error ? err.message : String(err);
        if (!aborted) failureMessage = message;
        outcome = aborted ? 'cancelled' : 'error';
        send({
          type: aborted ? 'cancelled' : 'error',
          text: fullText,
          message,
        });
      } finally {
        chatRequests.add(1, { provider, model, outcome });
        chatTotalDuration.record(performance.now() - requestStartMs, { provider, outcome });
        // Zero-text aborts persist nothing; real errors leave a marker.
        const persistText = fullText.trim()
          ? fullText
          : failureMessage
            ? `(no response - ${provider} returned an error: ${failureMessage})`
            : '';
        if (persistText) {
          await persistTurn({
            id: assistantId,
            content: persistText,
            tokenCount: completionTokens,
            inferenceEventId: eventId,
            metricsWindowMinutes: effectiveWindow,
          });
        }
        await llm.flush().catch(() => undefined);
        open = false;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
