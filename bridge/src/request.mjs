import { BridgeError, canonical } from './common.mjs';

const invalid = message => { throw new BridgeError(message, 400, 'invalid_request_error'); };
const advisoryFields = ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty'];
const allowedFields = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'user', 'n', ...advisoryFields]);

export function normalizeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Expected a JSON object.');
  for (const key of Object.keys(body)) if (!allowedFields.has(key) && body[key] != null) invalid(`Unsupported parameter: ${key}. This CLI bridge cannot enforce model sampling or output-token limits.`);
  if (typeof body.model !== 'string' || !/^(codex|claude)\/[a-zA-Z0-9._-]+$/.test(body.model)) invalid('Use a model ID from /v1/models, such as codex/<model> or claude/sonnet.');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2048) invalid('messages must contain 1–2048 entries.');
  if (body.n != null && body.n !== 1) invalid('Only n=1 is supported.');
  const ignoredParameters = advisoryFields.filter(k => body[k] != null);
  for (const key of ignoredParameters) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) invalid(`${key} must be a number.`);
    if (key.startsWith('max_') && (!Number.isInteger(body[key]) || body[key] < 1)) invalid(`${key} must be a positive integer.`);
  }
  if (body.stream != null && typeof body.stream !== 'boolean') invalid('stream must be boolean.');
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be boolean.');
  if (body.stream_options != null && (typeof body.stream_options !== 'object' || Object.keys(body.stream_options).some(k => k !== 'include_usage'))) invalid('Only stream_options.include_usage is supported.');
  if (body.reasoning_effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(body.reasoning_effort)) invalid('Unsupported reasoning_effort.');

  const messages = body.messages.map(m => {
    if (!m || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) invalid('Unsupported message role.');
    if (m.name != null) invalid('Named messages are not supported.');
    let content = m.content;
    if (Array.isArray(content)) {
      if (content.some(p => p?.type !== 'text' || typeof p.text !== 'string')) invalid('This release supports text input only.');
      content = content.map(p => p.text).join('\n');
    }
    if (content == null && m.role === 'assistant') content = '';
    if (typeof content !== 'string') invalid('Message content must be text.');
    const message = { role: m.role, content };
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string') invalid('Tool results require tool_call_id.');
      message.tool_call_id = m.tool_call_id;
    }
    if (m.tool_calls != null) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) invalid('Invalid tool_calls.');
      message.tool_calls = m.tool_calls.map(t => {
        if (typeof t?.id !== 'string' || t.type !== 'function' || typeof t.function?.name !== 'string' || typeof t.function.arguments !== 'string') invalid('Invalid function tool call.');
        try { JSON.parse(t.function.arguments); } catch { invalid('Tool arguments must be JSON.'); }
        return { id: t.id, type: 'function', function: { name: t.function.name, arguments: canonical(JSON.parse(t.function.arguments)) } };
      });
    }
    return message;
  });
  // Validate tool history, including historical parallel calls, before invoking a CLI.
  const pending = new Set(); const seen = new Set();
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) invalid('Tool result does not match an outstanding tool call.');
    } else {
      if (pending.size) invalid('Every tool call must have a result before the next message.');
      for (const t of m.tool_calls || []) {
        if (seen.has(t.id)) invalid('Duplicate tool call ID.');
        seen.add(t.id); pending.add(t.id);
      }
    }
  }
  if (pending.size) invalid('Missing tool results.');
  if (!['user', 'tool'].includes(messages.at(-1).role)) invalid('The last message must be a user message or tool result.');
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 128)) invalid('tools must be an array of at most 128 functions.');
  const names = new Set();
  const tools = (body.tools || []).map(t => {
    const f = t?.function;
    if (t?.type !== 'function' || typeof f?.name !== 'string' || !/^[\w-]{1,64}$/.test(f.name) || names.has(f.name)) invalid('Tool names must be unique and contain 1–64 letters, digits, underscores or hyphens.');
    if (f.description != null && typeof f.description !== 'string') invalid('Tool description must be text.');
    if (f.parameters != null && (typeof f.parameters !== 'object' || Array.isArray(f.parameters))) invalid('Tool parameters must be a JSON Schema object.');
    if (f.strict === true) invalid('Strict schema enforcement is not available through the CLI bridge.');
    names.add(f.name);
    return { name: f.name, description: f.description || '', inputSchema: f.parameters || { type: 'object', properties: {} } };
  });
  const choice = body.tool_choice ?? 'auto';
  if (!['auto', 'none', 'required'].includes(choice) && !(choice?.type === 'function' && names.has(choice.function?.name))) invalid('Invalid tool_choice.');
  if (choice === 'required' && !tools.length) invalid('tool_choice=required needs tools.');
  const activeTools = choice === 'none' ? [] : typeof choice === 'object' ? tools.filter(t => t.name === choice.function.name) : tools;
  return {
    model: body.model, messages, tools, activeTools, choice,
    reasoning: body.reasoning_effort, stream: body.stream === true, ignoredParameters,
    includeUsage: body.stream_options?.include_usage === true,
    signature: canonical({ model: body.model, tools, reasoning: body.reasoning_effort ?? null, choice })
  };
}

export function instructions(request) {
  return request.messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => m.content).join('\n\n');
}

export function toolInstructions(request) {
  const required = request.choice === 'required' || typeof request.choice === 'object';
  return 'You are the model backend for an external agent. Use only the supplied external tools. The external client executes them and returns results. Do not execute actions independently.' +
    (required ? ' You must call an available external tool before completing this response.' : '');
}
