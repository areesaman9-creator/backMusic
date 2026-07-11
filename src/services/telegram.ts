import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram/tl";
import mongoose from "mongoose";
import bigInt from "big-integer";

const API_ID = parseInt(process.env.TELEGRAM_API_ID as string, 10);
const API_HASH = process.env.TELEGRAM_API_HASH as string;
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING as string;

export interface AudioFile {
  messageId: number;
  title: string;
  artist: string;
  duration: number;
  fileId: string;
  fileSize: number;
  mimeType: string;
  messageDate: number;
  fileUrl: string;
  thumbnail?: string | null;
}

export interface StreamDownloadHandle {
  totalSize: number;
  chunks: AsyncGenerator<Buffer, void, unknown>;
}

class TelegramService {
  private client: TelegramClient | null = null;
  async initialize(_userId?: any): Promise<TelegramClient> {
    if (this.client) return this.client;

    const session = new StringSession(SESSION_STRING);
    this.client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: false,
    });
    await this.client.connect();
    return this.client;
  }

  private async getDocumentThumbnail(
    doc: any,
    channelUsername: string,
    messageId: number,
  ): Promise<string | null> {
    try {
      if (!doc.thumbs || doc.thumbs.length === 0) return null;

      let bestThumb = doc.thumbs[doc.thumbs.length - 1];
      if (
        bestThumb.className === "PhotoStrippedSize" &&
        doc.thumbs.length > 1
      ) {
        bestThumb = doc.thumbs[doc.thumbs.length - 2];
      }

      try {
        const thumbLocation = new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: bestThumb.type || "x",
        });
        const buffer = await this.client!.downloadFile(thumbLocation, {
          dcId: doc.dcId,
        });
        if (buffer && buffer.length > 0) {
          return `data:image/jpeg;base64,${buffer.toString("base64")}`;
        }
      } catch (error: any) {
        console.warn("Primary thumbnail download failed:", error.message);
      }

      try {
        const username = channelUsername.replace("@", "");
        const entity = await this.client!.getEntity(username);
        const messages = await this.client!.getMessages(entity, {
          ids: messageId,
        });
        if (messages[0] && messages[0].media) {
          const buffer = (await this.client!.downloadMedia(
            messages[0].media,
            {},
          )) as Buffer;
          if (buffer && buffer.length > 0) {
            return `data:image/jpeg;base64,${buffer.toString("base64")}`;
          }
        }
      } catch (error: any) {
        console.warn("Fallback thumbnail download failed:", error.message);
      }

      return null;
    } catch (error) {
      console.error("Failed to download thumbnail:", error);
      return null;
    }
  }

  async getChannelName(
    channelUsername: string,
    userId?: any,
  ): Promise<string | null> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);
      return (entity as any).title || null;
    } catch (error: any) {
      console.error("Failed to get channel name:", error);
      return null;
    }
  }

  async getChannelAudioFiles(
    channelUsername: string,
    userId?: any,
    lastMessageId: number = 0,
    onBatch?: (files: AudioFile[], totalEstimate: number) => Promise<void>,
  ): Promise<{ success: boolean; files?: AudioFile[]; error?: string }> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);

      const audioFiles: AudioFile[] = [];
      let offsetId = 0;
      let reachedEnd = false;
      let totalEstimate = 0;

      while (!reachedEnd) {
        const messages = await this.client!.getMessages(entity, {
          limit: 100,
          offsetId,
          filter: new Api.InputMessagesFilterMusic(),
        });

        if (totalEstimate === 0 && (messages as any).total) {
          totalEstimate = (messages as any).total;
        }

        if (messages.length === 0) {
          reachedEnd = true;
          break;
        }

        const batchFiles: AudioFile[] = [];

        for (const msg of messages) {
          if (lastMessageId > 0 && msg.id <= lastMessageId) {
            reachedEnd = true;
            break;
          }
          if (!msg.media || msg.media.className !== "MessageMediaDocument")
            continue;
          const doc = (msg.media as any).document;
          if (!doc) continue;

          const attributes = doc.attributes || [];
          let title = "Unknown",
            artist = "Unknown",
            duration = 0;
          for (const attr of attributes) {
            if (attr.className === "DocumentAttributeAudio") {
              title = attr.title || "Unknown";
              artist = attr.performer || "Unknown";
              duration = attr.duration || 0;
            }
          }

          batchFiles.push({
            messageId: msg.id,
            title,
            artist,
            duration,
            fileId: doc.id.toString(),
            fileSize: Number(doc.size) || 0,
            mimeType: doc.mimeType || "audio/mpeg",
            messageDate: msg.date,
            fileUrl: `https://t.me/${username}/${msg.id}`,
            thumbnail: null,
          });
        }

        audioFiles.push(...batchFiles);

        if (onBatch && batchFiles.length > 0) {
          await onBatch(batchFiles, totalEstimate);
        }

        if (reachedEnd) break;
        offsetId = messages[messages.length - 1].id;
        await new Promise((r) => setTimeout(r, 300));
      }

      return { success: true, files: audioFiles };
    } catch (error: any) {
      console.error("Telegram Error:", error);
      return { success: false, error: error.message || "Unknown error" };
    }
  }

  // دانلود مستقیم با fileId (برای bot songs)
  async prepareStreamDownloadByFileId(
    fileId: string,
    userId?: any,
  ): Promise<StreamDownloadHandle> {
    await this.initialize(userId);

    // از InputDocument یا InputFile با fileId استفاده کن
    const result = await this.client!.invoke(
      new Api.messages.GetMessages({
        id: [new Api.InputMessageID({ id: 0 })],
      }),
    ).catch(() => null);

    // روش مستقیم‌تر: از getMessages با fileId
    const inputFile = new Api.InputDocumentFileLocation({
      id: bigInt(fileId),
      accessHash: bigInt(0),
      fileReference: Buffer.alloc(0),
      thumbSize: "",
    });

    const totalSize = 0;
    const client = this.client!;

    async function* chunkGenerator() {
      try {
        for await (const chunk of client.iterDownload({
          file: inputFile as any,
          requestSize: 512 * 1024,
        })) {
          yield chunk as Buffer;
        }
      } catch {
        // fallback: از طریق messages.getDocumentByHash
      }
    }

    return { totalSize, chunks: chunkGenerator() };
  }

  async downloadFile(
    fileId: string,
    channelUsername: string,
    messageId: number,
    userId?: any,
    onProgress?: (progress: number, downloaded: number, total: number) => void,
  ): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);
      const message = await this.client!.getMessages(entity, {
        ids: messageId,
      });

      if (!message[0] || !message[0].media) {
        return { success: false, error: "File not found" };
      }

      const buffer = (await this.client!.downloadMedia(message[0].media, {
        progressCallback: (downloaded: any, total: any) => {
          const d = Number(downloaded),
            t = Number(total);
          if (t > 0 && onProgress) onProgress(Math.round((d / t) * 100), d, t);
        },
      })) as Buffer;

      return { success: true, buffer };
    } catch (error: any) {
      return { success: false, error: error.message || "Download failed" };
    }
  }

  async prepareStreamDownload(
    fileId: string,
    channelUsername: string,
    messageId: number,
    userId?: any,
  ): Promise<StreamDownloadHandle> {
    await this.initialize(userId);
    const username = channelUsername.replace("@", "");
    const entity = await this.client!.getEntity(username);
    const messages = await this.client!.getMessages(entity, { ids: messageId });

    if (!messages[0] || !messages[0].media) {
      throw new Error("File not found");
    }

    const media = messages[0].media as any;
    const doc = media.document;
    const totalSize = doc ? Number(doc.size) : 0;
    const client = this.client!;

    async function* chunkGenerator() {
      for await (const chunk of client.iterDownload({
        file: media,
        requestSize: 512 * 1024,
      })) {
        yield chunk as Buffer;
      }
    }

    return { totalSize, chunks: chunkGenerator() };
  }

  async testConnection(
    userId?: any,
  ): Promise<{ success: boolean; msg: string }> {
    try {
      await this.initialize(userId);
      await this.client!.getMe();
      return { success: true, msg: "Connection successful" };
    } catch (error: any) {
      return { success: false, msg: error.message || "Connection failed" };
    }
  }

  async getChannelPhoto(
    channelUsername: string,
    userId?: any,
  ): Promise<string | null> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);
      if ((entity as any).photo) {
        const buffer = (await this.client!.downloadProfilePhoto(
          entity,
        )) as Buffer;
        if (buffer && buffer.length > 0) {
          return `data:image/jpeg;base64,${buffer.toString("base64")}`;
        }
      }
      return null;
    } catch (error: any) {
      console.error("Failed to download channel photo:", error);
      return null;
    }
  }

  async downloadSongThumbnail(
    channelUsername: string,
    messageId: number,
    userId?: any,
  ): Promise<string | null> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);
      const messages = await this.client!.getMessages(entity, {
        ids: messageId,
      });
      if (!messages[0] || !messages[0].media) return null;
      const doc = (messages[0].media as any).document;
      if (!doc) return null;
      return await this.getDocumentThumbnail(doc, username, messageId);
    } catch (error: any) {
      console.error("Failed to download song thumbnail:", error);
      return null;
    }
  }

   async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {}
      this.client = null;
    }
  }
}

export default new TelegramService();
