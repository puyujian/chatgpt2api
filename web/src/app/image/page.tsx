"use client";

import Image from "next/image";
import type { ClipboardEvent, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  MessageSquarePlus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createImageTask, fetchAccounts, fetchImageTask, type Account, type ImageModel, type ImageTask } from "@/lib/api";
import {
  clearImageConversations,
  deleteImageConversation,
  listImageConversations,
  saveImageConversation,
  type ImageConversation,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";
import { cn } from "@/lib/utils";

const imageModelOptions: Array<{ label: string; value: ImageModel }> = [
  { label: "gpt-image-1", value: "gpt-image-1" },
  { label: "gpt-image-2", value: "gpt-image-2" },
];

const maxReferenceImageCount = 4;
const acceptedReferenceImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 5) {
    return trimmed;
  }
  return `${trimmed.slice(0, 5)}...`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status !== "禁用");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function markConversationInterrupted(item: ImageConversation): ImageConversation {
  return {
    ...item,
    status: "error",
    error: item.images.some((image) => image.status === "success")
      ? item.error || "生成已中断"
      : "页面已刷新，生成已中断",
    images: item.images.map((image) =>
      image.status === "loading"
        ? {
            ...image,
            status: "error",
            error: "页面已刷新，生成已中断",
          }
        : image,
    ),
  };
}

function markConversationFailed(item: ImageConversation, error: string): ImageConversation {
  return {
    ...item,
    status: "error",
    error,
    images: item.images.map((image) =>
      image.status === "loading"
        ? {
            ...image,
            status: "error",
            error,
          }
        : image,
    ),
  };
}

function mergeImageTask(conversation: ImageConversation, task: ImageTask): ImageConversation {
  const taskStatus = task.status === "success" ? "success" : task.status === "error" ? "error" : "generating";
  const baseImages: StoredImage[] =
    conversation.images.length > 0
      ? conversation.images
      : Array.from({ length: task.count }, (_, index) => ({
          id: `${conversation.id}-${index}`,
          status: "loading" as const,
        }));

  let changed =
    conversation.taskId !== task.id ||
    conversation.status !== taskStatus ||
    (conversation.error || undefined) !== (task.error || undefined) ||
    conversation.count !== task.count;

  const images = baseImages.map((image, index) => {
    const taskImage = task.images[index];
    if (!taskImage) {
      return image;
    }
    const nextImage: StoredImage = {
      id: image.id,
      status: taskImage.status,
      b64_json: taskImage.b64_json,
      error: taskImage.error,
    };
    if (
      image.status !== nextImage.status ||
      image.b64_json !== nextImage.b64_json ||
      image.error !== nextImage.error
    ) {
      changed = true;
    }
    return nextImage;
  });

  if (!changed) {
    return conversation;
  }

  return {
    ...conversation,
    taskId: task.id,
    count: task.count,
    status: taskStatus,
    error: task.error || undefined,
    images,
  };
}

function isFinalTask(task: ImageTask) {
  return task.status === "success" || task.status === "error";
}

async function normalizeConversationHistory(items: ImageConversation[]) {
  const normalized = items.map((item) =>
    item.status === "generating" && !item.taskId ? markConversationInterrupted(item) : item,
  );

  await Promise.all(
    normalized
      .filter((item, index) => item !== items[index])
      .map((item) => saveImageConversation(item)),
  );

  return normalized;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result) {
        resolve(reader.result);
        return;
      }
      reject(new Error("读取图片失败"));
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function getImageFiles(files: Iterable<File>) {
  return Array.from(files).filter((file) => acceptedReferenceImageTypes.has(file.type));
}

function getClipboardImageFiles(items: DataTransferItemList) {
  return Array.from(items).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      return [];
    }
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

type PreviewImage = {
  alt: string;
  src: string;
};

type PreviewState = {
  images: PreviewImage[];
  index: number;
  zoomed: boolean;
};

export default function ImagePage() {
  const didLoadQuotaRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("1");
  const [imageModel, setImageModel] = useState<ImageModel>("gpt-image-1");
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDraggingReferenceImage, setIsDraggingReferenceImage] = useState(false);
  const [availableQuota, setAvailableQuota] = useState("加载中");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepthRef = useRef(0);

  const parsedCount = useMemo(() => Math.max(1, Math.min(10, Number(imageCount) || 1)), [imageCount]);
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const items = await listImageConversations();
        const normalizedItems = await normalizeConversationHistory(items);
        if (cancelled) {
          return;
        }
        setConversations(normalizedItems);
        setSelectedConversationId((current) => current ?? normalizedItems[0]?.id ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取会话记录失败";
        toast.error(message);
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadQuota = useCallback(async () => {
    try {
      const data = await fetchAccounts();
      setAvailableQuota(formatAvailableQuota(data.items));
    } catch {
      setAvailableQuota((prev) => (prev === "加载中" ? "—" : prev));
    }
  }, []);

  useEffect(() => {
    if (didLoadQuotaRef.current) {
      return;
    }
    didLoadQuotaRef.current = true;

    const syncQuota = async () => {
      await loadQuota();
    };

    const handleFocus = () => {
      void syncQuota();
    };

    void syncQuota();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadQuota]);

  useEffect(() => {
    if (!selectedConversation && !isGenerating) {
      return;
    }

    resultsViewportRef.current?.scrollTo({
      top: resultsViewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [selectedConversation, isGenerating]);

  const stepPreview = useCallback((delta: number) => {
    setPreview((prev) =>
      prev && prev.images.length > 1
        ? {
            ...prev,
            index: (prev.index + delta + prev.images.length) % prev.images.length,
            zoomed: false,
          }
        : prev,
    );
  }, []);

  const toggleZoom = useCallback(() => {
    setPreview((prev) => (prev ? { ...prev, zoomed: !prev.zoomed } : null));
  }, []);

  const closePreview = useCallback(() => setPreview(null), []);

  const isPreviewOpen = preview !== null;

  useEffect(() => {
    if (!isPreviewOpen) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepPreview(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepPreview(1);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isPreviewOpen, stepPreview]);

  const handleDownloadPreview = () => {
    if (!preview) return;
    const current = preview.images[preview.index];
    if (!current) return;
    const mimeMatch = current.src.match(/^data:(image\/[^;]+);/);
    const mime = mimeMatch?.[1] ?? "image/png";
    const ext = (mime.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
    const link = document.createElement("a");
    link.href = current.src;
    link.download = `image-${preview.index + 1}-${Date.now()}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const persistConversation = useCallback(async (conversation: ImageConversation) => {
    setConversations((prev) => {
      const next = [conversation, ...prev.filter((item) => item.id !== conversation.id)];
      return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    await saveImageConversation(conversation);
  }, []);

  const updateConversation = useCallback(async (
    conversationId: string,
    updater: (current: ImageConversation | null) => ImageConversation | null,
  ) => {
    let nextConversation: ImageConversation | null = null;
    let shouldSave = false;

    setConversations((prev) => {
      const current = prev.find((item) => item.id === conversationId) ?? null;
      const nextItem = updater(current);
      if (!nextItem) {
        return prev;
      }
      nextConversation = nextItem;
      if (current && nextItem === current) {
        return prev;
      }
      shouldSave = true;
      const next = [nextItem, ...prev.filter((item) => item.id !== conversationId)];
      return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });

    if (nextConversation && shouldSave) {
      await saveImageConversation(nextConversation);
    }
  }, []);

  useEffect(() => {
    const activeConversations = conversations.filter(
      (conversation) => conversation.status === "generating" && Boolean(conversation.taskId),
    );
    if (activeConversations.length === 0) {
      return;
    }

    let cancelled = false;

    const syncTasks = async () => {
      await Promise.all(
        activeConversations.map(async (conversation) => {
          const taskId = conversation.taskId;
          if (!taskId) {
            return;
          }

          try {
            const task = await fetchImageTask(taskId);
            if (cancelled) {
              return;
            }
            await updateConversation(conversation.id, (current) =>
              current ? mergeImageTask(current, task) : null,
            );
            if (isFinalTask(task)) {
              await loadQuota();
            }
          } catch (error) {
            if (cancelled) {
              return;
            }
            const message = error instanceof Error ? error.message : "读取生成任务状态失败";
            await updateConversation(conversation.id, (current) =>
              current ? markConversationFailed(current, message) : null,
            );
          }
        }),
      );
    };

    void syncTasks();
    const timer = window.setInterval(() => {
      void syncTasks();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversations, loadQuota, updateConversation]);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    setImagePrompt("");
    setReferenceImages([]);
    textareaRef.current?.focus();
  };

  const handleReferenceImageUpload = async (files: File[], source: "选择" | "拖放" | "粘贴" = "选择") => {
    if (files.length === 0) {
      return;
    }

    const imageFiles = getImageFiles(files);
    if (imageFiles.length === 0) {
      toast.error("请上传 PNG、JPG、WEBP 或 GIF 图片");
      return;
    }

    const remainingCount = maxReferenceImageCount - referenceImages.length;
    if (remainingCount <= 0) {
      toast.error(`最多只能上传 ${maxReferenceImageCount} 张参考图`);
      return;
    }

    try {
      const uploaded = await Promise.all(
        imageFiles.slice(0, remainingCount).map(async (file, index) => ({
          id:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name || `${source}图片-${index + 1}.png`,
          data_url: await readFileAsDataUrl(file),
        })),
      );
      setReferenceImages((prev) => [...prev, ...uploaded].slice(0, maxReferenceImageCount));
      toast.success(`${source}上传 ${uploaded.length} 张参考图`);
      if (imageFiles.length > remainingCount) {
        toast.info(`最多保留 ${maxReferenceImageCount} 张参考图，已忽略多余图片`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  };

  const handleReferenceImageChange = async (fileList: FileList | null) => {
    await handleReferenceImageUpload(Array.from(fileList || []));
  };

  const handleReferenceImagePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = getClipboardImageFiles(event.clipboardData.items);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void handleReferenceImageUpload(files, "粘贴");
  };

  const handleReferenceImageDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingReferenceImage(true);
  };

  const handleReferenceImageDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleReferenceImageDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingReferenceImage(false);
    }
  };

  const handleReferenceImageDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingReferenceImage(false);
    void handleReferenceImageUpload(Array.from(event.dataTransfer.files), "拖放");
  };

  const handleRemoveReferenceImage = (id: string) => {
    setReferenceImages((prev) => prev.filter((item) => item.id !== id));
  };

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    setConversations(nextConversations);
    setSelectedConversationId((prev) => (prev === id ? null : prev));

    try {
      await deleteImageConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations();
      setConversations(items);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
      setConversations([]);
      setSelectedConversationId(null);
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    }
  };

  const handleGenerateImage = async () => {
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    const now = new Date().toISOString();
    const conversationId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const draftConversation: ImageConversation = {
      id: conversationId,
      taskId: conversationId,
      title: buildConversationTitle(prompt),
      prompt,
      model: imageModel,
      count: parsedCount,
      referenceImages: [...referenceImages],
      images: Array.from({ length: parsedCount }, (_, index) => ({
        id: `${conversationId}-${index}`,
        status: "loading" as const,
      })),
      createdAt: now,
      status: "generating",
    };

    setIsGenerating(true);
    setSelectedConversationId(conversationId);
    setImagePrompt("");
    setReferenceImages([]);

    try {
      await persistConversation(draftConversation);
      const task = await createImageTask(
        conversationId,
        prompt,
        imageModel,
        parsedCount,
        draftConversation.referenceImages.map((image) => ({
          data_url: image.data_url,
          name: image.name,
        })),
      );

      await updateConversation(conversationId, (current) =>
        current ? mergeImageTask(current, task) : null,
      );

      if (isFinalTask(task)) {
        await loadQuota();
        if (task.status === "success") {
          toast.success(`已生成 ${task.images.filter((image) => image.status === "success").length} 张图片`);
        } else {
          toast.error(task.error || "生成图片失败");
        }
      } else {
        toast.success("已提交生成任务");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成图片失败";
      await persistConversation(markConversationFailed(draftConversation, message));
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <>
      <section className="mx-auto grid h-[calc(100vh-5rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-3 px-3 pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-h-0 border-r border-stone-200/70 pr-3">
          <div className="flex h-full min-h-0 flex-col gap-3 py-2">
            <div className="flex items-center gap-2">
              <Button
                className="h-10 flex-1 rounded-xl bg-stone-950 text-white hover:bg-stone-800"
                onClick={handleCreateDraft}
              >
                <MessageSquarePlus className="size-4" />
                新建对话
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-xl border-stone-200 bg-white/85 px-3 text-stone-600 hover:bg-white"
                onClick={() => void handleClearHistory()}
                disabled={conversations.length === 0}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {isLoadingHistory ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-stone-500">
                  <LoaderCircle className="size-4 animate-spin" />
                  正在读取会话记录
                </div>
              ) : conversations.length === 0 ? (
                <div className="px-2 py-3 text-sm leading-6 text-stone-500">
                  还没有图片记录，输入提示词后会在这里显示。
                </div>
              ) : (
                conversations.map((conversation) => {
                  const active = conversation.id === selectedConversationId;
                  return (
                    <div
                      key={conversation.id}
                      className={cn(
                        "group relative w-full border-l-2 px-3 py-3 text-left transition",
                        active
                          ? "border-stone-900 bg-black/[0.03] text-stone-950"
                          : "border-transparent text-stone-700 hover:border-stone-300 hover:bg-white/40",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedConversationId(conversation.id)}
                        className="block w-full pr-8 text-left"
                      >
                        <div className="truncate text-sm font-semibold">{conversation.title}</div>
                        <div className={cn("mt-1 text-xs", active ? "text-stone-500" : "text-stone-400")}>
                          {formatConversationTime(conversation.createdAt)}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteConversation(conversation.id)}
                        className="absolute top-3 right-2 inline-flex size-7 items-center justify-center rounded-md text-stone-400 opacity-0 transition hover:bg-stone-100 hover:text-rose-500 group-hover:opacity-100"
                        aria-label="删除会话"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        <div className="flex min-h-0 flex-col gap-4">
          <div
            ref={resultsViewportRef}
            className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-3 sm:px-4 sm:py-4"
          >
            {!selectedConversation ? (
              <div className="flex h-full min-h-[420px] items-center justify-center text-center">
                <div className="w-full max-w-4xl">
                  <h1
                    className="text-3xl font-semibold tracking-tight text-stone-950 md:text-5xl"
                    style={{
                      fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
                    }}
                  >
                    Turn ideas into images
                  </h1>
                  <p
                    className="mt-4 text-[15px] italic tracking-[0.01em] text-stone-500"
                    style={{
                      fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
                    }}
                  >
                    Describe a scene, a mood, or a character, and let the next image start here.
                  </p>
                </div>
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5">
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-[22px] bg-stone-100 px-5 py-3 text-left text-[15px] leading-7 whitespace-pre-wrap text-stone-800">
                    {selectedConversation.prompt}
                  </div>
                </div>

                <div className="flex justify-start">
                  <div className="w-full p-1">
                    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                      <span className="rounded-full bg-stone-100 px-3 py-1">{selectedConversation.model}</span>
                      <span className="rounded-full bg-stone-100 px-3 py-1">{selectedConversation.count} 张</span>
                      {selectedConversation.referenceImages.length > 0 ? (
                        <span className="rounded-full bg-stone-100 px-3 py-1">
                          参考图 {selectedConversation.referenceImages.length} 张
                        </span>
                      ) : null}
                      <span className="rounded-full bg-stone-100 px-3 py-1">
                        {formatConversationTime(selectedConversation.createdAt)}
                      </span>
                    </div>

                    {selectedConversation.status === "error" && selectedConversation.images.length === 0 ? (
                      <div className="border-l-2 border-rose-300 bg-rose-50/70 px-4 py-4 text-sm leading-6 text-rose-600">
                        {selectedConversation.error || "生成失败"}
                      </div>
                    ) : null}

                    {selectedConversation.referenceImages.length > 0 ? (
                      <div className="mb-5">
                        <div className="mb-2 text-xs font-medium tracking-[0.12em] text-stone-400 uppercase">
                          Reference
                        </div>
                        <div className="flex flex-wrap gap-3">
                          {selectedConversation.referenceImages.map((image) => (
                            <div
                              key={image.id}
                              className="w-[140px] overflow-hidden rounded-[16px] border border-stone-200 bg-stone-50"
                            >
                              <Image
                                src={image.data_url}
                                alt={image.name}
                                width={280}
                                height={280}
                                unoptimized
                                className="block aspect-square h-auto w-full object-cover"
                              />
                              <div className="truncate px-3 py-2 text-xs text-stone-500">{image.name}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {selectedConversation.images.length > 0 ? (
                      <div className="columns-1 gap-4 space-y-4 sm:columns-2 xl:columns-3">
                        {selectedConversation.images.map((image, index) => (
                          <div key={image.id} className="break-inside-avoid overflow-hidden rounded-[22px]">
                            {image.status === "success" && image.b64_json ? (
                              <button
                                type="button"
                                onClick={() => {
                                  type Entry = PreviewImage & { id: string };
                                  const successList: Entry[] = selectedConversation.images
                                    .map<Entry | null>((img, i) =>
                                      img.status === "success" && img.b64_json
                                        ? {
                                            id: img.id,
                                            src: `data:image/png;base64,${img.b64_json}`,
                                            alt: `Generated result ${i + 1}`,
                                          }
                                        : null,
                                    )
                                    .filter((item): item is Entry => item !== null);
                                  const targetIdx = successList.findIndex((item) => item.id === image.id);
                                  setPreview({
                                    images: successList.map(({ src, alt }) => ({ src, alt })),
                                    index: Math.max(0, targetIdx),
                                    zoomed: false,
                                  });
                                }}
                                className="group relative block w-full cursor-zoom-in overflow-hidden rounded-[22px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2"
                                aria-label={`放大查看第 ${index + 1} 张生成图片`}
                              >
                                <Image
                                  src={`data:image/png;base64,${image.b64_json}`}
                                  alt={`Generated result ${index + 1}`}
                                  width={1024}
                                  height={1024}
                                  unoptimized
                                  className="block h-auto w-full transition duration-300 group-hover:scale-[1.02]"
                                />
                                <span className="pointer-events-none absolute inset-0 bg-black/0 transition duration-200 group-hover:bg-black/15" />
                                <span className="pointer-events-none absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition duration-200 group-hover:opacity-100">
                                  <Maximize2 className="size-4" />
                                </span>
                              </button>
                            ) : image.status === "error" ? (
                              <div className="flex min-h-[320px] items-center justify-center bg-rose-50 px-6 py-8 text-center text-sm leading-6 text-rose-600">
                                {image.error || "生成失败"}
                              </div>
                            ) : (
                              <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 bg-stone-100/80 px-6 py-8 text-center text-stone-500">
                                <div className="rounded-full bg-white p-3 shadow-sm">
                                  <LoaderCircle className="size-5 animate-spin" />
                                </div>
                                <p className="text-sm">正在生成图片...</p>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {selectedConversation.status === "error" && selectedConversation.images.length > 0 ? (
                      <div className="mt-4 border-l-2 border-amber-300 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-700">
                        {selectedConversation.error}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 flex justify-center">
            <div
              className={cn(
                "relative overflow-hidden rounded-[32px] border border-stone-200/80 bg-white shadow-[0_18px_48px_rgba(28,25,23,0.08)] transition focus-within:border-stone-300 focus-within:shadow-[0_20px_56px_rgba(28,25,23,0.12)]",
                isDraggingReferenceImage &&
                  "border-stone-900 bg-stone-50 shadow-[0_22px_64px_rgba(28,25,23,0.16)]",
              )}
              style={{ width: "min(980px, 100%)" }}
              onDragEnter={handleReferenceImageDragEnter}
              onDragOver={handleReferenceImageDragOver}
              onDragLeave={handleReferenceImageDragLeave}
              onDrop={handleReferenceImageDrop}
            >
              {isDraggingReferenceImage ? (
                <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-[26px] border-2 border-dashed border-stone-400 bg-white/80 text-sm font-medium text-stone-700 backdrop-blur-sm">
                  松开鼠标上传参考图
                </div>
              ) : null}
              <div
                className="flex cursor-text flex-col"
                onClick={() => {
                  textareaRef.current?.focus();
                }}
              >
                <Textarea
                  ref={textareaRef}
                  value={imagePrompt}
                  onChange={(event) => setImagePrompt(event.target.value)}
                  onPaste={handleReferenceImagePaste}
                  placeholder="输入你想要生成的画面"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      if (!isGenerating) {
                        void handleGenerateImage();
                      }
                    }
                  }}
                  className="min-h-[120px] resize-none rounded-none border-0 bg-transparent px-6 pt-6 pb-4 text-[15px] leading-7 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0"
                />

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void handleReferenceImageChange(event.target.files);
                    event.target.value = "";
                  }}
                />

                {referenceImages.length > 0 ? (
                  <div className="border-t border-stone-100 px-5 pt-3 pb-3 sm:px-6">
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-medium tracking-[0.1em] text-stone-400 uppercase">
                      <span>Reference</span>
                      <span className="text-stone-300">{referenceImages.length}/4</span>
                    </div>
                    <div className="flex gap-3 overflow-x-auto pb-1">
                      {referenceImages.map((image) => (
                        <div
                          key={image.id}
                          className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-stone-200 bg-stone-100"
                        >
                          <Image
                            src={image.data_url}
                            alt={image.name}
                            width={160}
                            height={160}
                            unoptimized
                            className="h-full w-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleRemoveReferenceImage(image.id);
                            }}
                            className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
                            aria-label={`删除参考图 ${image.name}`}
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 px-4 py-3 sm:px-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="rounded-full bg-stone-100 px-3 py-2 text-xs font-medium text-stone-600">
                      剩余额度 {availableQuota}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 rounded-full border-stone-200 bg-white px-4 text-sm font-medium text-stone-700 shadow-none hover:bg-stone-50"
                      onClick={(event) => {
                        event.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                    >
                      <ImagePlus className="size-4" />
                      参考图 / 拖拽 / 粘贴
                    </Button>
                    <Select value={imageModel} onValueChange={(value) => setImageModel(value as ImageModel)}>
                      <SelectTrigger className="h-10 w-[164px] rounded-full border-stone-200 bg-white text-sm font-medium text-stone-700 shadow-none focus-visible:ring-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {imageModelOptions.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <div className="flex h-10 items-center gap-2 rounded-full border border-stone-200 bg-white px-3">
                      <span className="text-sm font-medium text-stone-700">张数</span>
                      <Input
                        type="number"
                        min="1"
                        max="10"
                        step="1"
                        value={imageCount}
                        onChange={(event) => setImageCount(event.target.value)}
                        className="h-8 w-[56px] border-0 bg-transparent px-0 text-center text-sm font-medium text-stone-700 shadow-none focus-visible:ring-0"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleGenerateImage()}
                    disabled={isGenerating}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-stone-950 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
                    aria-label="生成图片"
                  >
                    {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => (!open ? setPreview(null) : null)}>
        <DialogContent
          className="max-w-none w-[min(98vw,1400px)] gap-0 overflow-hidden border-0 bg-black/95 p-0 text-white shadow-2xl"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">
            {preview
              ? `图片预览 ${preview.index + 1} / ${preview.images.length}`
              : "图片预览"}
          </DialogTitle>
          {preview && preview.images[preview.index] ? (
            <div className="relative flex h-[90vh] w-full flex-col">
              <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-gradient-to-b from-black/70 via-black/40 to-transparent px-4 py-3">
                <div className="pointer-events-auto rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white/90 backdrop-blur-sm">
                  {preview.index + 1} / {preview.images.length}
                </div>
                <div className="pointer-events-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadPreview}
                    className="inline-flex size-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    aria-label="下载图片"
                  >
                    <Download className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={closePreview}
                    className="inline-flex size-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    aria-label="关闭预览"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>

              <div
                className={cn(
                  "flex h-full w-full items-center justify-center",
                  preview.zoomed ? "overflow-auto" : "overflow-hidden",
                )}
                onClick={(event) => {
                  if (event.target === event.currentTarget) {
                    closePreview();
                  }
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview.images[preview.index].src}
                  alt={preview.images[preview.index].alt}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    preview.zoomed
                      ? "当前为原始尺寸，按 Enter 恢复适配"
                      : "当前适配视口，按 Enter 放大至原始尺寸"
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleZoom();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleZoom();
                    }
                  }}
                  draggable={false}
                  className={cn(
                    "block h-auto select-none transition-transform duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
                    preview.zoomed
                      ? "max-h-none max-w-none cursor-zoom-out"
                      : "max-h-[88vh] w-auto max-w-[96vw] cursor-zoom-in object-contain",
                  )}
                />
              </div>

              {preview.images.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => stepPreview(-1)}
                    className="absolute left-4 top-1/2 z-20 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    aria-label="上一张"
                  >
                    <ChevronLeft className="size-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => stepPreview(1)}
                    className="absolute right-4 top-1/2 z-20 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    aria-label="下一张"
                  >
                    <ChevronRight className="size-5" />
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
