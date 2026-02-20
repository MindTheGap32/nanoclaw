import { Bot } from "grammy";

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from "../config.js";
import { logger } from "../logger.js";
import { transcribeAudioBuffer } from "../transcription.js";
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from "../types.js";

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = "telegram";

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private stopping = false;
  private offset = 0;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Check if a sender is allowed to interact with the bot.
   * Allowed if: the chat is registered, OR the sender has a registered
   * private chat (i.e. the owner can use commands in unregistered chats).
   */
  private isAllowedSender(ctx: any): boolean {
    const chatJid = `tg:${ctx.chat.id}`;
    if (this.opts.registeredGroups()[chatJid]) return true;
    const senderId = ctx.from?.id;
    if (senderId && this.opts.registeredGroups()[`tg:${senderId}`]) return true;
    return false;
  }

  private registerHandlers(): void {
    if (!this.bot) return;

    // Ignore all messages from non-owners / unregistered chats
    this.bot.use((ctx, next) => {
      if (!this.isAllowedSender(ctx)) return;
      return next();
    });

    // Command to get chat ID (useful for registration)
    this.bot.command("chatid", (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === "private"
          ? ctx.from?.first_name || "Private"
          : (ctx.chat as any).title || "Unknown";

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: "Markdown" },
      );
    });

    // Command to check bot status
    this.bot.command("ping", (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on("message:text", async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith("/")) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        "Unknown";
      const sender = ctx.from?.id.toString() || "";
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === "private"
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === "mention") {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          "Message from unregistered Telegram chat",
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        "Telegram message stored",
      );
    });

    // Handle non-text messages with placeholders
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || "",
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on("message:photo", (ctx) => storeNonText(ctx, "[Photo]"));
    this.bot.on("message:video", (ctx) => storeNonText(ctx, "[Video]"));
    this.bot.on("message:voice", async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";

      this.opts.onChatMetadata(chatJid, timestamp);

      // Try to download and transcribe the voice message
      let content = "[Voice message]";
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          const transcript = await transcribeAudioBuffer(buffer);
          if (transcript) {
            content = `[Voice message] ${transcript}`;
          }
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, "Failed to transcribe Telegram voice");
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || "",
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on("message:audio", (ctx) => storeNonText(ctx, "[Audio]"));
    this.bot.on("message:document", (ctx) => {
      const name = ctx.message.document?.file_name || "file";
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on("message:sticker", (ctx) => {
      const emoji = ctx.message.sticker?.emoji || "";
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on("message:location", (ctx) => storeNonText(ctx, "[Location]"));
    this.bot.on("message:contact", (ctx) => storeNonText(ctx, "[Contact]"));

    // Handle middleware errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message || String(err) }, "Telegram bot error");
    });
  }

  async connect(): Promise<void> {
    this.stopping = false;
    this.bot = new Bot(this.botToken);
    this.registerHandlers();

    // Initialize bot info (getMe) and clear any webhook
    await this.bot.init();
    await this.bot.api.deleteWebhook({ drop_pending_updates: true });

    const botInfo = this.bot.botInfo;
    logger.info(
      { username: botInfo.username, id: botInfo.id },
      "Telegram bot connected",
    );
    console.log(`\n  Telegram bot: @${botInfo.username}`);
    console.log(
      `  Send /chatid to the bot to get a chat's registration ID\n`,
    );

    // Start our own polling loop (don't use bot.start() — it has 409 issues)
    this.pollLoop();
  }

  /**
   * Simple long-polling loop with built-in 409 recovery.
   *
   * Uses bot.api.getUpdates() directly instead of bot.start(), giving us
   * full control. Only ONE getUpdates request is in-flight at a time,
   * eliminating the concurrent-request 409 problem.
   */
  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const updates = await this.bot!.api.getUpdates({
          offset: this.offset,
          timeout: 30,
          limit: 100,
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await this.bot!.handleUpdate(update);
          } catch (err: any) {
            logger.error({ err: err.message }, "Error handling Telegram update");
          }
        }
      } catch (err: any) {
        if (this.stopping) break;
        const msg = err?.message || String(err);
        if (msg.includes("409")) {
          logger.warn("Telegram 409 conflict, waiting 5s...");
          await new Promise((r) => setTimeout(r, 5000));
        } else {
          logger.error({ err: msg }, "Telegram polling error, waiting 3s...");
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  private static readonly MAX_LENGTH = 4096;

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn("Telegram bot not initialized");
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, "");

      // Telegram has a 4096 character limit per message — split if needed
      if (text.length <= TelegramChannel.MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += TelegramChannel.MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + TelegramChannel.MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, "Telegram message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Telegram message");
    }
  }

  async sendMessageWithId(jid: string, text: string): Promise<string> {
    if (!this.bot) throw new Error("Telegram bot not initialized");
    const numericId = jid.replace(/^tg:/, "");
    const msg = await this.bot.api.sendMessage(
      numericId,
      text.slice(0, TelegramChannel.MAX_LENGTH),
    );
    return msg.message_id.toString();
  }

  async editMessage(jid: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not initialized");
    const numericId = jid.replace(/^tg:/, "");
    await this.bot.api.editMessageText(
      numericId,
      parseInt(messageId, 10),
      text.slice(0, TelegramChannel.MAX_LENGTH),
    );
  }

  async deleteMessage(jid: string, messageId: string): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not initialized");
    const numericId = jid.replace(/^tg:/, "");
    try {
      await this.bot.api.deleteMessage(numericId, parseInt(messageId, 10));
    } catch (err) {
      // Deletion can fail if message is already deleted or too old
      logger.debug({ jid, messageId, err }, "Failed to delete Telegram message");
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith("tg:");
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.bot) {
      this.bot = null;
      logger.info("Telegram bot stopped");
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, "");
      await this.bot.api.sendChatAction(numericId, "typing");
    } catch (err) {
      logger.debug({ jid, err }, "Failed to send Telegram typing indicator");
    }
  }
}
