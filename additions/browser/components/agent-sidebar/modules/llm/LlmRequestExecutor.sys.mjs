/* Resilient HTTP execution; authentication is delegated to ModelProvider. */
import { CodexStreamInterruptedError } from "./CodexResponses.sys.mjs";
import { LlmError } from "./LlmProtocol.sys.mjs";
import { readLlmStream } from "./LlmStreamParser.sys.mjs";

const cacheFieldRejectedEndpoints = new Set();
const streamUsageRejectedEndpoints = new Set();

export function createLlmCompatibilityState({ protocol, baseUrl, chatPath }) {
  const key = `${protocol}|${baseUrl}|${chatPath}`;
  let cacheFieldsRejected = cacheFieldRejectedEndpoints.has(key);
  let streamUsageRejected = streamUsageRejectedEndpoints.has(key);
  return Object.freeze({
    get cacheFieldsRejected() { return cacheFieldsRejected; },
    get streamUsageRejected() { return streamUsageRejected; },
    rejectOptionalFields({ cacheApplied, streamUsageApplied }) {
      if (cacheApplied) { cacheFieldsRejected = true; cacheFieldRejectedEndpoints.add(key); }
      if (streamUsageApplied) { streamUsageRejected = true; streamUsageRejectedEndpoints.add(key); }
    },
  });
}

export async function executeLlmChat(context, messages, opts = {}) {
  const { protocol, request, transport, compatibility, buildRequest, parseResponse, modelProvider } = context;
  const streaming = protocol === "openai-codex-responses" || typeof opts.onDelta === "function";
  const requestOpts = { ...opts, stream: streaming };
  let built = buildRequest(messages, requestOpts);
  let optionalFieldFallbackUsed = false;
  let authRetried = false;
  let rejectedAuthorization;
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.signal?.throwIfAborted();
    const controller = transport.createAbortController();
    let stalled = false;
    let watchdog = null;
    const stopWatch = () => {
      if (watchdog !== null) transport.clearTimeout(watchdog);
      watchdog = null;
    };
    const bump = () => {
      stopWatch();
      watchdog = transport.setTimeout(() => { stalled = true; controller.abort(); }, request.timeout_ms);
    };
    const abort = () => controller.abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    bump();
    try {
      const authorized = await modelProvider.authorize(built, {
        signal: controller.signal, rejectedAuthorization,
      });
      controller.signal.throwIfAborted();
      rejectedAuthorization = undefined;
      let response;
      try {
        response = await transport.fetch(authorized.url, { ...authorized.init, signal: controller.signal });
        bump();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = new LlmError(`network error calling ${built.url}: ${error.message}`, { cause: error });
        if (attempt < maxAttempts) {
          stopWatch();
          await transport.delay(500 * attempt);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const errorText = await response.text();
        stopWatch();
        if (response.status === 401 && modelProvider.canRefreshAuth && !authRetried) {
          authRetried = true;
          rejectedAuthorization = authorized.init.headers.Authorization;
          attempt--;
          continue;
        }
        if ((built.cacheApplied || built.streamUsageApplied) && !optionalFieldFallbackUsed &&
            [400, 404, 422].includes(response.status)) {
          compatibility.rejectOptionalFields(built);
          optionalFieldFallbackUsed = true;
          built = buildRequest(messages, { ...requestOpts, disablePromptCache: true, disableStreamUsage: true });
          attempt--;
          continue;
        }
        const transient = [429, 500, 502, 503, 504].includes(response.status) ||
          (!modelProvider.canRefreshAuth && /upstream|gateway|timeout|temporar|overload/i.test(errorText));
        const suffix = transient
          ? `（网关/上游暂时不可用，已自动重试 ${maxAttempts} 次；可稍后再试或换模型）`
          : response.status === 401 && modelProvider.canRefreshAuth ? "（ChatGPT 授权无效，请重新登录）" : "";
        lastError = new LlmError(`LLM API ${response.status} ${response.statusText}${suffix}`, {
          status: response.status,
          body: modelProvider.canRefreshAuth ? null : errorText.slice(0, 2000),
        });
        if (transient && attempt < maxAttempts) {
          await transport.delay(700 * attempt);
          continue;
        }
        throw lastError;
      }

      if (streaming) {
        try {
          return await readLlmStream(protocol, response, {
            onDelta: opts.onDelta, onReasoning: opts.onReasoning, onActivity: bump, parseResponse,
          });
        } catch (error) {
          // Retry only before any generated output. A partial attempt is visible
          // in the UI; replaying it silently would mix two different responses.
          if (error instanceof CodexStreamInterruptedError && !error.partial &&
              !controller.signal.aborted && attempt < maxAttempts) {
            stopWatch();
            await transport.delay(500 * attempt);
            continue;
          }
          throw error;
        }
      }
      const text = await response.text();
      try { return parseResponse(JSON.parse(text)); }
      catch (error) {
        throw new LlmError(`invalid JSON from ${built.url}`, { body: text.slice(0, 500), cause: error });
      }
    } catch (error) {
      if (opts.signal?.aborted) throw new LlmError("request aborted", { cause: error });
      if (stalled) throw new LlmError(
        `连接或流式响应超时：连续 ${Math.round(request.timeout_ms / 1000)}s 无数据，可直接重发。`, { cause: error });
      throw error;
    } finally {
      stopWatch();
      opts.signal?.removeEventListener("abort", abort);
    }
  }
  throw lastError;
}
