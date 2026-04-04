import { useState, useRef, useEffect, useCallback, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { useLocation, useNavigate } from "react-router-dom";
import { Send, Bot, User, ExternalLink, Loader, Sparkles, Trash2 } from "lucide-react";
import { useRepo } from "@/context/RepoContext";
import { useToast } from "@/context/ToastContext";
import { postJSON, fetchChatGraphStatus, type ChatGraphStatusResponse } from "@/lib/gitloreApi";
import {
  loadChatSessionCache,
  saveChatSessionCache,
  clearChatSessionCache,
} from "@/lib/overviewSessionCache";

interface Source {
  pr_number: number;
  pr_url: string;
  title: string;
  type: string;
  score?: number;
}

type SynthesisKind = "none" | "gemini" | "fallback_no_key" | "fallback_error";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  searchTier?: string;
  nodesUsed?: number;
  synthesis?: SynthesisKind;
  model?: string;
}

const TYPE_COLORS: Record<string, string> = {
  feature: "text-blue-400",
  bugfix: "text-red-400",
  refactor: "text-green-400",
  architecture: "text-purple-400",
  security: "text-orange-400",
  performance: "text-yellow-400",
  documentation: "text-gray-400",
  other: "text-gray-500",
};

/** Markdown mapping for assistant replies — scoped to the chat bubble. */
const assistantMarkdownComponents = {
  h1: (props: ComponentPropsWithoutRef<"h1">) => (
    <h1 className="mb-2 mt-3 text-base font-semibold text-gitlore-text first:mt-0" {...props} />
  ),
  h2: (props: ComponentPropsWithoutRef<"h2">) => (
    <h2 className="mb-2 mt-3 text-[15px] font-semibold text-gitlore-text first:mt-0" {...props} />
  ),
  h3: (props: ComponentPropsWithoutRef<"h3">) => (
    <h3 className="mb-1.5 mt-2 text-sm font-semibold text-gitlore-text first:mt-0" {...props} />
  ),
  p: (props: ComponentPropsWithoutRef<"p">) => <p className="mb-2 last:mb-0 leading-relaxed text-gitlore-text" {...props} />,
  ul: (props: ComponentPropsWithoutRef<"ul">) => (
    <ul className="mb-2 list-inside list-disc space-y-1 pl-0.5 text-gitlore-text marker:text-gitlore-text-secondary" {...props} />
  ),
  ol: (props: ComponentPropsWithoutRef<"ol">) => (
    <ol className="mb-2 list-inside list-decimal space-y-1 pl-0.5 text-gitlore-text marker:text-gitlore-text-secondary" {...props} />
  ),
  li: (props: ComponentPropsWithoutRef<"li">) => <li className="leading-relaxed [&>p]:mb-0" {...props} />,
  strong: (props: ComponentPropsWithoutRef<"strong">) => <strong className="font-semibold text-gitlore-text" {...props} />,
  em: (props: ComponentPropsWithoutRef<"em">) => <em className="italic text-gitlore-text" {...props} />,
  a: (props: ComponentPropsWithoutRef<"a">) => (
    <a
      className="text-gitlore-accent underline decoration-gitlore-accent/40 underline-offset-2 transition-colors hover:text-gitlore-accent-hover"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  code: ({ className, children, ...props }: ComponentPropsWithoutRef<"code">) => {
    const isBlock = /language-/.test(className || "");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded-sm bg-gitlore-code px-1.5 py-0.5 font-code text-[13px] text-gitlore-accent"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="mb-2 max-w-full overflow-x-auto rounded-sm border border-gitlore-border bg-gitlore-code p-3 font-code text-[13px] leading-relaxed text-gitlore-text">
      {children}
    </pre>
  ),
  blockquote: (props: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote className="mb-2 border-l-2 border-gitlore-border pl-3 text-gitlore-text-secondary italic" {...props} />
  ),
  hr: () => <hr className="my-3 border-gitlore-border" />,
};

function repoCacheKey(owner: string, name: string): string {
  return `${owner.trim().toLowerCase()}/${name.trim().toLowerCase()}`;
}

export function ChatPanel({ onChatComplete }: { onChatComplete?: () => void } = {}) {
  const { target, repoReady } = useRepo();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatStatus, setChatStatus] = useState<ChatGraphStatusResponse | null>(null);
  const [hydratedRepoKey, setHydratedRepoKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!repoReady) {
      setChatStatus(null);
      setMessages([]);
      setHydratedRepoKey(null);
      return;
    }
    const { owner, name } = target;
    const { messages: stored, chatStatus: storedStatus } = loadChatSessionCache(owner, name);
    setMessages(stored as Message[]);
    setChatStatus(storedStatus);
    setHydratedRepoKey(repoCacheKey(owner, name));
  }, [repoReady, target.owner, target.name]);

  useEffect(() => {
    if (!repoReady) return;
    let cancelled = false;
    void fetchChatGraphStatus(target.owner, target.name)
      .then((s) => {
        if (!cancelled) setChatStatus(s);
      })
      .catch(() => {
        if (!cancelled) {
          /* keep cached status if any */
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repoReady, target.owner, target.name]);

  useEffect(() => {
    if (!repoReady || !hydratedRepoKey) return;
    const key = repoCacheKey(target.owner, target.name);
    if (hydratedRepoKey !== key) return;
    saveChatSessionCache(target.owner, target.name, { messages, chatStatus });
  }, [repoReady, hydratedRepoKey, target.owner, target.name, messages, chatStatus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, loading]);

  const sendChatQuestion = useCallback(
    async (qRaw: string) => {
      const q = qRaw.trim();
      if (!q || loading || !repoReady) return;
      if (q.length < 5) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Please ask a slightly longer question (at least 5 characters) so the graph search can match meaningfully.",
          },
        ]);
        return;
      }

      setMessages((prev) => [...prev, { role: "user", content: q }]);
      setLoading(true);

      try {
        const res = (await postJSON(`/api/repo/${target.owner}/${target.name}/chat`, {
          question: q,
        })) as {
          answer: string;
          sources?: Source[];
          searchTier?: string;
          nodesUsed?: number;
          synthesis?: SynthesisKind;
          model?: string;
          geminiConfigured?: boolean;
          armorAgent?: boolean;
          enforcementLog?: Array<{ tool: string; action: string; reason: string }>;
        };
        if (typeof res.geminiConfigured === "boolean") {
          setChatStatus((prev) => ({
            geminiConfigured: res.geminiConfigured!,
            model: res.model || prev?.model || "gemini-2.5-flash-lite",
          }));
        }
        const armorNote =
          res.armorAgent && Array.isArray(res.enforcementLog)
            ? `\n\n---\n_ArmorClaw:_ ${res.enforcementLog.length} policy check(s) — ${res.enforcementLog.filter((e) => e.action === "deny").length} blocked. See **ArmorClaw enforcement** below._`
            : "";
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: res.answer + armorNote,
            sources: res.sources,
            searchTier: res.searchTier,
            nodesUsed: res.nodesUsed,
            synthesis: res.synthesis,
            model: res.model,
          },
        ]);
        if (res.nodesUsed === 0) {
          toast({
            message: "No decisions found yet. Build the Knowledge Graph first.",
            type: "info",
          });
        }
        onChatComplete?.();
      } catch (err) {
        const msg =
          err instanceof Error && /invalid question|5.*2000/i.test(err.message)
            ? "Use between 5 and 2000 characters for your question."
            : "Sorry, something went wrong. Try again.";
        setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
        console.error("Chat error:", err);
      } finally {
        setLoading(false);
      }
    },
    [loading, repoReady, target.owner, target.name, toast, onChatComplete]
  );

  useEffect(() => {
    const q = (location.state as { chatQuery?: string } | null)?.chatQuery?.trim();
    if (!q || !repoReady) return;
    navigate(location.pathname, { replace: true, state: {} });
    setInput("");
    void sendChatQuestion(q);
  }, [location.key, location.pathname, navigate, repoReady, sendChatQuestion]);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading || !repoReady) return;
    setInput("");
    await sendChatQuestion(q);
  };

  return (
    <div className="flex h-[420px] shrink-0 flex-col rounded-sm border border-gitlore-border bg-gitlore-surface">
      <div className="shrink-0 border-b border-gitlore-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-sm font-medium text-gitlore-text">Chat with the knowledge graph</h3>
          <div className="flex flex-wrap items-center gap-2">
            {messages.length > 0 && repoReady ? (
              <button
                type="button"
                onClick={() => {
                  setMessages([]);
                  clearChatSessionCache(target.owner, target.name);
                }}
                className="inline-flex items-center gap-1 rounded-sm border border-gitlore-border px-2 py-0.5 font-code text-[10px] text-gitlore-text-secondary transition-colors hover:border-gitlore-error/50 hover:text-gitlore-error"
                title="Clear this repo’s saved chat (local only)"
              >
                <Trash2 className="h-3 w-3 shrink-0" aria-hidden />
                Clear chat
              </button>
            ) : null}
            {chatStatus ? (
              <span
                className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 font-code text-[10px] ${
                  chatStatus.geminiConfigured
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-200"
                }`}
                title="Configured on the GitLore Backend (.env), not in the browser"
              >
                <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
                {chatStatus.geminiConfigured ? `Gemini: ${chatStatus.model}` : "Add GEMINI_API_KEY to Backend .env"}
              </span>
            ) : null}
          </div>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-gitlore-text-secondary">
          Retrieval from indexed PR decisions, then <span className="text-gitlore-text/90">Gemini</span> plans and answers on the server when{" "}
          <span className="font-code">GEMINI_API_KEY</span> is set. Each chat run can use <span className="text-gitlore-text/90">ArmorClaw</span>{" "}
          (intent plan + per-tool policy). Set <span className="font-code">GITLORE_ARMOR_AGENT_CHAT=0</span> on the backend to use the legacy path only.
        </p>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4">
        {messages.length === 0 && (
          <div className="py-6 text-center text-sm leading-relaxed text-gitlore-text-secondary">
            Try: &ldquo;Why did we change authentication?&rdquo; or &ldquo;What refactors touched the API layer?&rdquo;
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
            {msg.role === "assistant" && (
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gitlore-accent/20">
                <Bot className="h-4 w-4 text-gitlore-accent" />
              </div>
            )}
            <div
              className={`max-w-[88%] rounded-sm px-3 py-2.5 text-sm ${
                msg.role === "user"
                  ? "bg-gitlore-accent/15 text-gitlore-text"
                  : "bg-gitlore-code text-gitlore-text"
              }`}
            >
              {msg.role === "user" ? (
                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              ) : (
                <div className="min-w-0 break-words">
                  <ReactMarkdown components={assistantMarkdownComponents}>{msg.content}</ReactMarkdown>
                </div>
              )}
              {msg.role === "assistant" &&
                (msg.searchTier ||
                  msg.nodesUsed != null ||
                  (msg.synthesis && msg.synthesis !== "none")) && (
                  <p className="mt-2 border-t border-gitlore-border/50 pt-2 font-code text-[10px] text-gitlore-text-secondary">
                    {msg.synthesis && msg.synthesis !== "none" && (
                      <span className="mr-2">
                        {msg.synthesis === "gemini" && (
                          <span className="text-emerald-400/90">
                            Synthesis: Gemini{msg.model ? ` (${msg.model})` : ""}
                          </span>
                        )}
                        {msg.synthesis === "fallback_no_key" && (
                          <span className="text-amber-400/90">Synthesis: offline (no API key)</span>
                        )}
                        {msg.synthesis === "fallback_error" && (
                          <span className="text-red-400/90">Synthesis: Gemini error — raw matches shown</span>
                        )}
                      </span>
                    )}
                    {msg.searchTier && msg.searchTier !== "none" && (
                      <span>
                        Search: <span className="text-gitlore-accent">{msg.searchTier}</span>
                      </span>
                    )}
                    {msg.nodesUsed != null && (
                      <span className={msg.searchTier && msg.searchTier !== "none" ? " · " : ""}>
                        Nodes used: {msg.nodesUsed}
                      </span>
                    )}
                  </p>
                )}
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 border-t border-gitlore-border/60 pt-2">
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-gitlore-text-secondary">
                    Sources
                  </p>
                  <ul className="space-y-1">
                    {msg.sources.map((s) => (
                      <li key={s.pr_number}>
                        <a
                          href={s.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 break-words text-xs text-gitlore-accent transition-colors hover:text-gitlore-accent-hover"
                        >
                          <span className={TYPE_COLORS[s.type] || "text-gray-400"}>[{s.type}]</span>
                          <span>
                            PR #{s.pr_number}: {s.title.length > 42 ? `${s.title.slice(0, 40)}…` : s.title}
                          </span>
                          <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gitlore-surface">
                <User className="h-4 w-4 text-gitlore-text-secondary" />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gitlore-accent/20">
              <Loader className="h-4 w-4 animate-spin text-gitlore-accent" />
            </div>
            <div className="rounded-sm bg-gitlore-code px-3 py-2 text-sm text-gitlore-text-secondary">
              Searching knowledge nodes and synthesizing…
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-gitlore-border p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void handleSend()}
            placeholder="Ask about decisions in this repo…"
            disabled={loading || !repoReady}
            className="min-w-0 flex-1 rounded-sm border border-gitlore-border bg-gitlore-code px-3 py-2 text-sm text-gitlore-text placeholder:text-gitlore-text-secondary/50 focus:border-gitlore-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={loading || !input.trim() || !repoReady}
            className="shrink-0 rounded-sm bg-gitlore-accent px-3 py-2 text-white transition-colors hover:bg-gitlore-accent-hover disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
