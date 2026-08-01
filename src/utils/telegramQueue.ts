type Task<T> = () => Promise<T>;

class TelegramRequestQueue {
  private queue: Array<() => Promise<void>> = [];
  private active = 0;
  private concurrency = 3;

  enqueue<T>(task: Task<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        }
      });
      this._drain();
    });
  }

  private async _drain() {
    if (this.active >= this.concurrency) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active++;
    try {
      await next();
    } finally {
      this.active--;
      this._drain();
    }
  }
}

export const telegramQueue = new TelegramRequestQueue();

function parseFloodWaitSeconds(err: any): number | null {
  const msg = err?.errorMessage || err?.message || "";
  const match = /FLOOD_WAIT_(\d+)/.exec(msg);
  if (match) return parseInt(match[1], 10);
  if (typeof err?.seconds === "number") return err.seconds;
  return null;
}

export async function withFloodWaitRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 3 }: { maxRetries?: number } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const waitSeconds = parseFloodWaitSeconds(err);
      if (waitSeconds !== null && attempt < maxRetries) {
        attempt++;
        console.warn(
          `⏳ FLOOD_WAIT: ${waitSeconds} retry ${attempt}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, (waitSeconds + 1) * 1000));
        continue;
      }
      throw err;
    }
  }
}