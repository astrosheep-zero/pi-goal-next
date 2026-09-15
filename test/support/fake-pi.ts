type Handler = (event: any, ctx: any) => any;

export function createBranchedState(entries: any[] = []) {
  return { entries: [...entries], branch: [...entries] };
}

export function createFakePi(initial: any[] = []) {
  const state = createBranchedState(initial);
  const handlers = new Map<string, Handler[]>();
  const registrations = { tools: [] as any[], commands: [] as any[], renderers: [] as any[] };
  const journal: any[] = [];
  const sentMessages: any[] = [];
  let idle = true;
  let pending = false;
  const ctx: any = {
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => state.branch, appendCustomEntry: (customType: string, data: any) => { const e = { type: "custom", customType, data }; state.branch.push(e); state.entries.push(e); } },
    ui: { statuses: new Map<string, string>(), setStatus: (id: string, text: string) => ctx.ui.statuses.set(id, text), notify: () => undefined }
  };
  const pi: any = {
    ctx,
    on: (name: string, handler: Handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool: (tool: any) => registrations.tools.push(tool),
    registerCommand: (name: string, command: any) => registrations.commands.push({ name, ...command }),
    registerMessageRenderer: (...args: any[]) => registrations.renderers.push(args),
    appendEntry: async (customType: string, data: any) => { const entry = { type: "custom", customType, data }; journal.push(entry); state.branch.push(entry); state.entries.push(entry); },
    sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
    isIdle: () => idle,
    hasPendingMessages: () => pending
  };
  async function emit(name: string, event: any = {}) { let result; for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx); return result; }
  return { pi, ctx, state, handlers, registrations, journal, sentMessages, emit, setIdle: (v: boolean) => { idle = v; }, setPendingMessages: (v: boolean) => { pending = v; }, createBranchedState: (entries: any[] = state.branch) => { state.branch = [...entries]; return state; } };
}

export const createFakePiHarness = createFakePi;
