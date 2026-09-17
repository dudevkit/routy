// RE-E translate-mode stream adapter — mirrors upstream stream.js translate pipeline:
// parseSSELine → translateResponse(target→source) → hasValuableContent filter →
// terminal-chunk usage injection (estimateUsage/filterUsageForFormat/addBufferToUsage)
// → formatSSE per client format. Flush tail via translateResponse(null, state).
// No synthetic [DONE] in translate mode (parity — verified against L1/L2 fixtures).
// Bounded by design: totalContentLength counts; no response text accumulation.
import { translateResponse, initState } from "../translate/index.js";
import { parseSSELine, hasValuableContent, formatSSE } from "../translate/deps/streamHelpers.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, filterUsageForFormat, addBufferToUsage } from "../translate/deps/usageTracking.js";

export function createResponseTranslator({ sourceFormat, targetFormat, model, body, toolNameMap = null, customToolNames = null }) {
  const state = {
    ...initState(sourceFormat),
    provider: null,
    toolNameMap,
    customToolNames: new Set(customToolNames || []),
    model,
    sessionId: null,
  };
  let totalContentLength = 0;

  function trackContent(parsed) {
    const delta = parsed.delta;
    if (delta?.text) totalContentLength += delta.text.length;
    if (delta?.thinking) totalContentLength += delta.thinking.length;
    const od = parsed.choices?.[0]?.delta;
    if (od?.content) totalContentLength += od.content.length;
    if (od?.reasoning_content) totalContentLength += od.reasoning_content.length;
    if (parsed.candidates?.[0]?.content?.parts) {
      for (const part of parsed.candidates[0].content.parts) {
        if (typeof part.text === "string") totalContentLength += part.text.length;
      }
    }
  }

  /** frame: {event, data} from SseParser → array of wire strings for the client */
  function onFrame(frame) {
    if (frame.data === undefined || frame.data === null) return [];
    const parsed = parseSSELine("data: " + frame.data, targetFormat);
    if (!parsed) return [];
    if (parsed.done) return []; // sentinel — translate mode never forwards it
    trackContent(parsed);
    const extracted = extractUsage(parsed);
    if (extracted) state.usage = mergeUsage(state.usage, extracted);

    const translated = translateResponse(targetFormat, sourceFormat, parsed, state);
    const out = [];
    if (translated?.length > 0) {
      for (const item of translated) {
        if (item === null || item === undefined) continue;
        if (!hasValuableContent(item, sourceFormat)) continue;
        const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
        if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
          const estimated = estimateUsage(body, totalContentLength, sourceFormat);
          item.usage = filterUsageForFormat(estimated, sourceFormat);
          state.usage = estimated;
        } else if (state.finishReason && isFinishChunk && state.usage) {
          item.usage = filterUsageForFormat(addBufferToUsage(state.usage), sourceFormat);
        }
        out.push(formatSSE(item, sourceFormat));
      }
    }
    return out;
  }

  function flush() {
    const flushed = translateResponse(targetFormat, sourceFormat, null, state);
    const out = [];
    if (flushed?.length > 0) {
      for (const item of flushed) {
        if (item === null || item === undefined) continue;
        out.push(formatSSE(item, sourceFormat));
      }
    }
    return out;
  }

  return { onFrame, flush, state };
}
