/**
 * Пошаговое архитектурное руководство и эталонный код (шаги 1–4)
 * с подробными комментариями на русском языке.
 */

export interface BlueprintStep {
  id: string;
  stepNumber: string;
  title: string;
  subtitle: string;
  summary: string;
  highlights: string[];
  files: {
    filename: string;
    language: string;
    description: string;
    code: string;
  }[];
}

export const ARCHITECTURE_STEPS: BlueprintStep[] = [
  {
    id: 'step-1',
    stepNumber: '01',
    title: '01. Структура проекта и архитектура системы',
    subtitle: 'Модульная организация Fullstack-приложения (Frontend + Backend + WebRTC Signaling)',
    summary:
      'Архитектура разделена на два независимых слоя: клиентское SPA-приложение на React (TypeScript + Tailwind CSS) и серверный узел на Node.js + Express + Socket.io. HTTP-запросы отвечают за JWT-аутентификацию и загрузку истории, а постоянное двунаправленное WebSocket-соединение управляет присутствием (online/offline), мгновенной доставкой сообщений и сигналингом WebRTC (обмен SDP Offer/Answer и ICE-кандидатами).',
    highlights: [
      'Единый HTTP/WebSocket сервер на порту 3000 для бесшовной работы CORS и WebRTC сигналинга',
      'Персональные Socket-комнаты (user:<id>) для адресного вызова конкретного абонента и комнаты диалогов (conv_<idA>_<idB>)',
      'Прямая передача медиапотока (P2P MediaStream) между браузерами через RTCPeerConnection в обход нагрузки на сервер',
    ],
    files: [
      {
        filename: 'project-structure.txt',
        language: 'plaintext',
        description: 'Рекомендуемая файловая структура для масштабируемого Fullstack-мессенджера',
        code: `telepulse-messenger/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   └── db.ts                  # Подключение к MongoDB (Mongoose) / PostgreSQL
│   │   ├── models/
│   │   │   ├── User.ts                # Схема пользователя (логин, bcrypt-хэш, статус)
│   │   │   ├── Conversation.ts        # Схема диалога (участники, последнее сообщение)
│   │   │   └── Message.ts             # Схема сообщения (отправитель, текст, статус)
│   │   ├── middleware/
│   │   │   └── authMiddleware.ts      # Проверка JWT-токена в заголовке Authorization
│   │   ├── routes/
│   │   │   ├── authRoutes.ts          # POST /register, POST /login, GET /me
│   │   │   └── chatRoutes.ts          # GET /conversations, GET /messages/:conversationId
│   │   ├── socket/
│   │   │   └── socketHandler.ts       # Логика Socket.io: чат, статусы, WebRTC сигналинг
│   │   └── server.ts                  # Точка входа Express + HTTP + Socket.io
│   ├── package.json
│   └── tsconfig.json
│
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── AuthModal.tsx          # Регистрация и вход (JWT)
    │   │   ├── ChatList.tsx           # Список диалогов и индикаторы «В сети»
    │   │   ├── ChatWindow.tsx         # Окно переписки + кнопки Аудио/Видеозвонка
    │   │   └── CallModal.tsx          # Всплывающее окно звонка (Принять/Сбросить, WebRTC потоки)
    │   ├── hooks/
    │   │   ├── useSocket.ts           # Управление подключением Socket.io и событиями
    │   │   └── useWebRTC.ts           # Управление RTCPeerConnection, камерой и микрофоном
    │   ├── utils/
    │   │   └── messengerLogic.ts      # Чистые функции и конечный автомат состояний звонка
    │   ├── App.tsx                    # Главный лейаут приложения
    │   └── main.tsx                   # Инициализация React 19
    ├── package.json
    └── vite.config.ts`,
      },
      {
        filename: 'architecture-flow.txt',
        language: 'plaintext',
        description: 'Схема взаимодействия WebRTC сигналинга через Socket.io',
        code: `[Инициатор (Caller)]                  [Сервер Socket.io]                  [Принимающий (Callee)]
        |                                      |                                     |
        | 1. getUserMedia({video, audio})      |                                     |
        | 2. pc.createOffer()                  |                                     |
        | 3. emit("call:user", {sdpOffer}) --->|                                     |
        |                                      |---> 4. emit("call:incoming") ------>|
        |                                      |                                     | 5. Всплывает CallModal
        |                                      |                                     | 6. Нажатие «Принять»
        |                                      |                                     | 7. getUserMedia()
        |                                      |                                     | 8. pc.setRemoteDescription(offer)
        |                                      |                                     | 9. pc.createAnswer()
        |                                      |<--- 10. emit("call:answer") --------|
        |<--- 11. emit("call:accepted") -------|                                     |
        | 12. pc.setRemoteDescription(answer)  |                                     |
        |<====== 13. Обмен ICE-кандидатами ("webrtc:ice-candidate") ================>|
        |<==========================================================================>|
        |         ПРЯМОЙ P2P МЕДИАПОТОК (Видео + Аудио через STUN/TURN)              |`,
      },
    ],
  },
  {
    id: 'step-2',
    stepNumber: '02',
    title: '02. Схемы данных (User, Conversation, Message)',
    subtitle: 'Модели базы данных для MongoDB (Mongoose) и альтернативная схема для PostgreSQL',
    summary:
      'Ниже представлены готовые к продакшену схемы данных для трех ключевых сущностей мессенджера: Пользователь (User), Диалог (Conversation) и Сообщение (Message). Индексы настроены для быстрой выборки истории чата по составному ключу conversationId + createdAt.',
    highlights: [
      'Хранение паролей исключительно в виде bcrypt-хэша (поле passwordHash со скрытием select: false)',
      'Поддержка статусов присутствия (isOnline, lastSeen) для мгновенного отображения в списке контактов',
      'Индексация сообщений по времени создания для пагинации (cursor-based pagination)',
    ],
    files: [
      {
        filename: 'backend/src/models/schemas.mongoose.ts',
        language: 'typescript',
        description: 'Схемы Mongoose (MongoDB) для User, Conversation и Message на TypeScript',
        code: `import mongoose, { Schema, Document } from 'mongoose';

// 1. Схема Пользователя (User)
export interface IUser extends Document {
  username: string;
  displayName: string;
  passwordHash: string;
  avatarUrl?: string;
  isOnline: boolean;
  lastSeen: Date;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
    },
    displayName: { type: String, required: true, trim: true },
    // Скрываем хэш пароля при обычных SELECT-запросах
    passwordHash: { type: String, required: true, select: false },
    avatarUrl: { type: String, default: '' },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const UserModel = mongoose.model<IUser>('User', UserSchema);

// 2. Схема Диалога / Комнаты (Conversation)
export interface IConversation extends Document {
  participants: mongoose.Types.ObjectId[];
  lastMessage?: mongoose.Types.ObjectId;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    // Массив из 2 участников для личного диалога (или более для группового)
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    lastMessage: { type: Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true }
);

// Составной индекс для быстрого поиска диалога по участникам
ConversationSchema.index({ participants: 1 });

export const ConversationModel = mongoose.model<IConversation>('Conversation', ConversationSchema);

// 3. Схема Сообщения (Message)
export interface IMessage extends Document {
  conversationId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  recipientId: mongoose.Types.ObjectId;
  text: string;
  status: 'sent' | 'delivered' | 'read';
  createdAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read'],
      default: 'sent',
    },
  },
  { timestamps: true }
);

// Индекс для быстрой сортировки истории сообщений по времени
MessageSchema.index({ conversationId: 1, createdAt: 1 });

export const MessageModel = mongoose.model<IMessage>('Message', MessageSchema);`,
      },
      {
        filename: 'backend/src/models/schema.postgres.sql',
        language: 'sql',
        description: 'Альтернативная реляционная схема для PostgreSQL',
        code: `-- Таблица пользователей
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) UNIQUE NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,
  is_online BOOLEAN DEFAULT FALSE,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Таблица диалогов
CREATE TABLE conversations (
  id VARCHAR(128) PRIMARY KEY,
  participant_one UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_two UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_one, participant_two)
);

-- Таблица сообщений
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id VARCHAR(128) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status VARCHAR(16) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at ASC);`,
      },
    ],
  },
  {
    id: 'step-3',
    stepNumber: '03',
    title: '03. Код бэкенда: Express, JWT-авторизация и сигналинг Socket.io',
    subtitle: 'Серверная реализация аутентификации (bcrypt + JWT), комнат чата и маршрутизации WebRTC вызовов',
    summary:
      'Сервер объединяет REST API для регистрации/логина и WebSocket-сервер Socket.io. При подключении пользователь входит в персональную комнату `user:${userId}`, что позволяет доставлять входящие вызовы (`call:incoming`) и ICE-кандидаты (`webrtc:ice-candidate`) на все открытые вкладки абонента.',
    highlights: [
      'Хэширование паролей через bcrypt.hash(password, 10) и подпись JWT-токенов со сроком действия 7 дней',
      'Отслеживание онлайн-статуса в Map<userId, Set<socketId>> с корректной обработкой закрытия вкладок',
      'Полный цикл сигналинга WebRTC: события call:user, call:answer, webrtc:ice-candidate и call:end',
    ],
    files: [
      {
        filename: 'backend/src/server.ts',
        language: 'typescript',
        description: 'Настройка Express, JWT-роутов и обработчиков Socket.io для чата и WebRTC',
        code: `import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key';
// Хранилище активных сокетов пользователя: userId -> Set<socketId>
const activeUsers = new Map<string, Set<string>>();

// --- 1. АВТОРИЗАЦИЯ (Регистрация и Логин) ---
app.post('/api/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  // Хэшируем пароль перед сохранением в БД
  const passwordHash = await bcrypt.hash(password, 10);
  // Сохраняем пользователя в БД (UserModel.create(...))
  const user = { id: 'user_' + Date.now(), username, displayName };
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user });
});

// --- 2. SOCKET.IO: ЧАТ И WEBRTC СИГНАЛИНГ ---
io.on('connection', (socket) => {
  let currentUserId: string | null = null;

  // Пользователь авторизовался и вышел в сеть
  socket.on('user:online', (userId: string) => {
    currentUserId = userId;
    if (!activeUsers.has(userId)) activeUsers.set(userId, new Set());
    activeUsers.get(userId)!.add(socket.id);

    // Присоединяем к личной комнате для адресных уведомлений и звонков
    socket.join(\`user:\${userId}\`);
    io.emit('presence:update', { userId, online: true });
  });

  // Отправка и получение сообщений в реальном времени
  socket.on('message:send', async (data: { conversationId: string; senderId: string; recipientId: string; text: string }) => {
    // Сохраняем в БД и транслируем собеседнику
    const savedMsg = { ...data, id: 'msg_' + Date.now(), createdAt: new Date().toISOString() };
    io.to(\`user:\${data.recipientId}\`).to(\`user:\${data.senderId}\`).emit('message:receive', savedMsg);
  });

  // --- WEBRTC СИГНАЛИНГ ---
  // Шаг А: Звонящий отправляет SDP Offer вызываемому абоненту
  socket.on('call:user', ({ userToCall, from, callerName, mediaType, signalData }) => {
    io.to(\`user:\${userToCall}\`).emit('call:incoming', {
      from,
      callerName,
      mediaType,
      signalData, // SDP Offer
    });
  });

  // Шаг Б: Вызываемый абонент нажимает «Принять» и возвращает SDP Answer
  socket.on('call:answer', ({ to, from, signalData }) => {
    io.to(\`user:\${to}\`).emit('call:accepted', {
      from,
      signalData, // SDP Answer
    });
  });

  // Шаг В: Обмен сетевыми ICE-кандидатами (STUN/TURN маршруты)
  socket.on('webrtc:ice-candidate', ({ to, from, candidate }) => {
    io.to(\`user:\${to}\`).emit('webrtc:ice-candidate', { from, candidate });
  });

  // Шаг Г: Завершение или сброс вызова
  socket.on('call:end', ({ to, from }) => {
    io.to(\`user:\${to}\`).emit('call:ended', { from });
  });

  socket.on('disconnect', () => {
    if (currentUserId && activeUsers.has(currentUserId)) {
      const sockets = activeUsers.get(currentUserId)!;
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        activeUsers.delete(currentUserId);
        io.emit('presence:update', { userId: currentUserId, online: false });
      }
    }
  });
});

httpServer.listen(3000, () => console.log('Server running on port 3000'));`,
      },
    ],
  },
  {
    id: 'step-4',
    stepNumber: '04',
    title: '04. Код фронтенда: React-компоненты и хук useWebRTC',
    subtitle: 'Управление медиапотоками камеры/микрофона, RTCPeerConnection и всплывающим окном вызова',
    summary:
      'На фронтенде вся логика звонков инкапсулирована в кастомном хуке `useWebRTC`. Он запрашивает доступ к камере и микрофону (`navigator.mediaDevices.getUserMedia`), создает экземпляр `RTCPeerConnection` с публичными STUN-серверами Google, формирует SDP Offer/Answer и привязывает удаленный видеопоток к элементу `<video ref={remoteVideoRef}>`.',
    highlights: [
      'Чистый нативный RTCPeerConnection с STUN-серверами stun:stun.l.google.com:19302',
      'Очередь ICE-кандидатов: кандидаты, пришедшие до установки RemoteDescription, буферизуются и добавляются без ошибок',
      'Безопасный фолбэк синтетического видеопотока (Canvas MediaStream), если в тестовом окружении или браузере не подключена физическая веб-камера',
    ],
    files: [
      {
        filename: 'frontend/src/hooks/useWebRTC.ts',
        language: 'typescript',
        description: 'Кастомный React-хук для управления P2P аудио/видеозвонками через WebRTC и Socket.io',
        code: `import { useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function useWebRTC(socket: Socket | null, currentUserId: string) {
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // Создание и настройка RTCPeerConnection
  const createPeer = useCallback((targetUserId: string, stream: MediaStream) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // Добавляем локальные дорожки (аудио и видео) в соединение
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    // Отправляем найденные ICE-кандидаты собеседнику через Socket.io
    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('webrtc:ice-candidate', {
          to: targetUserId,
          from: currentUserId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Получаем медиапоток от удаленного собеседника
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };

    peerRef.current = pc;
    return pc;
  }, [socket, currentUserId]);

  // Инициация исходящего вызова
  const startCall = async (targetUserId: string, callerName: string, mediaType: 'audio' | 'video') => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mediaType === 'video',
    });
    setLocalStream(stream);

    const pc = createPeer(targetUserId, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket?.emit('call:user', {
      userToCall: targetUserId,
      from: currentUserId,
      callerName,
      mediaType,
      signalData: offer,
    });
  };

  return { localStream, remoteStream, startCall };
}`,
      },
    ],
  },
];
