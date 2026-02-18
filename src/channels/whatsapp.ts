import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
  upsertContacts,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  // Cache recent image messages for media download (keyed by chatJid, keeps latest per chat)
  private recentImageMessages = new Map<string, import('@whiskeysockets/baileys').WAMessage>();

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch(() => {});

        // Force app state resync to pull contacts from phone's address book
        this.sock.resyncAppState?.(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false).catch((err: Error) => {
          logger.debug({ err: err.message }, 'App state resync failed (non-critical)');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    // Sync contacts to database so agents can look up WhatsApp users
    this.sock.ev.on('contacts.upsert', (contacts) => {
      logger.info({ count: contacts.length }, 'Contacts upsert received');
      upsertContacts(contacts.map((c) => ({
        jid: c.id,
        name: c.name || undefined,
        notify: c.notify || undefined,
      })));
    });

    this.sock.ev.on('contacts.update', (updates) => {
      upsertContacts(updates.map((c) => ({
        jid: c.id!,
        name: (c as any).name || undefined,
        notify: (c as any).notify || undefined,
      })));
    });

    // History sync also carries contacts
    this.sock.ev.on('messaging-history.set', ({ contacts }) => {
      if (contacts && contacts.length > 0) {
        logger.info({ count: contacts.length }, 'Contacts from history sync');
        upsertContacts(contacts.map((c) => ({
          jid: c.id,
          name: c.name || undefined,
          notify: c.notify || undefined,
        })));
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Cache image messages for media download
        if (msg.message?.imageMessage) {
          this.recentImageMessages.set(chatJid, msg);
          logger.debug({ chatJid }, 'Cached image message for download');
        }

        // Always notify about chat metadata for group discovery
        this.opts.onChatMetadata(chatJid, timestamp);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          const imageCaption = msg.message?.imageMessage?.caption;
          const videoCaption = msg.message?.videoMessage?.caption;
          let content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            '';

          // Surface image/video messages so the agent knows media was sent
          if (!content && msg.message?.imageMessage) {
            content = imageCaption ? `[Image: ${imageCaption}]` : '[Image]';
          } else if (!content && msg.message?.videoMessage) {
            content = videoCaption ? `[Video: ${videoCaption}]` : '[Video]';
          } else if (imageCaption && !content) {
            content = imageCaption;
          } else if (videoCaption && !content) {
            content = videoCaption;
          }

          // Transcribe voice messages
          if (isVoiceMessage(msg)) {
            try {
              const transcript = await transcribeAudioMessage(msg, this.sock);
              if (transcript) {
                content = `[Voice: ${transcript}]`;
                logger.info({ chatJid, length: transcript.length }, 'Transcribed voice message');
              } else {
                content = '[Voice Message - transcription unavailable]';
              }
            } catch (err) {
              logger.error({ err }, 'Voice transcription error');
              content = '[Voice Message - transcription failed]';
            }
          }

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          // Store sender as contact (captures push names from incoming messages)
          if (sender.endsWith('@s.whatsapp.net') && msg.pushName) {
            upsertContacts([{ jid: sender, notify: msg.pushName }]);
          }

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages in groups so users know who's speaking on a shared
    // number. DMs don't need a prefix — the recipient sees the phone number.
    const isGroup = jid.endsWith('@g.us');
    const prefixed = (!ASSISTANT_HAS_OWN_NUMBER && isGroup)
      ? `${ASSISTANT_NAME}: ${text}`
      : text;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, imagePath }, 'WA disconnected, cannot send image');
      return;
    }
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      await this.sock.sendMessage(jid, {
        image: imageBuffer,
        caption: caption || undefined,
      });
      logger.info({ jid, imagePath }, 'Image sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send image');
    }
  }

  async downloadLatestImage(jid: string, savePath: string): Promise<boolean> {
    if (!this.connected) {
      logger.warn({ jid }, 'WA disconnected, cannot download image');
      return false;
    }
    try {
      const imageMsg = this.recentImageMessages.get(jid);
      if (!imageMsg) {
        logger.warn({ jid }, 'No cached image message found');
        return false;
      }
      const buffer = (await downloadMediaMessage(
        imageMsg,
        'buffer',
        {},
        {
          logger: logger as any,
          reuploadRequest: this.sock.updateMediaMessage,
        },
      )) as Buffer;
      if (!buffer || buffer.length === 0) {
        logger.error({ jid }, 'Failed to download image buffer');
        return false;
      }
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, buffer);
      logger.info({ jid, savePath, bytes: buffer.length }, 'Image downloaded');
      return true;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to download latest image');
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
