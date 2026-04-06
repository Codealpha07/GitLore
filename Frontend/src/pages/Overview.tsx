import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FadeIn } from "../components/effects/FadeIn";
import { ChatPanel } from "../components/ChatPanel";
import { EnforcementLog } from "../components/EnforcementLog";
import { IngestButton } from "../components/IngestButton";
import { PrIntelligenceButton } from "../components/PrIntelligenceButton";
import { KnowledgeDecisionsGraph } from "../components/KnowledgeDecisionsGraph";
import { invalidateKnowledgeSuggestionsCache } from "../components/KnowledgeSuggestions";
import { OverviewSkeleton, Spinner } from "../components/Skeleton";
import { useAuth } from "@/context/AuthContext";
import { useRepo } from "@/context/RepoContext";
import {
  fetchRepoAnalytics,
  fetchRepoOverview,
  fetchRepoPullRequests,
  type RepoAnalyticsPayload,
  type RepoOverviewResponse,
  type RepoPullSummary,
} from "@/lib/gitloreApi";
import { useRealtimeUpdates, formatCacheEventTime } from "@/hooks/useRealtimeUpdates";
import { startGithubOAuth as oauthNav } from "@/lib/githubOAuth";

// PR Intelligence QA (dummy): overview page is a common conflict surface when re-introducing UX after a revert.

const HealthBar = ({ score, max }: { score: number; max: number }) => (
  <div className="flex items-center gap-3">
    <progress className="overview-health-progress h-2 w-full overflow-hidden rounded-sm" value={score} max={max} />
    <span className="shrink-0 font-code text-sm text-gitlore-text">
      {typeof score === "number" ? score.toFixed(1) : score} / {max}
    </span>
  </div>
);

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return n.toLocaleString();
  return String(n);
}

const Overview = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { target, repoFull, setTarget, repoReady } = useRepo();
  const [data, setData] = useState<RepoOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [recentPulls, setRecentPulls] = useState<RepoPullSummary[]>([]);
  const [pullsLoading, setPullsLoading] = useState(false);
  const [pullsErr, setPullsErr] = useState<string | null>(null);
  const [refreshChat, setRefreshChat] = useState(0);
  const [enforcementTick, setEnforcementTick] = useState(0);
  const [showAllPRs, setShowAllPRs] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [mongoAnalytics, setMongoAnalytics] = useState<RepoAnalyticsPayload | null>(null);
  const [mongoAnalyticsErr, setMongoAnalyticsErr] = useState<string | null>(null);

  const { events: liveEvents, connected: liveConnected, streamError: liveStreamErr, clearEvents } =
    useRealtimeUpdates(repoReady ? repoFull : null);

  useEffect(() => {
    if (authLoading || !user || repoReady) return;
    navigate("/repos", { replace: true });
  }, [authLoading, user, repoReady, navigate]);

  useEffect(() => {
    if (!user) {
      setData(null);
      setLoading(false);
      setErr(null);
      return;
    }
    if (!repoReady) {
      setData(null);
      setLoading(false);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const o = await fetchRepoOverview(target.owner, target.name, target.branch);
        if (!cancelled) {
          setData(o);
          if (o.defaultBranch && o.defaultBranch !== target.branch) {
            /* optional: don’t auto-overwrite user branch */
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load overview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, repoReady, target.owner, target.name, target.branch]);

  useEffect(() => {
    if (!user || !repoReady) {
      setRecentPulls([]);
      setPullsLoading(false);
      setPullsErr(null);
      return;
    }
    let cancelled = false;
    setPullsLoading(true);
    setPullsErr(null);
    void fetchRepoPullRequests(target.owner, target.name, 12)
      .then((list) => {
        if (!cancelled) setRecentPulls(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setRecentPulls([]);
          setPullsErr(e instanceof Error ? e.message : "Could not load pull requests");
        }
      })
      .finally(() => {
        if (!cancelled) setPullsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, repoReady, target.owner, target.name]);

  useEffect(() => {
    if (!user || !repoReady) {
      setMongoAnalytics(null);
      setMongoAnalyticsErr(null);
      return;
    }
    let cancelled = false;
    void fetchRepoAnalytics(target.owner, target.name)
      .then((payload) => {
        if (!cancelled) {
          setMongoAnalytics(payload);
          setMongoAnalyticsErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setMongoAnalytics(null);
          setMongoAnalyticsErr(e instanceof Error ? e.message : "Analytics unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, repoReady, target.owner, target.name]);

  const onOpenFile = useCallback(
    (filePath: string) => {
      setTarget({ filePath });
      navigate("/app", { state: { file: filePath } });
    },
    [navigate, setTarget]
  );

  if (!user) {
    return (
      <div className="min-h-[calc(100vh-56px)] bg-gitlore-bg px-4 py-12 text-center">
        <p className="mb-4 text-gitlore-text-secondary">Sign in to load repository overview from GitHub.</p>
        <button type="button" onClick={() => oauthNav()} className="rounded-sm bg-gitlore-accent px-4 py-2 text-sm text-white">
          Connect GitHub
        </button>
      </div>
    );
  }

  if (!repoReady) {
    return (
      <div className="min-h-[calc(100vh-56px)] bg-gitlore-bg px-4 py-12 text-center">
        <p className="mx-auto mb-2 max-w-md text-gitlore-text-secondary">
          No repository is selected yet. Open{" "}
          <Link to="/repos" className="text-gitlore-accent hover:text-gitlore-accent-hover">
            repository selection
          </Link>
          , or use <strong className="text-gitlore-text">Repositories</strong> in the header search.
        </p>
      </div>
    );
  }

  const awaitingInitialContent = loading || pullsLoading || (data === null && !err);
  if (awaitingInitialContent) {
    const loadMessage =
      loading && data === null
        ? "Loading repository overview from GitHub…"
        : pullsLoading
          ? "Loading pull requests and wiring the overview…"
          : "Preparing your overview…";
    return <OverviewSkeleton message={loadMessage} />;
  }

  const stats = data?.stats;
  const anti = data?.topAntiPatterns?.length ? data.topAntiPatterns : [];
  const mostChanged = data?.mostChangedFiles?.length ? data.mostChangedFiles : [];
  const visiblePRs = showAllPRs ? recentPulls : recentPulls.slice(0, 5);
  const visibleFiles = showAllFiles ? mostChanged : mostChanged.slice(0, 5);

  return (
    <div className="min-h-[calc(100vh-56px)] bg-gitlore-bg">
      <div className="mx-auto max-w-[1400px] px-4 py-8 md:px-8 md:py-12">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-12 md:gap-8">
          {/* Left Column: Stats & Info */}
          <div className="min-w-0 space-y-8 md:col-span-5">
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-gitlore-text-secondary">Repository</div>
              <h1 className="font-heading text-2xl font-bold text-gitlore-text">{repoFull}</h1>
              {data?.description && <p className="mt-2 text-sm text-gitlore-text-secondary">{data.description}</p>}
              {data?.language && (
                <p className="mt-1 font-code text-xs text-gitlore-accent">Primary language: {data.language}</p>
              )}
            </div>

            {err && <p className="text-sm text-gitlore-error">{err}</p>}
            {loading && data && (
              <p className="flex items-center gap-2 text-sm text-gitlore-text-secondary" role="status" aria-live="polite">
                <Spinner className="h-4 w-4" label="Refreshing overview" />
                Refreshing overview…
              </p>
            )}

            <FadeIn direction="up">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {[
                  { value: stats ? fmt(stats.stars) : "-", label: "Stars" },
                  { value: stats ? fmt(stats.forks) : "-", label: "Forks" },
                  { value: stats ? fmt(stats.pullRequests) : "-", label: "Open + closed PRs (total)" },
                  { value: stats ? fmt(stats.commits) : "-", label: "Commits (default branch)" },
                  { value: stats?.issues != null ? fmt(stats.issues) : "-", label: "Issues" },
                  { value: stats?.contributors != null ? fmt(stats.contributors) : "-", label: "Contributors" },
                  { value: stats?.files != null ? fmt(stats.files) : "-", label: "Files (tree)" },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-sm border border-gitlore-border bg-gitlore-surface p-3">
                    <div className="font-heading text-xl font-bold text-gitlore-text">{stat.value}</div>
                    <div className="mt-0.5 text-xs text-gitlore-text-secondary">{stat.label}</div>
                  </div>
                ))}
              </div>
            </FadeIn>

            <div>
              <div className="mb-3 text-xs font-medium uppercase tracking-wider text-gitlore-text-secondary">Recent pull requests</div>
              {pullsErr && <p className="mb-2 text-sm text-gitlore-error">{pullsErr}</p>}
              {pullsLoading && (
                <p className="mb-2 flex items-center gap-2 text-sm text-gitlore-text-secondary" role="status" aria-live="polite">
                  <Spinner className="h-4 w-4" label="Loading pull requests" />
                  Loading PRs from GitHub…
                </p>
              )}
              {!pullsLoading && !pullsErr && recentPulls.length === 0 && (
                <p className="text-sm text-gitlore-text-secondary">No pull requests returned (empty repo or API scope).</p>
              )}
              <ul className="space-y-2">
                {visiblePRs.map((pr) => (
                  <li key={pr.number} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                    <a
                      href={pr.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 font-code text-gitlore-accent hover:text-gitlore-accent-hover"
                    >
                      #{pr.number}
                    </a>
                    <span className="min-w-0 flex-1 text-gitlore-text">{pr.title}</span>
                    <span className="font-code text-[11px] uppercase text-gitlore-text-secondary">{pr.state}</span>
                    {pr.authorLogin ? (
                      <span className="font-code text-[11px] text-gitlore-text-secondary">@{pr.authorLogin}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {recentPulls.length > 5 ? (
                <button
                  type="button"
                  onClick={() => setShowAllPRs((v) => !v)}
                  className="mt-2 cursor-pointer text-xs text-gitlore-accent hover:text-gitlore-accent-hover"
                >
                  {showAllPRs ? "Show less" : `Show all ${recentPulls.length}`}
                </button>
              ) : null}
            </div>

            <div>
              <div className="mb-3 text-xs font-medium uppercase tracking-wider text-gitlore-text-secondary">Code Health Score</div>
              <HealthBar score={data?.healthScore ?? 0} max={10} />
            </div>

            <div className="rounded-sm border border-gitlore-border bg-gitlore-surface p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase tracking-wider text-gitlore-text-secondary">
                  Live activity
                </div>
                <div className="flex items-center gap-2 text-[11px] text-gitlore-text-secondary">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${liveConnected ? "bg-gitlore-success" : "bg-gitlore-text-secondary/40"}`}
                    aria-hidden
                  />
                  {liveConnected ? "Connected" : liveStreamErr ? "Offline" : "Connecting…"}
                </div>
              </div>
              {liveStreamErr && (
                <p className="mb-2 text-xs text-gitlore-text-secondary">{liveStreamErr}</p>
              )}
              {liveEvents.length === 0 && !liveStreamErr && (
                <p className="text-sm text-gitlore-text-secondary">
                  New review explanations will appear here as they are cached for this repo.
                </p>
              )}
              <ul className="max-h-52 space-y-2 overflow-y-auto">
                {liveEvents.map((ev, i) => (
                  <li key={`${ev.timestamp}-${i}`} className="border-b border-gitlore-border/60 pb-2 text-sm last:border-0 last:pb-0">
                    <div className="font-code text-gitlore-text">
                      {ev.file_path || "-"}
                      {ev.line != null ? `:${ev.line}` : ""} · {ev.pattern_name || "Explanation cached"}
                    </div>
                    <div className="mt-0.5 text-xs text-gitlore-text-secondary">
                      <span className="uppercase">{ev.confidence}</span> confidence · {formatCacheEventTime(ev.timestamp)}
                    </div>
                  </li>
                ))}
              </ul>
              {liveEvents.length > 0 ? (
                <button
                  type="button"
                  onClick={() => clearEvents()}
                  className="mt-2 text-xs text-gitlore-accent hover:text-gitlore-accent-hover"
                >
                  Clear list
                </button>
              ) : null}
            </div>

            {mongoAnalyticsErr && (
              <p className="text-xs text-gitlore-text-secondary">{mongoAnalyticsErr}</p>
            )}
            {mongoAnalytics && !mongoAnalyticsErr ? (
              <div className="rounded-sm border border-gitlore-border bg-gitlore-surface p-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-wider text-gitlore-text-secondary">
                  Cached analyses (MongoDB)
                </div>
                {(() => {
                  const t = mongoAnalytics.analytics.totals[0];
                  return (
                    <p className="mb-3 text-sm text-gitlore-text">
                      <span className="font-medium">{t?.totalAnalyses ?? 0}</span> line analyses across{" "}
                      <span className="font-medium">{t?.uniqueFiles ?? 0}</span> files
                      {t != null && t.uniqueAuthors > 0 ? (
                        <>
                          {" "}
                          · <span className="font-medium">{t.uniqueAuthors}</span> authors in blame
                        </>
                      ) : null}
                      .
                    </p>
                  );
                })()}
                {mongoAnalytics.analytics.dataSignals.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[11px] uppercase text-gitlore-text-secondary">Data signals</div>
                    <ul className="mt-1 flex flex-wrap gap-2 text-xs">
                      {mongoAnalytics.analytics.dataSignals.slice(0, 6).map((s) => (
                        <li key={s._id} className="rounded-sm bg-gitlore-bg px-2 py-0.5 font-code text-gitlore-text">
                          {s._id}{" "}
                          <span className="text-gitlore-text-secondary">({s.count})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {mongoAnalytics.patterns.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase text-gitlore-text-secondary">Explain cache · top patterns</div>
                    <ul className="mt-1 space-y-1 text-sm text-gitlore-text">
                      {mongoAnalytics.patterns.slice(0, 5).map((p) => (
                        <li key={String(p._id)} className="flex justify-between gap-2">
                          <span className="min-w-0 truncate">{p._id || "-"}</span>
                          <span className="shrink-0 text-gitlore-text-secondary">{p.count}×</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : null}

            <div>
              <div className="mb-3 text-xs font-medium uppercase tracking-wider text-gitlore-text-secondary">Patterns (from cached reviews)</div>
              <div className="space-y-2">
                {anti.length ? (
                  anti.map((item) => (
                    <div key={item.text} className="flex items-center gap-2 text-sm">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${item.dot}`} />
                      <span className="text-gitlore-text">{item.text}</span>
                      <span className="text-gitlore-text-secondary">&mdash; found {item.count} times</span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-gitlore-text-secondary">No cached explain() pattern hits yet. Run review explanations on Live repo to populate.</p>
                )}
              </div>
            </div>

            <div className="min-w-0">
              <div className="mb-3 text-xs font-medium uppercase tracking-wider text-gitlore-text-secondary">Most churned files (recent commits)</div>
              <ol className="min-w-0 space-y-1.5">
                {mostChanged.length ? (
                  visibleFiles.map((file, i) => (
                    <li key={file.name} className="flex min-w-0 items-baseline gap-2 text-sm">
                      <span className="w-4 shrink-0 text-xs text-gitlore-text-secondary">{i + 1}.</span>
                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <button
                          type="button"
                          title={file.name}
                          className="min-w-0 flex-1 truncate text-left font-code text-gitlore-accent transition-colors hover:text-gitlore-accent-hover"
                          onClick={() => onOpenFile(file.name)}
                        >
                          {file.name}
                        </button>
                        <span className="shrink-0 whitespace-nowrap text-xs text-gitlore-text-secondary">
                          ({file.changes} line changes)
                        </span>
                      </div>
                    </li>
                  ))
                ) : (
                  <p className="text-sm text-gitlore-text-secondary">No churn data yet (private repo scope or no recent commits).</p>
                )}
              </ol>
              {mostChanged.length > 5 ? (
                <button
                  type="button"
                  onClick={() => setShowAllFiles((v) => !v)}
                  className="mt-2 cursor-pointer text-xs text-gitlore-accent hover:text-gitlore-accent-hover"
                >
                  {showAllFiles ? "Show less" : `Show all ${mostChanged.length}`}
                </button>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => navigate("/app")}
              className="w-full rounded-sm bg-gitlore-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-gitlore-accent-hover"
            >
              Explore Code &rarr;
            </button>
          </div>

          {/* Knowledge graph, ingest, chat */}
          <div className="flex min-h-0 flex-col gap-4 md:col-span-7">
            <KnowledgeDecisionsGraph refreshKey={refreshChat} />
            <div className="flex flex-col gap-3">
              <PrIntelligenceButton />
              <IngestButton
                onComplete={() => {
                  invalidateKnowledgeSuggestionsCache();
                  setRefreshChat((p) => p + 1);
                }}
              />
            </div>
            <ChatPanel key={refreshChat} onChatComplete={() => setEnforcementTick((t) => t + 1)} />
            <EnforcementLog refreshKey={refreshChat + enforcementTick} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Overview;
