import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";

/** Like InMemorySpanExporter, but keeps the spans after shutdown, which is when tests look at them. */
export class CollectingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: { code: number }) => void): void {
    this.spans.push(...spans);
    done({ code: 0 });
  }

  async shutdown(): Promise<void> {}

  named(name: string): ReadableSpan[] {
    return this.spans.filter((s) => s.name === name);
  }

  one(name: string): ReadableSpan {
    const found = this.named(name);
    if (found.length !== 1) throw new Error(`Expected one span ${name}, found ${found.length}: ${this.spans.map((s) => s.name).join(", ")}`);
    return found[0]!;
  }

  /** The span's parent, by span id. */
  parentOf(span: ReadableSpan): ReadableSpan | undefined {
    return this.spans.find((s) => s.spanContext().spanId === span.parentSpanContext?.spanId);
  }
}
