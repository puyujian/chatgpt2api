"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  Cloud,
  Copy,
  Database,
  FileText,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  clearUsageLogs,
  fetchUsageLogs,
  type UsageLog,
  type UsageLogListResponse,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "success" | "fail";
type SourceFilter = "all" | "pool" | "cpa";

const metricCards = [
  {
    key: "total" as const,
    label: "总调用",
    color: "text-stone-900",
    icon: FileText,
  },
  {
    key: "success" as const,
    label: "成功",
    color: "text-emerald-600",
    icon: CheckCircle2,
  },
  {
    key: "fail" as const,
    label: "失败",
    color: "text-rose-500",
    icon: CircleOff,
  },
];

const sourceOptions: { label: string; value: SourceFilter }[] = [
  { label: "全部来源", value: "all" },
  { label: "本地号池", value: "pool" },
  { label: "CPA 号池", value: "cpa" },
];

const statusOptions: { label: string; value: StatusFilter }[] = [
  { label: "全部状态", value: "all" },
  { label: "成功", value: "success" },
  { label: "失败", value: "fail" },
];

const PAGE_SIZE_OPTIONS = ["20", "50", "100", "200"];

function formatDuration(ms: number) {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatSourceBadge(source: string) {
  const normalized = String(source || "").toLowerCase();
  if (normalized === "cpa") return { label: "CPA", icon: Cloud, variant: "info" as const };
  return { label: "本地", icon: Database, variant: "secondary" as const };
}

export default function UsagePage() {
  const didLoadRef = useRef(false);
  const [logs, setLogs] = useState<UsageLog[]>([]);
  const [summary, setSummary] = useState<UsageLogListResponse["summary"]>({
    total: 0,
    success: 0,
    fail: 0,
  });
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("50");
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [query]);

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(total / Number(pageSize))),
    [pageSize, total],
  );
  const safePage = Math.max(1, Math.min(page, pageCount));

  const loadLogs = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoading(true);
      try {
        const data = await fetchUsageLogs({
          limit: Number(pageSize),
          offset: (safePage - 1) * Number(pageSize),
          status: statusFilter,
          source: sourceFilter,
          query: debouncedQuery,
        });
        const nextPageCount = Math.max(1, Math.ceil(data.total / Number(pageSize)));
        if (data.total > 0 && safePage > nextPageCount) {
          setTotal(data.total);
          setSummary(data.summary);
          setPage(nextPageCount);
          return;
        }
        setLogs(data.items);
        setTotal(data.total);
        setSummary(data.summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : "加载使用日志失败";
        toast.error(message);
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [debouncedQuery, pageSize, safePage, sourceFilter, statusFilter],
  );

  useEffect(() => {
    if (page !== safePage) {
      setPage(safePage);
    }
  }, [page, safePage]);

  useEffect(() => {
    if (didLoadRef.current) {
      void loadLogs();
      return;
    }
    didLoadRef.current = true;
    void loadLogs();
  }, [loadLogs]);

  const startIndex = (safePage - 1) * Number(pageSize);

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount, safePage + 1);
    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);
    return items;
  }, [pageCount, safePage]);

  const handleClear = async () => {
    if (!window.confirm("确认清空全部使用日志？此操作不可撤销。")) return;
    setIsClearing(true);
    try {
      const { removed } = await clearUsageLogs();
      toast.success(`已清空 ${removed} 条日志`);
      setPage(1);
      await loadLogs();
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空失败";
      toast.error(message);
    } finally {
      setIsClearing(false);
    }
  };

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">
            Usage Logs
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">使用日志</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void loadLogs()}
            disabled={isLoading}
          >
            <RefreshCw className={cn("size-4", isLoading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-rose-200 bg-white/80 px-4 text-rose-600 hover:bg-rose-50"
            onClick={() => void handleClear()}
            disabled={isClearing || summary.total === 0}
          >
            {isClearing ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            清空日志
          </Button>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {metricCards.map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.key} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
              <CardContent className="p-4">
                <div className="mb-4 flex items-start justify-between">
                  <span className="text-xs font-medium text-stone-400">{item.label}</span>
                  <Icon className="size-4 text-stone-400" />
                </div>
                <div className={cn("text-[1.75rem] font-semibold tracking-tight", item.color)}>
                  {summary[item.key]}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">调用记录</h2>
            <Badge variant="secondary" className="rounded-lg bg-stone-200 px-2 py-0.5 text-stone-700">
              {total}
            </Badge>
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-[260px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索 prompt / token / 错误信息"
                className="h-10 rounded-xl border-stone-200 bg-white/85 pl-10"
              />
            </div>
            <Select
              value={sourceFilter}
              onValueChange={(value) => {
                setSourceFilter(value as SourceFilter);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value as StatusFilter);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading && logs.length === 0 ? (
          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-stone-700">正在加载日志</p>
                <p className="text-sm text-stone-500">从后端同步最近的调用记录。</p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card
          className={cn(
            "overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm",
            isLoading && logs.length === 0 ? "hidden" : "",
          )}
        >
          <CardContent className="space-y-0 p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left">
                <thead className="border-b border-stone-100 text-[11px] text-stone-400 uppercase tracking-[0.18em]">
                  <tr>
                    <th className="w-44 px-4 py-3">时间</th>
                    <th className="w-20 px-4 py-3">状态</th>
                    <th className="w-24 px-4 py-3">来源</th>
                    <th className="w-36 px-4 py-3">模型</th>
                    <th className="w-56 px-4 py-3">token / 邮箱</th>
                    <th className="px-4 py-3">Prompt / 错误</th>
                    <th className="w-20 px-4 py-3">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const sourceMeta = formatSourceBadge(log.source);
                    const SourceIcon = sourceMeta.icon;
                    const StatusIcon = log.success ? CheckCircle2 : CircleOff;
                    const isExpanded = expandedId === log.id;
                    const displayMessage = log.success ? log.prompt : log.error || log.prompt;

                    return (
                      <tr
                        key={log.id}
                        className="border-b border-stone-100/80 text-sm text-stone-600 transition-colors hover:bg-stone-50/70"
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-xs leading-5 text-stone-500">
                          {log.timestamp}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={log.success ? "success" : "danger"}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1"
                          >
                            <StatusIcon className="size-3.5" />
                            {log.success ? "成功" : "失败"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={sourceMeta.variant}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1"
                          >
                            <SourceIcon className="size-3.5" />
                            {sourceMeta.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="space-y-0.5">
                            <div className="font-medium text-stone-700">{log.model}</div>
                            {log.upstream_model && log.upstream_model !== log.model ? (
                              <div className="text-xs text-stone-400">↳ {log.upstream_model}</div>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs tracking-tight text-stone-700">
                                {log.token_mask}
                              </span>
                              <button
                                type="button"
                                className="rounded-lg p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                                onClick={() => void handleCopy(log.token_mask, "token")}
                                title="复制 token 掩码"
                              >
                                <Copy className="size-3.5" />
                              </button>
                            </div>
                            <div className="text-xs leading-5 text-stone-400">
                              {log.account_email || "—"}
                              {log.account_type ? (
                                <span className="ml-1 text-stone-300">· {log.account_type}</span>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className={cn(
                              "w-full text-left text-xs leading-5",
                              log.success ? "text-stone-600" : "text-rose-500",
                            )}
                            onClick={() => setExpandedId(isExpanded ? null : log.id)}
                          >
                            <span className={cn(isExpanded ? "" : "line-clamp-2")}>
                              {displayMessage || "—"}
                            </span>
                            {log.has_reference_image ? (
                              <span className="ml-1 inline-flex items-center rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-500">
                                参考图
                              </span>
                            ) : null}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-xs text-stone-500 whitespace-nowrap">
                          {formatDuration(log.duration_ms)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {!isLoading && logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                    <FileText className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-stone-700">暂无使用日志</p>
                    <p className="text-sm text-stone-500">
                      发起生图调用后将在此记录成功/失败历史。
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-stone-100 px-4 py-4">
              <div className="flex items-center justify-center gap-3 overflow-x-auto whitespace-nowrap">
                <div className="shrink-0 text-sm text-stone-500">
                  显示第 {total === 0 ? 0 : startIndex + 1} -{" "}
                  {Math.min(startIndex + Number(pageSize), total)} 条，共 {total} 条
                </div>
                <span className="shrink-0 text-sm leading-none text-stone-500">
                  {safePage} / {pageCount} 页
                </span>
                <Select
                  value={pageSize}
                  onValueChange={(value) => {
                    setPageSize(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="h-10 w-[108px] shrink-0 rounded-lg border-stone-200 bg-white text-sm leading-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <SelectItem key={size} value={size}>
                        {size} / 页
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {paginationItems.map((item, index) =>
                  item === "..." ? (
                    <span key={`ellipsis-${index}`} className="px-1 text-sm text-stone-400">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === safePage ? "default" : "outline"}
                      className={cn(
                        "h-10 min-w-10 shrink-0 rounded-lg px-3",
                        item === safePage
                          ? "bg-stone-950 text-white hover:bg-stone-800"
                          : "border-stone-200 bg-white text-stone-700",
                      )}
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
