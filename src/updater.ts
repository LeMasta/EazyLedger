import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export type AvailableUpdate = {
  version: string;
  notes: string;
  date: string | null;
};

export type UpdateProgress = {
  downloaded: number;
  total: number | null;
  percent: number | null;
};

export type UpdateFailure = {
  kind: "timeout" | "network" | "rate-limit" | "metadata" | "signature" | "unknown";
  title: string;
  message: string;
  detail: string;
};

let pendingUpdate: Awaited<ReturnType<typeof check>> = null;
let activeCheck: Promise<Awaited<ReturnType<typeof check>>> | null = null;
const EXPECTED_VERSION_KEY = "eazyledger.update.expected-version";
const CHECK_TIMEOUT_MS = 25_000;
const CHECK_RETRY_DELAY_MS = 1_200;

export async function currentVersion(): Promise<string> {
  return getVersion();
}

export function previousInstallIssue(current: string): string | null {
  const expected = localStorage.getItem(EXPECTED_VERSION_KEY);
  if (!expected) return null;
  if (compareVersions(current, expected) >= 0) {
    localStorage.removeItem(EXPECTED_VERSION_KEY);
    return null;
  }
  return `上次计划安装 v${expected}，但当前仍是 v${current}。安装没有真正替换当前程序；请重新更新，若仍失败请确认启动的是同一个 EazyLedger 安装目录。`;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export async function findUpdate(): Promise<AvailableUpdate | null> {
  if (!activeCheck) activeCheck = checkWithRetry().finally(() => { activeCheck = null; });
  pendingUpdate = await activeCheck;
  if (!pendingUpdate) return null;
  return {
    version: pendingUpdate.version,
    notes: pendingUpdate.body ?? "",
    date: pendingUpdate.date ?? null,
  };
}

async function checkWithRetry(): Promise<Awaited<ReturnType<typeof check>>> {
  try {
    return await withTimeout(check(), CHECK_TIMEOUT_MS);
  } catch (firstReason) {
    if (!shouldRetryCheck(firstReason)) throw firstReason;
    await delay(CHECK_RETRY_DELAY_MS);
    try {
      return await withTimeout(check(), CHECK_TIMEOUT_MS);
    } catch (retryReason) {
      throw new Error(`Update check failed after retry. First attempt: ${failureDetail(firstReason)}; retry: ${failureDetail(retryReason)}`);
    }
  }
}

function shouldRetryCheck(reason: unknown): boolean {
  const normalized = failureDetail(reason).toLowerCase();
  return ["timeout", "timed out", "network", "connect", "connection", "dns", "tcp", "tls", "offline", "request", "socket"]
    .some((term) => normalized.includes(term));
}

function failureDetail(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function describeUpdateFailure(reason: unknown): UpdateFailure {
  const detail = failureDetail(reason);
  const normalized = detail.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("超时")) {
    return { kind: "timeout", title: "GitHub 响应超时", message: "已自动尝试两次连接 GitHub，但每次在 25 秒内都未收到完整响应。请检查代理或稍后重试；也可从 GitHub Release 手动下载安装包。", detail };
  }
  if (normalized.includes("rate limit") || normalized.includes("429") || normalized.includes("403")) {
    return { kind: "rate-limit", title: "GitHub 暂时限制了请求", message: "已连接到 GitHub，但当前请求受到频率限制。等待几分钟后重试。", detail };
  }
  if (["error sending request", "network", "connect", "connection", "dns", "tcp", "tls", "offline", "socket"].some((term) => normalized.includes(term))) {
    return { kind: "network", title: "无法连接 GitHub", message: "自动重试后仍未连接到 GitHub。请检查网络、代理或防火墙；也可从 GitHub Release 手动下载安装包。", detail };
  }
  if (normalized.includes("404") || normalized.includes("not found") || normalized.includes("latest.json") || normalized.includes("json") || normalized.includes("deserialize") || normalized.includes("parse")) {
    return { kind: "metadata", title: "更新清单不可用", message: "已访问更新地址，但 Release 中缺少或无法解析 latest.json。当前安装不会受影响。", detail };
  }
  if (normalized.includes("signature") || normalized.includes("public key") || normalized.includes("minisign")) {
    return { kind: "signature", title: "更新签名校验失败", message: "安装包或签名与应用内公钥不匹配。为安全起见，更新已停止。", detail };
  }
  return { kind: "unknown", title: "检查更新失败", message: "更新服务返回了未识别的错误。可展开技术信息用于排查。", detail };
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Update request timed out after ${timeoutMs}ms`)), timeoutMs);
    task.then(
      (result) => { window.clearTimeout(timer); resolve(result); },
      (reason) => { window.clearTimeout(timer); reject(reason); },
    );
  });
}

export async function installPendingUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
  if (!pendingUpdate) throw new Error("更新信息已经失效，请重新检查更新");
  const targetVersion = pendingUpdate.version;
  localStorage.setItem(EXPECTED_VERSION_KEY, targetVersion);
  let downloaded = 0;
  let total: number | null = null;
  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        downloaded = 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
      }
      onProgress({
        downloaded,
        total,
        percent: total && total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : null,
      });
    });
  } catch (error) {
    localStorage.removeItem(EXPECTED_VERSION_KEY);
    throw error;
  }
  await relaunch();
}

