"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUpRight, Check, CircleHelp, Clock3,
  FileUp, Folder, Inbox, LoaderCircle, LogOut, Plus, RefreshCw,
  RotateCcw, Settings2, ShieldAlert, Trash2, X,
} from "lucide-react";

type Source = {
  id: string; title: string; url: string; folder: string | null; site_url: string | null;
  error: string | null; last_checked_at: string | null; last_success_at: string | null; unread_count: number;
};
type Item = { id: string; source_id: string; title: string; url: string; summary: string | null; published_at: string | null; discovered_at: string };
type InboxData = { sources: Source[]; items: Item[]; user: { email: string } };
type Operation = { id: number; ids: string[]; label: string; savedAt: number | null };
type Filter = { type: "all" } | { type: "folder"; folder: string } | { type: "source"; id: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  if (response.status === 401) { window.location.assign("/login"); throw new Error("Your session has ended. Sign in again to continue."); }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json(); if (body.error) message = body.error; } catch { /* response may not contain JSON */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function timeLabel(value: string | null) {
  if (!value) return "Recently";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recently";
  const elapsed = Date.now() - date.valueOf();
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function trapDialogTab(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const focusable = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")]
    .filter((element) => element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) { event.preventDefault(); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}

export default function Reader() {
  const [data, setData] = useState<InboxData | null>(null);
  const [filter, setFilter] = useState<Filter>({ type: "all" });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceFolder, setSourceFolder] = useState("");
  const [adding, setAdding] = useState(false);
  const [busySource, setBusySource] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<Operation[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [undoingOperationId, setUndoingOperationId] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const opQueue = useRef<Promise<void>>(Promise.resolve());
  const refreshCount = useRef(0);
  const inboxRequestId = useRef(0);
  const currentFocus = useRef<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const focusRestoreRef = useRef<HTMLElement | null>(null);
  const operationSerial = useRef(0);
  const undoStackRef = useRef(undoStack);
  const undoingRef = useRef<number | null>(null);
  const pendingRef = useRef(pendingIds);
  const initialLoadCompleteRef = useRef(false);
  const returnSyncActiveRef = useRef(false);
  const lastReturnSyncAtRef = useRef(0);
  undoStackRef.current = undoStack;
  pendingRef.current = pendingIds;

  const updateUndoStack = useCallback((update: (stack: Operation[]) => Operation[]) => {
    const next = update(undoStackRef.current);
    undoStackRef.current = next;
    setUndoStack(next);
  }, []);

  const fetchInbox = useCallback(async (preserveFocus = false) => {
    const requestId = ++inboxRequestId.current;
    const focusedId = preserveFocus ? document.activeElement?.getAttribute("data-item-id") ?? null : null;
    const result = await request<InboxData>("/api/inbox", { cache: "no-store" });
    if (requestId !== inboxRequestId.current) return;
    const pending = pendingRef.current;
    const visible = result.items.filter((item) => !pending.has(item.id));
    const hiddenBySource = new Map<string, number>();
    for (const item of result.items) if (pending.has(item.id)) hiddenBySource.set(item.source_id, (hiddenBySource.get(item.source_id) ?? 0) + 1);
    setData({ ...result, items: visible, sources: result.sources.map((source) => ({ ...source, unread_count: Math.max(0, source.unread_count - (hiddenBySource.get(source.id) ?? 0)) })) });
    if (focusedId) currentFocus.current = focusedId;
  }, []);

  const refresh = useCallback(async () => {
    if (refreshCount.current > 0) return false;
    refreshCount.current += 1;
    setRefreshing(true);
    setError("");
    let succeeded = false;
    try {
      await request<{ refreshed: number; failed: number; skipped: number }>("/api/refresh", { method: "POST" });
      await fetchInbox(true);
      succeeded = true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not refresh your feeds.";
      setError(message);
    } finally {
      refreshCount.current -= 1;
      setRefreshing(false);
    }
    return succeeded;
  }, [fetchInbox]);

  useEffect(() => {
    let mounted = true;
    const initialize = async () => {
      try { await fetchInbox(); }
      catch (cause) { if (mounted) setError(cause instanceof Error ? cause.message : "Could not load your feeds."); }
      if (mounted) {
        initialLoadCompleteRef.current = true;
        setLoading(false);
        void refresh();
      }
    };
    void initialize();
    return () => { mounted = false; };
  }, [fetchInbox, refresh]);

  const syncOnReturn = useCallback(() => {
    if (document.visibilityState !== "visible" || !initialLoadCompleteRef.current || returnSyncActiveRef.current) return;
    const now = Date.now();
    if (now - lastReturnSyncAtRef.current < 1000) return;
    lastReturnSyncAtRef.current = now;
    returnSyncActiveRef.current = true;
    void (async () => {
      let inboxError = "";
      try { await fetchInbox(true); }
      catch (cause) { inboxError = cause instanceof Error ? cause.message : "Could not reload your inbox."; }
      const anotherRefreshWasActive = refreshCount.current > 0;
      const refreshed = await refresh();
      if (inboxError && !anotherRefreshWasActive && !refreshed) setError(inboxError);
      returnSyncActiveRef.current = false;
    })();
  }, [fetchInbox, refresh]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") syncOnReturn();
    };
    window.addEventListener("focus", syncOnReturn);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", syncOnReturn);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [syncOnReturn]);

  useEffect(() => {
    if (settingsOpen || helpOpen) {
      focusRestoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const frame = window.requestAnimationFrame(() => {
        const first = dialogRef.current?.querySelector<HTMLElement>("[autofocus], input:not([disabled]), button:not([disabled]), a[href]");
        first?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    focusRestoreRef.current?.focus();
    focusRestoreRef.current = null;
  }, [settingsOpen, helpOpen]);

  useEffect(() => {
    if (!undoStack.length) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [undoStack.length]);

  const sources = data?.sources ?? [];
  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of sources) if (source.folder) counts.set(source.folder, (counts.get(source.folder) ?? 0) + source.unread_count);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sources]);
  const shownItems = useMemo(() => {
    const items = data?.items ?? [];
    if (filter.type === "source") return items.filter((item) => item.source_id === filter.id);
    if (filter.type === "folder") {
      const ids = new Set(sources.filter((source) => source.folder === filter.folder).map((source) => source.id));
      return items.filter((item) => ids.has(item.source_id));
    }
    return items;
  }, [data?.items, filter, sources]);
  const sourceMap = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const visibleItems = useMemo(() => shownItems.filter((item) => !pendingIds.has(item.id)), [shownItems, pendingIds]);
  const allUnread = sources.reduce((total, source) => total + source.unread_count, 0);
  const activeLabel = filter.type === "all" ? "All unread" : filter.type === "folder" ? filter.folder : sourceMap.get(filter.id)?.title ?? "Feed";
  const latestUndo = undoStack.at(-1);
  const undoExpired = !!latestUndo?.savedAt && clockNow - latestUndo.savedAt > 24 * 60 * 60 * 1000;
  const canUndo = !!latestUndo && latestUndo.savedAt !== null && !undoExpired && undoingOperationId === null;

  useEffect(() => {
    const focusId = currentFocus.current;
    if (focusId) {
      const index = visibleItems.findIndex((item) => item.id === focusId);
      if (index >= 0) { setActiveIndex(index); itemRefs.current[index]?.focus({ preventScroll: true }); }
      currentFocus.current = null;
    } else if (activeIndex >= visibleItems.length) setActiveIndex(Math.max(0, visibleItems.length - 1));
  }, [visibleItems, activeIndex]);

  const mutateSeen = useCallback((ids: string[], label = "Marked as seen") => {
    const uniqueIds = [...new Set(ids)].filter((id) => !pendingRef.current.has(id));
    if (!uniqueIds.length) return;
    const focusedId = document.activeElement?.getAttribute("data-item-id");
    if (focusedId && uniqueIds.includes(focusedId)) {
      const index = visibleItems.findIndex((item) => item.id === focusedId);
      const next = visibleItems.slice(index + 1).find((item) => !uniqueIds.includes(item.id)) ?? [...visibleItems.slice(0, Math.max(0, index))].reverse().find((item) => !uniqueIds.includes(item.id));
      currentFocus.current = next?.id ?? null;
    }
    pendingRef.current = new Set([...pendingRef.current, ...uniqueIds]);
    setPendingIds(new Set(pendingRef.current));
    setData((old) => old ? { ...old, items: old.items.filter((item) => !uniqueIds.includes(item.id)), sources: old.sources.map((source) => ({ ...source, unread_count: Math.max(0, source.unread_count - uniqueIds.filter((id) => old.items.some((item) => item.id === id && item.source_id === source.id)).length) })) } : old);
    const operation: Operation = { id: ++operationSerial.current, ids: [], label, savedAt: null };
    updateUndoStack((old) => [...old, operation].slice(-10));
    setNotice(`${label} · undo`);
    setError("");
    opQueue.current = opQueue.current.then(async () => {
      const committedIds: string[] = [];
      try {
        for (let offset = 0; offset < uniqueIds.length; offset += 5000) {
          const batch = uniqueIds.slice(offset, offset + 5000);
          await request<{ updated: number }>("/api/items/seen", { method: "POST", body: JSON.stringify({ ids: batch }) });
          committedIds.push(...batch);
        }
        const savedAt = Date.now();
        updateUndoStack((old) => old.map((entry) => entry.id === operation.id ? { ...entry, ids: committedIds, savedAt } : entry));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Could not save this change.";
        const committed = new Set(committedIds);
        uniqueIds.filter((id) => !committed.has(id)).forEach((id) => pendingRef.current.delete(id));
        setPendingIds(new Set(pendingRef.current));
        updateUndoStack((old) => committedIds.length
          ? old.map((entry) => entry.id === operation.id ? { ...entry, ids: committedIds, savedAt: Date.now() } : entry)
          : old.filter((entry) => entry.id !== operation.id));
        setError(committedIds.length
          ? `Some stories could not be saved: ${message}. ${committedIds.length} were marked as seen and can be undone.`
          : `Could not save “${label.toLowerCase()}”: ${message}`);
        void fetchInbox(true).catch(() => undefined);
      }
    }).catch(() => undefined);
  }, [fetchInbox, updateUndoStack, visibleItems]);

  const undo = useCallback(() => {
    const operation = undoStackRef.current.at(-1);
    if (!operation || operation.savedAt === null || Date.now() - operation.savedAt > 24 * 60 * 60 * 1000 || undoingRef.current !== null) return;
    undoingRef.current = operation.id;
    setUndoingOperationId(operation.id);
    setError("");
    opQueue.current = opQueue.current.then(async () => {
      const restoredIds: string[] = [];
      let updatedCount = 0;
      try {
        for (let offset = 0; offset < operation.ids.length; offset += 5000) {
          const batch = operation.ids.slice(offset, offset + 5000);
          const result = await request<{ updated: number }>("/api/items/undo", { method: "POST", body: JSON.stringify({ ids: batch }) });
          updatedCount += result.updated;
          restoredIds.push(...batch);
        }
        operation.ids.forEach((id) => pendingRef.current.delete(id));
        setPendingIds(new Set(pendingRef.current));
        updateUndoStack((old) => old.filter((entry) => entry.id !== operation.id));
        setNotice(updatedCount === operation.ids.length ? "Restored to your unread list" : updatedCount ? `Restored ${updatedCount} of ${operation.ids.length} stories` : "No stories could be restored; the undo window may have expired");
        await fetchInbox(true);
      } catch (cause) {
        restoredIds.forEach((id) => pendingRef.current.delete(id));
        setPendingIds(new Set(pendingRef.current));
        updateUndoStack((old) => old.map((entry) => entry.id === operation.id ? { ...entry, ids: entry.ids.filter((id) => !restoredIds.includes(id)) } : entry));
        setError(restoredIds.length
          ? `Could not undo every story: ${cause instanceof Error ? cause.message : "Please try again."} ${updatedCount} were restored.`
          : `Could not undo: ${cause instanceof Error ? cause.message : "Please try again."}`);
        void fetchInbox(true).catch(() => undefined);
      } finally {
        undoingRef.current = null;
        setUndoingOperationId(null);
      }
    }).catch(() => undefined);
  }, [fetchInbox, updateUndoStack]);

  const openItem = useCallback((item: Item) => {
    window.open(item.url, "_blank", "noopener,noreferrer");
    mutateSeen([item.id], "Marked as seen");
  }, [mutateSeen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Escape") {
        if (settingsOpen || helpOpen) { event.preventDefault(); setHelpOpen(false); setSettingsOpen(false); }
        return;
      }
      if (typing) return;
      if (settingsOpen || helpOpen) return;
      const interactive = target?.closest("button, a, [role='button']");
      const articleLink = target?.closest("a.article-open[data-item-id]");
      if (interactive && !articleLink) return;
      if (event.key === "?") { event.preventDefault(); setHelpOpen(true); return; }
      if (event.key === "z") { event.preventDefault(); undo(); return; }
      if (!visibleItems.length) return;
      if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); const next = Math.min(visibleItems.length - 1, activeIndex + 1); setActiveIndex(next); itemRefs.current[next]?.focus(); }
      else if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); const next = Math.max(0, activeIndex - 1); setActiveIndex(next); itemRefs.current[next]?.focus(); }
      else if (event.key === "o" || event.key === "Enter") { const item = visibleItems[activeIndex]; if (item) { event.preventDefault(); openItem(item); } }
      else if (event.key === "d" || event.key === "e") { const item = visibleItems[activeIndex]; if (item) { event.preventDefault(); mutateSeen([item.id], "Dismissed"); } }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, helpOpen, mutateSeen, openItem, settingsOpen, undo, visibleItems]);

  const markAllShown = () => mutateSeen(visibleItems.map((item) => item.id), "Marked all shown as seen");
  const addSource = async (event: React.FormEvent) => {
    event.preventDefault(); setAdding(true); setError(""); setNotice("");
    try {
      await request("/api/sources", { method: "POST", body: JSON.stringify({ url: sourceUrl, ...(sourceTitle ? { title: sourceTitle } : {}), ...(sourceFolder ? { folder: sourceFolder } : {}) }) });
      setSourceUrl(""); setSourceTitle(""); setSourceFolder(""); setNotice("Feed added"); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this feed."); }
    finally { setAdding(false); }
  };
  const removeSource = async (source: Source) => {
    setBusySource(source.id); setError("");
    try { await request(`/api/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" }); setNotice(`${source.title} removed`); await fetchInbox(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove this feed."); }
    finally { setBusySource(null); }
  };
  const importOpml = async (file?: File) => {
    if (!file) return;
    setImporting(true); setError("");
    try { const opml = await file.text(); const result = await request<{ imported?: number; added?: number }>("/api/sources/import", { method: "POST", body: JSON.stringify({ opml }) }); setNotice(`${result.imported ?? result.added ?? "Feeds"} imported`); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not import this OPML file."); }
    finally { setImporting(false); }
  };

  const filterAll = () => setFilter({ type: "all" });
  const setFolder = (folder: string) => setFilter({ type: "folder", folder });
  const setSource = (id: string) => setFilter({ type: "source", id });

  return <main className="app-shell">
    <aside className="sidebar" aria-label="Feed navigation">
      <div className="brand-row"><span className="brand-mark" aria-hidden="true">p</span><span className="brand-name">Porto</span></div>
      <div className="sidebar-caption">YOUR READING</div>
      <button className={`nav-item ${filter.type === "all" ? "selected" : ""}`} onClick={filterAll} aria-current={filter.type === "all" ? "page" : undefined}>
        <Inbox size={17} strokeWidth={1.8} /><span>All unread</span><span className="nav-count">{allUnread}</span>
      </button>
      {folders.length > 0 && <div className="folder-list">{folders.map(([folder, count]) => <button key={folder} className={`nav-item ${filter.type === "folder" && filter.folder === folder ? "selected" : ""}`} onClick={() => setFolder(folder)} aria-current={filter.type === "folder" && filter.folder === folder ? "page" : undefined}>
        <Folder size={16} strokeWidth={1.8} /><span className="nav-label">{folder}</span><span className="nav-count">{count}</span>
      </button>)}</div>}
      <div className="sidebar-caption feeds-caption">FEEDS <button aria-label="Manage feeds" title="Manage feeds" className="icon-button tiny" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></button></div>
      <nav className="source-list" aria-label="Feeds">{sources.map((source) => <button key={source.id} className={`nav-item source-nav ${filter.type === "source" && filter.id === source.id ? "selected" : ""}`} onClick={() => setSource(source.id)} aria-current={filter.type === "source" && filter.id === source.id ? "page" : undefined}>
        <span className={`source-dot ${source.error ? "source-dot-error" : ""}`} aria-hidden="true" /><span className="nav-label">{source.title}</span>{source.unread_count > 0 && <span className="nav-count">{source.unread_count}</span>}
      </button>)}{sources.length === 0 && !loading && <p className="sidebar-empty">Your feeds will appear here.</p>}</nav>
      <div className="sidebar-bottom"><div className="account-line"><div className="avatar" aria-hidden="true">{data?.user.email?.slice(0, 1).toUpperCase() ?? "P"}</div><div className="account-details"><strong>{data?.user.email ?? "Your account"}</strong><span>Personal library</span></div><form action="/auth/signout" method="post"><button className="icon-button" aria-label="Sign out" title="Sign out"><LogOut size={16} /></button></form></div></div>
    </aside>

    <section className="reader-pane" aria-label="Unread articles">
      <header className="topbar"><div className="mobile-brand"><span className="brand-mark">p</span><span className="brand-name">Porto</span><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Manage feeds"><Settings2 size={18} /></button></div><div className="topbar-label">{data?.user.email && <span className="sync-label"><span className={`sync-dot ${refreshing ? "spinning" : ""}`} />{refreshing ? "Checking feeds" : "Library up to date"}</span>}</div><div className="topbar-actions"><button className="quiet-button" onClick={() => setExpanded((old) => !old)} aria-pressed={expanded}>{expanded ? "Hide excerpts" : "Show excerpts"}</button><button className="quiet-button" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts"><CircleHelp size={16} /><span>Shortcuts</span></button><button className="icon-button refresh-button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh feeds" title="Refresh feeds"><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button><button className="primary-button mark-all" onClick={markAllShown} disabled={!visibleItems.length || loading}><Check size={15} />Mark all shown</button></div></header>
      <nav className="mobile-filters" aria-label="Feed filters"><button className={filter.type === "all" ? "active" : ""} aria-current={filter.type === "all" ? "page" : undefined} onClick={filterAll}>All unread <span>{allUnread}</span></button>{folders.map(([folder, count]) => <button key={`mobile-folder-${folder}`} className={filter.type === "folder" && filter.folder === folder ? "active" : ""} aria-current={filter.type === "folder" && filter.folder === folder ? "page" : undefined} onClick={() => setFolder(folder)}>{folder}<span>{count}</span></button>)}{sources.map((source) => <button key={`mobile-source-${source.id}`} className={filter.type === "source" && filter.id === source.id ? "active" : ""} aria-current={filter.type === "source" && filter.id === source.id ? "page" : undefined} onClick={() => setSource(source.id)}>{source.title}{source.unread_count > 0 && <span>{source.unread_count}</span>}</button>)}</nav>
      <div className="reader-content">
        <div className="page-heading"><div><div className="eyebrow">A LITTLE SPACE TO CATCH UP</div><h1>{activeLabel}</h1><p className="heading-subtitle">{visibleItems.length === 1 ? "One story waiting for you." : `${visibleItems.length} stories waiting for you.`}</p></div><button className="mobile-mark-all" onClick={markAllShown} disabled={!visibleItems.length || loading}><Check size={15} />Mark all</button></div>
        {notice && <div role="status" className="notice"><span>{notice.replace(" · undo", "")}</span>{notice.includes("undo") && <button onClick={undo} disabled={!canUndo}><RotateCcw size={13} />{undoingOperationId !== null ? "Undoing" : latestUndo?.savedAt === null ? "Saving" : undoExpired ? "Expired" : "Undo"} <kbd>Z</kbd></button>}<button className="notice-close" aria-label="Dismiss message" onClick={() => setNotice("")}><X size={14} /></button></div>}
        {error && <div role="alert" className="alert"><ShieldAlert size={17} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}><X size={14} /></button></div>}
        {!loading && sources.some((source) => source.error) && <div className="feed-warning"><ShieldAlert size={15} /><span>{sources.filter((source) => source.error).length} {sources.filter((source) => source.error).length === 1 ? "feed needs" : "feeds need"} attention</span><button onClick={() => setSettingsOpen(true)}>Review feeds <ArrowUpRight size={13} /></button></div>}
        <div className="list-meta"><span>{loading ? "Loading your feeds…" : `${visibleItems.length} UNREAD`}</span><span className="list-meta-right"><Clock3 size={13} />Newest first</span></div>
        {loading ? <div className="loading-state"><LoaderCircle size={21} className="spin" /><span>Gathering your unread stories</span></div> : !data ? <div className="caught-up"><div className="caught-up-icon caught-up-error"><ShieldAlert size={21} /></div><h2>Your feeds didn’t load.</h2><p>Porto couldn’t reach your library. Check the connection and try again.</p><button className="quiet-button caught-up-refresh" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? "spin" : ""} />Try again</button></div> : visibleItems.length ? <div className="article-list" role="list">{visibleItems.map((item, index) => {
          const source = sourceMap.get(item.source_id);
          return <article role="listitem" className={`article-row ${index === activeIndex ? "row-active" : ""}`} key={item.id} onMouseEnter={() => setActiveIndex(index)}>
            <a href={item.url} target="_blank" rel="noopener noreferrer" data-item-id={item.id} ref={(node) => { itemRefs.current[index] = node; }} className="article-open" onClick={() => mutateSeen([item.id], "Marked as seen")} onAuxClick={(event) => { if (event.button === 1) mutateSeen([item.id], "Marked as seen"); }}>
              <span className="article-main"><span className="source-line"><span className="source-name">{source?.title ?? "Unknown feed"}</span>{source?.folder && <><span className="metadata-dot">·</span><span className="source-folder">{source.folder}</span></>}<span className="metadata-dot">·</span><time dateTime={item.published_at ?? item.discovered_at}>{timeLabel(item.published_at ?? item.discovered_at)}</time></span><span className="article-title">{item.title || "Untitled story"}</span>{expanded && item.summary && <span className="article-summary">{item.summary}</span>}</span><span className="article-trailing"><span className="unread-dot" aria-label="Unread" /><ArrowUpRight size={15} className="open-indicator" /></span>
            </a><button data-item-id={item.id} className="dismiss-button" onClick={() => mutateSeen([item.id], "Dismissed")} aria-label={`Dismiss ${item.title || "story"}`} title="Dismiss"><X size={15} /></button>
          </article>;
        })}</div> : <div className="caught-up"><div className="caught-up-icon"><Check size={22} /></div><h2>You’re all caught up.</h2><p>There’s nothing unread in this view. New stories will find their way here.</p><button className="quiet-button caught-up-refresh" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? "spin" : ""} />Check for new stories</button></div>}
        <footer className="reader-footer"><span>Take your time.</span><button onClick={() => setSettingsOpen(true)}>Manage feeds <ArrowUpRight size={13} /></button></footer>
      </div>
    </section>

    {settingsOpen && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section ref={dialogRef} onKeyDown={trapDialogTab} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header className="panel-header"><div><div className="eyebrow">YOUR LIBRARY</div><h2 id="settings-title">Manage feeds</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button></header>
      <form className="add-feed-form" onSubmit={addSource}><label htmlFor="feed-url">Add a feed</label><div className="feed-url-row"><input id="feed-url" type="url" placeholder="https://example.com/feed.xml" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} required autoFocus /><button className="primary-button" type="submit" disabled={adding || !sourceUrl.trim()}>{adding ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Add</button></div><div className="form-secondary"><input aria-label="Feed name (optional)" placeholder="Feed name (optional)" value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} /><input aria-label="Folder (optional)" placeholder="Folder (optional)" value={sourceFolder} onChange={(event) => setSourceFolder(event.target.value)} /></div></form>
      <div className="opml-actions"><label className="quiet-button file-button"><FileUp size={15} />{importing ? "Importing…" : "Import OPML"}<input type="file" accept=".opml,.xml,text/xml,application/xml" disabled={importing} onChange={(event) => { void importOpml(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><a className="quiet-button" href="/api/sources/export"><ArrowDown size={15} />Export OPML</a></div>
      <div className="settings-list-heading"><span>SUBSCRIPTIONS</span><span>{sources.length}</span></div><div className="settings-source-list">{sources.map((source) => <div className="settings-source" key={source.id}><div className="settings-source-icon"><span className={`source-dot ${source.error ? "source-dot-error" : ""}`} /></div><div className="settings-source-copy"><strong>{source.title}</strong><span>{source.folder ? `${source.folder} · ` : ""}{source.error ? source.error : source.url}</span></div><button className="icon-button remove-source" onClick={() => void removeSource(source)} disabled={busySource === source.id} aria-label={`Remove ${source.title}`} title="Remove feed">{busySource === source.id ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}</button></div>)}{sources.length === 0 && <p className="empty-sources">No feeds yet. Add one above or import your OPML file.</p>}</div>
      <div className="panel-bottom"><span>{data?.user.email ?? ""}</span><form action="/auth/signout" method="post"><button className="quiet-button" type="submit"><LogOut size={15} />Sign out</button></form></div>
    </section></div>}
    {helpOpen && <div className="overlay help-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section ref={dialogRef} onKeyDown={trapDialogTab} className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title"><header className="panel-header"><div><div className="eyebrow">MOVE THROUGH YOUR FEEDS</div><h2 id="help-title">Keyboard shortcuts</h2></div><button className="icon-button" autoFocus onClick={() => setHelpOpen(false)} aria-label="Close shortcuts"><X size={18} /></button></header><div className="shortcut-list"><div><span>Next / previous story</span><span><kbd>J</kbd><kbd>K</kbd></span></div><div><span>Open story</span><span><kbd>O</kbd><kbd>↵</kbd></span></div><div><span>Dismiss story</span><kbd>D</kbd></div><div><span>Undo last change</span><kbd>Z</kbd></div><div><span>Show this panel</span><kbd>?</kbd></div></div><p className="help-note">Shortcuts pause while you’re typing. Use <kbd>Esc</kbd> to close this panel.</p></section></div>}
  </main>;
}
