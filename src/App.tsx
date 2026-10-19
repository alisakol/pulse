/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  LogOut,
  User,
  Check,
  Send,
  Camera,
  Trash2,
  Bell,
  BellOff,
  KeyRound,
  Database,
  HardDrive,
  Smartphone,
  ShieldCheck,
  HelpCircle,
} from 'lucide-react';
import { MessengerWorkspace } from './components/MessengerWorkspace';
import { CallModal } from './components/CallModal';
import { AuthScreen, type SavedSessionEntry } from './components/AuthModal';
import { UserAvatar, processAvatarImageFile } from './components/UserAvatar';
import { StorageOverviewModal } from './components/StorageOverviewModal';
import {
  NotificationCenter,
  playMessageNotificationSound,
  playIncomingCallRingtonePulse,
  triggerBrowserNotification,
  type AppNotificationItem,
} from './components/NotificationCenter';
import { useWebRTC } from './hooks/useWebRTC';
import type { RecordedMediaPayload } from './components/MediaMessages';
import type { RoomAdminUpdatePayload } from './components/RoomModals';
import {
  appendMessageIdempotent,
  computeUpdatedUnreadCount,
  buildNotificationPayload,
  validatePasswordReset,
  formatMessagePreview,
  normalizeMediaDataUrl,
  isRoomId,
  getMessageTargetId,
  canUserAccessRoom,
  roomToContactProfile,
  applyReadReceiptToMessages,
  getConversationId,
  type UserProfile,
  type ChatMessage,
  type ChatRoom,
  type DeviceSessionInfo,
} from './utils/messengerLogic';
import {
  saveRoomToFirestore,
  subscribeToRooms,
  saveMessageToFirestore,
  subscribeToConversationMessages,
  updateUserProfileInFirestore,
  auth,
} from './firebase';
import { signOut } from 'firebase/auth';

const TOKEN_STORAGE_KEY = 'pulse_jwt_token';
const USER_STORAGE_KEY = 'pulse_current_user';
const SAVED_SESSIONS_KEY = 'pulse_saved_accounts';
const MESSAGES_BACKUP_KEY = 'pulse_messages_backup';
const ROOMS_BACKUP_KEY = 'pulse_rooms_backup';
const SOUND_NOTIF_STORAGE_KEY = 'pulse_sound_notifications';

const TELEGRAM_AVATAR_COLORS = [
  '#5288C1',
  '#3E9F65',
  '#D97724',
  '#8E57C2',
  '#D84B6B',
  '#2F9FA8',
];

function loadRoomsBackup(): ChatRoom[] {
  try {
    const raw = localStorage.getItem(ROOMS_BACKUP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatRoom[];
    return Array.isArray(parsed)
      ? parsed.filter((r) => r && r.id && r.title && (r.type === 'group' || r.type === 'channel'))
      : [];
  } catch {
    return [];
  }
}

function saveRoomsToBackup(list: ChatRoom[]) {
  try {
    localStorage.setItem(ROOMS_BACKUP_KEY, JSON.stringify(list));
  } catch {
    // ignore quota error
  }
}

function loadMessagesBackup(): Record<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(MESSAGES_BACKUP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ChatMessage[]>;
    const cleaned: Record<string, ChatMessage[]> = {};
    for (const [key, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      cleaned[key] = list.filter((m) => {
        if (!m || !m.id) return false;
        if (m.attachmentType === 'video_note' || m.attachmentType === 'voice') {
          return Boolean(m.mediaUrl && m.mediaUrl.length >= 150);
        }
        return Boolean(m.text && m.text.trim());
      });
    }
    return cleaned;
  } catch {
    return {};
  }
}

function saveMessagesToBackup(convKey: string, list: ChatMessage[]) {
  const validList = list.filter((m) => {
    if (!m || !m.id) return false;
    if (m.attachmentType === 'video_note' || m.attachmentType === 'voice') {
      return Boolean(m.mediaUrl && m.mediaUrl.length >= 150);
    }
    return Boolean(m.text && m.text.trim());
  });
  const current = loadMessagesBackup();
  for (const limit of [30, 12, 5, 2]) {
    try {
      current[convKey] = validList.slice(-limit);
      localStorage.setItem(MESSAGES_BACKUP_KEY, JSON.stringify(current));
      return;
    } catch {
      // Пробуем меньшее окно последних сообщений при нехватке квоты localStorage
    }
  }
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem(USER_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as UserProfile) : null;
    } catch {
      return null;
    }
  });

  const [token, setToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const [savedSessions, setSavedSessions] = useState<SavedSessionEntry[]>(() => {
    try {
      const raw = localStorage.getItem(SAVED_SESSIONS_KEY);
      return raw ? (JSON.parse(raw) as SavedSessionEntry[]) : [];
    } catch {
      return [];
    }
  });

  const [activeNav, setActiveNav] = useState<'chats' | 'contacts' | 'profile'>('chats');
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [allRooms, setAllRooms] = useState<ChatRoom[]>(() => loadRoomsBackup());
  const [summaries, setSummaries] = useState<
    Record<string, { lastMessage: ChatMessage; unreadCount: number }>
  >({});
  const [selectedContact, setSelectedContact] = useState<UserProfile | null>(null);
  // Управление полноэкранным открытием чата на мобильных устройствах
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Настройки уведомлений и список всплывающих уведомлений
  const [soundNotificationsEnabled, setSoundNotificationsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SOUND_NOTIF_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [browserNotifPermission, setBrowserNotifPermission] = useState<string>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission;
    }
    return 'default';
  });
  const [notifications, setNotifications] = useState<AppNotificationItem[]>([]);

  // Поля редактирования профиля
  const [profileName, setProfileName] = useState(() => currentUser?.displayName || '');
  const [profileBio, setProfileBio] = useState(() => currentUser?.role || '');
  const [profileColor, setProfileColor] = useState(() => currentUser?.avatarColor || '#5288C1');
  const [profileAvatarUrl, setProfileAvatarUrl] = useState(
    () => currentUser?.avatarUrl || ''
  );
  const [profileError, setProfileError] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);
  const profileAvatarInputRef = useRef<HTMLInputElement | null>(null);

  // Поля сброса / смены пароля в настройках
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');
  const [passwordResetError, setPasswordResetError] = useState('');
  const [passwordResetSuccess, setPasswordResetSuccess] = useState('');

  // Облачное хранилище и активные сессии устройств
  const [isStorageModalOpen, setIsStorageModalOpen] = useState(false);
  const [deviceSessions, setDeviceSessions] = useState<DeviceSessionInfo[]>([]);
  const [logoutOthersMsg, setLogoutOthersMsg] = useState('');

  // Состояние Socket.io
  const [socket, setSocket] = useState<Socket | null>(null);
  const [typingUserIds, setTypingUserIds] = useState<Set<string>>(new Set());

  const combinedContacts = React.useMemo(() => {
    const roomProfiles = allRooms.map(roomToContactProfile);
    return [...allUsers, ...roomProfiles];
  }, [allUsers, allRooms]);

  const selectedContactRef = useRef<UserProfile | null>(null);
  selectedContactRef.current = selectedContact;
  const activeNavRef = useRef(activeNav);
  activeNavRef.current = activeNav;
  const mobileChatOpenRef = useRef(mobileChatOpen);
  mobileChatOpenRef.current = mobileChatOpen;
  const allUsersRef = useRef<UserProfile[]>(allUsers);
  allUsersRef.current = allUsers;
  const allRoomsRef = useRef<ChatRoom[]>(allRooms);
  allRoomsRef.current = allRooms;
  const soundEnabledRef = useRef(soundNotificationsEnabled);
  soundEnabledRef.current = soundNotificationsEnabled;

  const pushAppNotification = useCallback((item: AppNotificationItem) => {
    setNotifications((prev) => [item, ...prev.filter((n) => n.id !== item.id)].slice(0, 4));
    if (item.type === 'message') {
      setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== item.id));
      }, 6000);
    }
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const toggleSoundNotifications = useCallback(() => {
    setSoundNotificationsEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SOUND_NOTIF_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const requestBrowserNotificationsPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    try {
      const perm = await Notification.requestPermission();
      setBrowserNotifPermission(perm);
    } catch {
      // ignore
    }
  }, []);

  // Сохранение или обновление аккаунта в списке быстрых входов на устройстве
  const upsertSavedSession = useCallback((user: UserProfile, jwtToken: string) => {
    setSavedSessions((prev) => {
      const filtered = prev.filter((item) => item.user.id !== user.id);
      const next: SavedSessionEntry[] = [
        { user, token: jwtToken, savedAt: new Date().toISOString() },
        ...filtered,
      ];
      try {
        localStorage.setItem(SAVED_SESSIONS_KEY, JSON.stringify(next));
      } catch {
        // ignore storage quota errors
      }
      return next;
    });
  }, []);

  const handleRemoveSavedSession = useCallback((userId: string) => {
    setSavedSessions((prev) => {
      const next = prev.filter((item) => item.user.id !== userId);
      try {
        localStorage.setItem(SAVED_SESSIONS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Загрузка списка пользователей, групп/каналов и сводки диалогов
  const fetchContactsAndSummaries = useCallback((userId: string) => {
    fetch(`/api/users?forUser=${encodeURIComponent(userId)}`)
      .then((res) => res.json())
      .then((data) => {
        const fetchedUsers: UserProfile[] = Array.isArray(data.users) ? data.users : [];
        const fetchedRooms: ChatRoom[] = Array.isArray(data.rooms)
          ? (data.rooms as ChatRoom[]).filter((r) => canUserAccessRoom(r, userId))
          : [];
        if (Array.isArray(data.users)) {
          setAllUsers(fetchedUsers);
        }
        if (Array.isArray(data.rooms)) {
          setAllRooms(fetchedRooms);
          saveRoomsToBackup(fetchedRooms);
        }
        const roomProfiles = fetchedRooms.map(roomToContactProfile);
        const allEntities = [...fetchedUsers, ...roomProfiles];
        const fetchedSummaries = data.summaries || {};

        setSelectedContact((prev) => {
          if (prev) {
            if (isRoomId(prev.id)) {
              return roomProfiles.find((r) => r.id === prev.id) || null;
            }
            return allEntities.find((u) => u.id === prev.id) || prev;
          }
          // Автоматически выбираем только уже начатый диалог или группу/канал, куда пользователь приглашен
          if (roomProfiles.length > 0) {
            return roomProfiles[0];
          }
          const activePeer = fetchedUsers.find(
            (u) => u.id !== userId && Boolean(fetchedSummaries[u.id]?.lastMessage)
          );
          return activePeer || null;
        });

        if (data.summaries) {
          setSummaries((prev) => {
            const merged = { ...data.summaries };
            for (const [peerId, item] of Object.entries(prev)) {
              if (merged[peerId]) {
                merged[peerId] = {
                  ...merged[peerId],
                  unreadCount: item.unreadCount || 0,
                };
              }
            }
            return merged;
          });
        }
      })
      .catch((err) => console.error('Ошибка загрузки контактов:', err));
  }, []);

  // Автоматическая синхронизация и восстановление аккаунта после публикации новой версии приложения
  useEffect(() => {
    const entriesToSync: Array<{ token: string; user: UserProfile }> = [...savedSessions];
    if (token && currentUser && !entriesToSync.some((e) => e.user.id === currentUser.id)) {
      entriesToSync.unshift({ token, user: currentUser });
    }

    const roomsBackup = loadRoomsBackup();

    if (entriesToSync.length > 0 || roomsBackup.length > 0) {
      fetch('/api/auth/sync-vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: entriesToSync,
          roomsBackup,
          messagesBackup: loadMessagesBackup(),
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data.users)) {
            setAllUsers(data.users);
          }
          if (Array.isArray(data.rooms)) {
            const visible = currentUser
              ? (data.rooms as ChatRoom[]).filter((r) => canUserAccessRoom(r, currentUser.id))
              : [];
            setAllRooms(visible);
            saveRoomsToBackup(visible);
          }
        })
        .catch(() => {
          // ignore network error
        });
    }

    if (!token) return;

    fetch('/api/auth/me', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        token,
        user: currentUser,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Session check failed');
        return res.json();
      })
      .then((data) => {
        if (data.user) {
          const nextToken = data.token || token;
          setCurrentUser(data.user);
          setProfileName(data.user.displayName);
          setProfileBio(data.user.role);
          setProfileColor(data.user.avatarColor || '#5288C1');
          setProfileAvatarUrl(data.user.avatarUrl || '');
          localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
          localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
          if (nextToken !== token) {
            setToken(nextToken);
          }
          upsertSavedSession(data.user, nextToken);
        }
      })
      .catch(() => {
        // Не удаляем сохраненную сессию при перезапуске контейнера или публикации новой версии!
      });
  }, [token, upsertSavedSession]);

  // Подключение к серверу Socket.io для авторизованного пользователя
  useEffect(() => {
    if (!currentUser) return;

    const newSocket = io({
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
    });

    newSocket.on('connect', () => {
      newSocket.emit('user:online', {
        userId: currentUser.id,
        token: token || undefined,
        user: currentUser,
      });
    });

    newSocket.on('users:update', (updatedUsers: UserProfile[]) => {
      setAllUsers(updatedUsers);
      setSelectedContact((prev) => {
        if (!prev) return null;
        if (isRoomId(prev.id)) return prev;
        return updatedUsers.find((u) => u.id === prev.id) || prev;
      });
    });

    newSocket.on('rooms:update', (updatedRooms: ChatRoom[]) => {
      const visible = updatedRooms.filter((r) => canUserAccessRoom(r, currentUser.id));
      setAllRooms(visible);
      saveRoomsToBackup(visible);
      setSelectedContact((prev) => {
        if (!prev || !isRoomId(prev.id)) return prev;
        const matchingRoom = visible.find((r) => r.id === prev.id);
        return matchingRoom ? roomToContactProfile(matchingRoom) : null;
      });
    });

    newSocket.on('message:receive', (incoming: ChatMessage) => {
      const isFromOtherUser = incoming.senderId !== currentUser.id;
      const peerId = getMessageTargetId(incoming, currentUser.id);
      const activePeer = selectedContactRef.current;

      const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 1024;
      const isChatCurrentlyOpen =
        activeNavRef.current !== 'profile' &&
        activePeer?.id === peerId &&
        (isDesktop || mobileChatOpenRef.current);

      setSummaries((prev) => {
        const prevEntry = prev[peerId];
        if (prevEntry?.lastMessage?.id === incoming.id) {
          return prev;
        }
        const prevUnread = prevEntry?.unreadCount || 0;
        return {
          ...prev,
          [peerId]: {
            lastMessage: incoming,
            unreadCount: computeUpdatedUnreadCount(
              prevUnread,
              isFromOtherUser,
              Boolean(isChatCurrentlyOpen)
            ),
          },
        };
      });

      if (activePeer && activePeer.id === peerId) {
        setMessages((prev) => {
          const next = appendMessageIdempotent(prev, incoming);
          saveMessagesToBackup(
            isRoomId(peerId) ? peerId : `${currentUser.id}_${activePeer.id}`,
            next
          );
          return next;
        });

        if (isFromOtherUser && isChatCurrentlyOpen) {
          newSocket.emit('messages:read', {
            readerId: currentUser.id,
            peerId,
          });
        }
      }

      // Уведомление о новом входящем сообщении
      if (isFromOtherUser) {
        const senderProfile = allUsersRef.current.find((u) => u.id === incoming.senderId);
        const roomTarget = isRoomId(peerId)
          ? allRoomsRef.current.find((r) => r.id === peerId)
          : undefined;
        const rawSenderName =
          incoming.senderName || senderProfile?.displayName || 'Собеседник';
        const displayTitleSource = roomTarget
          ? roomTarget.type === 'channel'
            ? roomTarget.title
            : `${rawSenderName} (${roomTarget.title})`
          : rawSenderName;

        const notifPayload = buildNotificationPayload(
          'message',
          displayTitleSource,
          formatMessagePreview(incoming)
        );

        if (soundEnabledRef.current) {
          playMessageNotificationSound();
        }
        triggerBrowserNotification(notifPayload.title, notifPayload.body, `msg_${incoming.id}`);

        pushAppNotification({
          id: `notif_msg_${incoming.id}`,
          type: 'message',
          senderId: peerId,
          senderName: displayTitleSource,
          senderAvatarColor: roomTarget?.avatarColor || senderProfile?.avatarColor,
          senderAvatarUrl: roomTarget?.avatarUrl || senderProfile?.avatarUrl,
          title: notifPayload.title,
          body: notifPayload.body,
          createdAt: incoming.createdAt,
        });
      }
    });

    newSocket.on(
      'messages:read',
      (payload: {
        conversationId: string;
        readerId: string;
        peerId?: string;
        messageIds: string[];
      }) => {
        if (!payload || !Array.isArray(payload.messageIds)) return;
        const readSet = new Set(payload.messageIds);

        setMessages((prev) => {
          const updated = applyReadReceiptToMessages(
            prev,
            payload.messageIds,
            payload.conversationId
          );
          const activePeer = selectedContactRef.current;
          if (activePeer) {
            saveMessagesToBackup(
              isRoomId(activePeer.id) ? activePeer.id : `${currentUser.id}_${activePeer.id}`,
              updated
            );
          }
          return updated;
        });

        setSummaries((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [contactId, summary] of Object.entries(next)) {
            const last = summary?.lastMessage;
            if (
              last &&
              last.status !== 'read' &&
              (readSet.has(last.id) ||
                (last.conversationId === payload.conversationId &&
                  last.senderId === currentUser.id))
            ) {
              next[contactId] = {
                ...summary,
                lastMessage: {
                  ...last,
                  status: 'read',
                },
              };
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    );

    newSocket.on(
      'call:incoming',
      (payload: { from: string; callerName: string; mediaType: 'audio' | 'video' }) => {
        const callerProfile = allUsersRef.current.find((u) => u.id === payload.from);
        const callerName = payload.callerName || callerProfile?.displayName || 'Собеседник';
        const notifPayload = buildNotificationPayload('call', callerName, payload.mediaType);

        triggerBrowserNotification(notifPayload.title, notifPayload.body, `call_${payload.from}`);

        pushAppNotification({
          id: `notif_call_${payload.from}`,
          type: 'call',
          senderId: payload.from,
          senderName: callerName,
          senderAvatarColor: callerProfile?.avatarColor,
          senderAvatarUrl: callerProfile?.avatarUrl,
          title: notifPayload.title,
          body: notifPayload.body,
          mediaType: payload.mediaType,
          createdAt: new Date().toISOString(),
        });
      }
    );

    newSocket.on('typing:status', ({ userId, isTyping }: { userId: string; isTyping: boolean }) => {
      setTypingUserIds((prev) => {
        const next = new Set(prev);
        if (isTyping) next.add(userId);
        else next.delete(userId);
        return next;
      });
    });

    // Мгновенная синхронизация обновлений профиля между всеми устройствами пользователя
    newSocket.on('user:profile-updated', (updatedUser: UserProfile) => {
      if (updatedUser && updatedUser.id === currentUser.id) {
        setCurrentUser(updatedUser);
        setProfileName(updatedUser.displayName);
        setProfileBio(updatedUser.role);
        setProfileColor(updatedUser.avatarColor || '#5288C1');
        setProfileAvatarUrl(updatedUser.avatarUrl || '');
        try {
          localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updatedUser));
        } catch {
          // ignore
        }
      }
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [currentUser?.id, token, pushAppNotification]);

  // Синхронизация комнат из Google Cloud Firebase Firestore в реальном времени
  useEffect(() => {
    if (!currentUser) return;
    const unsubscribe = subscribeToRooms((firestoreRooms) => {
      if (Array.isArray(firestoreRooms) && firestoreRooms.length > 0) {
        setAllRooms((prev) => {
          const map = new Map<string, ChatRoom>();
          prev.forEach((r) => map.set(r.id, r));
          firestoreRooms.forEach((r) => map.set(r.id, r));
          const merged = Array.from(map.values()).filter((r) =>
            canUserAccessRoom(r, currentUser.id)
          );
          saveRoomsToBackup(merged);
          return merged;
        });
      }
    });
    return () => unsubscribe();
  }, [currentUser?.id]);

  // Синхронизация сообщений открытого диалога из Cloud Firestore в реальном времени
  useEffect(() => {
    if (!currentUser || !selectedContact) return;
    const conversationId = getConversationId(currentUser.id, selectedContact.id);
    const unsubscribe = subscribeToConversationMessages(conversationId, (firestoreMsgs) => {
      if (Array.isArray(firestoreMsgs) && firestoreMsgs.length > 0) {
        setMessages((prev) => {
          let updated = [...prev];
          for (const msg of firestoreMsgs) {
            updated = appendMessageIdempotent(updated, msg);
          }
          const backupKey = isRoomId(selectedContact.id)
            ? selectedContact.id
            : `${currentUser.id}_${selectedContact.id}`;
          saveMessagesToBackup(backupKey, updated);
          return updated;
        });
      }
    });
    return () => unsubscribe();
  }, [currentUser?.id, selectedContact?.id]);

  const fetchDeviceSessions = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/auth/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.sessions)) {
          setDeviceSessions(data.sessions);
        }
      }
    } catch {
      // ignore
    }
  }, [token]);

  useEffect(() => {
    if (activeNav === 'profile' && token) {
      fetchDeviceSessions();
    }
  }, [activeNav, token, fetchDeviceSessions]);

  const handleLogoutOtherDevices = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/auth/logout-other-devices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setLogoutOthersMsg('Все остальные сессии успешно завершены');
        fetchDeviceSessions();
        setTimeout(() => setLogoutOthersMsg(''), 4000);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    fetchContactsAndSummaries(currentUser.id);
  }, [currentUser?.id, fetchContactsAndSummaries]);

  // Загрузка истории сообщений при выборе собеседника/группы/канала и сброс счетчика непрочитанных
  useEffect(() => {
    if (!currentUser || !selectedContact) return;

    setSummaries((prev) => {
      if (!prev[selectedContact.id] || prev[selectedContact.id].unreadCount === 0) {
        return prev;
      }
      return {
        ...prev,
        [selectedContact.id]: {
          ...prev[selectedContact.id],
          unreadCount: 0,
        },
      };
    });

    if (socket) {
      socket.emit('conversation:join', {
        userA: currentUser.id,
        userB: selectedContact.id,
      });
      socket.emit('messages:read', {
        readerId: currentUser.id,
        peerId: selectedContact.id,
      });
    }

    fetch(`/api/messages/${currentUser.id}/${selectedContact.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.messages)) {
          setMessages(data.messages);
        }
      })
      .catch((err) => console.error('Ошибка загрузки истории чата:', err));
  }, [selectedContact?.id, currentUser?.id, socket]);

  // Хук аудио- и видеозвонков WebRTC
  const {
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
  } = useWebRTC(socket, currentUser?.id || '', currentUser?.displayName || '');

  // Мелодия входящего вызова и очистка уведомления о звонке после ответа/сброса
  useEffect(() => {
    if (callState !== 'ringing') {
      setNotifications((prev) => prev.filter((n) => n.type !== 'call'));
      return;
    }

    if (soundNotificationsEnabled) {
      playIncomingCallRingtonePulse();
    }
    const interval = window.setInterval(() => {
      if (soundEnabledRef.current) {
        playIncomingCallRingtonePulse();
      }
    }, 1500);

    return () => window.clearInterval(interval);
  }, [callState, soundNotificationsEnabled]);

  // Обновление заголовка вкладки браузера при непрочитанных сообщениях или входящем звонке
  const totalUnreadCount = Object.values(summaries).reduce(
    (acc, item) => acc + (item.unreadCount || 0),
    0
  );

  useEffect(() => {
    if (callState === 'ringing') {
      document.title = `📞 Входящий звонок от ${remotePeerName || 'собеседника'} — Pulse`;
    } else if (totalUnreadCount > 0) {
      document.title = `(${totalUnreadCount}) Новое сообщение — Pulse`;
    } else {
      document.title = 'Pulse — Облачный мессенджер и видеозвонки';
    }
  }, [callState, remotePeerName, totalUnreadCount]);

  // Переход по клику на всплывающее уведомление
  const handleSelectNotification = useCallback(
    (item: AppNotificationItem) => {
      dismissNotification(item.id);
      if (item.type === 'call') {
        if (callState === 'ringing') {
          acceptIncomingCall();
        }
        return;
      }
      const targetEntity = combinedContacts.find((u) => u.id === item.senderId);
      if (targetEntity) {
        setSelectedContact(targetEntity);
        setActiveNav('chats');
        setMobileChatOpen(true);
        setSummaries((prev) =>
          prev[targetEntity.id]
            ? { ...prev, [targetEntity.id]: { ...prev[targetEntity.id], unreadCount: 0 } }
            : prev
        );
      }
    },
    [combinedContacts, callState, acceptIncomingCall, dismissNotification]
  );

  // Сброс / смена пароля из настроек профиля
  const handleProfilePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setPasswordResetError('');
    setPasswordResetSuccess('');

    const validation = validatePasswordReset(
      currentUser.username,
      newPasswordInput,
      confirmPasswordInput
    );
    if (!validation.valid) {
      setPasswordResetError(validation.error || 'Проверьте новый пароль');
      return;
    }

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser.username,
          newPassword: newPasswordInput,
          confirmPassword: confirmPasswordInput,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPasswordResetError(data.error || 'Не удалось обновить пароль');
        return;
      }
      if (data.token && data.user) {
        setToken(data.token);
        localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
        upsertSavedSession(data.user, data.token);
      }
      setNewPasswordInput('');
      setConfirmPasswordInput('');
      setPasswordResetSuccess('Новый пароль успешно сохранен');
      setTimeout(() => setPasswordResetSuccess(''), 3000);
    } catch {
      setPasswordResetError('Ошибка соединения при смене пароля');
    }
  };

  // Создание нового группового чата или канала
  const handleCreateRoom = useCallback(
    async (payload: {
      type: 'group' | 'channel';
      title: string;
      handle: string;
      description: string;
      avatarColor: string;
      avatarUrl?: string;
      memberIds: string[];
      isPublic: boolean;
    }): Promise<{ ok: boolean; error?: string }> => {
      if (!currentUser) return { ok: false, error: 'Необходима авторизация' };
      try {
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            ownerId: currentUser.id,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.room) {
          return { ok: false, error: data.error || 'Не удалось создать группу или канал' };
        }
        const createdRoom = data.room as ChatRoom;
        saveRoomToFirestore(createdRoom).catch(() => {});
        setAllRooms((prev) => {
          const next = [createdRoom, ...prev.filter((r) => r.id !== createdRoom.id)];
          saveRoomsToBackup(next);
          return next;
        });
        const contactProfile = roomToContactProfile(createdRoom);
        setSelectedContact(contactProfile);
        setMessages([]);
        setActiveNav('chats');
        setMobileChatOpen(true);
        return { ok: true };
      } catch {
        return { ok: false, error: 'Ошибка соединения с сервером' };
      }
    },
    [currentUser]
  );

  // Вступление / подписка или выход из группового чата / канала
  const handleJoinOrLeaveRoom = useCallback(
    async (roomId: string, action: 'join' | 'leave') => {
      if (!currentUser) return;
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUser.id, action }),
        });
        const data = await res.json();
        if (res.ok && data.room) {
          const updated = data.room as ChatRoom;
          setAllRooms((prev) => {
            const next = prev.map((r) => (r.id === updated.id ? updated : r));
            saveRoomsToBackup(next);
            return next;
          });
          setSelectedContact((prev) =>
            prev?.id === updated.id ? roomToContactProfile(updated) : prev
          );
        }
      } catch {
        // ignore network error
      }
    },
    [currentUser]
  );

  // Обновление списка участников группы или канала
  const handleUpdateRoomMembers = useCallback(
    async (roomId: string, memberIds: string[]) => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: currentUser?.id,
            memberIds,
          }),
        });
        const data = await res.json();
        if (res.ok && data.room) {
          const updated = data.room as ChatRoom;
          setAllRooms((prev) => {
            const next = prev.map((r) => (r.id === updated.id ? updated : r));
            saveRoomsToBackup(next);
            return next;
          });
          setSelectedContact((prev) =>
            prev?.id === updated.id ? roomToContactProfile(updated) : prev
          );
        }
      } catch {
        // ignore network error
      }
    },
    [currentUser?.id]
  );

  // Администрирование группы или канала (аватар, название, описание, участники, права администраторов)
  const handleUpdateRoom = useCallback(
    async (
      roomId: string,
      updates: RoomAdminUpdatePayload
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!currentUser) return { ok: false, error: 'Необходима авторизация' };
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: currentUser.id,
            ...updates,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.room) {
          return { ok: false, error: data.error || 'Не удалось обновить настройки' };
        }
        const updated = data.room as ChatRoom;
        saveRoomToFirestore(updated).catch(() => {});
        setAllRooms((prev) => {
          const next = prev.map((r) => (r.id === updated.id ? updated : r));
          saveRoomsToBackup(next);
          return next;
        });
        setSelectedContact((prev) =>
          prev?.id === updated.id ? roomToContactProfile(updated) : prev
        );
        return { ok: true };
      } catch {
        return { ok: false, error: 'Ошибка соединения с сервером' };
      }
    },
    [currentUser]
  );

  // Удаление группы или канала создателем
  const handleDeleteRoom = useCallback(
    async (roomId: string) => {
      if (!currentUser) return;
      try {
        const res = await fetch(
          `/api/rooms/${encodeURIComponent(roomId)}?userId=${encodeURIComponent(currentUser.id)}`,
          { method: 'DELETE' }
        );
        if (res.ok) {
          setAllRooms((prev) => {
            const next = prev.filter((r) => r.id !== roomId);
            saveRoomsToBackup(next);
            return next;
          });
          setSelectedContact((prev) => (prev?.id === roomId ? null : prev));
          setMobileChatOpen(false);
        }
      } catch {
        // ignore network error
      }
    },
    [currentUser]
  );

  // Отправка текстового сообщения, голосового сообщения или видеокружка
  const handleSendMessage = useCallback(
    (text: string, media?: RecordedMediaPayload) => {
      if (!currentUser || !selectedContact) return;

      const sanitizedMediaUrl = media?.mediaUrl
        ? normalizeMediaDataUrl(media.mediaUrl, media.attachmentType) || media.mediaUrl
        : undefined;

      const fallbackText = media
        ? formatMessagePreview({
            text: text.trim(),
            attachmentType: media.attachmentType,
            mediaDuration: media.mediaDuration,
          })
        : text.trim();

      if (!fallbackText && !media) return;

      const peerId = selectedContact.id;
      const backupKey = isRoomId(peerId) ? peerId : `${currentUser.id}_${peerId}`;

      const optimisticMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        conversationId: getConversationId(currentUser.id, peerId),
        senderId: currentUser.id,
        senderName: currentUser.displayName,
        senderAvatarColor: currentUser.avatarColor,
        senderAvatarUrl: currentUser.avatarUrl,
        recipientId: peerId,
        text: text.trim() || fallbackText,
        createdAt: new Date().toISOString(),
        status: 'sent',
        attachmentType: media?.attachmentType || 'text',
        mediaUrl: sanitizedMediaUrl,
        mediaDuration: media?.mediaDuration,
        waveform: media?.waveform,
      };

      setMessages((prev) => {
        const next = appendMessageIdempotent(prev, optimisticMsg);
        saveMessagesToBackup(backupKey, next);
        return next;
      });
      setSummaries((prev) => ({
        ...prev,
        [peerId]: {
          lastMessage: optimisticMsg,
          unreadCount: 0,
        },
      }));

      // Сохраняем в Google Cloud Firebase Firestore для глобальной синхронизации
      saveMessageToFirestore(optimisticMsg).catch(() => {});

      const wirePayload = {
        id: optimisticMsg.id,
        senderId: currentUser.id,
        recipientId: peerId,
        text: optimisticMsg.text,
        attachmentType: optimisticMsg.attachmentType,
        mediaUrl: optimisticMsg.mediaUrl,
        mediaDuration: optimisticMsg.mediaDuration,
        waveform: optimisticMsg.waveform,
      };

      // 1. Отправка по HTTP POST /api/messages гарантирует доставку даже тяжелых видеокружков (до 25 МБ)
      fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wirePayload),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data?.message) {
            setMessages((prev) => {
              const next = appendMessageIdempotent(prev, data.message as ChatMessage);
              saveMessagesToBackup(backupKey, next);
              return next;
            });
          }
        })
        .catch(() => {
          // Если HTTP временно недоступен, дублируем через Socket.io ниже
        });

      // 2. Дублирование через Socket.io (сервер идемпотентно проверяет msg.id)
      if (socket) {
        socket.emit('message:send', wirePayload);
      }
    },
    [currentUser, selectedContact, socket]
  );

  // Статус набора текста
  const handleTypingChange = useCallback(
    (isTyping: boolean) => {
      if (!currentUser || !selectedContact || !socket) return;
      socket.emit(isTyping ? 'typing:start' : 'typing:stop', {
        senderId: currentUser.id,
        recipientId: selectedContact.id,
      });
    },
    [currentUser, selectedContact, socket]
  );

  // Успешный вход или регистрация
  const handleAuthSuccess = (
    user: UserProfile,
    jwtToken: string,
    rememberSession: boolean
  ) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, jwtToken);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    if (rememberSession) {
      upsertSavedSession(user, jwtToken);
    }
    setToken(jwtToken);
    setCurrentUser(user);
    setProfileName(user.displayName);
    setProfileBio(user.role);
    setProfileColor(user.avatarColor || '#5288C1');
    setProfileAvatarUrl(user.avatarUrl || '');
  };

  // Выход из аккаунта
  const handleLogout = () => {
    if (socket) {
      socket.disconnect();
    }
    signOut(auth).catch(() => {});
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    setToken(null);
    setCurrentUser(null);
    setSelectedContact(null);
    setMobileChatOpen(false);
    setMessages([]);
  };

  // Вспомогательная функция сохранения профиля на сервере и в локальном хранилище
  const persistProfileChanges = async (
    nextName: string,
    nextBio: string,
    nextColor: string,
    nextAvatarUrl: string
  ) => {
    if (!token || !nextName.trim()) return;
    setProfileError('');
    try {
      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          displayName: nextName,
          bio: nextBio,
          avatarColor: nextColor,
          avatarUrl: nextAvatarUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setProfileError(data.error || 'Не удалось сохранить изменения профиля');
        return;
      }
      if (data.user) {
        const nextToken = data.token || token;
        setCurrentUser(data.user);
        setToken(nextToken);
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
        localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
        upsertSavedSession(data.user, nextToken);
        updateUserProfileInFirestore(data.user.id, {
          displayName: nextName,
          role: nextBio,
          avatarColor: nextColor,
          avatarUrl: nextAvatarUrl,
        }).catch(() => {});
        setProfileSaved(true);
        setTimeout(() => setProfileSaved(false), 2000);
      }
    } catch (err) {
      console.error('Ошибка обновления профиля:', err);
      setProfileError('Ошибка соединения при сохранении профиля');
    }
  };

  // Сохранение изменений профиля по кнопке
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    await persistProfileChanges(profileName, profileBio, profileColor, profileAvatarUrl);
  };

  // Загрузка нового фото аватара в настройках профиля (с мгновенным сохранением)
  const handleProfileAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProfileError('');
    const result = await processAvatarImageFile(file);
    if (result.error) {
      setProfileError(result.error);
      return;
    }
    if (result.dataUrl) {
      setProfileAvatarUrl(result.dataUrl);
      await persistProfileChanges(
        profileName || currentUser?.displayName || '',
        profileBio,
        profileColor,
        result.dataUrl
      );
    }
  };

  // Удаление фото аватара (возврат к инициалам на цветном фоне)
  const handleRemoveProfileAvatar = async () => {
    setProfileAvatarUrl('');
    await persistProfileChanges(
      profileName || currentUser?.displayName || '',
      profileBio,
      profileColor,
      ''
    );
  };

  if (!currentUser) {
    return (
      <AuthScreen
        savedSessions={savedSessions}
        onAuthSuccess={handleAuthSuccess}
        onRemoveSavedSession={handleRemoveSavedSession}
      />
    );
  }

  // На мобильном экране при открытом диалоге верхняя панель навигации уступает место шапке чата (как в мобильном Telegram)
  const isMobileConversationActive = activeNav !== 'profile' && mobileChatOpen && Boolean(selectedContact);

  return (
    <div className="min-h-screen flex flex-col bg-[#0E1621] text-[#F5F5F5]">
      {/* Top Bar Contract в цветах Telegram (#17212B) */}
      <header
        className={`${
          isMobileConversationActive ? 'hidden lg:flex' : 'flex'
        } items-center justify-between gap-2 sm:gap-8 px-3 sm:px-6 h-14 border-b border-[#101921] bg-[#17212B] shrink-0`}
      >
        <a
          href="#chats"
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('chats');
            setMobileChatOpen(false);
          }}
          className="inline-flex items-center gap-1.5 sm:gap-2 text-sm sm:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          <Send className="w-4 h-4 text-[#64B5EF]" />
          <span>Pulse</span>
        </a>

        <nav className="flex items-center gap-3 sm:gap-6 text-xs sm:text-sm font-medium text-[#7F91A4]">
          <a
            href="#chats"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('chats');
              setMobileChatOpen(false);
            }}
            className={`inline-flex items-center gap-1 hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'chats'
                ? 'text-[#64B5EF] underline underline-offset-8 decoration-[#5288C1]'
                : ''
            }`}
          >
            <span>Чаты</span>
            {totalUnreadCount > 0 && (
              <span
                aria-label={`Непрочитанных сообщений: ${totalUnreadCount}`}
                className="min-w-4.5 h-4.5 px-1.5 rounded-full bg-[#5288C1] text-white text-[10px] font-bold font-mono tabular-nums inline-flex items-center justify-center"
              >
                {totalUnreadCount}
              </span>
            )}
          </a>
          <a
            href="#contacts"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('contacts');
              setMobileChatOpen(false);
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'contacts'
                ? 'text-[#64B5EF] underline underline-offset-8 decoration-[#5288C1]'
                : ''
            }`}
          >
            Контакты
          </a>
          <a
            href="#profile"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('profile');
              setMobileChatOpen(false);
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'profile'
                ? 'text-[#64B5EF] underline underline-offset-8 decoration-[#5288C1]'
                : ''
            }`}
          >
            Настройки
          </a>
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleSoundNotifications}
            aria-label={
              soundNotificationsEnabled
                ? 'Выключить звук уведомлений'
                : 'Включить звук уведомлений'
            }
            title={
              soundNotificationsEnabled
                ? 'Звуковые уведомления о сообщениях и звонках включены'
                : 'Звуковые уведомления выключены'
            }
            className="w-8 h-8 flex items-center justify-center rounded-full bg-[#242F3D] hover:bg-[#2C394A] text-[#64B5EF] transition-colors cursor-pointer shrink-0"
          >
            {soundNotificationsEnabled ? (
              <Bell className="w-4 h-4" />
            ) : (
              <BellOff className="w-4 h-4 text-[#7F91A4]" />
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveNav('profile');
              setMobileChatOpen(false);
            }}
            aria-label="Открыть профиль"
            title={`${currentUser.displayName} (@${currentUser.username})`}
            className="rounded-full focus:outline-none focus:ring-2 focus:ring-[#64B5EF] cursor-pointer shrink-0"
          >
            <UserAvatar
              displayName={currentUser.displayName}
              avatarColor={currentUser.avatarColor}
              avatarUrl={currentUser.avatarUrl}
              sizeClass="w-8 h-8"
              textClass="text-xs"
            />
          </button>

          <button
            type="button"
            onClick={handleLogout}
            aria-label="Выйти из аккаунта"
            title="Выйти из аккаунта"
            className="flex items-center justify-center gap-1.5 w-8 h-8 sm:w-auto sm:h-auto sm:px-3.5 sm:py-1.5 text-xs font-medium text-[#F5F5F5] bg-[#242F3D] hover:bg-[#2C394A] rounded-full sm:rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5 text-[#64B5EF]" />
            <span className="hidden sm:inline">Выйти</span>
          </button>
        </div>
      </header>

      {/* Всплывающие уведомления о новых сообщениях и входящих звонках */}
      <NotificationCenter
        notifications={notifications}
        onSelectNotification={handleSelectNotification}
        onDismissNotification={dismissNotification}
      />

      {/* Основная рабочая область (на мобильных без лишних отступов вокруг чата) */}
      <main className="flex-1 max-w-7xl w-full mx-auto lg:px-6 lg:py-4">
        {activeNav === 'profile' ? (
          <div className="max-w-xl mx-auto m-4 lg:m-0 bg-[#17212B] border border-[#101921] rounded-2xl p-6 sm:p-8 space-y-6 shadow-2xl">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-5 border-b border-[#101921]">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => profileAvatarInputRef.current?.click()}
                  title="Нажмите, чтобы загрузить или изменить фото профиля"
                  className="relative group rounded-full focus:outline-none focus:ring-2 focus:ring-[#64B5EF] cursor-pointer shrink-0"
                >
                  <UserAvatar
                    displayName={profileName || currentUser.displayName}
                    avatarColor={profileColor}
                    avatarUrl={profileAvatarUrl}
                    sizeClass="w-20 h-20"
                    textClass="text-2xl"
                  />
                  <span className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-[#5288C1] border-2 border-[#17212B] flex items-center justify-center text-white shadow-md group-hover:bg-[#467AB0] transition-colors">
                    <Camera className="w-3.5 h-3.5" />
                  </span>
                </button>
                <div className="min-w-0">
                  <h1 className="text-lg font-bold text-white truncate">
                    {currentUser.displayName}
                  </h1>
                  <p className="text-xs text-[#64B5EF] truncate">@{currentUser.username}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <input
                      ref={profileAvatarInputRef}
                      type="file"
                      accept="image/*"
                      aria-label="Загрузить фото профиля"
                      onChange={handleProfileAvatarUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => profileAvatarInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#2B5278] hover:bg-[#34628E] text-white text-xs font-semibold rounded-xl transition-colors cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5 text-[#64B5EF]" />
                      <span>{profileAvatarUrl ? 'Изменить фото' : 'Загрузить фото'}</span>
                    </button>

                    {profileAvatarUrl && (
                      <button
                        type="button"
                        onClick={handleRemoveProfileAvatar}
                        className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#242F3D] hover:bg-rose-950/60 text-xs font-medium text-[#7F91A4] hover:text-rose-300 rounded-xl transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Удалить фото</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {profileError && (
              <div
                role="alert"
                className="p-3 bg-rose-950/60 border border-rose-800/80 rounded-xl text-xs text-rose-200"
              >
                {profileError}
              </div>
            )}

            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div>
                <label
                  htmlFor="profile-name"
                  className="block text-xs font-medium text-[#7F91A4] mb-1.5"
                >
                  Ваше имя
                </label>
                <input
                  id="profile-name"
                  type="text"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white focus:outline-none focus:border-[#5288C1]"
                />
              </div>

              <div>
                <label
                  htmlFor="profile-bio"
                  className="block text-xs font-medium text-[#7F91A4] mb-1.5"
                >
                  О себе
                </label>
                <input
                  id="profile-bio"
                  type="text"
                  value={profileBio}
                  onChange={(e) => setProfileBio(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white focus:outline-none focus:border-[#5288C1]"
                />
              </div>

              <div>
                <span className="block text-xs font-medium text-[#7F91A4] mb-2">
                  Цвет фона (если фото не загружено)
                </span>
                <div className="flex items-center gap-2.5">
                  {TELEGRAM_AVATAR_COLORS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setProfileColor(hex)}
                      aria-label={`Выбрать цвет ${hex}`}
                      className={`w-8 h-8 rounded-full transition-transform cursor-pointer ${
                        profileColor === hex ? 'ring-2 ring-white scale-110' : ''
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
              </div>

              <div className="pt-2 flex items-center justify-between gap-4">
                <button
                  type="submit"
                  className="flex items-center gap-2 px-5 py-2.5 bg-[#5288C1] hover:bg-[#467AB0] text-white text-xs font-semibold rounded-xl transition-colors cursor-pointer"
                >
                  {profileSaved ? (
                    <>
                      <Check className="w-4 h-4" />
                      Профиль сохранен
                    </>
                  ) : (
                    <>
                      <User className="w-4 h-4" />
                      Сохранить изменения
                    </>
                  )}
                </button>
              </div>
            </form>

            {/* Раздел: Уведомления о сообщениях и звонках */}
            <div className="pt-5 border-t border-[#101921] space-y-3">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-[#64B5EF]" />
                <h2 className="text-sm font-semibold text-white">
                  Уведомления о сообщениях и звонках
                </h2>
              </div>

              <div className="p-3.5 bg-[#0E1621] border border-[#232E3C] rounded-xl space-y-3">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <p className="text-xs font-medium text-white">
                      Звуковые оповещения в приложении
                    </p>
                    <p className="text-[11px] text-[#7F91A4]">
                      Мелодия входящего звонка и сигнал нового сообщения
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={soundNotificationsEnabled}
                    onChange={toggleSoundNotifications}
                    className="rounded border-[#2B3848] bg-[#242F3D] text-[#5288C1] focus:ring-0"
                  />
                </label>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#17212B]">
                  <div>
                    <p className="text-xs font-medium text-white">
                      Системные уведомления браузера
                    </p>
                    <p className="text-[11px] text-[#7F91A4]">
                      {browserNotifPermission === 'granted'
                        ? 'Системные уведомления активны'
                        : 'Показывать всплывающие уведомления поверх других вкладок'}
                    </p>
                  </div>
                  {browserNotifPermission !== 'granted' && (
                    <button
                      type="button"
                      onClick={requestBrowserNotificationsPermission}
                      className="px-3 py-1.5 bg-[#242F3D] hover:bg-[#2C394A] text-xs font-medium text-[#64B5EF] rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                    >
                      Разрешить уведомления
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Раздел: Сброс и смена пароля */}
            <form
              onSubmit={handleProfilePasswordReset}
              className="pt-5 border-t border-[#101921] space-y-3"
            >
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-[#64B5EF]" />
                <h2 className="text-sm font-semibold text-white">Сброс и смена пароля</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="profile-new-password"
                    className="block text-xs font-medium text-[#7F91A4] mb-1.5"
                  >
                    Новый пароль
                  </label>
                  <input
                    id="profile-new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPasswordInput}
                    onChange={(e) => setNewPasswordInput(e.target.value)}
                    placeholder="Минимум 6 символов"
                    className="w-full px-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="profile-confirm-password"
                    className="block text-xs font-medium text-[#7F91A4] mb-1.5"
                  >
                    Подтвердите пароль
                  </label>
                  <input
                    id="profile-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPasswordInput}
                    onChange={(e) => setConfirmPasswordInput(e.target.value)}
                    placeholder="Повторите новый пароль"
                    className="w-full px-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
                  />
                </div>
              </div>

              {passwordResetError && (
                <div
                  role="alert"
                  className="p-2.5 bg-rose-950/60 border border-rose-800/80 rounded-xl text-xs text-rose-200"
                >
                  {passwordResetError}
                </div>
              )}

              {passwordResetSuccess && (
                <div
                  role="status"
                  className="p-2.5 bg-emerald-950/60 border border-emerald-800/80 rounded-xl text-xs text-emerald-200"
                >
                  {passwordResetSuccess}
                </div>
              )}

              <button
                type="submit"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#242F3D] hover:bg-[#2C394A] text-white text-xs font-semibold rounded-xl transition-colors cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5 text-[#64B5EF]" />
                <span>Обновить пароль</span>
              </button>
            </form>

            {/* Раздел: Облачное хранилище и синхронизация сессий */}
            <div className="pt-5 border-t border-[#101921] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-[#64B5EF]" />
                  <h2 className="text-sm font-semibold text-white">
                    Облачное хранилище и синхронизация
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setIsStorageModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2B5278] hover:bg-[#34628E] text-xs font-semibold text-white rounded-lg transition-colors cursor-pointer"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-[#64B5EF]" />
                  <span>Где хранить данные?</span>
                </button>
              </div>

              <div className="p-3.5 bg-[#0E1621] border border-[#232E3C] rounded-xl space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-white flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5 text-[#4CAF50]" />
                      Серверный Pulse WAL Store (.pulse-data.json)
                    </p>
                    <p className="text-[11px] text-[#7F91A4] mt-0.5">
                      Атомарная запись на диск + real-time WebSockets синхронизация между всеми подключенными браузерами и смартфонами
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-950/80 text-emerald-400 border border-emerald-800 shrink-0 self-start sm:self-auto">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Активно
                  </span>
                </div>

                {/* Управление активными сессиями на устройствах */}
                <div className="pt-2.5 border-t border-[#17212B] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#7F91A4] flex items-center gap-1.5">
                      <Smartphone className="w-3.5 h-3.5 text-[#64B5EF]" />
                      Активные сессии на устройствах
                    </span>
                    {deviceSessions.length > 1 && (
                      <button
                        type="button"
                        onClick={handleLogoutOtherDevices}
                        className="text-[11px] text-[#64B5EF] hover:underline cursor-pointer"
                      >
                        Завершить другие сессии
                      </button>
                    )}
                  </div>

                  {logoutOthersMsg && (
                    <div
                      role="status"
                      className="p-2 bg-emerald-950/70 border border-emerald-800 rounded-lg text-[11px] text-emerald-200"
                    >
                      {logoutOthersMsg}
                    </div>
                  )}

                  {deviceSessions.length > 0 ? (
                    <div className="space-y-1.5">
                      {deviceSessions.map((sess) => (
                        <div
                          key={sess.id}
                          className="flex items-center justify-between p-2 bg-[#17212B] border border-[#232E3C] rounded-lg text-xs"
                        >
                          <div className="min-w-0 pr-2">
                            <p className="font-medium text-white truncate flex items-center gap-1.5">
                              <span>{sess.deviceName}</span>
                              {sess.isCurrent && (
                                <span className="text-[10px] bg-[#2B5278] text-[#64B5EF] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap">
                                  Текущее устройство
                                </span>
                              )}
                            </p>
                            <p className="text-[11px] text-[#7F91A4] truncate">{sess.browser}</p>
                          </div>
                          <span className="text-[11px] text-[#6C7883] shrink-0 font-mono">
                            {new Date(sess.lastActiveAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-[#6C7883]">
                      Данные текущей авторизации безопасно сохранены в токене JWT.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <MessengerWorkspace
            currentUser={currentUser}
            contacts={combinedContacts}
            rooms={allRooms}
            summaries={summaries}
            selectedContact={selectedContact}
            onSelectContact={(c) => {
              setSelectedContact(c);
              setActiveNav('chats');
              setMobileChatOpen(true);
            }}
            messages={messages}
            onSendMessage={handleSendMessage}
            onStartCall={(contact, type) => startCall(contact.id, contact.displayName, type)}
            typingUserIds={typingUserIds}
            onTypingChange={handleTypingChange}
            activeTab={activeNav === 'contacts' ? 'contacts' : 'chats'}
            mobileChatOpen={mobileChatOpen}
            onBackToMobileList={() => setMobileChatOpen(false)}
            hasActiveCall={callState !== 'idle' && callState !== 'ended'}
            onCreateRoom={handleCreateRoom}
            onJoinOrLeaveRoom={handleJoinOrLeaveRoom}
            onUpdateRoomMembers={handleUpdateRoomMembers}
            onUpdateRoom={handleUpdateRoom}
            onDeleteRoom={handleDeleteRoom}
          />
        )}
      </main>

      {/* Всплывающее / сворачиваемое окно звонка */}
      <CallModal
        callState={callState}
        mediaType={mediaType}
        remotePeerName={remotePeerName}
        remotePeerAvatarColor={
          (allUsers.find((u) => u.id === remotePeerId) || selectedContact)?.avatarColor
        }
        remotePeerAvatarUrl={
          (allUsers.find((u) => u.id === remotePeerId) || selectedContact)?.avatarUrl
        }
        localStream={localStream}
        remoteStream={remoteStream}
        isMicMuted={isMicMuted}
        isCamOff={isCamOff}
        callDurationSec={callDurationSec}
        mediaWarning={mediaWarning}
        onAccept={acceptIncomingCall}
        onRejectOrHangup={endCall}
        onToggleMic={toggleMic}
        onToggleCamera={toggleCamera}
      />

      {/* Модальное окно архитектуры хранения и синхронизации данных */}
      <StorageOverviewModal
        isOpen={isStorageModalOpen}
        onClose={() => setIsStorageModalOpen(false)}
      />
    </div>
  );
}
