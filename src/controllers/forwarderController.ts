import { Request, Response, NextFunction } from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram/tl";

const API_ID = parseInt(process.env.TELEGRAM_API_ID as string, 10);
const API_HASH = process.env.TELEGRAM_API_HASH as string;
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING as string;
// ── Active job store (in-memory) ───────────────────────────────
// key: jobId, value: job state
export interface ForwarderJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  targetChannel: string;
  sourceChannels: string[];
  totalFound: number;
  totalSent: number;
  totalFailed: number;
  currentChannel: string;
  currentFile: string;
  logs: string[];
  startedAt: Date;
  finishedAt?: Date;
  error?: string;
}

const jobs = new Map<string, ForwarderJob>();
const cancelFlags = new Map<string, boolean>();

function jobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isAudio(doc: any): boolean {
  if (!doc) return false;
  const attrs = doc.attributes || [];
  for (const attr of attrs) {
    if (attr.className === "DocumentAttributeAudio") return true;
  }
  const mime: string = doc.mimeType || "";
  return mime.startsWith("audio/");
}

async function runForwarder(job: ForwarderJob): Promise<void> {
  const push = (msg: string) => {
    job.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
    // keep last 500 lines
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  };

  let client: TelegramClient | null = null;
  try {
    const session = new StringSession(SESSION_STRING);
    client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: false,
    });
    await client.connect();
    push("✅ Connected to Telegram");

    const target = job.targetChannel.replace("@", "").trim();
    const targetEntity = await client.getEntity(target);

    for (const rawChannel of job.sourceChannels) {
      if (cancelFlags.get(job.id)) break;

      const channel = rawChannel.replace("@", "").trim();
      job.currentChannel = channel;
      push(`🔍 Scanning @${channel}...`);

      let audioMessages: any[] = [];
      try {
        for await (const msg of client.iterMessages(channel, { limit: undefined } as any)) {
          if (cancelFlags.get(job.id)) break;
          if (!msg.media || msg.media.className !== "MessageMediaDocument") continue;
          const doc = (msg.media as any).document;
          if (doc && isAudio(doc)) {
            audioMessages.push(msg);
          }
        }
        push(`✅ Found ${audioMessages.length} audio files in @${channel}`);
        job.totalFound += audioMessages.length;
      } catch (e: any) {
        push(`❌ Error scanning @${channel}: ${e.message}`);
        continue;
      }

      if (audioMessages.length === 0) {
        push(`⚠️ No audio in @${channel}`);
        continue;
      }

      for (let i = 0; i < audioMessages.length; i++) {
        if (cancelFlags.get(job.id)) break;

        const msg = audioMessages[i];
        const doc = (msg.media as any)?.document;
        let fileName = "Unknown";
        if (doc) {
          for (const attr of doc.attributes || []) {
            if (attr.className === "DocumentAttributeFilename" && attr.fileName) {
              fileName = attr.fileName;
              break;
            }
            if (attr.className === "DocumentAttributeAudio") {
              const t = attr.title || "";
              const p = attr.performer || "";
              if (t || p) fileName = [p, t].filter(Boolean).join(" - ");
            }
          }
        }

        job.currentFile = fileName;
        push(`[${i + 1}/${audioMessages.length}] 🎵 ${fileName}`);

        let sent = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (cancelFlags.get(job.id)) break;
          try {
            await client.forwardMessages(targetEntity as any, {
              messages: [msg.id],
              fromPeer: channel,
            });
            job.totalSent++;
            push(`  ✅ Forwarded`);
            sent = true;
            await new Promise((r) => setTimeout(r, 3000)); // 3s delay
            break;
          } catch (e: any) {
            const msg2 = e.message || "";
            if (msg2.includes("FLOOD_WAIT")) {
              const secs = parseInt(msg2.match(/(\d+)/)?.[1] || "30") + 5;
              push(`  ⏳ Flood wait ${secs}s...`);
              await new Promise((r) => setTimeout(r, secs * 1000));
            } else if (attempt < 2) {
              push(`  ⚠️ Attempt ${attempt + 1} failed: ${msg2}`);
              await new Promise((r) => setTimeout(r, 5000));
            } else {
              push(`  ❌ Failed: ${msg2}`);
              job.totalFailed++;
            }
          }
        }
      }
    }

    if (cancelFlags.get(job.id)) {
      job.status = "cancelled";
      push("🛑 Job cancelled by user");
    } else {
      job.status = "done";
      push(`🎉 Done! Sent: ${job.totalSent}, Failed: ${job.totalFailed}`);
    }
  } catch (e: any) {
    job.status = "error";
    job.error = e.message;
    job.logs.push(`❌ Fatal error: ${e.message}`);
  } finally {
    job.finishedAt = new Date();
    job.currentChannel = "";
    job.currentFile = "";
    cancelFlags.delete(job.id);
    try {
      await client?.disconnect();
    } catch {}
  }
}

// ── POST /api/admin/forwarder/start ───────────────────────────
export const startForwarder = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { targetChannel, sourceChannels } = req.body as {
      targetChannel: string;
      sourceChannels: string[];
    };

    if (!targetChannel || !Array.isArray(sourceChannels) || sourceChannels.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "targetChannel and sourceChannels[] required",
      });
    }

    const id = jobId();
    const job: ForwarderJob = {
      id,
      status: "running",
      targetChannel: targetChannel.trim(),
      sourceChannels: sourceChannels.map((c) => c.trim()).filter(Boolean),
      totalFound: 0,
      totalSent: 0,
      totalFailed: 0,
      currentChannel: "",
      currentFile: "",
      logs: [],
      startedAt: new Date(),
    };

    jobs.set(id, job);
    cancelFlags.set(id, false);

    // fire and forget
    runForwarder(job).catch((e) => {
      job.status = "error";
      job.error = e.message;
      job.finishedAt = new Date();
    });

    res.json({ success: true, jobId: id });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/admin/forwarder/status/:jobId ────────────────────
export const getForwarderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { jobId: id } = req.params;
    const job = jobs.get(id);
    if (!job) {
      return res.status(404).json({ success: false, msg: "Job not found" });
    }

    res.json({
      success: true,
      data: {
        id: job.id,
        status: job.status,
        targetChannel: job.targetChannel,
        sourceChannels: job.sourceChannels,
        totalFound: job.totalFound,
        totalSent: job.totalSent,
        totalFailed: job.totalFailed,
        currentChannel: job.currentChannel,
        currentFile: job.currentFile,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error,
        // last 100 log lines for polling
        logs: job.logs.slice(-100),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/admin/forwarder/cancel/:jobId ───────────────────
export const cancelForwarder = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { jobId: id } = req.params;
    const job = jobs.get(id);
    if (!job) {
      return res.status(404).json({ success: false, msg: "Job not found" });
    }
    if (job.status !== "running") {
      return res.json({ success: true, msg: "Job already finished" });
    }
    cancelFlags.set(id, true);
    res.json({ success: true, msg: "Cancel signal sent" });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/admin/forwarder/jobs ─────────────────────────────
export const listForwarderJobs = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const list = Array.from(jobs.values())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 20)
      .map((j) => ({
        id: j.id,
        status: j.status,
        targetChannel: j.targetChannel,
        sourceChannels: j.sourceChannels,
        totalFound: j.totalFound,
        totalSent: j.totalSent,
        totalFailed: j.totalFailed,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        error: j.error,
      }));

    res.json({ success: true, data: list });
  } catch (error) {
    next(error);
  }
};
