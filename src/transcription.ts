import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TranscriptionConfig {
  provider: string;
  openai?: {
    apiKey: string;
    model: string;
  };
  enabled: boolean;
  fallbackMessage: string;
}

function loadConfig(): TranscriptionConfig {
  const configPath = path.join(__dirname, '../.transcription.config.json');
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } catch (err) {
    logger.error({ err }, 'Failed to load transcription config');
    return {
      provider: 'openai',
      enabled: false,
      fallbackMessage: '[Voice Message - transcription unavailable]',
    };
  }
}

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  if (!config.openai?.apiKey || config.openai.apiKey === '') {
    logger.warn('OpenAI API key not configured for transcription');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey: config.openai.apiKey });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: config.openai.model || 'whisper-1',
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}

/**
 * Transcribe a raw audio buffer. Reusable by any channel (WhatsApp, Telegram, etc.)
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    logger.error('Empty audio buffer for transcription');
    return config.fallbackMessage;
  }

  logger.debug({ bytes: audioBuffer.length }, 'Transcribing audio');

  let transcript: string | null = null;

  switch (config.provider) {
    case 'openai':
      transcript = await transcribeWithOpenAI(audioBuffer, config);
      break;
    default:
      logger.error({ provider: config.provider }, 'Unknown transcription provider');
      return config.fallbackMessage;
  }

  if (!transcript) {
    return config.fallbackMessage;
  }

  return transcript.trim();
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    return transcribeAudioBuffer(buffer);
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
