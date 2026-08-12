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

let pendingUpdate: Awaited<ReturnType<typeof check>> = null;

export async function currentVersion(): Promise<string> {
  return getVersion();
}

export async function findUpdate(): Promise<AvailableUpdate | null> {
  pendingUpdate = await check();
  if (!pendingUpdate) return null;
  return {
    version: pendingUpdate.version,
    notes: pendingUpdate.body ?? "",
    date: pendingUpdate.date ?? null,
  };
}

export async function installPendingUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
  if (!pendingUpdate) throw new Error("更新信息已经失效，请重新检查更新");
  let downloaded = 0;
  let total: number | null = null;
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
  await relaunch();
}
