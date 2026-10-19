/**
 * Pulse Backend Server (Express + Socket.io + JWT + bcrypt + WebRTC Signaling)
 * Атомарное сохранение реальных пользовательских аккаунтов и переписки на диск.
 */
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import {
  getConversationId,
  isRoomId,
  validateCredentials,
  validateAvatarDataUrl,
  validatePasswordReset,
  validateMediaAttachment,
  normalizeMediaDataUrl,
  formatMessagePreview,
  normalizeWaveform,
  validateRoomCreation,
  canUserAccessRoom,
  canUserAdministerRoom,
  canUserPostInRoom,
  markConversationMessagesAsRead,
  type UserProfile,
  type ChatMessage,
  type ChatRoom,
  type MessageAttachmentType,
  normalizeUsername,
  STORAGE_BACKEND_OPTIONS,
  type DeviceSessionInfo,
} from './src/utils/messengerLogic.ts';

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pulse-super-secret-jwt-key-2026';
const DATA_FILE = path.join(process.cwd(), '.pulse-data.json');
const BACKUP_FILE = path.join(process.cwd(), '.pulse-data.backup.json');

interface StoredUser extends UserProfile {
  passwordHash: string;
}

interface StoredConversation {
  id: string;
  participants: string[];
  updatedAt: string;
}

interface StoredDeviceSession {
  token: string;
  userId: string;
  deviceName: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastActiveAt: string;
}

const users = new Map<string, StoredUser>();
const rooms = new Map<string, ChatRoom>();
const messages = new Map<string, ChatMessage[]>();
const conversations = new Map<string, StoredConversation>();
const userSockets = new Map<string, Set<string>>();
const userSessions = new Map<string, StoredDeviceSession[]>();

let lastSavedAt = new Date().toISOString();

/**
 * Загрузка сохраненных пользователей, групп, каналов и сообщений с диска при старте сервера
 * с поддержкой автоматического резервного восстановления при повреждении файла.
 */
function loadStore() {
  const tryLoadFromPath = (targetPath: string): boolean => {
    try {
      if (!fs.existsSync(targetPath)) return false;
      const raw = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      if (Array.isArray(raw.users)) {
        for (const u of raw.users) {
          if (u && u.id && u.username && u.passwordHash) {
            users.set(u.id, { ...u, online: false });
          }
        }
      }
      if (Array.isArray(raw.rooms)) {
        for (const r of raw.rooms) {
          if (r && r.id && r.title && (r.type === 'group' || r.type === 'channel')) {
            rooms.set(r.id, {
              ...r,
              adminIds: Array.isArray(r.adminIds) ? r.adminIds : [r.ownerId],
              memberIds: Array.isArray(r.memberIds) ? r.memberIds : [r.ownerId],
              isPublic: r.isPublic ?? true,
            });
          }
        }
      }
      if (raw.messages && typeof raw.messages === 'object') {
        for (const [convId, list] of Object.entries(raw.messages)) {
          if (Array.isArray(list)) {
            const validList = (list as ChatMessage[]).filter((m) => {
              if (!m || !m.id) return false;
              if (m.attachmentType === 'video_note' || m.attachmentType === 'voice') {
                return Boolean(m.mediaUrl && m.mediaUrl.length >= 150);
              }
              return Boolean(m.text && m.text.trim());
            });
            messages.set(convId, validList);
          }
        }
      }
      if (Array.isArray(raw.conversations)) {
        for (const c of raw.conversations) {
          if (c && c.id && Array.isArray(c.participants)) {
            conversations.set(c.id, c);
          }
        }
      }
      return true;
    } catch (err) {
      console.error(`[Pulse] Ошибка чтения из ${targetPath}:`, err);
      return false;
    }
  };

  const loadedPrimary = tryLoadFromPath(DATA_FILE);
  if (!loadedPrimary || users.size === 0) {
    tryLoadFromPath(BACKUP_FILE);
  }
}

/**
 * Атомарная запись состояния на диск (через временный файл + rename),
 * чтобы данные аккаунтов, групп, каналов и диалогов никогда не повреждались,
 * с созданием резервной копии.
 */
function saveStore() {
  try {
    const payload = {
      users: Array.from(users.values()),
      rooms: Array.from(rooms.values()),
      messages: Object.fromEntries(messages.entries()),
      conversations: Array.from(conversations.values()),
      savedAt: new Date().toISOString(),
    };
    const tempFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tempFile, DATA_FILE);
    lastSavedAt = payload.savedAt;

    // Резервная копия
    try {
      fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    } catch {
      // ignore
    }
  } catch (err) {
    console.error('[Pulse] Ошибка сохранения хранилища:', err);
  }
}

loadStore();

// Очистка объекта пользователя от passwordHash и вычисление реального онлайн-статуса
function sanitizeUser(user: StoredUser): UserProfile {
  const { passwordHash: _, ...publicProfile } = user;
  const activeSocketSet = userSockets.get(user.id);
  const isOnline = activeSocketSet ? activeSocketSet.size > 0 : false;
  return {
    ...publicProfile,
    online: isOnline,
  };
}

// Возвращает список групп и каналов, доступных пользователю (ТОЛЬКО те, которые он создал или куда приглашен)
function getVisibleRoomsForUser(userId?: string): ChatRoom[] {
  if (!userId) return [];
  const all = Array.from(rooms.values());
  return all.filter((r) => canUserAccessRoom(r, userId));
}

// Сводка последних сообщений по каждому личному диалогу, группе и каналу для текущего пользователя
function getRecentSummariesForUser(userId: string) {
  const summaries: Record<string, { lastMessage: ChatMessage; unreadCount: number }> = {};
  for (const [convId, msgList] of messages.entries()) {
    if (!msgList || msgList.length === 0) continue;
    const last = msgList[msgList.length - 1];
    if (isRoomId(convId) || isRoomId(last.recipientId)) {
      const roomId = isRoomId(convId) ? convId : last.recipientId;
      const room = rooms.get(roomId);
      if (room && canUserAccessRoom(room, userId)) {
        summaries[roomId] = {
          lastMessage: last,
          unreadCount: 0,
        };
      }
      continue;
    }
    if (last.senderId === userId || last.recipientId === userId) {
      const peerId = last.senderId === userId ? last.recipientId : last.senderId;
      summaries[peerId] = {
        lastMessage: last,
        unreadCount: 0,
      };
    }
  }
  return summaries;
}

// Генерация чистого, безопасного JWT-токена (без раскрытия passwordHash)
function signUserToken(user: StoredUser): string {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: '365d' }
  );
}

// Регистрация активной сессии устройства
function recordDeviceSession(userId: string, token: string, req: express.Request) {
  const userAgent = req.headers['user-agent'] || 'Неизвестный браузер';
  let deviceName = 'Компьютер / Браузер';
  if (/mobile/i.test(userAgent)) deviceName = 'Смартфон';
  if (/tablet|ipad/i.test(userAgent)) deviceName = 'Планшет';
  if (/macintosh|mac os/i.test(userAgent)) deviceName = 'macOS';
  if (/windows/i.test(userAgent)) deviceName = 'Windows ПК';
  if (/linux/i.test(userAgent)) deviceName = 'Linux ПК';
  if (/android/i.test(userAgent)) deviceName = 'Android устройство';
  if (/iphone/i.test(userAgent)) deviceName = 'iPhone';

  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
  const sessions = userSessions.get(userId) || [];
  const existing = sessions.find((s) => s.token === token);
  if (existing) {
    existing.lastActiveAt = new Date().toISOString();
  } else {
    sessions.unshift({
      token,
      userId,
      deviceName,
      userAgent: userAgent.slice(0, 120),
      ip: ip.split(',')[0].trim(),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
  }
  userSessions.set(userId, sessions.slice(0, 10));
}

// Автоматическое восстановление пользователя из подписанного JWT-токена и клиентского бэкапа
function restoreUserFromDecodedToken(
  decoded: {
    userId?: string;
    username?: string;
    displayName?: string;
    avatarColor?: string;
    role?: string;
  },
  backupUser?: Partial<UserProfile>,
  plainPasswordForHash?: string
): StoredUser | null {
  const userId = decoded.userId || backupUser?.id;
  if (!userId) return null;

  const existing = users.get(userId);
  if (existing) {
    if (!existing.avatarUrl && backupUser?.avatarUrl) {
      const check = validateAvatarDataUrl(backupUser.avatarUrl);
      if (check.valid && check.sanitized) {
        existing.avatarUrl = check.sanitized;
        users.set(userId, existing);
        saveStore();
      }
    }
    return existing;
  }

  const username = normalizeUsername(decoded.username || backupUser?.username || '');
  if (!username) return null;

  // Проверяем, нет ли уже пользователя с таким username
  const byUsername = Array.from(users.values()).find(
    (u) => u.username.toLowerCase() === username
  );
  if (byUsername) {
    if (!byUsername.avatarUrl && backupUser?.avatarUrl) {
      const check = validateAvatarDataUrl(backupUser.avatarUrl);
      if (check.valid && check.sanitized) {
        byUsername.avatarUrl = check.sanitized;
        users.set(byUsername.id, byUsername);
        saveStore();
      }
    }
    return byUsername;
  }

  const passwordHash = plainPasswordForHash
    ? bcrypt.hashSync(plainPasswordForHash, 10)
    : bcrypt.hashSync(userId, 10);

  const avatarCheck = validateAvatarDataUrl(backupUser?.avatarUrl);

  const restored: StoredUser = {
    id: userId,
    username,
    displayName: decoded.displayName || backupUser?.displayName || username,
    avatarColor: decoded.avatarColor || backupUser?.avatarColor || '#5288C1',
    avatarUrl: avatarCheck.valid && avatarCheck.sanitized ? avatarCheck.sanitized : undefined,
    role: decoded.role || backupUser?.role || 'В сети Pulse',
    online: true,
    lastSeen: new Date().toISOString(),
    passwordHash,
  };

  users.set(restored.id, restored);
  saveStore();
  return restored;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    path: '/socket.io/',
    destroyUpgrade: false,
    maxHttpBufferSize: 25 * 1024 * 1024,
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // ============================================================================
  // 1. REST API: АВТОРИЗАЦИЯ, ПРОФИЛЬ И АВТО-ВОССТАНОВЛЕНИЕ ПРИ ПУБЛИКАЦИИ ВЕРСИЙ
  // ============================================================================

  // POST /api/auth/sync-vault — Автоматическая синхронизация сохраненных на устройстве аккаунтов, групп, каналов и переписки
  // при открытии приложения после публикации новой версии
  app.post('/api/auth/sync-vault', (req, res) => {
    try {
      const { entries, roomsBackup, messagesBackup } = req.body as {
        entries?: Array<{
          token?: string;
          user?: UserProfile;
          passwordHint?: string;
        }>;
        roomsBackup?: ChatRoom[];
        messagesBackup?: Record<string, ChatMessage[]>;
      };

      let restoredCount = 0;
      let restoredRoomsCount = 0;

      if (Array.isArray(entries)) {
        for (const item of entries) {
          if (!item?.token) continue;
          try {
            const decoded = jwt.verify(item.token, JWT_SECRET) as {
              userId?: string;
              username?: string;
              displayName?: string;
              avatarColor?: string;
              role?: string;
              passwordHash?: string;
            };
            const restored = restoreUserFromDecodedToken(
              decoded,
              item.user,
              item.passwordHint
            );
            if (restored) {
              restoredCount++;
            }
          } catch {
            // ignore invalid token
          }
        }
      }

      if (Array.isArray(roomsBackup)) {
        for (const r of roomsBackup) {
          if (!r || !r.id || !r.title || (r.type !== 'group' && r.type !== 'channel')) continue;
          if (!rooms.has(r.id)) {
            rooms.set(r.id, {
              ...r,
              adminIds: Array.isArray(r.adminIds) ? r.adminIds : [r.ownerId],
              memberIds: Array.isArray(r.memberIds) ? r.memberIds : [r.ownerId],
              isPublic: r.isPublic ?? true,
            });
            restoredRoomsCount++;
          }
        }
      }

      if (messagesBackup && typeof messagesBackup === 'object') {
        for (const [peerKey, msgList] of Object.entries(messagesBackup)) {
          if (!Array.isArray(msgList) || msgList.length === 0) continue;
          for (const m of msgList) {
            if (!m || !m.id || !m.senderId || !m.recipientId) continue;
            const isMediaMsg = m.attachmentType === 'video_note' || m.attachmentType === 'voice';
            if (isMediaMsg) {
              if (!m.mediaUrl || typeof m.mediaUrl !== 'string' || m.mediaUrl.length < 150) {
                continue;
              }
              const mediaCheck = validateMediaAttachment(
                m.attachmentType,
                m.mediaUrl,
                m.mediaDuration
              );
              if (!mediaCheck.valid) continue;
            } else if (!m.text || !m.text.trim()) {
              continue;
            }
            const convId = getConversationId(m.senderId, m.recipientId);
            const existingList = messages.get(convId) || [];
            if (!existingList.some((existingMsg) => existingMsg.id === m.id)) {
              const sanitizedMediaUrl = m.mediaUrl
                ? normalizeMediaDataUrl(m.mediaUrl, m.attachmentType) || m.mediaUrl
                : undefined;
              existingList.push({
                ...m,
                conversationId: convId,
                mediaUrl: sanitizedMediaUrl,
              });
              existingList.sort(
                (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
              );
              messages.set(convId, existingList);
            }
          }
          void peerKey;
        }
      }

      if (restoredCount > 0 || restoredRoomsCount > 0 || messagesBackup) {
        saveStore();
      }

      if (restoredCount > 0) {
        io.emit('users:update', Array.from(users.values()).map(sanitizeUser));
      }
      if (restoredRoomsCount > 0) {
        io.emit('rooms:update', Array.from(rooms.values()));
      }

      res.json({
        ok: true,
        restoredCount,
        users: Array.from(users.values()).map(sanitizeUser),
        rooms: Array.from(rooms.values()),
      });
    } catch (err) {
      console.error('Ошибка синхронизации аккаунтов:', err);
      res.status(500).json({ error: 'Ошибка синхронизации' });
    }
  });

  // POST /api/auth/register — Регистрация нового аккаунта
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, password, displayName, bio, avatarUrl } = req.body;
      const validation = validateCredentials(
        username || '',
        password || '',
        true,
        displayName || ''
      );
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const avatarCheck = validateAvatarDataUrl(avatarUrl);
      if (!avatarCheck.valid) {
        res.status(400).json({ error: avatarCheck.error });
        return;
      }

      const normalizedUsername = username.trim().toLowerCase();
      const existing = Array.from(users.values()).find(
        (u) => u.username.toLowerCase() === normalizedUsername
      );
      if (existing) {
        res.status(409).json({ error: 'Это имя пользователя уже занято. Выберите другое или войдите в аккаунт.' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const telegramColors = ['#5288C1', '#3E9F65', '#D97724', '#8E57C2', '#D84B6B', '#2F9FA8'];
      const newUserId = req.body.id || `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const newUser: StoredUser = {
        id: newUserId,
        username: normalizedUsername,
        displayName: displayName.trim(),
        email: typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : undefined,
        avatarColor: telegramColors[users.size % telegramColors.length],
        avatarUrl: avatarCheck.sanitized || undefined,
        role: bio?.trim() || 'В сети Pulse',
        online: true,
        lastSeen: new Date().toISOString(),
        passwordHash,
      };

      users.set(newUserId, newUser);
      saveStore();

      const token = signUserToken(newUser);
      recordDeviceSession(newUser.id, token, req);

      io.emit('users:update', Array.from(users.values()).map(sanitizeUser));

      res.status(201).json({
        token,
        user: sanitizeUser(newUser),
      });
    } catch (err) {
      console.error('Ошибка регистрации:', err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера при регистрации' });
    }
  });

  // POST /api/auth/login — Вход в существующий аккаунт
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const normalizedUsername = normalizeUsername(username || '');

      const foundUser = Array.from(users.values()).find(
        (u) => u.username.toLowerCase() === normalizedUsername
      );

      if (!foundUser) {
        res.status(401).json({ error: 'Аккаунт с таким логином не найден' });
        return;
      }

      const passwordMatches = await bcrypt.compare(password || '', foundUser.passwordHash);
      if (!passwordMatches) {
        res.status(401).json({ error: 'Неверный пароль' });
        return;
      }

      foundUser.lastSeen = new Date().toISOString();
      users.set(foundUser.id, foundUser);
      saveStore();

      const token = signUserToken(foundUser);
      recordDeviceSession(foundUser.id, token, req);

      res.json({
        token,
        user: sanitizeUser(foundUser),
      });
    } catch (err) {
      console.error('Ошибка входа:', err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера при входе' });
    }
  });

  // POST /api/auth/reset-password — Сброс и установка нового пароля для аккаунта
  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const { username, newPassword, confirmPassword } = req.body;
      const cleanUsername = normalizeUsername(username || '');
      const validation = validatePasswordReset(
        cleanUsername,
        newPassword || '',
        confirmPassword ?? newPassword ?? ''
      );
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const foundUser = Array.from(users.values()).find(
        (u) => u.username.toLowerCase() === cleanUsername
      );

      if (!foundUser) {
        res.status(404).json({
          error: 'Аккаунт с таким именем пользователя (@username) не найден',
        });
        return;
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      foundUser.passwordHash = passwordHash;
      foundUser.lastSeen = new Date().toISOString();
      users.set(foundUser.id, foundUser);
      saveStore();

      const token = signUserToken(foundUser);
      recordDeviceSession(foundUser.id, token, req);

      res.json({
        ok: true,
        token,
        user: sanitizeUser(foundUser),
      });
    } catch (err) {
      console.error('Ошибка сброса пароля:', err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера при сбросе пароля' });
    }
  });

  // GET & POST /api/auth/me — Восстановление сессии по сохраненному JWT-токену
  const handleAuthMe = (req: express.Request, res: express.Response) => {
    try {
      const authHeader = req.headers.authorization;
      const bodyToken = req.body?.token;
      const rawToken =
        authHeader && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : typeof bodyToken === 'string'
            ? bodyToken
            : '';

      if (!rawToken) {
        res.status(401).json({ error: 'Требуется авторизация' });
        return;
      }

      const decoded = jwt.verify(rawToken, JWT_SECRET) as {
        userId?: string;
        username?: string;
        displayName?: string;
        avatarColor?: string;
        role?: string;
      };

      const backupUser = req.body?.user as Partial<UserProfile> | undefined;
      const foundOrRestored = restoreUserFromDecodedToken(decoded, backupUser);

      if (!foundOrRestored) {
        res.status(401).json({ error: 'Аккаунт не найден' });
        return;
      }

      const refreshedToken = signUserToken(foundOrRestored);
      recordDeviceSession(foundOrRestored.id, refreshedToken, req);
      io.emit('users:update', Array.from(users.values()).map(sanitizeUser));

      res.json({
        user: sanitizeUser(foundOrRestored),
        token: refreshedToken,
      });
    } catch {
      res.status(401).json({ error: 'Сессия истекла, войдите снова' });
    }
  };

  app.get('/api/auth/me', handleAuthMe);
  app.post('/api/auth/me', handleAuthMe);

  // GET /api/auth/storage-info — Информация об активном хранилище и вариантах хранения данных
  app.get('/api/auth/storage-info', (_req, res) => {
    let totalMessages = 0;
    for (const list of messages.values()) {
      totalMessages += list.length;
    }
    res.json({
      engine: 'Pulse Server Engine (Atomic WAL Store)',
      status: 'active',
      dataFile: DATA_FILE,
      backupFile: BACKUP_FILE,
      usersCount: users.size,
      roomsCount: rooms.size,
      conversationsCount: conversations.size,
      messagesCount: totalMessages,
      lastSavedAt,
      options: STORAGE_BACKEND_OPTIONS,
    });
  });

  // GET /api/auth/sessions — Список активных устройств и сессий пользователя
  app.get('/api/auth/sessions', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Требуется авторизация' });
      return;
    }
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId?: string };
      if (!decoded.userId) {
        res.status(401).json({ error: 'Неверный токен' });
        return;
      }
      const sessions = userSessions.get(decoded.userId) || [];
      const formatted: DeviceSessionInfo[] = sessions.map((s, idx) => ({
        id: `sess_${idx}_${s.token.slice(-6)}`,
        deviceName: s.deviceName,
        browser: s.userAgent,
        ip: s.ip,
        lastActiveAt: s.lastActiveAt,
        isCurrent: s.token === token,
      }));
      res.json({ sessions: formatted });
    } catch {
      res.status(401).json({ error: 'Недействительный токен' });
    }
  });

  // POST /api/auth/logout-other-devices — Завершить сессии на всех остальных устройствах
  app.post('/api/auth/logout-other-devices', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Требуется авторизация' });
      return;
    }
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId?: string };
      if (!decoded.userId) {
        res.status(401).json({ error: 'Неверный токен' });
        return;
      }
      const sessions = userSessions.get(decoded.userId) || [];
      const current = sessions.find((s) => s.token === token);
      userSessions.set(decoded.userId, current ? [current] : []);
      res.json({ ok: true, activeCount: current ? 1 : 0 });
    } catch {
      res.status(401).json({ error: 'Недействительный токен' });
    }
  });

  // PATCH /api/users/profile — Сохранение изменений профиля (Имя, О себе, Цвет аватара, Фото аватара)
  app.patch('/api/users/profile', (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Требуется авторизация' });
        return;
      }
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET) as {
        userId?: string;
        username?: string;
        displayName?: string;
        avatarColor?: string;
        role?: string;
        passwordHash?: string;
      };
      const foundUser = restoreUserFromDecodedToken(decoded);
      if (!foundUser) {
        res.status(404).json({ error: 'Пользователь не найден' });
        return;
      }

      const { displayName, bio, avatarColor, avatarUrl } = req.body;
      if (displayName && displayName.trim().length >= 2) {
        foundUser.displayName = displayName.trim();
      }
      if (typeof bio === 'string') {
        foundUser.role = bio.trim() || 'В сети Pulse';
      }
      if (typeof avatarColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(avatarColor)) {
        foundUser.avatarColor = avatarColor;
      }
      if (avatarUrl !== undefined) {
        const avatarCheck = validateAvatarDataUrl(avatarUrl);
        if (!avatarCheck.valid) {
          res.status(400).json({ error: avatarCheck.error });
          return;
        }
        foundUser.avatarUrl = avatarCheck.sanitized || undefined;
      }

      users.set(foundUser.id, foundUser);
      saveStore();

      const updatedProfile = sanitizeUser(foundUser);
      const refreshedToken = signUserToken(foundUser);
      io.emit('users:update', Array.from(users.values()).map(sanitizeUser));
      io.to(`user:${foundUser.id}`).emit('user:profile-updated', updatedProfile);
      res.json({ user: updatedProfile, token: refreshedToken });
    } catch {
      res.status(401).json({ error: 'Не удалось сохранить профиль' });
    }
  });

  // GET /api/users — Список всех зарегистрированных пользователей, доступных групп/каналов и сводка диалогов
  app.get('/api/users', (req, res) => {
    const currentUserId = typeof req.query.forUser === 'string' ? req.query.forUser : '';
    const list = Array.from(users.values()).map(sanitizeUser);
    const visibleRooms = getVisibleRoomsForUser(currentUserId);
    const summaries = currentUserId ? getRecentSummariesForUser(currentUserId) : {};
    res.json({ users: list, rooms: visibleRooms, summaries });
  });

  // GET /api/rooms — Список групповых чатов и каналов
  app.get('/api/rooms', (req, res) => {
    const currentUserId = typeof req.query.forUser === 'string' ? req.query.forUser : '';
    res.json({ rooms: getVisibleRoomsForUser(currentUserId) });
  });

  // POST /api/rooms — Создание нового группового чата или канала
  app.post('/api/rooms', (req, res) => {
    try {
      const {
        type,
        title,
        handle,
        description,
        avatarColor,
        avatarUrl,
        ownerId,
        memberIds,
        isPublic,
      } = req.body || {};

      if (!ownerId || typeof ownerId !== 'string') {
        res.status(400).json({ error: 'Не указан создатель группы или канала' });
        return;
      }

      const check = validateRoomCreation({ type, title, handle, description });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const avatarCheck = validateAvatarDataUrl(avatarUrl);
      if (!avatarCheck.valid) {
        res.status(400).json({ error: avatarCheck.error });
        return;
      }

      const uniqueMembers = Array.from(
        new Set([
          ownerId,
          ...(Array.isArray(memberIds)
            ? memberIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
            : []),
        ])
      );

      const defaultColors = ['#3E9F65', '#8E57C2', '#5288C1', '#D97724', '#D84B6B', '#2F9FA8'];
      const chosenColor =
        typeof avatarColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(avatarColor)
          ? avatarColor
          : defaultColors[rooms.size % defaultColors.length];

      const roomId = `${check.roomType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const newRoom: ChatRoom = {
        id: roomId,
        type: check.roomType,
        title: check.sanitizedTitle,
        handle: check.sanitizedHandle,
        description: check.sanitizedDescription,
        avatarColor: chosenColor,
        avatarUrl: avatarCheck.sanitized || undefined,
        ownerId,
        adminIds: [ownerId],
        memberIds: uniqueMembers,
        isPublic: isPublic !== undefined ? Boolean(isPublic) : false,
        createdAt: new Date().toISOString(),
      };

      rooms.set(newRoom.id, newRoom);
      saveStore();

      io.emit('rooms:update', Array.from(rooms.values()));
      res.status(201).json({ ok: true, room: newRoom });
    } catch (err) {
      console.error('Ошибка создания группы/канала:', err);
      res.status(500).json({ error: 'Не удалось создать группу или канал' });
    }
  });

  // POST /api/rooms/:roomId/join — Вступление/подписка или выход из группового чата / канала
  app.post('/api/rooms/:roomId/join', (req, res) => {
    const { roomId } = req.params;
    const { userId, action } = req.body as { userId?: string; action?: 'join' | 'leave' };
    if (!userId) {
      res.status(400).json({ error: 'Не указан пользователь' });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      res.status(404).json({ error: 'Группа или канал не найдены' });
      return;
    }

    if (action === 'leave') {
      if (room.ownerId !== userId) {
        room.memberIds = room.memberIds.filter((id) => id !== userId);
        room.adminIds = room.adminIds.filter((id) => id !== userId);
      }
    } else if (!room.memberIds.includes(userId)) {
      room.memberIds = [...room.memberIds, userId];
    }

    rooms.set(room.id, room);
    saveStore();
    io.emit('rooms:update', Array.from(rooms.values()));
    res.json({ ok: true, room });
  });

  // PATCH /api/rooms/:roomId — Администрирование группы или канала (аватар, название, описание, приглашение людей, назначение админов)
  app.patch('/api/rooms/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = rooms.get(roomId);
    if (!room) {
      res.status(404).json({ error: 'Группа или канал не найдены' });
      return;
    }

    const { actorId, title, description, avatarColor, avatarUrl, memberIds, adminIds } =
      req.body || {};
    if (actorId && !canUserAdministerRoom(room, actorId)) {
      res.status(403).json({
        error: 'Только создатель или администраторы могут управлять этой группой или каналом',
      });
      return;
    }

    if (typeof title === 'string' && title.trim().length >= 2) {
      room.title = title.trim().slice(0, 80);
    }
    if (typeof description === 'string') {
      room.description = description.trim().slice(0, 240);
    }
    if (typeof avatarColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(avatarColor)) {
      room.avatarColor = avatarColor;
    }
    if (avatarUrl !== undefined) {
      const check = validateAvatarDataUrl(avatarUrl);
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
      room.avatarUrl = check.sanitized || undefined;
    }
    if (Array.isArray(memberIds)) {
      room.memberIds = Array.from(
        new Set([
          room.ownerId,
          ...memberIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())),
        ])
      );
      // Если кого-то исключили из участников, снимаем и права администратора
      room.adminIds = room.adminIds.filter(
        (adminId) => adminId === room.ownerId || room.memberIds.includes(adminId)
      );
    }
    if (Array.isArray(adminIds)) {
      room.adminIds = Array.from(
        new Set([
          room.ownerId,
          ...adminIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())),
        ])
      );
      // Все администраторы также являются участниками комнаты
      room.memberIds = Array.from(new Set([...room.memberIds, ...room.adminIds]));
    }

    rooms.set(room.id, room);
    saveStore();
    io.emit('rooms:update', Array.from(rooms.values()));
    res.json({ ok: true, room });
  });

  // DELETE /api/rooms/:roomId — Удаление группового чата или канала владельцем
  app.delete('/api/rooms/:roomId', (req, res) => {
    const { roomId } = req.params;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : req.body?.userId;
    const room = rooms.get(roomId);
    if (!room) {
      res.status(404).json({ error: 'Группа или канал не найдены' });
      return;
    }
    if (userId && room.ownerId !== userId) {
      res.status(403).json({ error: 'Удалить группу или канал может только создатель' });
      return;
    }
    rooms.delete(roomId);
    messages.delete(roomId);
    conversations.delete(roomId);
    saveStore();
    io.emit('rooms:update', Array.from(rooms.values()));
    res.json({ ok: true });
  });

  // Общая функция валидации, сохранения и рассылки сообщения (текст, голосовое, видеокружок)
  const processAndPersistMessage = (payload: {
    id?: string;
    senderId: string;
    recipientId: string;
    text?: string;
    attachmentType?: MessageAttachmentType;
    mediaUrl?: string;
    mediaDuration?: number;
    waveform?: number[];
  }): { ok: boolean; message?: ChatMessage; error?: string } => {
    const { senderId, recipientId, attachmentType, mediaUrl, mediaDuration, waveform } =
      payload || {};
    if (!senderId || !recipientId) {
      return { ok: false, error: 'Не указан отправитель или получатель' };
    }

    const isRoomTarget = isRoomId(recipientId);
    const targetRoom = isRoomTarget ? rooms.get(recipientId) : undefined;
    if (isRoomTarget && targetRoom) {
      if (!canUserPostInRoom(targetRoom, senderId)) {
        return {
          ok: false,
          error: 'Только администраторы могут публиковать записи в этом канале',
        };
      }
      if (targetRoom.type === 'group' && !targetRoom.memberIds.includes(senderId)) {
        targetRoom.memberIds.push(senderId);
        rooms.set(targetRoom.id, targetRoom);
      }
    }

    const isMedia = attachmentType === 'voice' || attachmentType === 'video_note';
    let sanitizedMediaUrl: string | undefined;
    let safeDuration: number | undefined;
    let safeWaveform: number[] | undefined;

    if (isMedia) {
      const mediaCheck = validateMediaAttachment(attachmentType, mediaUrl, mediaDuration);
      if (!mediaCheck.valid) {
        return { ok: false, error: mediaCheck.error || 'Некорректный медиафайл' };
      }
      sanitizedMediaUrl = mediaCheck.sanitizedUrl;
      safeDuration = mediaCheck.durationSec;
      if (attachmentType === 'voice') {
        safeWaveform = normalizeWaveform(waveform || [], 28);
      }
    } else if (!payload.text || !payload.text.trim()) {
      return { ok: false, error: 'Пустое сообщение' };
    }

    const fallbackText = isMedia
      ? formatMessagePreview({
          text: payload.text || '',
          attachmentType,
          mediaDuration: safeDuration,
        })
      : (payload.text || '').trim();

    const convId = getConversationId(senderId, recipientId);
    const existingList = messages.get(convId) || [];
    const existingMsg = payload.id ? existingList.find((m) => m.id === payload.id) : undefined;

    if (existingMsg) {
      return { ok: true, message: existingMsg };
    }

    const senderUser = users.get(senderId);

    const newMessage: ChatMessage = {
      id: payload.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      conversationId: convId,
      senderId,
      senderName: senderUser?.displayName,
      senderAvatarColor: senderUser?.avatarColor,
      senderAvatarUrl: senderUser?.avatarUrl,
      recipientId,
      text: (payload.text || '').trim() || fallbackText,
      createdAt: new Date().toISOString(),
      status: 'delivered',
      attachmentType: isMedia ? attachmentType : 'text',
      mediaUrl: sanitizedMediaUrl,
      mediaDuration: safeDuration,
      waveform: safeWaveform,
      viewsCount:
        targetRoom?.type === 'channel' ? Math.max(1, targetRoom.memberIds.length) : undefined,
    };

    existingList.push(newMessage);
    messages.set(convId, existingList);
    conversations.set(convId, {
      id: convId,
      participants: targetRoom ? targetRoom.memberIds : [senderId, recipientId],
      updatedAt: newMessage.createdAt,
    });
    saveStore();

    if (isRoomTarget) {
      if (targetRoom) {
        const recipients = new Set([
          senderId,
          targetRoom.ownerId,
          ...(targetRoom.adminIds || []),
          ...(targetRoom.memberIds || []),
        ]);
        for (const uid of recipients) {
          io.to(`user:${uid}`).emit('message:receive', newMessage);
        }
      } else {
        io.to(`user:${senderId}`).emit('message:receive', newMessage);
      }
    } else {
      io.to(`user:${senderId}`).emit('message:receive', newMessage);
      if (recipientId !== senderId) {
        io.to(`user:${recipientId}`).emit('message:receive', newMessage);
      }
    }

    return { ok: true, message: newMessage };
  };

  // Помечает входящие сообщения в диалоге прочитанными и рассылает уведомление отправителю (2 галочки)
  const markConversationAsReadAndNotify = (
    userA: string,
    userB: string
  ): { conversationId: string; changedIds: string[] } => {
    const convId = getConversationId(userA, userB);
    const currentList = messages.get(convId) || [];
    if (currentList.length === 0) {
      return { conversationId: convId, changedIds: [] };
    }

    const { updated, changedIds } = markConversationMessagesAsRead(currentList, userA);
    if (changedIds.length > 0) {
      messages.set(convId, updated);
      saveStore();

      const senderIds = new Set<string>();
      for (const msg of currentList) {
        if (changedIds.includes(msg.id)) {
          senderIds.add(msg.senderId);
        }
      }

      const payload = {
        conversationId: convId,
        readerId: userA,
        peerId: userB,
        messageIds: changedIds,
      };

      io.to(convId).emit('messages:read', payload);
      io.to(`user:${userA}`).emit('messages:read', payload);
      for (const sid of senderIds) {
        io.to(`user:${sid}`).emit('messages:read', payload);
      }
    }

    return { conversationId: convId, changedIds };
  };

  // GET /api/messages/:userA/:userB — История сообщений диалога, группы или канала
  app.get('/api/messages/:userA/:userB', (req, res) => {
    const { userA, userB } = req.params;
    if (req.query.markRead !== 'false') {
      markConversationAsReadAndNotify(userA, userB);
    }
    const convId = getConversationId(userA, userB);
    const history = (messages.get(convId) || []).map((m) => {
      if (!m.senderName) {
        const u = users.get(m.senderId);
        if (u) {
          return {
            ...m,
            senderName: u.displayName,
            senderAvatarColor: u.avatarColor,
            senderAvatarUrl: u.avatarUrl,
          };
        }
      }
      return m;
    });
    res.json({ conversationId: convId, messages: history });
  });

  // POST /api/messages/read — Явная отметка сообщений диалога как прочитанных собеседником
  app.post('/api/messages/read', (req, res) => {
    const { readerId, peerId, userId } = req.body as {
      readerId?: string;
      peerId?: string;
      userId?: string;
    };
    const effectiveReader = readerId || userId;
    if (!effectiveReader || !peerId) {
      res.status(400).json({ error: 'Не указан пользователь или собеседник' });
      return;
    }
    const result = markConversationAsReadAndNotify(effectiveReader, peerId);
    res.json({
      ok: true,
      conversationId: result.conversationId,
      readMessageIds: result.changedIds,
    });
  });

  // POST /api/messages — Надежная отправка текстовых сообщений, голосовых и видеокружков по HTTP
  app.post('/api/messages', (req, res) => {
    const result = processAndPersistMessage(req.body);
    if (!result.ok || !result.message) {
      res.status(400).json({ error: result.error || 'Не удалось отправить сообщение' });
      return;
    }
    res.status(201).json({ ok: true, message: result.message });
  });

  // Очистка только технических аккаунтов автотестов (pw_test_*), не затрагивая реальных пользователей
  app.post('/api/auth/cleanup-test-users', (_req, res) => {
    const testUserIds = new Set<string>();
    for (const [id, u] of users.entries()) {
      if (u.username.startsWith('pw_test_')) {
        testUserIds.add(id);
        users.delete(id);
      }
    }
    let removedRooms = false;
    for (const [roomId, r] of rooms.entries()) {
      if (
        testUserIds.has(r.ownerId) ||
        r.handle.startsWith('pw_test_') ||
        r.title.startsWith('PW_TEST_')
      ) {
        rooms.delete(roomId);
        messages.delete(roomId);
        conversations.delete(roomId);
        removedRooms = true;
      }
    }
    if (testUserIds.size > 0 || removedRooms) {
      for (const [convId] of messages.entries()) {
        for (const testId of testUserIds) {
          if (convId.includes(testId)) {
            messages.delete(convId);
            conversations.delete(convId);
          }
        }
      }
      saveStore();
      io.emit('users:update', Array.from(users.values()).map(sanitizeUser));
      io.emit('rooms:update', Array.from(rooms.values()));
    }
    res.json({ ok: true });
  });

  // ============================================================================
  // 2. SOCKET.IO: РЕАЛЬНОЕ ВРЕМЯ (ЧАТ, ОНЛАЙН-СТАТУСЫ И WEBRTC СИГНАЛИНГ)
  // ============================================================================
  io.on('connection', (socket) => {
    let currentUserId: string | null = null;

    socket.on(
      'user:online',
      (
        payload:
          | string
          | { userId: string; token?: string; user?: Partial<UserProfile> }
      ) => {
        const userId = typeof payload === 'string' ? payload : payload?.userId;
        if (!userId) return;

        if (!users.has(userId) && typeof payload === 'object' && payload.token) {
          try {
            const decoded = jwt.verify(payload.token, JWT_SECRET) as {
              userId?: string;
              username?: string;
              displayName?: string;
              avatarColor?: string;
              role?: string;
              passwordHash?: string;
            };
            restoreUserFromDecodedToken(decoded, payload.user);
          } catch {
            // ignore
          }
        }

        if (!users.has(userId)) return;
        currentUserId = userId;

        if (!userSockets.has(userId)) {
          userSockets.set(userId, new Set());
        }
        userSockets.get(userId)!.add(socket.id);

        socket.join(`user:${userId}`);

        const userRecord = users.get(userId)!;
        userRecord.online = true;
        userRecord.lastSeen = new Date().toISOString();

        io.emit('users:update', Array.from(users.values()).map(sanitizeUser));
      }
    );

    socket.on('conversation:join', ({ userA, userB }: { userA: string; userB: string }) => {
      const convId = getConversationId(userA, userB);
      socket.join(convId);
      markConversationAsReadAndNotify(userA, userB);
    });

    socket.on(
      'messages:read',
      ({ readerId, peerId }: { readerId: string; peerId: string }) => {
        if (!readerId || !peerId) return;
        markConversationAsReadAndNotify(readerId, peerId);
      }
    );

    socket.on(
      'message:send',
      (payload: {
        id?: string;
        senderId: string;
        recipientId: string;
        text?: string;
        attachmentType?: MessageAttachmentType;
        mediaUrl?: string;
        mediaDuration?: number;
        waveform?: number[];
      }) => {
        processAndPersistMessage(payload);
      }
    );

    socket.on(
      'typing:start',
      ({ senderId, recipientId }: { senderId: string; recipientId: string }) => {
        if (isRoomId(recipientId)) {
          socket.broadcast.emit('typing:status', {
            userId: recipientId,
            actorId: senderId,
            isTyping: true,
          });
        } else {
          io.to(`user:${recipientId}`).emit('typing:status', { userId: senderId, isTyping: true });
        }
      }
    );

    socket.on(
      'typing:stop',
      ({ senderId, recipientId }: { senderId: string; recipientId: string }) => {
        if (isRoomId(recipientId)) {
          socket.broadcast.emit('typing:status', {
            userId: recipientId,
            actorId: senderId,
            isTyping: false,
          });
        } else {
          io.to(`user:${recipientId}`).emit('typing:status', { userId: senderId, isTyping: false });
        }
      }
    );

    // Сигналинг WebRTC
    socket.on(
      'call:user',
      (data: {
        userToCall: string;
        from: string;
        callerName: string;
        mediaType: 'audio' | 'video';
        signalData: RTCSessionDescriptionInit | null;
      }) => {
        io.to(`user:${data.userToCall}`).emit('call:incoming', {
          from: data.from,
          callerName: data.callerName,
          mediaType: data.mediaType,
          signalData: data.signalData,
        });
      }
    );

    socket.on(
      'call:answer',
      (data: { to: string; from: string; signalData: RTCSessionDescriptionInit | null }) => {
        io.to(`user:${data.to}`).emit('call:accepted', {
          from: data.from,
          signalData: data.signalData,
        });
      }
    );

    socket.on(
      'webrtc:ice-candidate',
      (data: { to: string; from: string; candidate: RTCIceCandidateInit }) => {
        io.to(`user:${data.to}`).emit('webrtc:ice-candidate', {
          from: data.from,
          candidate: data.candidate,
        });
      }
    );

    socket.on('call:end', (data: { to: string; from: string; reason?: string }) => {
      io.to(`user:${data.to}`).emit('call:ended', {
        from: data.from,
        reason: data.reason || 'hangup',
      });
    });

    socket.on('disconnect', () => {
      if (currentUserId && userSockets.has(currentUserId)) {
        const set = userSockets.get(currentUserId)!;
        set.delete(socket.id);
        if (set.size === 0) {
          userSockets.delete(currentUserId);
          const u = users.get(currentUserId);
          if (u) {
            u.online = false;
            u.lastSeen = new Date().toISOString();
            saveStore();
          }
        }
        io.emit('users:update', Array.from(users.values()).map(sanitizeUser));
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer,
          path: '/__vite_hmr',
        },
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Pulse] Сервер запущен на http://localhost:${PORT}`);
  });
}

startServer();
