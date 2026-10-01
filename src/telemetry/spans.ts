import { context, SpanStatusCode, trace, type Attributes, type Link, type Span, type TimeInput } from "@opentelemetry/api";

/**
 * Span helpers for the whole program. They use only `@opentelemetry/api`, which is a no-op until `startTelemetry`
 * registers an SDK, so instrumented code needs no "is telemetry on" checks.
 */

const tracer = () => trace.getTracer("x-plan");

/** Spans started and not yet ended, so an interruption can close them (`interruptOpenSpans`). */
const open = new Set<Span>();
let capture = false;

/** Whether prompts, reasoning, tool arguments and answers go into spans (`telemetry.captureContent`). */
export function captureContent(): boolean {
  return capture;
}

export function setCaptureContent(value: boolean): void {
  capture = value;
}

/** Runs `fn` inside a new span that is the active span for everything `fn` starts; an exception marks it failed. */
export function inSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, links?: Link[]): Promise<T> {
  return tracer().startActiveSpan(name, { attributes, ...(links?.length ? { links } : {}) }, async (span) => {
    open.add(span);
    try {
      return await fn(span);
    } catch (error) {
      failSpan(span, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      endSpan(span);
    }
  });
}

/** Starts a span that does not become active; end it with `endSpan`. `parent` defaults to the active span. */
export function startSpan(name: string, attributes: Attributes, opts: { parent?: Span; startTime?: TimeInput } = {}): Span {
  const parentContext = opts.parent ? trace.setSpan(context.active(), opts.parent) : context.active();
  const span = tracer().startSpan(name, { attributes, ...(opts.startTime !== undefined ? { startTime: opts.startTime } : {}) }, parentContext);
  open.add(span);
  return span;
}

export function endSpan(span: Span, endTime?: TimeInput): void {
  if (!open.delete(span)) return;
  span.end(endTime);
}

export function failSpan(span: Span, message: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Closes every open span as interrupted (Ctrl+C), so the backend shows where the Run stopped. */
export function interruptOpenSpans(): void {
  for (const span of open) {
    span.setAttribute("xplan.interrupted", true);
    failSpan(span, "interrupted");
    span.end();
  }
  open.clear();
}

/** Runs `fn` with `span` as the active span, e.g. a check executed on behalf of a tool call. */
export function withSpan<T>(span: Span, fn: () => Promise<T>): Promise<T> {
  return context.with(trace.setSpan(context.active(), span), fn);
}
