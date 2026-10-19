import React, { useEffect, useRef, useState } from 'react';
import {
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Minimize2,
  Maximize2,
  MessageSquare,
  ArrowUpRight,
  ArrowDownLeft,
} from 'lucide-react';
import {
  formatCallDuration,
  type CallState,
  type CallMediaType,
} from '../utils/messengerLogic';
import { UserAvatar } from './UserAvatar';

interface CallModalProps {
  callState: CallState;
  mediaType: CallMediaType;
  remotePeerName: string;
  remotePeerAvatarColor?: string;
  remotePeerAvatarUrl?: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMicMuted: boolean;
  isCamOff: boolean;
  callDurationSec: number;
  mediaWarning: string | null;
  onAccept: () => void;
  onRejectOrHangup: () => void;
  onToggleMic: () => void;
  onToggleCamera: () => void;
}

/**
 * Удобное окно звонка с поддержкой двух режимов:
 * 1. Полноразмерный режим (с возможностью свернуть в 1 клик или перейти к чату).
 * 2. Компактный плавающий режим (Picture-in-Picture в углу экрана), который не перекрывает чат
 *    и позволяет свободно читать переписку и отправлять сообщения во время видео- или аудиозвонка.
 */
export const CallModal: React.FC<CallModalProps> = ({
  callState,
  mediaType,
  remotePeerName,
  remotePeerAvatarColor = '#5288C1',
  remotePeerAvatarUrl,
  localStream,
  remoteStream,
  isMicMuted,
  isCamOff,
  callDurationSec,
  mediaWarning,
  onAccept,
  onRejectOrHangup,
  onToggleMic,
  onToggleCamera,
}) => {
  const [isMinimized, setIsMinimized] = useState(false);
  const [dockCorner, setDockCorner] = useState<'bottom-left' | 'top-right'>('top-right');

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  // Сбрасываем свернутое состояние при новом входящем вызове
  useEffect(() => {
    if (callState === 'ringing' || callState === 'idle' || callState === 'ended') {
      setIsMinimized(false);
    }
  }, [callState]);

  // Привязываем медиапотоки при переключении между полным и компактным режимом
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, callState, isMinimized]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, callState, isMinimized]);

  if (callState === 'idle' || callState === 'ended') {
    return null;
  }

  // ============================================================================
  // 1. КОМПАКТНОЕ МИНИАТЮРНОЕ ОКОШКО ЗВОНКА (PICTURE-IN-PICTURE НА МОБИЛЬНЫХ И ПК)
  // ============================================================================
  if (isMinimized) {
    const positionClasses =
      dockCorner === 'bottom-left'
        ? 'bottom-16 left-2.5 sm:bottom-5 sm:left-5'
        : 'top-16 right-2.5 sm:top-20 sm:right-5';

    return (
      <aside
        aria-label="Свернутое окно активного звонка"
        className={`fixed ${positionClasses} z-40 w-56 sm:w-76 bg-[#17212B]/95 backdrop-blur-md border border-[#2B5278]/80 rounded-2xl shadow-2xl overflow-hidden transition-all`}
      >
        {/* Верхняя компактная панель мини-окошка */}
        <div className="flex items-center justify-between gap-1.5 px-2.5 sm:px-3 py-2 bg-[#0E1621]/90 border-b border-[#101921]">
          <div className="min-w-0 flex items-center gap-1.5 sm:gap-2">
            <UserAvatar
              displayName={remotePeerName}
              avatarColor={remotePeerAvatarColor}
              avatarUrl={remotePeerAvatarUrl}
              sizeClass="w-5 h-5 sm:w-6 sm:h-6"
              textClass="text-[10px] sm:text-xs"
            />
            <div className="min-w-0">
              <p className="text-[11px] sm:text-xs font-semibold text-white truncate">
                {remotePeerName}
              </p>
              <p className="text-[10px] sm:text-[11px] font-mono text-emerald-400 tabular-nums truncate whitespace-nowrap">
                {callState === 'connected'
                  ? formatCallDuration(callDurationSec)
                  : 'Вызов...'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() =>
                setDockCorner((prev) => (prev === 'bottom-left' ? 'top-right' : 'bottom-left'))
              }
              title="Переместить мини-окно в другой угол"
              aria-label="Переместить мини-окно"
              className="flex items-center justify-center w-6 h-6 sm:w-7 sm:h-7 text-[#7F91A4] hover:text-white bg-[#242F3D] rounded-lg transition-colors cursor-pointer shrink-0"
            >
              {dockCorner === 'bottom-left' ? (
                <ArrowUpRight className="w-3.5 h-3.5" />
              ) : (
                <ArrowDownLeft className="w-3.5 h-3.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setIsMinimized(false)}
              aria-label="Развернуть окно звонка"
              title="Развернуть на весь экран"
              className="flex items-center gap-1 px-2 py-1 text-[11px] sm:text-xs font-medium text-white bg-[#2B5278] hover:bg-[#34628E] rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Maximize2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#64B5EF]" />
              <span>Развернуть</span>
            </button>
          </div>
        </div>

        {/* Миниатюрный видеоэкран (работает одинаково в мобильной и веб-версии) */}
        <div
          onClick={() => setIsMinimized(false)}
          className="relative aspect-video bg-[#0E1621] flex items-center justify-center overflow-hidden cursor-pointer"
        >
          {remoteStream && mediaType === 'video' ? (
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="text-center p-2 pb-5">
              <UserAvatar
                displayName={remotePeerName}
                avatarColor={remotePeerAvatarColor}
                avatarUrl={remotePeerAvatarUrl}
                sizeClass="w-8 h-8 sm:w-10 sm:h-10"
                textClass="text-xs"
                className="mx-auto mb-1"
              />
              <p className="text-[10px] sm:text-[11px] text-[#7F91A4]">
                {callState === 'calling'
                  ? 'Ожидание ответа...'
                  : mediaType === 'video'
                    ? 'Видеозвонок'
                    : 'Голосовой звонок'}
              </p>
            </div>
          )}

          {/* Миниатюра вашей камеры в углу (PiP) */}
          {mediaType === 'video' && (
            <div className="absolute bottom-1.5 right-1.5 w-14 sm:w-20 aspect-video bg-[#17212B] border border-[#242F3D] rounded-md overflow-hidden shadow-lg flex items-center justify-center">
              {localStream && !isCamOff ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              ) : (
                <VideoOff className="w-3 h-3 text-[#7F91A4]" />
              )}
            </div>
          )}
        </div>

        {/* Нижняя панель кнопок управления внутри мини-окошка */}
        <div className="flex items-center justify-between gap-1.5 px-2.5 sm:px-3 py-2 bg-[#17212B] border-t border-[#101921]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleMic}
              aria-label={isMicMuted ? 'Включить микрофон' : 'Выключить микрофон'}
              title={isMicMuted ? 'Включить микрофон' : 'Выключить микрофон'}
              className={`p-1.5 sm:p-2 rounded-full transition-colors cursor-pointer ${
                isMicMuted
                  ? 'bg-amber-500/20 text-amber-300'
                  : 'bg-[#242F3D] text-white hover:bg-[#2C394A]'
              }`}
            >
              {isMicMuted ? (
                <MicOff className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              ) : (
                <Mic className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              )}
            </button>

            {mediaType === 'video' && (
              <button
                type="button"
                onClick={onToggleCamera}
                aria-label={isCamOff ? 'Включить камеру' : 'Выключить камеру'}
                title={isCamOff ? 'Включить камеру' : 'Выключить камеру'}
                className={`p-1.5 sm:p-2 rounded-full transition-colors cursor-pointer ${
                  isCamOff
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-[#242F3D] text-white hover:bg-[#2C394A]'
                }`}
              >
                {isCamOff ? (
                  <VideoOff className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                ) : (
                  <Video className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                )}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onRejectOrHangup}
            className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-[11px] sm:text-xs font-semibold rounded-full transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <PhoneOff className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            <span>Завершить</span>
          </button>
        </div>
      </aside>
    );
  }

  // ============================================================================
  // 2. ПОЛНОРАЗМЕРНОЕ ОКНО ЗВОНКА С КНОПКОЙ «СВЕРНУТЬ К ЧАТУ»
  // ============================================================================
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="call-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0E1621]/85 backdrop-blur-sm p-3 sm:p-4"
    >
      <div className="w-full max-w-3xl bg-[#17212B] border border-[#242F3D] rounded-2xl shadow-2xl overflow-hidden">
        {/* Верхняя панель звонка */}
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-3.5 sm:py-4 border-b border-[#101921]">
          <div className="min-w-0">
            <h2 id="call-modal-title" className="text-sm sm:text-base font-semibold text-white truncate">
              {callState === 'ringing' &&
                `Входящий ${mediaType === 'video' ? 'видео' : 'аудио'}звонок`}
              {callState === 'calling' && `Звонок: ${remotePeerName}`}
              {callState === 'connected' && remotePeerName}
            </h2>
            <p className="text-xs text-[#7F91A4] mt-0.5 truncate">
              {callState === 'ringing' && 'Нажмите «Принять», чтобы начать разговор'}
              {callState === 'calling' && 'Ожидание ответа собеседника...'}
              {callState === 'connected' && (
                <span className="font-mono text-emerald-400 tabular-nums">
                  В разговоре · {formatCallDuration(callDurationSec)}
                </span>
              )}
            </p>
          </div>

          {/* Кнопка сворачивания окна, чтобы писать в чате во время разговора */}
          {callState !== 'ringing' && (
            <button
              type="button"
              onClick={() => setIsMinimized(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-[#242F3D] hover:bg-[#2C394A] rounded-xl transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Minimize2 className="w-3.5 h-3.5 text-[#64B5EF]" />
              <span>Свернуть в чат</span>
            </button>
          )}
        </div>

        {/* Основная область: Входящий вызов ИЛИ Активный разговор */}
        {callState === 'ringing' ? (
          <div className="p-8 sm:p-10 text-center space-y-6">
            <UserAvatar
              displayName={remotePeerName}
              avatarColor={remotePeerAvatarColor}
              avatarUrl={remotePeerAvatarUrl}
              sizeClass="w-20 h-20 sm:w-24 sm:h-24"
              textClass="text-2xl sm:text-3xl"
              className="mx-auto"
            />
            <div className="space-y-1">
              <p className="text-lg sm:text-xl font-bold text-white">{remotePeerName}</p>
              <p className="text-xs sm:text-sm text-[#7F91A4]">
                {mediaType === 'video' ? 'Видеозвонок Pulse' : 'Аудиозвонок Pulse'}
              </p>
            </div>

            <div className="flex items-center justify-center gap-3 sm:gap-4 pt-2">
              <button
                type="button"
                onClick={onAccept}
                className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-full transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {mediaType === 'video' ? (
                  <Video className="w-4 h-4" />
                ) : (
                  <Phone className="w-4 h-4" />
                )}
                Принять
              </button>

              <button
                type="button"
                onClick={onRejectOrHangup}
                className="flex items-center gap-2 px-6 py-3 bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold rounded-full transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <PhoneOff className="w-4 h-4" />
                Сбросить
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 sm:p-6 space-y-4">
            {mediaWarning && (
              <div className="px-3.5 py-2 bg-amber-950/60 border border-amber-800/60 rounded-lg text-xs text-amber-200">
                {mediaWarning}
              </div>
            )}

            {/* Удобная сцена: крупное видео собеседника + компактное окно вашей камеры в углу */}
            <div className="relative aspect-video bg-[#0E1621] border border-[#101921] rounded-xl overflow-hidden flex items-center justify-center">
              {remoteStream && mediaType === 'video' ? (
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-center p-4 sm:p-6">
                  <UserAvatar
                    displayName={remotePeerName}
                    avatarColor={remotePeerAvatarColor}
                    avatarUrl={remotePeerAvatarUrl}
                    sizeClass="w-16 h-16 sm:w-20 sm:h-20"
                    textClass="text-xl sm:text-2xl"
                    className="mx-auto mb-2.5"
                  />
                  <p className="text-sm sm:text-base font-semibold text-white">{remotePeerName}</p>
                  <p className="text-xs text-[#7F91A4] mt-1">
                    {callState === 'calling' ? 'Вызов абонента...' : 'Голосовая связь активна'}
                  </p>
                </div>
              )}

              <div className="absolute bottom-2.5 left-2.5 px-2.5 py-1 bg-[#0E1621]/80 rounded-lg text-xs font-medium text-white">
                {remotePeerName}
              </div>

              {/* Ваша камера в формате Picture-in-Picture внутри сцены */}
              <div className="absolute bottom-2.5 right-2.5 w-28 sm:w-44 aspect-video bg-[#17212B] border border-[#242F3D] rounded-xl overflow-hidden shadow-xl flex items-center justify-center">
                {localStream && mediaType === 'video' && !isCamOff ? (
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-center p-1.5">
                    <VideoOff className="w-4 h-4 text-[#7F91A4] mx-auto mb-0.5" />
                    <p className="text-[10px] text-[#7F91A4]">
                      {isCamOff ? 'Камера выкл.' : 'Вы'}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Нижняя панель управления звонком (удобные круглые/компактные кнопки на телефонах) */}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#101921]">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onToggleMic}
                  aria-label={isMicMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                  className={`flex items-center gap-2 p-3 sm:px-4 sm:py-2.5 text-xs font-medium rounded-full sm:rounded-xl transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    isMicMuted
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-[#242F3D] text-white hover:bg-[#2C394A]'
                  }`}
                >
                  {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  <span className="hidden sm:inline">
                    {isMicMuted ? 'Включить микрофон' : 'Микрофон'}
                  </span>
                </button>

                {mediaType === 'video' && (
                  <button
                    type="button"
                    onClick={onToggleCamera}
                    aria-label={isCamOff ? 'Включить камеру' : 'Выключить камеру'}
                    className={`flex items-center gap-2 p-3 sm:px-4 sm:py-2.5 text-xs font-medium rounded-full sm:rounded-xl transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      isCamOff
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-[#242F3D] text-white hover:bg-[#2C394A]'
                    }`}
                  >
                    {isCamOff ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                    <span className="hidden sm:inline">
                      {isCamOff ? 'Включить камеру' : 'Камера'}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsMinimized(true)}
                  aria-label="Перейти в чат"
                  className="flex items-center gap-2 p-3 sm:px-4 sm:py-2.5 text-xs font-medium rounded-full sm:rounded-xl bg-[#242F3D] text-white hover:bg-[#2C394A] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <MessageSquare className="w-4 h-4 text-[#64B5EF]" />
                  <span className="hidden sm:inline">Чат</span>
                </button>
              </div>

              <button
                type="button"
                onClick={onRejectOrHangup}
                className="flex items-center gap-2 px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-full sm:rounded-xl transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <PhoneOff className="w-4 h-4" />
                <span>Завершить</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
