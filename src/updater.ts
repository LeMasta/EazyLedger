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
const CHECK_TIMEOUT_MS = 8_000;
const STABLE_MANIFEST_URL = "https://raw.githubusercontent.com/LeMasta/EazyLedger/main/update/latest.json";
const WEBVIEW_PROBE_TIMEOUT_MS = 5_000;

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
  return `上次计划安装 v${expected}，但当前仍是 v${current}。安装没有真正替换当前程序。请重新更新，也可以直接运行新版安装包覆盖升级，无需先卸载旧版。`;
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

async function fetchPublishedVersion(): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), WEBVIEW_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(STABLE_MANIFEST_URL, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`更新清单请求失败（${response.status}）`);
    const manifest = await response.json() as { version?: unknown };
    if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new Error("更新清单缺少版本号");
    return manifest.version.trim();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function performUpdateCheck(): Promise<Awaited<ReturnType<typeof check>>> {
  const installedVersion = await getVersion();
  const nativePromise = check({ timeout: CHECK_TIMEOUT_MS });
  const manifestOutcome = fetchPublishedVersion().then(
    (value) => ({ kind: "manifest-ok" as const, value }),
    (error: unknown) => ({ kind: "manifest-error" as const, error }),
  );
  const nativeOutcome = nativePromise.then(
    (value) => ({ kind: "native-ok" as const, value }),
    (error: unknown) => ({ kind: "native-error" as const, error }),
  );

  const first = await Promise.race([manifestOutcome, nativeOutcome]);
  if (first.kind === "native-ok") return first.value;
  if (first.kind === "manifest-ok") {
    if (compareVersions(installedVersion, first.value) >= 0) {
      void nativePromise.catch(() => undefined);
      return null;
    }
    return nativePromise;
  }
  if (first.kind === "manifest-error") return nativePromise;

  const manifest = await manifestOutcome;
  if (manifest.kind === "manifest-ok" && compareVersions(installedVersion, manifest.value) >= 0) return null;
  throw first.error;
}

export async function findUpdate(): Promise<AvailableUpdate | null> {
  if (!activeCheck) activeCheck = performUpdateCheck().finally(() => { activeCheck = null; });
  pendingUpdate = await activeCheck;
  if (!pendingUpdate) return null;
  return {
    version: pendingUpdate.version,
    notes: pendingUpdate.body ?? "",
    date: pendingUpdate.date ?? null,
  };
}

function failureDetail(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

export function describeUpdateFailure(reason: unknown): UpdateFailure {
  const detail = failureDetail(reason);
  const normalized = detail.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("超时")) {
    return { kind: "timeout", title: "GitHub 响应超时", message: "更新服务在 8 秒内没有响应。请稍后重试，或从 GitHub Release 手动下载安装包。", detail };
  }
  if (normalized.includes("rate limit") || normalized.includes("429") || normalized.includes("403")) {
    return { kind: "rate-limit", title: "GitHub 暂时限制了请求", message: "已连接到 GitHub，但当前请求受到频率限制。等待几分钟后重试。", detail };
  }
  if (["network", "connect", "connection", "dns", "tcp", "tls", "offline", "request", "socket", "sending request"].some((term) => normalized.includes(term))) {
    return { kind: "network", title: "无法连接更新服务", message: "安装包和更新清单均已发布，但应用当前无法建立网络连接。请检查 Windows 网络或稍后重试；也可直接下载安装包覆盖升级。", detail };
  }
  if (normalized.includes("signature") || normalized.includes("public key") || normalized.includes("minisign")) {
    return { kind: "signature", title: "更新签名校验失败", message: "安装包或签名与应用内公钥不匹配。为安全起见，更新已停止。", detail };
  }
  if (["404", "not found", "deserialize", "parse", "invalid release json", "valid release json", "json error"].some((term) => normalized.includes(term))) {
    return { kind: "metadata", title: "更新清单格式异常", message: "更新地址可以访问，但返回的清单不存在或格式不正确。当前安装不会受影响。", detail };
  }
  return { kind: "unknown", title: "检查更新失败", message: "更新服务返回了未识别的错误。可展开技术信息用于排查。", detail };
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

