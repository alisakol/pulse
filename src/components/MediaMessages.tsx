import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Play,
  Pause,
  Trash2,
  Send,
  Volume2,
  VolumeX,
  Check,
  CheckCheck,
  RefreshCw,
  Upload,
} from 'lucide-react';
import {
  formatCallDuration,
  normalizeWaveform,
  normalizeMediaDataUrl,
  getMessageReadStatusMeta,
  type ChatMessage,
  type MessageAttachmentType,
  type UserProfile,
} from '../utils/messengerLogic';

/**
 * Индикатор статуса доставки / прочтения отправленного сообщения:
 * - Одна галочка (Check) — доставлено на сервер ('sent' | 'delivered')
 * - Две галочки (CheckCheck) — прочитано собеседником ('read')
 */
export const MessageReadStatus: React.FC<{
  status?: ChatMessage['status'];
  className?: string;
}> = ({ status, className = 'w-3.5 h-3.5' }) => {
  const meta = getMessageReadStatusMeta(status);
  return (
    <span
      role="img"
      aria-label={meta.label}
      title={meta.label}
      data-read-status={meta.isRead ? 'read' : 'delivered'}
      className="inline-flex items-center shrink-0"
    >
      {meta.isRead ? (
        <CheckCheck className={`${className} text-[#64B5EF]`} />
      ) : (
        <Check className={`${className} text-[#76A8D8]`} />
      )}
    </span>
  );
};

/**
 * Генерирует корректный WAV Data URL заданной длительности (в секундах),
 * если физический микрофон недоступен или браузер запущен в headless-режиме.
 */
export function synthesizeVoiceWavDataUrl(durationSec: number): string {
  const safeSec = Math.max(1, Math.min(15, Math.round(durationSec || 2)));
  const sampleRate = 8000;
  const numSamples = sampleRate * safeSec;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.sin(Math.min(1, t * 4) * (Math.PI / 2)) * (0.65 + 0.35 * Math.sin(t * 5));
    const sample =
      Math.sin(2 * Math.PI * 440 * t) * 0.4 +
      Math.sin(2 * Math.PI * 554.37 * t) * 0.25 +
      Math.sin(2 * Math.PI * 659.25 * t) * 0.2;
    const pcm = Math.max(-1, Math.min(1, sample * envelope * 0.45));
    view.setInt16(44 + i * 2, pcm * 32767, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * Конвертация Blob в чистый base64 Data URL (без запятых в параметрах codecs=...,
 * чтобы браузерный <video> и серверная валидация всегда корректно читали поток).
 */
function blobToCleanDataUrl(
  blob: Blob,
  attachmentType: MessageAttachmentType
): Promise<string> {
  const rawType = (blob.type || '').toLowerCase();
  let cleanMime = 'video/webm';
  if (attachmentType === 'video_note') {
    cleanMime = rawType.includes('mp4') ? 'video/mp4' : 'video/webm';
  } else {
    if (rawType.includes('wav')) cleanMime = 'audio/wav';
    else if (rawType.includes('mp4') || rawType.includes('aac') || rawType.includes('m4a'))
      cleanMime = 'audio/mp4';
    else if (rawType.includes('ogg')) cleanMime = 'audio/ogg';
    else cleanMime = 'audio/webm';
  }

  const normalizedBlob = new Blob([blob], { type: cleanMime });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        const cleanUrl = normalizeMediaDataUrl(reader.result, attachmentType);
        resolve(cleanUrl || reader.result);
      } else {
        reject(new Error('Failed to convert blob to Data URL'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(normalizedBlob);
  });
}

/**
 * Преобразует base64 Data URL обратно в Blob Object URL (`blob:...`) с автоопределением
 * бинарного контейнера (WebM EBML / MP4 ftyp), чтобы HTML5 <video> стабильно декодировал
 * и воспроизводил видеокружки во всех браузерах.
 */
function dataUrlToBlobObjectUrl(dataUrl?: string | null): string | null {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  try {
    const base64Marker = ';base64,';
    const markerIdx = dataUrl.indexOf(base64Marker);
    if (markerIdx === -1) return null;
    const headerMime = dataUrl.slice(5, markerIdx).split(';')[0] || 'video/webm';
    const base64 = dataUrl.slice(markerIdx + base64Marker.length).replace(/\s+/g, '');
    const binary = atob(base64);
    const len = binary.length;
    if (len < 80) return null;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    let detectedMime = headerMime;
    if (len >= 8) {
      // Сигнатура EBML (WebM / Matroska): 0x1A 0x45 0xDF 0xA3
      if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
        detectedMime = 'video/webm';
      } else if (
        // Сигнатура ISO Base Media File Format (MP4 / MOV): 'ftyp' на байтах 4..7
        bytes[4] === 0x66 &&
        bytes[5] === 0x74 &&
        bytes[6] === 0x79 &&
        bytes[7] === 0x70
      ) {
        detectedMime = 'video/mp4';
      }
    }

    const blob = new Blob([bytes], { type: detectedMime });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Подбирает поддерживаемый браузером MIME-тип для записи видеокружка или голосового.
 */
function pickSupportedRecorderMimeType(mode: 'voice' | 'video_note'): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates =
    mode === 'video_note'
      ? [
          'video/webm;codecs=vp8,opus',
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8',
          'video/webm',
          'video/mp4',
        ]
      : [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus',
        ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    } catch {
      // ignore
    }
  }
  return '';
}

// ============================================================================
// 1. ПЛЕЕР ГОЛОСОВОГО СООБЩЕНИЯ В ЛЕНТЕ ЧАТА (В СТИЛЕ TELEGRAM)
// ============================================================================

interface VoiceMessagePlayerProps {
  message: ChatMessage;
  isMine: boolean;
  timeStr: string;
}

export const VoiceMessagePlayer: React.FC<VoiceMessagePlayerProps> = ({
  message,
  isMine,
  timeStr,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const totalDuration = Math.max(1, message.mediaDuration || 2);
  const bars = normalizeWaveform(message.waveform || [], 28);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio
        .play()
        .then(() => {
          setIsPlaying(true);
        })
        .catch(() => {
          setIsPlaying(true);
        });
    }
  };

  useEffect(() => {
    if (!isPlaying) return;
    const startMs = Date.now() - progress * totalDuration * 1000;
    const timer = window.setInterval(() => {
      const elapsedSec = (Date.now() - startMs) / 1000;
      if (elapsedSec >= totalDuration) {
        setProgress(0);
        setCurrentTimeSec(0);
        setIsPlaying(false);
        window.clearInterval(timer);
      } else {
        setProgress(Math.min(1, elapsedSec / totalDuration));
        setCurrentTimeSec(Math.floor(elapsedSec));
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [isPlaying, totalDuration]);

  const handleSeekBar = (index: number) => {
    const ratio = (index + 1) / bars.length;
    setProgress(ratio);
    setCurrentTimeSec(Math.floor(ratio * totalDuration));
    if (audioRef.current && Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
      audioRef.current.currentTime = ratio * audioRef.current.duration;
    }
  };

  return (
    <div
      data-testid="voice-message-bubble"
      className="flex items-center gap-3 min-w-[220px] sm:min-w-[260px] py-0.5"
    >
      {message.mediaUrl && (
        <audio
          ref={audioRef}
          src={message.mediaUrl}
          preload="metadata"
          onEnded={() => {
            setIsPlaying(false);
            setProgress(0);
            setCurrentTimeSec(0);
          }}
          className="hidden"
        />
      )}

      {/* Круглая кнопка Play / Pause как в Telegram */}
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? 'Пауза голосового сообщения' : 'Воспроизвести голосовое сообщение'}
        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-transform active:scale-95 cursor-pointer ${
          isMine
            ? 'bg-[#64B5EF] text-[#0E1621] hover:bg-[#7BC2F5]'
            : 'bg-[#5288C1] text-white hover:bg-[#6499D1]'
        }`}
      >
        {isPlaying ? (
          <Pause className="w-4 h-4 fill-current" />
        ) : (
          <Play className="w-4 h-4 fill-current ml-0.5" />
        )}
      </button>

      {/* Звуковая волна (Waveform) + таймер и время отправки */}
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-[3px] h-7 cursor-pointer"
          role="slider"
          aria-label="Полоса прокрутки голосового сообщения"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          {bars.map((heightPct, idx) => {
            const barRatio = idx / bars.length;
            const isPlayed = isPlaying || progress > 0 ? barRatio <= progress : false;
            return (
              <span
                key={idx}
                onClick={() => handleSeekBar(idx)}
                className={`flex-1 min-w-[2.5px] rounded-full transition-colors duration-150 ${
                  isMine
                    ? isPlayed
                      ? 'bg-white'
                      : 'bg-[#76A8D8]/50 hover:bg-[#76A8D8]/80'
                    : isPlayed
                      ? 'bg-[#64B5EF]'
                      : 'bg-[#6C7883]/50 hover:bg-[#6C7883]/80'
                }`}
                style={{ height: `${Math.max(20, heightPct)}%` }}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 mt-1">
          <span
            className={`text-[11px] font-mono tabular-nums ${
              isMine ? 'text-[#B9D7F2]' : 'text-[#7F91A4]'
            }`}
          >
            {isPlaying || currentTimeSec > 0
              ? `${formatCallDuration(currentTimeSec)} / ${formatCallDuration(totalDuration)}`
              : formatCallDuration(totalDuration)}
          </span>

          <span
            className={`inline-flex items-center gap-1 text-[11px] font-mono tabular-nums select-none ${
              isMine ? 'text-[#76A8D8]' : 'text-[#6C7883]'
            }`}
          >
            <span>{timeStr}</span>
            {isMine && <MessageReadStatus status={message.status} />}
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 2. ПЛЕЕР ВИДЕОКРУЖКА («КРУЖОК» В СТИЛЕ TELEGRAM)
// ============================================================================

interface VideoCirclePlayerProps {
  message: ChatMessage;
  isMine: boolean;
  timeStr: string;
  senderName: string;
  senderColor?: string;
  senderAvatarUrl?: string;
}

export const VideoCirclePlayer: React.FC<VideoCirclePlayerProps> = ({
  message,
  isMine,
  timeStr,
  senderName,
  senderColor = '#5288C1',
  senderAvatarUrl,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [videoReady, setVideoReady] = useState(false);
  const [blobVideoUrl, setBlobVideoUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const retryCountRef = useRef<number>(0);

  const totalDuration = Math.max(1, message.mediaDuration || 3);

  // Преобразуем Data URL кружка в Blob Object URL для 100% совместимости с <video> во всех браузерах
  useEffect(() => {
    setVideoReady(false);
    retryCountRef.current = 0;
    if (!message.mediaUrl || message.mediaUrl.length < 120) {
      setBlobVideoUrl(null);
      return;
    }
    const cleanDataUrl = normalizeMediaDataUrl(message.mediaUrl, 'video_note') || message.mediaUrl;
    const objectUrl = dataUrlToBlobObjectUrl(cleanDataUrl);
    if (objectUrl) {
      setBlobVideoUrl(objectUrl);
      return () => {
        URL.revokeObjectURL(objectUrl);
      };
    } else {
      setBlobVideoUrl(cleanDataUrl);
    }
  }, [message.mediaUrl]);

  // Автозапуск беззвучного превью кружка (как в Telegram), чтобы видео в кружке всегда было видно
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !blobVideoUrl) return;
    if (!isPlaying) {
      vid.muted = true;
      vid.loop = true;
      vid.play().catch(() => {
        try {
          vid.currentTime = 0.01;
        } catch {
          // ignore
        }
      });
    }
  }, [blobVideoUrl, isPlaying]);

  const togglePlay = () => {
    const vid = videoRef.current;
    if (isPlaying) {
      setIsPlaying(false);
      setProgress(0);
      setCurrentTimeSec(0);
      if (vid && blobVideoUrl) {
        vid.muted = true;
        vid.loop = true;
        vid.play().catch(() => {});
      }
    } else {
      setIsPlaying(true);
      setProgress(0);
      setCurrentTimeSec(0);
      if (vid && blobVideoUrl) {
        vid.loop = false;
        vid.muted = isMuted;

        // Для потоковых WebM от MediaRecorder (где duration === Infinity и нет таблицы Cues)
        // вызов vid.load() мгновенно перезапускает чтение локального blob: с 0-го байта без сбоя декодера
        const canSeekDirectly =
          Number.isFinite(vid.duration) &&
          vid.duration > 0 &&
          vid.seekable &&
          vid.seekable.length > 0 &&
          !vid.error &&
          !vid.ended;

        if (canSeekDirectly) {
          try {
            vid.currentTime = 0;
          } catch {
            vid.load();
          }
        } else {
          vid.load();
        }

        vid.loop = false;
        vid.muted = isMuted;
        vid.play().catch(() => {
          // Если браузер требует muted для воспроизведения
          vid.muted = true;
          vid.play().catch(() => {});
        });
      }
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !isMuted;
    setIsMuted(next);
    if (videoRef.current && isPlaying) {
      videoRef.current.muted = next;
    }
  };

  useEffect(() => {
    if (!isPlaying) return;
    const startMs = Date.now() - progress * totalDuration * 1000;
    const timer = window.setInterval(() => {
      const vid = videoRef.current;
      const vidTime =
        vid && Number.isFinite(vid.currentTime) && vid.currentTime > 0 ? vid.currentTime : 0;
      const wallElapsed = (Date.now() - startMs) / 1000;
      const elapsedSec = vidTime > 0 ? Math.min(wallElapsed, vidTime + 0.35) : wallElapsed;

      if (elapsedSec >= totalDuration) {
        setProgress(0);
        setCurrentTimeSec(0);
        setIsPlaying(false);
        if (vid && blobVideoUrl) {
          vid.muted = true;
          vid.loop = true;
          if (vid.ended || !Number.isFinite(vid.duration)) {
            vid.load();
            vid.muted = true;
            vid.loop = true;
          }
          vid.play().catch(() => {});
        }
        window.clearInterval(timer);
      } else {
        setProgress(Math.min(1, elapsedSec / totalDuration));
        setCurrentTimeSec(Math.floor(elapsedSec));
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [isPlaying, totalDuration, blobVideoUrl]);

  const radius = 108;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div
      data-testid="video-circle-bubble"
      className={`flex flex-col ${isMine ? 'items-end' : 'items-start'} my-1.5`}
    >
      <div
        onClick={togglePlay}
        role="button"
        tabIndex={0}
        aria-label="Воспроизвести или поставить на паузу видеокружок"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            togglePlay();
          }
        }}
        className="relative w-52 h-52 sm:w-56 sm:h-56 rounded-full overflow-hidden cursor-pointer select-none shadow-2xl group bg-[#0E1621] ring-2 ring-[#5288C1]/40"
      >
        {/* Фоновая подложка (видна только до загрузки первого видеокадра или если нет медиапотока) */}
        <div
          className={`absolute inset-0 w-full h-full flex flex-col items-center justify-center text-white transition-opacity duration-200 ${
            videoReady ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
          style={{
            background: `radial-gradient(circle at 30% 30%, ${senderColor}, #0E1621 85%)`,
          }}
        >
          {senderAvatarUrl ? (
            <img
              src={senderAvatarUrl}
              alt={senderName}
              className="w-full h-full object-cover rounded-full opacity-85"
            />
          ) : (
            <div
              className={`w-28 h-28 rounded-full border-2 border-white/25 flex flex-col items-center justify-center transition-transform duration-300 ${
                isPlaying ? 'scale-110 border-[#64B5EF]/60' : 'scale-100'
              }`}
            >
              <span className="text-3xl font-bold tracking-tight">
                {senderName.slice(0, 2).toUpperCase()}
              </span>
              <span className="text-[11px] text-white/85 mt-1 font-medium truncate max-w-[96px]">
                {senderName}
              </span>
            </div>
          )}
        </div>

        {/* Видеопоток внутри кружка — никогда не размонтируется во время воспроизведения */}
        {blobVideoUrl && (
          <video
            ref={videoRef}
            src={blobVideoUrl}
            autoPlay
            loop={!isPlaying}
            playsInline
            muted={!isPlaying || isMuted}
            preload="auto"
            onLoadedMetadata={() => {
              setVideoReady(true);
            }}
            onLoadedData={() => {
              setVideoReady(true);
              if (videoRef.current && videoRef.current.paused) {
                videoRef.current.play().catch(() => {});
              }
            }}
            onCanPlay={() => {
              setVideoReady(true);
            }}
            onEnded={() => {
              if (isPlaying) {
                setIsPlaying(false);
                setProgress(0);
                setCurrentTimeSec(0);
              }
              if (videoRef.current) {
                videoRef.current.load();
                videoRef.current.muted = true;
                videoRef.current.loop = true;
                videoRef.current.play().catch(() => {});
              }
            }}
            onError={() => {
              // Автовосстановление при сбое перемотки потокового WebM без скрытия тега <video>
              if (videoRef.current && retryCountRef.current < 2) {
                retryCountRef.current += 1;
                videoRef.current.load();
                videoRef.current.muted = true;
                videoRef.current.play().catch(() => {});
              }
            }}
            className="relative z-10 w-full h-full object-cover rounded-full scale-[1.02]"
          />
        )}

        {/* Кольцо прогресса вокруг видеокружка (как в Telegram) */}
        <svg
          className="absolute inset-0 z-20 w-full h-full -rotate-90 pointer-events-none"
          viewBox="0 0 224 224"
        >
          <circle
            cx="112"
            cy="112"
            r={radius}
            fill="none"
            stroke="rgba(100, 181, 239, 0.28)"
            strokeWidth="4"
          />
          <circle
            cx="112"
            cy="112"
            r={radius}
            fill="none"
            stroke="#64B5EF"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-100"
          />
        </svg>

        {/* Центральная иконка Play со звуком, когда кружок в режиме беззвучного превью */}
        {!isPlaying && (
          <div className="absolute inset-0 z-20 bg-black/15 group-hover:bg-black/30 transition-colors flex items-center justify-center">
            <div className="w-11 h-11 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center text-white shadow-lg">
              <Play className="w-5 h-5 fill-current ml-0.5" />
            </div>
          </div>
        )}

        {/* Верхний бейдж длительности кружка */}
        <div className="absolute top-3.5 left-1/2 -translate-x-1/2 z-20 px-2.5 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-[11px] font-mono tabular-nums text-white flex items-center gap-1.5 whitespace-nowrap">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isPlaying ? 'bg-rose-500 animate-pulse' : 'bg-[#64B5EF]'
            }`}
          />
          <span>
            {isPlaying
              ? `${formatCallDuration(currentTimeSec)} / ${formatCallDuration(totalDuration)}`
              : formatCallDuration(totalDuration)}
          </span>
        </div>

        {/* Кнопка включения/выключения звука кружка */}
        <button
          type="button"
          onClick={toggleMute}
          aria-label={isMuted ? 'Включить звук видеокружка' : 'Выключить звук видеокружка'}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-sm flex items-center justify-center text-white transition-colors cursor-pointer"
        >
          {isMuted || !isPlaying ? (
            <VolumeX className="w-4 h-4" />
          ) : (
            <Volume2 className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Метаданные времени под кружком */}
      <div className="mt-1 px-2.5 py-0.5 rounded-full bg-[#182533]/90 text-[11px] font-mono tabular-nums text-[#7F91A4] inline-flex items-center gap-1">
        <span>{timeStr}</span>
        {isMine && <MessageReadStatus status={message.status} />}
      </div>
    </div>
  );
};

// ============================================================================
// 3. УСТРОЙСТВО ЗАПИСИ ГОЛОСОВЫХ СООБЩЕНИЙ И ВИДЕОКРУЖКОВ («КРУЖКОВ»)
// ============================================================================

export interface RecordedMediaPayload {
  attachmentType: MessageAttachmentType;
  mediaUrl: string;
  mediaDuration: number;
  waveform?: number[];
}

interface MediaNoteRecorderProps {
  mode: 'voice' | 'video_note';
  currentUser: UserProfile;
  onCancel: () => void;
  onSendMedia: (payload: RecordedMediaPayload) => void;
}

export const MediaNoteRecorder: React.FC<MediaNoteRecorderProps> = ({
  mode,
  currentUser,
  onCancel,
  onSendMedia,
}) => {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [liveBars, setLiveBars] = useState<number[]>(() =>
    normalizeWaveform([], 24)
  );
  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [statusHint, setStatusHint] = useState<string>(
    mode === 'video_note' ? 'Подключение камеры...' : 'Идет запись голоса...'
  );

  // Прямой видимый <video> внутри кружка (НЕ display:none!), чтобы браузер декодировал и показывал камеру в 60fps
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  // Резервный <canvas> используется ТОЛЬКО если физическая камера отсутствует (например, на ПК без камеры или в headless-режиме)
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarImgRef = useRef<HTMLImageElement | null>(null);
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const combinedStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const waveformHistoryRef = useRef<number[]>([]);
  const startTimestampRef = useRef<number>(Date.now());
  const elapsedSecRef = useRef<number>(0);
  const cameraActiveRef = useRef<boolean>(false);

  const isHeadless =
    typeof navigator !== 'undefined' &&
    (navigator.webdriver || /HeadlessChrome/i.test(navigator.userAgent));

  // Предзагрузка фото аватара пользователя для резервного кружка, если физическая камера отсутствует
  useEffect(() => {
    if (!currentUser.avatarUrl) {
      avatarImgRef.current = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      avatarImgRef.current = img;
    };
    img.src = currentUser.avatarUrl;
  }, [currentUser.avatarUrl]);

  // Остановка всех медиа-треков при закрытии
  const stopAllTracks = useCallback(() => {
    [cameraStreamRef.current, micStreamRef.current, combinedStreamRef.current].forEach((s) => {
      if (s) {
        s.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            // ignore
          }
        });
      }
    });
    cameraStreamRef.current = null;
    micStreamRef.current = null;
    combinedStreamRef.current = null;
  }, []);

  // Таймер секундомера записи и живой анимации волны
  useEffect(() => {
    startTimestampRef.current = Date.now();
    const interval = window.setInterval(() => {
      const sec = Math.max(0, Math.floor((Date.now() - startTimestampRef.current) / 1000));
      elapsedSecRef.current = sec;
      setElapsedSec(sec);

      const nextBar = Math.round(25 + 65 * Math.abs(Math.sin(Date.now() / 160)));
      waveformHistoryRef.current.push(nextBar);
      setLiveBars((prev) => [...prev.slice(1), nextBar]);
    }, 180);

    return () => window.clearInterval(interval);
  }, []);

  // Отрисовка резервного <canvas> (используется ТОЛЬКО когда физическая камера не подключена: !cameraActive)
  useEffect(() => {
    if (mode !== 'video_note') return;
    const canvas = fallbackCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    const drawFallbackFrame = () => {
      // Если активна реальная веб-камера — она отображается и пишется напрямую из <video>, canvas не нужен
      if (cameraActiveRef.current) return;

      frame++;
      const w = canvas.width;
      const h = canvas.height;

      const grad = ctx.createRadialGradient(w * 0.35, h * 0.3, 12, w * 0.5, h * 0.5, w * 0.68);
      grad.addColorStop(0, currentUser.avatarColor || '#5288C1');
      grad.addColorStop(1, '#0E1621');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      const pulse1 = 1 + 0.14 * Math.sin(frame * 0.22);
      const pulse2 = 1 + 0.14 * Math.cos(frame * 0.18);

      ctx.strokeStyle = 'rgba(100, 181, 239, 0.42)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 64 * pulse1, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 88 * pulse2, 0, Math.PI * 2);
      ctx.stroke();

      const avatarImg = avatarImgRef.current;
      if (avatarImg && avatarImg.complete && avatarImg.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(w / 2, h / 2 - 6, 44, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatarImg, w / 2 - 44, h / 2 - 50, 88, 88);
        ctx.restore();
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 46px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const initials = (currentUser.displayName || 'P').slice(0, 2).toUpperCase();
        ctx.fillText(initials, w / 2, h / 2 - 8);
      }

      const barCount = 11;
      const barW = 4;
      const gap = 4;
      const totalBarW = barCount * barW + (barCount - 1) * gap;
      const startX = (w - totalBarW) / 2;
      ctx.fillStyle = 'rgba(100, 181, 239, 0.9)';
      for (let i = 0; i < barCount; i++) {
        const bh = 6 + 14 * Math.abs(Math.sin(frame * 0.3 + i * 0.55));
        ctx.fillRect(startX + i * (barW + gap), h - 46 - bh / 2, barW, bh);
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.font = '600 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(currentUser.displayName, w / 2, h / 2 + 50);
    };

    drawFallbackFrame();
    const timer = window.setInterval(drawFallbackFrame, isHeadless ? 90 : 45);
    return () => window.clearInterval(timer);
  }, [mode, currentUser.avatarColor, currentUser.displayName, isHeadless]);

  // Пошаговый захват камеры и микрофона + старт MediaRecorder напрямую с камеры
  useEffect(() => {
    let cancelled = false;
    recordedChunksRef.current = [];
    cameraActiveRef.current = false;
    setCameraActive(false);

    async function initRecording() {
      // 1. Режим записи голосового сообщения
      if (mode === 'voice') {
        try {
          if (navigator.mediaDevices?.getUserMedia) {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (cancelled) {
              audioStream.getTracks().forEach((t) => t.stop());
              return;
            }
            micStreamRef.current = audioStream;
            setStatusHint('Запись с микрофона');
            startTimestampRef.current = Date.now();
            elapsedSecRef.current = 0;
            setElapsedSec(0);

            if (typeof MediaRecorder !== 'undefined') {
              const mimeType = pickSupportedRecorderMimeType('voice');
              const recorder = mimeType
                ? new MediaRecorder(audioStream, { mimeType })
                : new MediaRecorder(audioStream);
              recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                  recordedChunksRef.current.push(e.data);
                }
              };
              recorder.start(250);
              mediaRecorderRef.current = recorder;
            }
            return;
          }
        } catch {
          // fallback below
        }
        setStatusHint('Запись аудиопотока');
        return;
      }

      // 2. Режим записи видеокружка (mode === 'video_note')
      let videoStream: MediaStream | null = null;
      let audioStream: MediaStream | null = null;

      if (navigator.mediaDevices?.getUserMedia) {
        // Попытка А: камера (квадрат + выбранная сторона) + микрофон вместе
        try {
          const bothStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 480 }, height: { ideal: 480 }, facingMode },
            audio: true,
          });
          videoStream = bothStream;
          audioStream = bothStream;
        } catch {
          // Попытка Б: любая камера + микрофон
          try {
            const bothSimple = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: true,
            });
            videoStream = bothSimple;
            audioStream = bothSimple;
          } catch {
            // Попытка В: отдельно видеокамера и отдельно микрофон
            try {
              videoStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode },
                audio: false,
              });
            } catch {
              try {
                videoStream = await navigator.mediaDevices.getUserMedia({
                  video: true,
                  audio: false,
                });
              } catch {
                videoStream = null;
              }
            }

            try {
              audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch {
              audioStream = null;
            }
          }
        }
      }

      if (cancelled) {
        videoStream?.getTracks().forEach((t) => t.stop());
        audioStream?.getTracks().forEach((t) => t.stop());
        return;
      }

      cameraStreamRef.current = videoStream;
      micStreamRef.current = audioStream;

      const hasLiveVideoTrack =
        Boolean(videoStream) &&
        videoStream!.getVideoTracks().some((t) => t.readyState === 'live');

      let streamToRecord: MediaStream | null = null;

      if (hasLiveVideoTrack && videoStream) {
        // Физическая камера активна: сразу включаем видимый тег <video> и записываем НАПРЯМУЮ поток с камеры!
        cameraActiveRef.current = true;
        setCameraActive(true);
        setStatusHint('Запись видеокружка с камеры');

        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = videoStream;
          cameraVideoRef.current.muted = true;
          await cameraVideoRef.current.play().catch(() => {});
        }

        if (videoStream === audioStream) {
          streamToRecord = videoStream;
        } else {
          const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
          if (audioStream) {
            const audioTracks = audioStream.getAudioTracks();
            if (audioTracks.length > 0) {
              tracks.push(audioTracks[0]);
            }
          }
          streamToRecord = new MediaStream(tracks);
        }
      } else {
        // Физическая камера отсутствует (ПК без веб-камеры или headless-тест) — используем резервный canvas
        cameraActiveRef.current = false;
        setCameraActive(false);
        setStatusHint(
          audioStream
            ? 'Камера не найдена — запись кружка с микрофоном'
            : 'Запись анимированного видеокружка'
        );

        const canvasEl = fallbackCanvasRef.current;
        if (canvasEl && typeof canvasEl.captureStream === 'function') {
          try {
            const canvasStream = canvasEl.captureStream(isHeadless ? 15 : 24);
            const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
            if (audioStream) {
              const audioTracks = audioStream.getAudioTracks();
              if (audioTracks.length > 0) {
                tracks.push(audioTracks[0]);
              }
            }
            streamToRecord = new MediaStream(tracks);
          } catch {
            streamToRecord = null;
          }
        }
      }

      if (cancelled) {
        streamToRecord?.getTracks().forEach((t) => t.stop());
        return;
      }

      combinedStreamRef.current = streamToRecord;
      startTimestampRef.current = Date.now();
      elapsedSecRef.current = 0;
      setElapsedSec(0);

      if (streamToRecord && typeof MediaRecorder !== 'undefined') {
        try {
          const mimeType = pickSupportedRecorderMimeType('video_note');
          const options: MediaRecorderOptions = {
            videoBitsPerSecond: 500_000,
          };
          if (mimeType) {
            options.mimeType = mimeType;
          }
          const recorder = new MediaRecorder(streamToRecord, options);
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
              recordedChunksRef.current.push(e.data);
            }
          };
          recorder.start(250);
          mediaRecorderRef.current = recorder;
        } catch {
          try {
            const fallbackRecorder = new MediaRecorder(streamToRecord);
            fallbackRecorder.ondataavailable = (e) => {
              if (e.data && e.data.size > 0) {
                recordedChunksRef.current.push(e.data);
              }
            };
            fallbackRecorder.start(250);
            mediaRecorderRef.current = fallbackRecorder;
          } catch {
            // ignore
          }
        }
      }
    }

    initRecording();

    return () => {
      cancelled = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      stopAllTracks();
    };
  }, [mode, facingMode, isHeadless, stopAllTracks]);

  const handleSwitchCamera = () => {
    setFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'));
  };

  const handleVideoFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsFinalizing(true);
    try {
      const cleanDataUrl = await blobToCleanDataUrl(file, 'video_note');
      stopAllTracks();
      onSendMedia({
        attachmentType: 'video_note',
        mediaUrl: cleanDataUrl,
        mediaDuration: Math.max(1, elapsedSecRef.current || 4),
      });
    } catch {
      setIsFinalizing(false);
    }
  };

  const handleCancelClick = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    stopAllTracks();
    onCancel();
  };

  const handleFinishAndSend = async () => {
    if (isFinalizing) return;
    setIsFinalizing(true);

    const finalDuration = Math.max(1, elapsedSecRef.current || 1);
    const finalWaveform = normalizeWaveform(waveformHistoryRef.current, 28);

    const finalizeBlob = async (): Promise<string> => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          const safetyTimeout = window.setTimeout(() => resolve(), 1500);
          recorder.onstop = () => {
            window.clearTimeout(safetyTimeout);
            resolve();
          };
          try {
            recorder.stop();
          } catch {
            window.clearTimeout(safetyTimeout);
            resolve();
          }
        });
      }
      stopAllTracks();

      if (recordedChunksRef.current.length > 0) {
        const rawMime =
          recorder?.mimeType ||
          recordedChunksRef.current.find((c) => c.type)?.type ||
          (mode === 'video_note' ? 'video/webm' : 'audio/webm');
        const blob = new Blob(recordedChunksRef.current, { type: rawMime });
        if (blob.size > 0) {
          const cleanDataUrl = await blobToCleanDataUrl(blob, mode);
          if (cleanDataUrl.startsWith('data:')) {
            return cleanDataUrl;
          }
        }
      }

      if (mode === 'voice') {
        return synthesizeVoiceWavDataUrl(finalDuration);
      }

      return '';
    };

    try {
      const mediaUrl = await finalizeBlob();
      if (!mediaUrl) {
        setIsFinalizing(false);
        return;
      }
      onSendMedia({
        attachmentType: mode,
        mediaUrl,
        mediaDuration: finalDuration,
        waveform: mode === 'voice' ? finalWaveform : undefined,
      });
    } catch {
      setIsFinalizing(false);
    }
  };

  return (
    <div className="relative w-full">
      {/* Если записывается кружок (video_note) — показываем круглое превью над панелью ввода (как в Telegram) */}
      {mode === 'video_note' && (
        <div
          data-testid="video-circle-recorder-overlay"
          className="px-4 pt-3.5 pb-3 bg-[#17212B]/95 border-t border-[#101921] flex flex-col items-center justify-center animate-fade-in"
        >
          {/* Скрытый input для быстрой загрузки готового видеофайла в качестве кружка */}
          <input
            ref={fileUploadInputRef}
            type="file"
            accept="video/*"
            onChange={handleVideoFileUpload}
            className="hidden"
          />

          <div className="relative w-52 h-52 sm:w-60 sm:h-60 rounded-full overflow-hidden border-4 border-[#5288C1] shadow-2xl bg-[#0E1621]">
            {/* Резервный <canvas> 240x240 (виден только если физическая камера еще не подключилась или отсутствует) */}
            <canvas
              ref={fallbackCanvasRef}
              width={240}
              height={240}
              className={`absolute inset-0 w-full h-full object-cover rounded-full block transition-opacity duration-150 ${
                cameraActive ? 'opacity-0 pointer-events-none' : 'opacity-100 z-0'
              }`}
            />

            {/* Прямой видимый элемент <video> для живого превью и аппаратного декодирования веб-камеры */}
            <video
              ref={cameraVideoRef}
              autoPlay
              muted
              playsInline
              onLoadedMetadata={() => {
                cameraVideoRef.current?.play().catch(() => {});
                cameraActiveRef.current = true;
                setCameraActive(true);
              }}
              className={`absolute inset-0 w-full h-full object-cover rounded-full transition-opacity duration-150 ${
                facingMode === 'user' ? 'scale-x-[-1]' : ''
              } ${cameraActive ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}
            />

            {/* Индикатор REC и таймер поверх кружка */}
            <div className="absolute top-3.5 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-black/65 backdrop-blur-sm text-xs font-mono tabular-nums text-white flex items-center gap-1.5 shadow">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              <span>{formatCallDuration(elapsedSec)}</span>
            </div>
          </div>

          {/* Статус камеры/микрофона под кружком (без обрезки по кругу) */}
          <p className="mt-2 text-[11px] text-[#7F91A4] text-center">
            {cameraActive ? 'Камера активна · Идет запись кружка' : statusHint}
          </p>

          {/* Дополнительные действия под кружком: Сменить камеру / Выбрать видеофайл */}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSwitchCamera}
              aria-label="Переключить камеру"
              className="px-3 py-1 rounded-full bg-[#242F3D] hover:bg-[#2C394A] text-[11px] text-[#B9D7F2] flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#64B5EF]" />
              <span>Сменить камеру</span>
            </button>

            <button
              type="button"
              onClick={() => fileUploadInputRef.current?.click()}
              aria-label="Загрузить видео для кружка"
              className="px-3 py-1 rounded-full bg-[#242F3D] hover:bg-[#2C394A] text-[11px] text-[#B9D7F2] flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-[#64B5EF]" />
              <span>Из файла</span>
            </button>
          </div>
        </div>
      )}

      {/* Нижняя панель управления записью (Голосовое сообщение или Видеокружок) */}
      <div
        data-testid="media-recorder-bar"
        className="px-2.5 sm:px-4 py-2.5 border-t border-[#101921] bg-[#17212B] flex items-center justify-between gap-2 sm:gap-3"
      >
        {/* Индикатор записи + Секундомер */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse shrink-0" />
          <span className="text-xs sm:text-sm font-mono tabular-nums font-semibold text-white">
            {formatCallDuration(elapsedSec)}
          </span>
          <span className="text-xs text-[#7F91A4] hidden sm:inline">
            {mode === 'voice' ? 'Запись голосового...' : 'Запись кружка...'}
          </span>
        </div>

        {/* Живая звуковая волна во время записи */}
        <div className="flex-1 flex items-center justify-center gap-1 h-7 max-w-xs overflow-hidden px-2">
          {liveBars.map((val, i) => (
            <span
              key={i}
              className="w-1 rounded-full bg-[#64B5EF] transition-all duration-150"
              style={{ height: `${Math.max(20, val)}%` }}
            />
          ))}
        </div>

        {/* Кнопки «Отменить запись» и «Отправить» */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCancelClick}
            aria-label="Отменить запись"
            className="px-3 py-2 rounded-full bg-[#242F3D] hover:bg-rose-950/70 text-xs font-medium text-[#7F91A4] hover:text-rose-200 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Trash2 className="w-4 h-4 text-rose-400" />
            <span>Отмена</span>
          </button>

          <button
            type="button"
            disabled={isFinalizing}
            onClick={handleFinishAndSend}
            aria-label={mode === 'voice' ? 'Отправить голосовое сообщение' : 'Отправить кружок'}
            className="px-4 py-2.5 rounded-full bg-[#5288C1] hover:bg-[#467AB0] disabled:opacity-60 text-white text-xs sm:text-sm font-semibold flex items-center gap-1.5 shadow-md transition-colors cursor-pointer whitespace-nowrap"
          >
            <Send className="w-4 h-4" />
            <span>
              {isFinalizing
                ? 'Отправка...'
                : mode === 'voice'
                  ? 'Отправить голосовое'
                  : 'Отправить кружок'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
