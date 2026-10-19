import React from 'react';
import { Bell, MessageSquare, PhoneCall, Video, X } from 'lucide-react';
import { UserAvatar } from './UserAvatar';

export interface AppNotificationItem {
  id: string;
  type: 'message' | 'call';
  senderId: string;
  senderName: string;
  senderAvatarColor?: string;
  senderAvatarUrl?: string;
  title: string;
  body: string;
  mediaType?: 'audio' | 'video';
  createdAt: string;
}

/**
 * Синтез приятного звукового сигнала уведомления о новом сообщении через Web Audio API
 * (не требует внешних MP3-файлов и работает мгновенно).
 */
export function playMessageNotificationSound() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880, now + 0.09); // A5

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 400);
  } catch {
    // Игнорируем ограничения автовоспроизведения браузера
  }
}

/**
 * Синтез мелодии входящего звонка через Web Audio API.
 */
export function playIncomingCallRingtonePulse() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = [659.25, 783.99, 987.77]; // E5, G5, B5
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const start = now + idx * 0.14;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.26);
    });

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 900);
  } catch {
    // Игнорируем ограничения автовоспроизведения браузера
  }
}

/**
 * Отправка системного браузерного уведомления (Web Notifications API), если разрешение выдано.
 */
export function triggerBrowserNotification(title: string, body: string, tag: string) {
  try {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title, {
          body,
          tag,
        });
      }
    }
  } catch {
    // Игнорируем в окружениях без поддержки системных уведомлений
  }
}

interface NotificationCenterProps {
  notifications: AppNotificationItem[];
  onSelectNotification: (item: AppNotificationItem) => void;
  onDismissNotification: (id: string) => void;
}

/**
 * Всплывающие интерактивные уведомления в стиле Telegram о новых сообщениях и входящих звонках.
 */
export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  notifications,
  onSelectNotification,
  onDismissNotification,
}) => {
  if (notifications.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Уведомления"
      className="fixed top-16 right-3 left-3 sm:left-auto sm:top-16 sm:right-5 z-[60] flex flex-col gap-2 sm:w-88 pointer-events-none"
    >
      {notifications.map((item) => {
        const isCall = item.type === 'call';
        return (
          <div
            key={item.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-2xl border shadow-2xl backdrop-blur-md transition-all ${
              isCall
                ? 'bg-[#17212B]/95 border-emerald-500/70 ring-1 ring-emerald-500/30'
                : 'bg-[#17212B]/95 border-[#2B5278]'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelectNotification(item)}
              className="flex items-start gap-3 flex-1 min-w-0 text-left cursor-pointer"
            >
              <div className="relative shrink-0">
                <UserAvatar
                  displayName={item.senderName}
                  avatarColor={item.senderAvatarColor || '#5288C1'}
                  avatarUrl={item.senderAvatarUrl}
                  sizeClass="w-11 h-11"
                  textClass="text-sm"
                />
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full flex items-center justify-center text-white shadow ${
                    isCall ? 'bg-emerald-600' : 'bg-[#5288C1]'
                  }`}
                >
                  {isCall ? (
                    item.mediaType === 'video' ? (
                      <Video className="w-2.5 h-2.5" />
                    ) : (
                      <PhoneCall className="w-2.5 h-2.5" />
                    )
                  ) : (
                    <MessageSquare className="w-2.5 h-2.5" />
                  )}
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <Bell className="w-3 h-3 text-[#64B5EF] shrink-0" />
                  <p className="text-xs font-semibold text-white truncate">{item.title}</p>
                </div>
                <p className="text-xs text-[#D3E5F6] line-clamp-2 mt-0.5 break-words">
                  {item.body}
                </p>
                <span className="inline-block text-[11px] font-medium text-[#64B5EF] mt-1">
                  {isCall ? 'Ответить на звонок →' : 'Открыть диалог →'}
                </span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onDismissNotification(item.id)}
              aria-label="Закрыть уведомление"
              className="p-1 text-[#7F91A4] hover:text-white rounded-lg transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
