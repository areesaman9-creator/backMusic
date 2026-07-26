import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram/tl";
import mongoose from "mongoose";

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
  private _resolvedEntityCache = new Map<string, any>();

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

  private isInviteLink(input: string): boolean {
    return (
      /t\.me\/(\+|joinchat\/)/i.test(input) || /^\+[\w-]+$/.test(input.trim())
    );
  }

  private extractInviteHash(input: string): string {
    const trimmed = input.trim();
    const joinchatMatch = trimmed.match(/joinchat\/([\w-]+)/i);
    if (joinchatMatch) return joinchatMatch[1];
    const plusMatch = trimmed.match(/t\.me\/\+([\w-]+)/i);
    if (plusMatch) return plusMatch[1];
    return trimmed.replace(/^\+/, "");
  }

  private async resolveEntity(usernameOrLink: string): Promise<any> {
    if (!this.isInviteLink(usernameOrLink)) {
      return this.client!.getEntity(usernameOrLink);
    }

    const hash = this.extractInviteHash(usernameOrLink);

    const cached = this._resolvedEntityCache.get(hash);
    if (cached) return cached;

    const invite: any = await this.client!.invoke(
      new Api.messages.CheckChatInvite({ hash }),
    );

    if (invite.chat) {
      this._resolvedEntityCache.set(hash, invite.chat);
      return invite.chat;
    }

    try {
      const joined: any = await this.client!.invoke(
        new Api.messages.ImportChatInvite({ hash }),
      );
      const chat = joined.chats?.[0];
      if (!chat) throw new Error("Could not resolve invite link");
      this._resolvedEntityCache.set(hash, chat);
      return chat;
    } catch (err: any) {
      if (
        err.errorMessage === "USER_ALREADY_PARTICIPANT" ||
        err.message?.includes("USER_ALREADY_PARTICIPANT")
      ) {
        const recheck: any = await this.client!.invoke(
          new Api.messages.CheckChatInvite({ hash }),
        );
        if (recheck.chat) {
          this._resolvedEntityCache.set(hash, recheck.chat);
          return recheck.chat;
        }
      }
      throw err;
    }
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
      const entity = await this.resolveEntity(username);
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
      const entity = await this.resolveEntity(username);

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
      const entity = await this.resolveEntity(username);
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
    const entity = await this.resolveEntity(username);
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
      const entity = await this.resolveEntity(username);
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
      const entity = await this.resolveEntity(username);
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
  isConnected(): boolean {
    try {
      return !!this.client && (this.client as any).connected === true;
    } catch {
      return false;
    }
  }
}

export default new TelegramService();
