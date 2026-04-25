import { httpRequest } from "@/lib/request";

export type AccountType = "Free" | "Plus" | "Pro" | "Team";
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = "gpt-image-1" | "gpt-image-2";

export type Account = {
  id: string;
  access_token: string;
  type: AccountType;
  status: AccountStatus;
  quota: number;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restoreAt?: string | null;
  success: number;
  fail: number;
  lastUsedAt: string | null;
};

type AccountListResponse = {
  items: Account[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  errors: Array<{ access_token: string; error: string }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  secret_key: string;
  enabled: boolean;
};

export type CPAStatus = {
  enabled: boolean;
  pools: number;
  tokens: number;
};

export type ReferenceImageInput = {
  data_url: string;
  name?: string;
};

export type ImageTaskStatus = "queued" | "generating" | "success" | "error";

export type ImageTaskImage = {
  id: string;
  status: "loading" | "success" | "error";
  b64_json?: string;
  revised_prompt?: string;
  error?: string;
};

export type ImageTask = {
  id: string;
  status: ImageTaskStatus;
  prompt: string;
  model: ImageModel;
  count: number;
  images: ImageTaskImage[];
  created_at: string;
  updated_at: string;
  error?: string;
};

export async function login(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<{ ok: boolean }>("/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    redirectOnUnauthorized: false,
  });
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function createAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens },
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
  });
}

export async function refreshAccounts(accessTokens: string[]) {
  return httpRequest<AccountRefreshResponse>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
  });
}

export async function generateImage(
  prompt: string,
  model: ImageModel = "gpt-image-1",
  referenceImages: ReferenceImageInput[] = [],
) {
  const hasReferenceImages = referenceImages.length > 0;
  return httpRequest<{ created: number; data: Array<{ b64_json: string; revised_prompt?: string }> }>(
    hasReferenceImages ? "/v1/images/edits" : "/v1/images/generations",
    {
      method: "POST",
      body: {
        prompt,
        model,
        n: 1,
        response_format: "b64_json",
        images: referenceImages,
      },
    },
  );
}

export async function createImageTask(
  taskId: string,
  prompt: string,
  model: ImageModel = "gpt-image-1",
  count = 1,
  referenceImages: ReferenceImageInput[] = [],
) {
  return httpRequest<ImageTask>("/api/image-tasks", {
    method: "POST",
    body: {
      task_id: taskId,
      prompt,
      model,
      n: count,
      response_format: "b64_json",
      images: referenceImages,
    },
  });
}

export async function fetchImageTask(taskId: string) {
  return httpRequest<ImageTask>(`/api/image-tasks/${encodeURIComponent(taskId)}`);
}

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools");
}

export async function createCPAPool(pool: { name: string; base_url: string; secret_key: string; enabled?: boolean }) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string; enabled?: boolean },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function fetchCPAPoolStatus(poolId: string) {
  return httpRequest<{ pool_id: string; tokens: number }>(`/api/cpa/pools/${poolId}/status`);
}

export async function syncCPAPool(poolId: string) {
  return httpRequest<{
    added: number;
    skipped: number;
    refreshed: number;
    errors: Array<{ access_token: string; error: string }>;
    items: Account[];
  }>(`/api/cpa/pools/${poolId}/sync`, { method: "POST" });
}

export async function fetchCPAGlobalStatus() {
  return httpRequest<CPAStatus>("/api/cpa/status");
}

export type UsageLog = {
  id: string;
  timestamp: string;
  token_mask: string;
  source: string;
  model: string;
  upstream_model?: string | null;
  prompt: string;
  success: boolean;
  duration_ms: number;
  error?: string | null;
  account_email?: string | null;
  account_type?: string | null;
  has_reference_image: boolean;
};

export type UsageLogListResponse = {
  items: UsageLog[];
  total: number;
  limit: number;
  offset: number;
  summary: { total: number; success: number; fail: number };
};

export type UsageLogQuery = {
  limit?: number;
  offset?: number;
  status?: "all" | "success" | "fail";
  source?: "all" | "pool" | "cpa";
  query?: string;
};

export async function fetchUsageLogs(params: UsageLogQuery = {}) {
  const search = new URLSearchParams();
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.source && params.source !== "all") search.set("source", params.source);
  if (params.query) search.set("query", params.query);
  const qs = search.toString();
  return httpRequest<UsageLogListResponse>(`/api/usage-logs${qs ? `?${qs}` : ""}`);
}

export async function clearUsageLogs() {
  return httpRequest<{ removed: number }>("/api/usage-logs", {
    method: "DELETE",
  });
}
