import Anthropic from "@anthropic-ai/sdk";

import { readApiKey } from "../../../api-key";

/**
 * Tool-use endpoint.
 *
 * POST { query: string }
 * Returns: JSON
 *   {
 *     toolCalls: Array<{ name: string; input: unknown; result: unknown }>,
 *     finalText: string,
 *   }
 *   or 502 `{ error, toolCalls }` when the model did not finish: a turn that
 *   stopped at `max_tokens` (no tool runs from it), a `refusal`, or a model
 *   still calling tools when the two turns run out (#179).
 *
 * Two tools ship: `get_weather` returns canned weather; `calculate` evaluates
 * a simple arithmetic expression. Both are pure functions of the input so
 * cassette playback is deterministic — the model's choice of tool depends
 * only on the recorded API response.
 */
export const runtime = "nodejs";

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "calculate",
    description: "Evaluate a simple arithmetic expression like `(3+4) * 2`.",
    input_schema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
];

function executeTool(name: string, input: unknown): unknown {
  if (name === "get_weather") {
    const city = (input as { city?: string }).city ?? "?";
    return { city, condition: "sunny", temperature_c: 22 };
  }
  if (name === "calculate") {
    const expression = (input as { expression?: string }).expression ?? "";
    // Deliberately narrow eval: only digits, operators, whitespace, and parens.
    // No fancy parser — the goal is a deterministic small surface, not a
    // production calculator.
    if (!/^[0-9+\-*/(). ]+$/.test(expression)) {
      return { error: "expression contains unsupported characters" };
    }
    try {
      // Function constructor avoids `eval`'s scope leak; same restriction
      // surface, narrower side effects.
      const value: unknown = new Function(`return (${expression});`)();
      return { expression, value };
    } catch {
      return { error: "expression did not evaluate" };
    }
  }
  return { error: `unknown tool: ${name}` };
}

interface ToolCall {
  name: string;
  input: unknown;
  result: unknown;
}

export async function POST(req: Request) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // Valid JSON is not necessarily an object (#135): `null` passed the parse
  // and then threw on the field read below -- a TypeError 500 -- while an
  // array, string or number was refused only because its property is undefined.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const body = parsed as { query?: unknown };
  if (typeof body.query !== "string" || body.query.length === 0) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }

  const apiKey = readApiKey();
  const client = new Anthropic({ apiKey });

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: body.query },
  ];

  const toolCalls: ToolCall[] = [];
  let finalText = "";
  let answered = false;

  // Two-turn loop: the model picks a tool (turn 1), we execute it and feed
  // the result back (turn 2). Three-turn or longer is out of scope for the
  // example app — it'd just be more of the same shape.
  for (let turn = 0; turn < 2; turn += 1) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    // How the model ended this turn decides what the route may do with it
    // (#179). Read off the content alone, a max_tokens stop returned cut text
    // as the final answer, and a cut `tool_use` block ran its tool on partial
    // input.
    const stop = response.stop_reason;
    if (stop !== "tool_use" && stop !== "end_turn" && stop !== "stop_sequence") {
      return Response.json(
        { error: `the model stopped with stop_reason=${String(stop)}; the answer is incomplete`, toolCalls },
        { status: 502 },
      );
    }
    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (stop !== "tool_use" || toolUses.length === 0) {
      const textBlocks = response.content.filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      finalText = textBlocks.map((b) => b.text).join("\n");
      answered = true;
      break;
    }
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const result = executeTool(tu.name, tu.input);
      toolCalls.push({ name: tu.name, input: tu.input, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (!answered) {
    // The model still wanted a tool when the two turns ran out: there is no
    // answer to return, and `finalText: ""` read as one (#179).
    return Response.json(
      { error: "the model was still calling tools after the last turn; no final answer", toolCalls },
      { status: 502 },
    );
  }
  return Response.json({ toolCalls, finalText });
}
