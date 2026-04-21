"use client";

import { useEffect, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  ServerCog,
  Trash2,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createCPAPool,
  deleteCPAPool,
  fetchCPAPoolStatus,
  fetchCPAPools,
  syncCPAPool,
  updateCPAPool,
  type CPAPool,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type PoolStatus = { pool_id: string; tokens: number };

export default function SettingsPage() {
  const didLoadRef = useRef(false);
  const [pools, setPools] = useState<CPAPool[]>([]);
  const [poolStatuses, setPoolStatuses] = useState<Record<string, PoolStatus>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPool, setEditingPool] = useState<CPAPool | null>(null);
  const [formName, setFormName] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formSecretKey, setFormSecretKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadPools = async () => {
    setIsLoading(true);
    try {
      const data = await fetchCPAPools();
      setPools(data.pools);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载 CPA 配置失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadPools();
  }, []);

  const openAddDialog = () => {
    setEditingPool(null);
    setFormName("");
    setFormBaseUrl("");
    setFormSecretKey("");
    setShowSecret(false);
    setDialogOpen(true);
  };

  const openEditDialog = (pool: CPAPool) => {
    setEditingPool(pool);
    setFormName(pool.name);
    setFormBaseUrl(pool.base_url);
    setFormSecretKey(pool.secret_key);
    setShowSecret(false);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formBaseUrl.trim()) {
      toast.error("请输入 CPA 地址");
      return;
    }
    if (!formSecretKey.trim()) {
      toast.error("请输入 Secret Key");
      return;
    }

    setIsSaving(true);
    try {
      if (editingPool) {
        const data = await updateCPAPool(editingPool.id, {
          name: formName.trim(),
          base_url: formBaseUrl.trim(),
          secret_key: formSecretKey.trim(),
        });
        setPools(data.pools);
        toast.success("号池已更新");
      } else {
        const data = await createCPAPool({
          name: formName.trim(),
          base_url: formBaseUrl.trim(),
          secret_key: formSecretKey.trim(),
        });
        setPools(data.pools);
        toast.success("号池已添加");
      }
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggle = async (pool: CPAPool) => {
    setTogglingId(pool.id);
    try {
      const data = await updateCPAPool(pool.id, { enabled: !pool.enabled });
      setPools(data.pools);
      toast.success(pool.enabled ? "已禁用" : "已启用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (pool: CPAPool) => {
    setDeletingId(pool.id);
    try {
      const data = await deleteCPAPool(pool.id);
      setPools(data.pools);
      toast.success("号池已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  const handleTest = async (pool: CPAPool) => {
    setTestingId(pool.id);
    try {
      const result = await fetchCPAPoolStatus(pool.id);
      setPoolStatuses((prev) => ({ ...prev, [pool.id]: result }));
      if (result.tokens > 0) {
        toast.success(`连接成功，获取到 ${result.tokens} 个 token`);
      } else {
        toast.warning("连接成功，但未获取到 token");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setTestingId(null);
    }
  };

  const handleSync = async (pool: CPAPool) => {
    setSyncingId(pool.id);
    try {
      const result = await syncCPAPool(pool.id);
      if ((result.errors?.length ?? 0) > 0) {
        toast.warning(`同步完成：新增 ${result.added}，刷新 ${result.refreshed}，失败 ${result.errors.length}`);
      } else {
        toast.success(`同步完成：新增 ${result.added}，跳过 ${result.skipped}，刷新 ${result.refreshed}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "同步失败");
    } finally {
      setSyncingId(null);
    }
  };

  const enabledCount = pools.filter((pool) => pool.enabled).length;

  return (
    <>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Settings</div>
          <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        </div>
      </section>

      <section className="space-y-6">
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-6 p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                  <ServerCog className="size-5 text-stone-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">CPA 号池管理</h2>
                  <p className="text-sm text-stone-500">连接多个 CLIProxyAPI 实例，自动获取 access_token 用于生图</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {pools.length > 0 ? (
                  <Badge variant={enabledCount > 0 ? "success" : "secondary"} className="rounded-md px-2.5 py-1">
                    {enabledCount}/{pools.length} 启用
                  </Badge>
                ) : null}
                <Button className="h-9 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={openAddDialog}>
                  <Plus className="size-4" />
                  添加号池
                </Button>
              </div>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-10">
                <LoaderCircle className="size-5 animate-spin text-stone-400" />
              </div>
            ) : pools.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-stone-50 px-6 py-10 text-center">
                <ServerCog className="size-8 text-stone-300" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-stone-600">暂无 CPA 号池</p>
                  <p className="text-sm text-stone-400">点击「添加号池」连接你的 CLIProxyAPI 实例</p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {pools.map((pool) => {
                  const status = poolStatuses[pool.id];
                  const isBusy =
                    testingId === pool.id ||
                    syncingId === pool.id ||
                    deletingId === pool.id ||
                    togglingId === pool.id;

                  return (
                    <div
                      key={pool.id}
                      className={cn(
                        "flex flex-col gap-3 rounded-xl border px-4 py-3 transition",
                        pool.enabled ? "border-stone-200 bg-white" : "border-stone-100 bg-stone-50 opacity-60",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={cn("size-2.5 rounded-full", pool.enabled ? "bg-emerald-500" : "bg-stone-300")} />
                          <div>
                            <div className="text-sm font-medium text-stone-800">{pool.name || pool.base_url}</div>
                            {pool.name ? <div className="text-xs text-stone-400">{pool.base_url}</div> : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="rounded-lg p-2 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                            onClick={() => void handleToggle(pool)}
                            disabled={isBusy}
                            title={pool.enabled ? "禁用" : "启用"}
                          >
                            {togglingId === pool.id ? (
                              <LoaderCircle className="size-4 animate-spin" />
                            ) : pool.enabled ? (
                              <Power className="size-4" />
                            ) : (
                              <PowerOff className="size-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="rounded-lg p-2 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                            onClick={() => openEditDialog(pool)}
                            disabled={isBusy}
                            title="编辑"
                          >
                            <Pencil className="size-4" />
                          </button>
                          <button
                            type="button"
                            className="rounded-lg p-2 text-stone-400 transition hover:bg-rose-50 hover:text-rose-500"
                            onClick={() => void handleDelete(pool)}
                            disabled={isBusy}
                            title="删除"
                          >
                            {deletingId === pool.id ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                          </button>
                        </div>
                      </div>

                      {pool.enabled ? (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs text-stone-600"
                            onClick={() => void handleTest(pool)}
                            disabled={isBusy}
                          >
                            {testingId === pool.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                            测试连接
                          </Button>
                          <Button
                            variant="outline"
                            className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs text-stone-600"
                            onClick={() => void handleSync(pool)}
                            disabled={isBusy}
                          >
                            {syncingId === pool.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                            同步到号池
                          </Button>
                          {status ? <span className="text-xs text-stone-400">可用 Token: {status.tokens}</span> : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="rounded-xl bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-500">
              <p className="font-medium text-stone-600">使用说明</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                <li>添加多个 CPA 号池后，生图请求会自动从所有启用的号池获取 token</li>
                <li>也可以点击「同步到号池」将某个 CPA 的 token 导入本地号池管理</li>
                <li>CPA 需要开启 remote-management 并设置 allow-remote: true</li>
                <li>同步 token 不会影响 CPA 原有的登录态</li>
                <li>禁用或删除号池即可停止从该 CPA 获取 token</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>{editingPool ? "编辑号池" : "添加号池"}</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              {editingPool ? "修改 CPA 号池的连接信息" : "添加一个新的 CLIProxyAPI 号池"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">名称（可选）</label>
              <Input
                value={formName}
                onChange={(event) => setFormName(event.target.value)}
                placeholder="例如：主号池、备用池"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium text-stone-700">
                <Link2 className="size-3.5" />
                CPA 地址
              </label>
              <Input
                value={formBaseUrl}
                onChange={(event) => setFormBaseUrl(event.target.value)}
                placeholder="http://your-cpa-host:8317"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium text-stone-700">
                <Unplug className="size-3.5" />
                Management Secret Key
              </label>
              <div className="relative">
                <Input
                  type={showSecret ? "text" : "password"}
                  value={formSecretKey}
                  onChange={(event) => setFormSecretKey(event.target.value)}
                  placeholder="CPA 管理密钥"
                  className="h-11 rounded-xl border-stone-200 bg-white pr-10"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 transition hover:text-stone-600"
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setDialogOpen(false)}
              disabled={isSaving}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleSave()}
              disabled={isSaving}
            >
              {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              {editingPool ? "保存修改" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
