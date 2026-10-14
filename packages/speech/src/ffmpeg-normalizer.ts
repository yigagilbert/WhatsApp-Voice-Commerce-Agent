import { spawn } from 'node:child_process';
import { ProviderError } from '@vca/shared';
import type { AudioInput, AudioNormalizer } from './types';

/**
 * Converts any input audio to 16 kHz mono WAV via ffmpeg, streaming through stdin/stdout
 * (no temporary files). Many ASR models (Whisper, MMS, Sunbird) prefer this format.
 */
export class FfmpegAudioNormalizer implements AudioNormalizer {
  readonly id = 'ffmpeg';

  constructor(
    private readonly options: {
      ffmpegPath?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    } = {},
  ) {}

  normalize(audio: AudioInput): Promise<AudioInput> {
    const maxOutput = this.options.maxOutputBytes ?? 50 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.options.ffmpegPath ?? 'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          'pipe:0',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-f',
          'wav',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ProviderError('ffmpeg', 'timed out'));
      }, this.options.timeoutMs ?? 30_000);

      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutput) {
          child.kill('SIGKILL');
          reject(new ProviderError('ffmpeg', 'output exceeded size limit'));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-1000);
      });
      child.on('error', (cause) => {
        clearTimeout(timer);
        reject(new ProviderError('ffmpeg', 'could not start ffmpeg (is it installed?)', { cause }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new ProviderError('ffmpeg', `exited with code ${code}`, { details: stderr }),
          );
        resolve({ data: Buffer.concat(chunks), mimeType: 'audio/wav', filename: 'audio.wav' });
      });
      child.stdin.on('error', () => undefined); // ffmpeg may close stdin early on bad input
      child.stdin.end(audio.data);
    });
  }
}
