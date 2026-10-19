import { useState, useRef, useCallback, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import {
  transitionCallState,
  type CallState,
  type CallMediaType,
} from '../utils/messengerLogic';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export interface IncomingCallPayload {
  from: string;
  callerName: string;
  mediaType: CallMediaType;
  signalData: RTCSessionDescriptionInit | null;
}

/**
 * Хук управления аудио- и видеозвонками через WebRTC и Socket.io для конечных пользователей.
 */
export function useWebRTC(
  socket: Socket | null,
  currentUserId: string,
  currentUserName: string
) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [mediaType, setMediaType] = useState<CallMediaType>('video');
  const [remotePeerId, setRemotePeerId] = useState<string>('');
  const [remotePeerName, setRemotePeerName] = useState<string>('');
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCamOff, setIsCamOff] = useState(false);
  const [callDurationSec, setCallDurationSec] = useState(0);
  const [mediaWarning, setMediaWarning] = useState<string | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const incomingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);

  // Очистка всех медиапотоков и закрытие RTCPeerConnection
  const cleanupMediaAndPeer = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((t) => t.stop());
      remoteStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setIsMicMuted(false);
    setIsCamOff(false);
    setCallDurationSec(0);
    setMediaWarning(null);
    pendingIceCandidatesRef.current = [];
    incomingOfferRef.current = null;
  }, []);

  // Запрос локальной камеры и микрофона пользователя
  const acquireMediaStream = useCallback(
    async (requestedType: CallMediaType): Promise<MediaStream | null> => {
      setMediaWarning(null);
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: requestedType === 'video' ? { width: 1280, height: 720 } : false,
          });
          return stream;
        } catch {
          if (requestedType === 'video') {
            // Пробуем подключить хотя бы микрофон, если веб-камера занята или не подключена
            try {
              const audioOnly = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false,
              });
              setMediaWarning('Камера не найдена — звонок продолжается в аудиорежиме.');
              return audioOnly;
            } catch {
              setMediaWarning('Нет доступа к микрофону и камере. Проверьте разрешения браузера.');
              return null;
            }
          }
          setMediaWarning('Нет доступа к микрофону. Проверьте разрешения браузера.');
          return null;
        }
      }
      setMediaWarning('Ваш браузер не поддерживает доступ к медиаустройствам.');
      return null;
    },
    []
  );

  // Инициализация RTCPeerConnection
  const initPeerConnection = useCallback(
    (targetUserId: string, stream: MediaStream | null) => {
      const pc = new RTCPeerConnection(RTC_CONFIG);

      if (stream) {
        stream.getTracks().forEach((track) => {
          pc.addTrack(track, stream);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('webrtc:ice-candidate', {
            to: targetUserId,
            from: currentUserId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          remoteStreamRef.current = event.streams[0];
          setRemoteStream(event.streams[0]);
        }
      };

      peerConnectionRef.current = pc;
      return pc;
    },
    [socket, currentUserId]
  );

  // 1. Начать исходящий звонок (Аудио или Видео)
  const startCall = useCallback(
    async (targetUserId: string, targetUserName: string, type: CallMediaType) => {
      cleanupMediaAndPeer();
      setMediaType(type);
      setRemotePeerId(targetUserId);
      setRemotePeerName(targetUserName);
      setCallState((prev) => transitionCallState(prev, 'START_OUTGOING'));

      const stream = await acquireMediaStream(type);
      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = initPeerConnection(targetUserId, stream);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: type === 'video',
      });
      await pc.setLocalDescription(offer);

      socket?.emit('call:user', {
        userToCall: targetUserId,
        from: currentUserId,
        callerName: currentUserName,
        mediaType: type,
        signalData: offer,
      });
    },
    [cleanupMediaAndPeer, acquireMediaStream, initPeerConnection, socket, currentUserId, currentUserName]
  );

  // 2. Принять входящий вызов
  const acceptIncomingCall = useCallback(async () => {
    const stream = await acquireMediaStream(mediaType);
    localStreamRef.current = stream;
    setLocalStream(stream);

    if (incomingOfferRef.current && socket) {
      const pc = initPeerConnection(remotePeerId, stream);
      await pc.setRemoteDescription(new RTCSessionDescription(incomingOfferRef.current));

      for (const candidate of pendingIceCandidatesRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingIceCandidatesRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('call:answer', {
        to: remotePeerId,
        from: currentUserId,
        signalData: answer,
      });
    }

    setCallState((prev) => transitionCallState(prev, 'ACCEPT'));
  }, [acquireMediaStream, mediaType, socket, initPeerConnection, remotePeerId, currentUserId]);

  // 3. Сбросить или завершить вызов
  const endCall = useCallback(() => {
    if (remotePeerId && socket) {
      socket.emit('call:end', {
        to: remotePeerId,
        from: currentUserId,
        reason: 'hangup',
      });
    }
    cleanupMediaAndPeer();
    setCallState((prev) => transitionCallState(prev, 'HANGUP'));
  }, [remotePeerId, socket, currentUserId, cleanupMediaAndPeer]);

  // Управление микрофоном во время звонка
  const toggleMic = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
    }
    setIsMicMuted((prev) => !prev);
  }, []);

  // Управление камерой во время звонка
  const toggleCamera = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
    }
    setIsCamOff((prev) => !prev);
  }, []);

  // Таймер длительности активного разговора
  useEffect(() => {
    if (callState !== 'connected') {
      setCallDurationSec(0);
      return;
    }
    const timer = window.setInterval(() => {
      setCallDurationSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callState]);

  // Подписка на события сигналинга от Socket.io
  useEffect(() => {
    if (!socket) return;

    const handleIncoming = (payload: IncomingCallPayload) => {
      incomingOfferRef.current = payload.signalData;
      setMediaType(payload.mediaType);
      setRemotePeerId(payload.from);
      setRemotePeerName(payload.callerName);
      setCallState((prev) => transitionCallState(prev, 'RECEIVE_INCOMING'));
    };

    const handleAccepted = async (payload: {
      from: string;
      signalData: RTCSessionDescriptionInit | null;
    }) => {
      if (peerConnectionRef.current && payload.signalData) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(payload.signalData)
        );
        for (const candidate of pendingIceCandidatesRef.current) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingIceCandidatesRef.current = [];
      }
      setCallState((prev) => transitionCallState(prev, 'ACCEPT'));
    };

    const handleIceCandidate = async (payload: {
      from: string;
      candidate: RTCIceCandidateInit;
    }) => {
      if (!payload.candidate) return;
      const pc = peerConnectionRef.current;
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } else {
        pendingIceCandidatesRef.current.push(payload.candidate);
      }
    };

    const handleCallEnded = () => {
      cleanupMediaAndPeer();
      setCallState((prev) => transitionCallState(prev, 'HANGUP'));
    };

    socket.on('call:incoming', handleIncoming);
    socket.on('call:accepted', handleAccepted);
    socket.on('webrtc:ice-candidate', handleIceCandidate);
    socket.on('call:ended', handleCallEnded);

    return () => {
      socket.off('call:incoming', handleIncoming);
      socket.off('call:accepted', handleAccepted);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
      socket.off('call:ended', handleCallEnded);
    };
  }, [socket, cleanupMediaAndPeer]);

  return {
    callState,
    mediaType,
    remotePeerId,
    remotePeerName,
    localStream,
    remoteStream,
    isMicMuted,
    isCamOff,
    callDurationSec,
    mediaWarning,
    startCall,
    acceptIncomingCall,
    endCall,
    toggleMic,
    toggleCamera,
  };
}
