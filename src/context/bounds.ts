import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
export const truncateBytes = (text: string, max: number) => {
  if (Buffer.byteLength(text) <= max) return text;
  return (
    Buffer.from(text)
      .subarray(0, Math.max(0, max - 18))
      .toString("utf8")
      .replace(/\uFFFD$/u, "") + "\n[truncated]"
  );
};
/** Remove whole old turns so tool calls/results remain paired; never drop the task. */
export function boundMessages(
  messages: ChatCompletionMessageParam[],
  maxBytes: number,
) {
  const size = () => Buffer.byteLength(JSON.stringify(messages));
  while (size() > maxBytes) {
    const next = messages.findIndex((m, i) => i > 2 && m.role === "assistant");
    if (next < 0)
      throw Error(
        "Model context budget exceeded; cannot fit task and latest tool exchange",
      );
    messages.splice(2, next - 2);
  }
  return messages;
}
