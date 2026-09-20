import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export type UpdateChannel = "stable" | "beta";

export type AvailableUpdate = {
  version: string;
  notes: string;
  date: string | null;
  channel: UpdateChannel;
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

type NativeUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;
type PendingUpdate =
  | { kind: "stable"; update: NativeUpdate }
  | { kind: "channel"; info: AvailableUpdate };

let pendingUpdate: PendingUpdate | null = null;
let activeCheck: Promise<AvailableUpdate | null> | null = null;
let activeCheckIncludesBeta = false;
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

function parsedVersion(value: string): { core: number[]; prerelease: string[] } {
  const normalized = value.trim().replace(/^v/i, "").split("+")[0];
  const [corePart, prereleasePart = ""] = normalized.split("-", 2);
  return {
    core: corePart.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prereleasePart ? prereleasePart.split(".") : [],
  };
}

function compareVersions(left: string, right: string): number {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return difference;
  }
  if (!a.prerelease.length && b.prerelease.length) return 1;
  if (a.prerelease.length && !b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart.localeCompare(rightPart);
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

async function performStableUpdateCheck(): Promise<NativeUpdate | null> {
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

async function performUpdateCheck(includeBeta: boolean): Promise<AvailableUpdate | null> {
  pendingUpdate = null;
  if (includeBeta) {
    const info = await invoke<AvailableUpdate | null>("check_beta_update");
    if (info) pendingUpdate = { kind: "channel", info };
    return info;
  }
  const update = await performStableUpdateCheck();
  if (!update) return null;
  pendingUpdate = { kind: "stable", update };
  return {
    version: update.version,
    notes: update.body ?? "",
    date: update.date ?? null,
    channel: "stable",
  };
}

export async function findUpdate(includeBeta = false): Promise<AvailableUpdate | null> {
  if (!activeCheck || activeCheckIncludesBeta !== includeBeta) {
    activeCheckIncludesBeta = includeBeta;
    activeCheck = performUpdateCheck(includeBeta).finally(() => { activeCheck = null; });
  }
  return activeCheck;
}

function failureDetail(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

export function describeUpdateFailure(reason: unknown): UpdateFailure {
  const detail = failureDetail(reason);
  const normalized = detail.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("超时")) {
    return { kind: "timeout", title: "GitHub 响应超时", message: "更新服务没有在限定时间内响应。请稍后重试，或从 GitHub Release 手动下载安装包。", detail };
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
  const targetVersion = pendingUpdate.kind === "stable" ? pendingUpdate.update.version : pendingUpdate.info.version;
  localStorage.setItem(EXPECTED_VERSION_KEY, targetVersion);
  try {
    if (pendingUpdate.kind === "channel") {
      const onEvent = new Channel<UpdateProgress>();
      onEvent.onmessage = onProgress;
      await invoke("install_beta_update", { expectedVersion: targetVersion, onEvent });
    } else {
      let downloaded = 0;
      let total: number | null = null;
      await pendingUpdate.update.downloadAndInstall((event) => {
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
    }
  } catch (error) {
    localStorage.removeItem(EXPECTED_VERSION_KEY);
    throw error;
  }
  await relaunch();
}
