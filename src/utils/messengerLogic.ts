/**
 * Чистая бизнес-логика мессенджера и WebRTC сигналинга.
 * Отделена от UI и сетевого слоя для детерминированного модульного тестирования (node:test).
 */

export type ChatEntityKind = 'direct' | 'group' | 'channel';

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  avatarColor: string;
  avatarUrl?: string;
  role: string;
  online: boolean;
  lastSeen: string;
  kind?: ChatEntityKind;
  ownerId?: string;
  adminIds?: string[];
  memberIds?: string[];
  isPublic?: boolean;
  description?: string;
}

export interface ChatRoom {
  id: string;
  type: 'group' | 'channel';
  title: string;
  handle: string;
  description: string;
  avatarColor: string;
  avatarUrl?: string;
  ownerId: string;
  adminIds: string[];
  memberIds: string[];
  isPublic: boolean;
  createdAt: string;
}

export type MessageAttachmentType = 'text' | 'voice' | 'video_note';

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  senderAvatarColor?: string;
  senderAvatarUrl?: string;
  recipientId: string;
  text: string;
  createdAt: string;
  status: 'sent' | 'delivered' | 'read';
  attachmentType?: MessageAttachmentType;
  mediaUrl?: string;
  mediaDuration?: number;
  waveform?: number[];
  viewsCount?: number;
}

export interface ConversationItem {
  id: string;
  participants: string[];
  lastMessage?: ChatMessage;
  unreadCount: number;
}

export type CallState = 'idle' | 'calling' | 'ringing' | 'connected' | 'ended';
export type CallMediaType = 'audio' | 'video';

export interface ActiveCallSession {
  callId: string;
  callerId: string;
  callerName: string;
  calleeId: string;
  calleeName: string;
  mediaType: CallMediaType;
  state: CallState;
  startedAt?: number;
}

/**
 * Проверяет, является ли идентификатор групповым чатом или каналом.
 */
export function isRoomId(id?: string | null): boolean {
  if (!id) return false;
  const clean = id.trim();
  return clean.startsWith('group_') || clean.startsWith('channel_');
}

/**
 * Генерирует детерминированный идентификатор диалога между двумя пользователями
 * или возвращает ID комнаты для группового чата / канала.
 */
export function getConversationId(userA: string, userB: string): string {
  const cleanA = (userA || '').trim();
  const cleanB = (userB || '').trim();
  if (isRoomId(cleanA)) return cleanA;
  if (isRoomId(cleanB)) return cleanB;
  const sorted = [cleanA, cleanB].sort((a, b) => a.localeCompare(b));
  return `conv_${sorted[0]}_${sorted[1]}`;
}

/**
 * Возвращает ключ диалога (ID собеседника или ID группы/канала) для входящего/исходящего сообщения.
 */
export function getMessageTargetId(
  msg: Pick<ChatMessage, 'senderId' | 'recipientId' | 'conversationId'>,
  currentUserId: string
): string {
  if (isRoomId(msg.recipientId)) return msg.recipientId;
  if (isRoomId(msg.conversationId)) return msg.conversationId;
  return msg.senderId === currentUserId ? msg.recipientId : msg.senderId;
}

/**
 * Идемпотентное добавление сообщения в список (защита от дубликатов при реконнекте Socket.io).
 */
export function appendMessageIdempotent(
  messages: ChatMessage[],
  incoming: ChatMessage
): ChatMessage[] {
  if (!incoming || !incoming.id) {
    return messages;
  }
  const isMedia = incoming.attachmentType === 'voice' || incoming.attachmentType === 'video_note';
  const hasValidMedia = isMedia && Boolean(incoming.mediaUrl && incoming.mediaUrl.trim().length > 100);
  const hasContent = isMedia ? hasValidMedia : Boolean(incoming.text?.trim());
  if (!hasContent) {
    return messages;
  }
  const exists = messages.some((m) => m.id === incoming.id);
  if (exists) {
    return messages.map((m) =>
      m.id === incoming.id
        ? {
            ...m,
            ...incoming,
            mediaUrl: incoming.mediaUrl || m.mediaUrl,
          }
        : m
    );
  }
  return [...messages, incoming].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/**
 * Нормализует логин пользователя: убирает начальный символ '@', пробелы и приводит к нижнему регистру.
 */
export function normalizeUsername(username: string): string {
  if (!username) return '';
  return username.trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Оценивает надежность пароля по шкале от 0 до 3.
 */
export function validatePasswordStrength(password: string): {
  score: number;
  label: string;
  color: string;
} {
  if (!password || password.length === 0) {
    return { score: 0, label: '', color: '#6C7883' };
  }
  if (password.length < 6) {
    return { score: 1, label: 'Слишком короткий (минимум 6)', color: '#E53935' };
  }
  const hasLetters = /[a-zA-Zа-яА-ЯёЁ]/.test(password);
  const hasNumbers = /[0-9]/.test(password);
  const hasSymbols = /[^a-zA-Z0-9а-яА-ЯёЁ]/.test(password);

  if (password.length >= 10 && hasLetters && hasNumbers && hasSymbols) {
    return { score: 3, label: 'Отличный надежный пароль', color: '#4CAF50' };
  }
  if (password.length >= 8 && (hasLetters && hasNumbers || hasLetters && hasSymbols)) {
    return { score: 2, label: 'Хороший пароль', color: '#64B5EF' };
  }
  return { score: 1, label: 'Простой пароль', color: '#FFA726' };
}

/**
 * Валидация учетных данных при регистрации и входе.
 */
export function validateCredentials(
  username: string,
  password: string,
  isRegister = false,
  displayName = '',
  confirmPassword?: string
): { valid: boolean; error?: string; normalizedUsername?: string } {
  const cleanUser = normalizeUsername(username);
  if (cleanUser.length < 3) {
    return { valid: false, error: 'Имя пользователя должно содержать минимум 3 символа' };
  }
  if (!/^[a-z0-9_.-]+$/.test(cleanUser)) {
    return {
      valid: false,
      error: 'Имя пользователя может содержать только латинские буквы, цифры и символы _ . -',
    };
  }
  if (password.length < 6) {
    return { valid: false, error: 'Пароль должен содержать минимум 6 символов' };
  }
  if (isRegister) {
    if (displayName.trim().length < 2) {
      return { valid: false, error: 'Укажите отображаемое имя (минимум 2 символа)' };
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return { valid: false, error: 'Пароли не совпадают' };
    }
  }
  return { valid: true, normalizedUsername: cleanUser };
}

/**
 * Конечный автомат (State Machine) переходов состояния звонка WebRTC.
 */
export function transitionCallState(
  current: CallState,
  event: 'START_OUTGOING' | 'RECEIVE_INCOMING' | 'ACCEPT' | 'REJECT' | 'HANGUP'
): CallState {
  switch (event) {
    case 'START_OUTGOING':
      return current === 'idle' || current === 'ended' ? 'calling' : current;
    case 'RECEIVE_INCOMING':
      return current === 'idle' || current === 'ended' ? 'ringing' : current;
    case 'ACCEPT':
      return current === 'ringing' || current === 'calling' ? 'connected' : current;
    case 'REJECT':
    case 'HANGUP':
      return 'idle';
    default:
      return current;
  }
}

/**
 * Форматирование длительности звонка в табличный формат MM:SS.
 */
export function formatCallDuration(seconds: number): string {
  const safeSec = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safeSec / 60);
  const secs = safeSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Проверка корректности и размера Data URL загруженного аватара пользователя.
 */
export function validateAvatarDataUrl(dataUrl?: string | null): {
  valid: boolean;
  sanitized: string;
  error?: string;
} {
  if (!dataUrl || !dataUrl.trim()) {
    return { valid: true, sanitized: '' };
  }
  const trimmed = dataUrl.trim();
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
    return {
      valid: false,
      sanitized: '',
      error: 'Поддерживаются только изображения форматов JPG, PNG, WebP или GIF',
    };
  }
  if (trimmed.length > 700_000) {
    return {
      valid: false,
      sanitized: '',
      error: 'Размер обработанного изображения слишком велик',
    };
  }
  return { valid: true, sanitized: trimmed };
}

/**
 * Валидация формы сброса (восстановления) пароля.
 */
export function validatePasswordReset(
  username: string,
  newPassword: string,
  confirmPassword: string
): { valid: boolean; error?: string } {
  const cleanUser = username.trim();
  if (cleanUser.length < 3) {
    return { valid: false, error: 'Введите корректное имя пользователя (минимум 3 символа)' };
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(cleanUser)) {
    return {
      valid: false,
      error: 'Имя пользователя может содержать только латинские буквы, цифры и символы _ . -',
    };
  }
  if (newPassword.length < 6) {
    return { valid: false, error: 'Новый пароль должен содержать минимум 6 символов' };
  }
  if (newPassword !== confirmPassword) {
    return { valid: false, error: 'Пароли не совпадают' };
  }
  return { valid: true };
}

/**
 * Вычисляет обновленный счетчик непрочитанных сообщений для диалога.
 */
export function computeUpdatedUnreadCount(
  currentUnread: number,
  isFromOtherUser: boolean,
  isChatCurrentlyOpen: boolean
): number {
  if (!isFromOtherUser) return currentUnread;
  if (isChatCurrentlyOpen) return 0;
  return Math.max(0, currentUnread) + 1;
}

/**
 * Формирует заголовок и текст уведомления о новом сообщении или входящем звонке.
 */
export function buildNotificationPayload(
  type: 'message' | 'call',
  senderName: string,
  textOrMediaType: string
): { title: string; body: string } {
  const cleanSender = senderName.trim() || 'Пользователь Pulse';
  if (type === 'call') {
    const isVideo = textOrMediaType === 'video';
    return {
      title: `Входящий ${isVideo ? 'видеозвонок' : 'аудиозвонок'}`,
      body: `${cleanSender} вызывает вас в Pulse`,
    };
  }
  const preview =
    textOrMediaType.trim().length > 80
      ? `${textOrMediaType.trim().slice(0, 77)}...`
      : textOrMediaType.trim();
  return {
    title: `Новое сообщение от ${cleanSender}`,
    body: preview || 'Отправил(а) вам сообщение',
  };
}

/**
 * Нормализует заголовок Data URL медиафайла, убирая параметры кодеков с запятыми
 * (например, `data:video/webm;codecs=vp8,opus;base64,...` -> `data:video/webm;base64,...`),
 * которые ломают парсер RFC 2397 в теге <video> и валидацию на сервере.
 */
export function normalizeMediaDataUrl(
  rawUrl?: string | null,
  attachmentType?: MessageAttachmentType
): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed.startsWith('data:')) return '';

  const base64Marker = ';base64,';
  const markerIdx = trimmed.indexOf(base64Marker);
  if (markerIdx === -1) {
    return trimmed;
  }

  const header = trimmed.slice(5, markerIdx).toLowerCase();
  const payload = trimmed.slice(markerIdx + base64Marker.length).replace(/\s+/g, '');
  if (!payload) return '';

  const mimeMain = header.split(';')[0].trim();

  if (attachmentType === 'video_note') {
    if (!mimeMain.startsWith('video/')) {
      return `data:${mimeMain || 'application/octet-stream'};base64,${payload}`;
    }
    const cleanVideoMime = mimeMain.includes('mp4') ? 'video/mp4' : 'video/webm';
    return `data:${cleanVideoMime};base64,${payload}`;
  }

  if (attachmentType === 'voice') {
    if (!mimeMain.startsWith('audio/') && !mimeMain.startsWith('video/')) {
      return `data:${mimeMain || 'application/octet-stream'};base64,${payload}`;
    }
    let cleanAudioMime = 'audio/webm';
    if (mimeMain.includes('wav')) cleanAudioMime = 'audio/wav';
    else if (mimeMain.includes('mp4') || mimeMain.includes('aac') || mimeMain.includes('m4a'))
      cleanAudioMime = 'audio/mp4';
    else if (mimeMain.includes('ogg')) cleanAudioMime = 'audio/ogg';
    else if (mimeMain.includes('mpeg') || mimeMain.includes('mp3')) cleanAudioMime = 'audio/mpeg';
    return `data:${cleanAudioMime};base64,${payload}`;
  }

  return `data:${mimeMain || 'application/octet-stream'};base64,${payload}`;
}

/**
 * Проверка корректности голосового сообщения или видеокружка (Data URL и длительность).
 */
export function validateMediaAttachment(
  attachmentType?: MessageAttachmentType,
  mediaUrl?: string | null,
  mediaDuration?: number
): { valid: boolean; sanitizedUrl: string; durationSec: number; error?: string } {
  if (!attachmentType || attachmentType === 'text') {
    return { valid: true, sanitizedUrl: '', durationSec: 0 };
  }
  const trimmed = (mediaUrl || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      sanitizedUrl: '',
      durationSec: 0,
      error: 'Медиафайл пуст или не был записан',
    };
  }
  if (trimmed.length > 22_000_000) {
    return {
      valid: false,
      sanitizedUrl: '',
      durationSec: 0,
      error: 'Размер записи превышает допустимый лимит',
    };
  }

  const normalized = normalizeMediaDataUrl(trimmed, attachmentType);
  if (!normalized) {
    return {
      valid: false,
      sanitizedUrl: '',
      durationSec: 0,
      error: 'Некорректный формат медиафайла',
    };
  }

  if (attachmentType === 'voice') {
    if (!/^data:(audio|video)\/[a-zA-Z0-9.+_-]+;base64,[A-Za-z0-9+/=%]+$/i.test(normalized)) {
      return {
        valid: false,
        sanitizedUrl: '',
        durationSec: 0,
        error: 'Некорректный формат аудиозаписи',
      };
    }
  } else if (attachmentType === 'video_note') {
    if (!/^data:video\/[a-zA-Z0-9.+_-]+;base64,[A-Za-z0-9+/=%]+$/i.test(normalized)) {
      return {
        valid: false,
        sanitizedUrl: '',
        durationSec: 0,
        error: 'Некорректный формат видеокружка',
      };
    }
  }

  const safeDuration = Math.max(1, Math.min(300, Math.round(Number(mediaDuration) || 1)));
  return {
    valid: true,
    sanitizedUrl: normalized,
    durationSec: safeDuration,
  };
}

/**
 * Формирует текстовое описание сообщения для списка чатов и уведомлений
 * (например, «🎤 Голосовое сообщение (00:05)» или «📹 Видеокружок (00:04)»).
 */
export function formatMessagePreview(
  msg: Pick<ChatMessage, 'text' | 'attachmentType' | 'mediaDuration'>
): string {
  const dur = formatCallDuration(msg.mediaDuration || 1);
  if (msg.attachmentType === 'voice') {
    return `🎤 Голосовое сообщение (${dur})`;
  }
  if (msg.attachmentType === 'video_note') {
    return `📹 Видеокружок (${dur})`;
  }
  return msg.text;
}

/**
 * Нормализует массив амплитуд звука в фиксированное число столбиков (15..100) для волны голосового сообщения.
 */
export function normalizeWaveform(samples: number[], barCount = 28): number[] {
  const safeCount = Math.max(4, Math.min(64, Math.floor(barCount)));
  if (!Array.isArray(samples) || samples.length === 0) {
    return Array.from({ length: safeCount }, (_, i) =>
      Math.round(25 + 45 * Math.abs(Math.sin((i + 1) * 0.65)))
    );
  }
  const result: number[] = [];
  for (let i = 0; i < safeCount; i++) {
    const idx = Math.min(samples.length - 1, Math.floor((i * samples.length) / safeCount));
    const raw = Number(samples[idx]) || 0;
    const clamped = Math.max(15, Math.min(100, Math.round(raw)));
    result.push(clamped);
  }
  return result;
}

/**
 * Транслитерация кириллицы в латиницу для автоматической генерации короткой ссылки (@handle) группы или канала.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function generateRoomHandle(title: string, type: 'group' | 'channel'): string {
  const slug = title
    .trim()
    .toLowerCase()
    .split('')
    .map((ch) => (CYRILLIC_TO_LATIN[ch] !== undefined ? CYRILLIC_TO_LATIN[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  if (slug.length >= 3) {
    return slug;
  }
  return `${type}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Валидация параметров создания группового чата или канала.
 */
export function validateRoomCreation(input: {
  type?: string;
  title?: string;
  handle?: string;
  description?: string;
}): {
  valid: boolean;
  roomType: 'group' | 'channel';
  sanitizedTitle: string;
  sanitizedHandle: string;
  sanitizedDescription: string;
  error?: string;
} {
  const roomType: 'group' | 'channel' = input.type === 'channel' ? 'channel' : 'group';
  const cleanTitle = (input.title || '').trim();
  if (cleanTitle.length < 2) {
    return {
      valid: false,
      roomType,
      sanitizedTitle: '',
      sanitizedHandle: '',
      sanitizedDescription: '',
      error:
        roomType === 'channel'
          ? 'Название канала должно содержать минимум 2 символа'
          : 'Название группового чата должно содержать минимум 2 символа',
    };
  }
  if (cleanTitle.length > 80) {
    return {
      valid: false,
      roomType,
      sanitizedTitle: '',
      sanitizedHandle: '',
      sanitizedDescription: '',
      error: 'Название не должно превышать 80 символов',
    };
  }

  const rawHandle = (input.handle || '').trim().replace(/^@+/, '').toLowerCase();
  let sanitizedHandle = rawHandle;
  if (rawHandle) {
    if (rawHandle.length < 3 || !/^[a-z0-9_.-]+$/.test(rawHandle)) {
      return {
        valid: false,
        roomType,
        sanitizedTitle: '',
        sanitizedHandle: '',
        sanitizedDescription: '',
        error: 'Ссылка (@handle) должна содержать минимум 3 символа (латиница, цифры, _)',
      };
    }
  } else {
    sanitizedHandle = generateRoomHandle(cleanTitle, roomType);
  }

  const sanitizedDescription = (input.description || '').trim().slice(0, 240);

  return {
    valid: true,
    roomType,
    sanitizedTitle: cleanTitle,
    sanitizedHandle,
    sanitizedDescription,
  };
}

/**
 * Проверяет, имеет ли пользователь доступ к групповому чату или каналу:
 * общие чаты и каналы видят только создатель (ownerId), администраторы (adminIds) и приглашенные участники (memberIds).
 */
export function canUserAccessRoom(
  room: Pick<ChatRoom, 'ownerId' | 'adminIds' | 'memberIds'>,
  userId: string
): boolean {
  const cleanId = (userId || '').trim();
  if (!cleanId || !room) return false;
  if (room.ownerId === cleanId) return true;
  if (Array.isArray(room.adminIds) && room.adminIds.includes(cleanId)) return true;
  if (Array.isArray(room.memberIds) && room.memberIds.includes(cleanId)) return true;
  return false;
}

/**
 * Проверяет, имеет ли пользователь права администратора группового чата или канала
 * (редактирование аватара, названия, описания, приглашение и удаление участников).
 */
export function canUserAdministerRoom(
  room: Pick<ChatRoom, 'ownerId' | 'adminIds'>,
  userId: string
): boolean {
  const cleanId = (userId || '').trim();
  if (!cleanId || !room) return false;
  if (room.ownerId === cleanId) return true;
  return Array.isArray(room.adminIds) && room.adminIds.includes(cleanId);
}

/**
 * Проверяет, имеет ли пользователь право отправлять сообщения в комнату:
 * - В групповом чате ('group') писать могут только участники этой группы.
 * - В канале ('channel') публиковать посты могут только создатель (ownerId) и администраторы (adminIds).
 */
export function canUserPostInRoom(
  room: Pick<ChatRoom, 'type' | 'ownerId' | 'adminIds' | 'memberIds'>,
  userId: string
): boolean {
  if (!userId) return false;
  if (room.type === 'channel') {
    return canUserAdministerRoom(room, userId);
  }
  return canUserAccessRoom(room, userId);
}

/**
 * Форматирует подпись с числом участников группы или подписчиков канала на русском языке.
 */
export function formatRoomMembersLabel(type: 'group' | 'channel', count: number): string {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const mod10 = n % 10;
  const mod100 = n % 100;

  if (type === 'channel') {
    if (mod10 === 1 && mod100 !== 11) return `${n} подписчик`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} подписчика`;
    return `${n} подписчиков`;
  }

  if (mod10 === 1 && mod100 !== 11) return `${n} участник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} участника`;
  return `${n} участников`;
}

/**
 * Преобразует объект группового чата или канала в профиль списка чатов (`UserProfile`),
 * сохраняя тип (`kind: 'group' | 'channel'`) и метаданные участников.
 */
export function roomToContactProfile(room: ChatRoom): UserProfile {
  const memberCount = Array.isArray(room.memberIds) ? room.memberIds.length : 1;
  const countLabel = formatRoomMembersLabel(room.type, memberCount);
  return {
    id: room.id,
    username: room.handle,
    displayName: room.title,
    avatarColor: room.avatarColor || (room.type === 'channel' ? '#8E57C2' : '#3E9F65'),
    avatarUrl: room.avatarUrl,
    role: room.description || countLabel,
    online: true,
    lastSeen: room.createdAt,
    kind: room.type,
    ownerId: room.ownerId,
    adminIds: room.adminIds || [room.ownerId],
    memberIds: room.memberIds || [room.ownerId],
    isPublic: room.isPublic ?? false,
    description: room.description || '',
  };
}

/**
 * Фильтрует список чатов и участников для левой панели:
 * - Общие чаты (группы и каналы) видят ТОЛЬКО создатель и приглашенные туда участники.
 * - Другие участники не отображаются сразу по умолчанию: без поискового запроса видны только
 *   уже начатые личные диалоги (где есть переписка) и доступные пользователю группы/каналы.
 * - При вводе поискового запроса (searchQuery) находятся участники по имени или @username.
 */
export function filterVisibleContactsAndRooms(params: {
  contacts: UserProfile[];
  currentUserId: string;
  summaries: Record<string, { lastMessage?: ChatMessage | null; unreadCount: number }>;
  searchQuery: string;
  activeTab: 'chats' | 'contacts';
  filterKind: 'all' | 'direct' | 'group' | 'channel';
  selectedContactId?: string | null;
}): UserProfile[] {
  const {
    contacts,
    currentUserId,
    summaries,
    searchQuery,
    activeTab,
    filterKind,
    selectedContactId,
  } = params;
  const q = (searchQuery || '').trim().toLowerCase().replace(/^@+/, '');
  const hasSearch = q.length > 0;

  return (contacts || []).filter((c) => {
    if (!c || c.id === currentUserId) return false;
    const itemKind = c.kind || 'direct';

    if (activeTab === 'contacts') {
      if (itemKind !== 'direct') return false;
      // В разделе «Контакты» участники видны ТОЛЬКО если найти их по поиску
      if (!hasSearch) return false;
      return (
        c.displayName.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q)
      );
    }

    if (filterKind !== 'all' && itemKind !== filterKind) {
      return false;
    }

    // Проверка прав доступа к группе или каналу (только создатель и приглашенные)
    if (itemKind === 'group' || itemKind === 'channel') {
      const canSeeRoom = canUserAccessRoom(
        {
          ownerId: c.ownerId || '',
          adminIds: c.adminIds || [],
          memberIds: c.memberIds || [],
        },
        currentUserId
      );
      if (!canSeeRoom) return false;

      if (!hasSearch) return true;
      return (
        c.displayName.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q)
      );
    }

    // Для личных контактов (direct):
    // Без поиска показываем только тех, с кем уже есть переписка (или открыт активный диалог)
    if (!hasSearch) {
      const hasHistory = Boolean(summaries?.[c.id]?.lastMessage);
      const isCurrentlySelected = Boolean(selectedContactId && selectedContactId === c.id);
      return hasHistory || isCurrentlySelected;
    }

    return (
      c.displayName.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q)
    );
  });
}

/**
 * Ищет пользователей по имени или @username для приглашения в группу или канал.
 * Без поискового запроса список скрыт, чтобы все участники не были видны сразу.
 */
export function searchUsersToInvite(
  users: UserProfile[],
  currentUserId: string,
  excludeUserIds: string[],
  query: string
): UserProfile[] {
  const q = (query || '').trim().toLowerCase().replace(/^@+/, '');
  if (!q) return [];
  const excluded = new Set([currentUserId, ...(excludeUserIds || [])]);

  return (users || []).filter((u) => {
    if (!u || excluded.has(u.id)) return false;
    if (u.kind && u.kind !== 'direct') return false;
    return (
      u.displayName.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q)
    );
  });
}

/**
 * Возвращает метаданные индикатора статуса отправленного сообщения:
 * - 1 галочка (checkmarksCount: 1) — доставлено на сервер ('sent' | 'delivered')
 * - 2 галочки (checkmarksCount: 2) — прочитано собеседником ('read')
 */
export function getMessageReadStatusMeta(status?: ChatMessage['status']): {
  isRead: boolean;
  checkmarksCount: 1 | 2;
  label: string;
} {
  if (status === 'read') {
    return {
      isRead: true,
      checkmarksCount: 2,
      label: 'Прочитано собеседником',
    };
  }
  return {
    isRead: false,
    checkmarksCount: 1,
    label: 'Доставлено на сервер',
  };
}

/**
 * Помечает все входящие сообщения в диалоге (отправленные не readerId) как прочитанные ('read').
 * Возвращает обновленный массив сообщений и список ID сообщений, чей статус изменился.
 */
export function markConversationMessagesAsRead(
  messages: ChatMessage[],
  readerId: string
): { updated: ChatMessage[]; changedIds: string[] } {
  const cleanReader = (readerId || '').trim();
  if (!cleanReader || !Array.isArray(messages) || messages.length === 0) {
    return { updated: messages || [], changedIds: [] };
  }

  const changedIds: string[] = [];
  const updated = messages.map((msg) => {
    if (msg.senderId !== cleanReader && msg.status !== 'read') {
      changedIds.push(msg.id);
      return {
        ...msg,
        status: 'read' as const,
      };
    }
    return msg;
  });

  return { updated, changedIds };
}

/**
 * Применяет событие прочтения (messages:read) к локальному списку сообщений отправителя.
 */
export function applyReadReceiptToMessages(
  messages: ChatMessage[],
  readMessageIds: string[],
  conversationId?: string
): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const idSet = new Set(Array.isArray(readMessageIds) ? readMessageIds : []);

  return messages.map((msg) => {
    if (idSet.has(msg.id) || (conversationId && msg.conversationId === conversationId && idSet.size === 0)) {
      if (msg.status !== 'read') {
        return { ...msg, status: 'read' as const };
      }
    }
    return msg;
  });
}

export interface DeviceSessionInfo {
  id: string;
  deviceName: string;
  browser: string;
  ip?: string;
  lastActiveAt: string;
  isCurrent?: boolean;
}

export interface StorageBackendOption {
  id: string;
  title: string;
  badge: string;
  badgeColor: string;
  description: string;
  features: string[];
  pros: string[];
  cons: string[];
  recommendedFor: string;
  isCurrentActive?: boolean;
}

/**
 * Варианты хранения данных мессенджера Pulse (архитектурный обзор).
 */
export const STORAGE_BACKEND_OPTIONS: StorageBackendOption[] = [
  {
    id: 'pulse_server_wal',
    title: 'Серверный Pulse WAL Store (Текущее)',
    badge: 'Активно сейчас',
    badgeColor: '#4CAF50',
    description:
      'Атомарное файловое хранилище на сервере Node.js с гарантией целостности через Write-Ahead Log (WAL), временные файлы и автоматическую синхронизацию в реальном времени через Socket.io.',
    features: [
      'Мгновенная синхронизация между всеми открытыми устройствами (WebSockets)',
      'Полная автономность (работает без сторонних облачных аккаунтов и API-ключей)',
      'Атомарная запись на диск (temp-файл + rename)',
      'Поддержка видеокружков, голосовых, каналов и групп',
    ],
    pros: [
      'Полный контроль над кодом и данными',
      'Нулевая задержка сигналов WebRTC и сообщений',
      '100% совместимость с локальным и облачным деплоем',
    ],
    cons: [
      'Масштабирование на несколько серверов требует общего диска или Redis',
    ],
    recommendedFor: 'Разработка, прототипирование, внутренние корпоративные сети и локальный запуск.',
    isCurrentActive: true,
  },
  {
    id: 'firebase_firestore',
    title: 'Google Cloud Firebase (Firestore + Auth + Storage)',
    badge: 'Подключено к проекту',
    badgeColor: '#4CAF50',
    description:
      'Облачная бессерверная NoSQL-база данных от Google с нативной поддержкой real-time слушателей (onSnapshot), оффлайн-кэшированием и сервисом авторизации Firebase Auth.',
    features: [
      'Нативные real-time подписки на коллекции чатов и сообщений',
      'Firebase Auth (Email/пароль, Google OAuth, телефон)',
      'Cloud Storage для хранения тяжелых видеокружков и аудиосообщений',
      'Оффлайн-синхронизация на смартфонах и в браузере',
    ],
    pros: [
      'Не нужно администрировать сервер баз данных',
      'Бесплатный щедрый тариф Spark',
      'В AI Studio есть встроенный инструмент мгновенного подключения',
    ],
    cons: [
      'При огромном числе сообщений стоимость запросов на чтение/запись может расти',
    ],
    recommendedFor: 'Продакшен-мессенджеры, мобильные приложения, кросс-платформенные клиенты.',
  },
  {
    id: 'postgresql_cloudsql',
    title: 'PostgreSQL / Cloud SQL (Реляционная база данных)',
    badge: 'Корпоративный стандарт',
    badgeColor: '#5288C1',
    description:
      'Мощная реляционная СУБД с полной поддержкой транзакций (ACID), типизированной схемой (Drizzle/Prisma ORM) и сложными аналитическими запросами.',
    features: [
      'Строгая схема данных (users, channels, messages, read_receipts)',
      'Быстрые индексы по sender_id, recipient_id, created_at для миллиардов записей',
      'Каскадное удаление и целостность внешних ключей',
    ],
    pros: [
      'Золотой стандарт безопасности корпоративных мессенджеров',
      'Легко делать полнотекстовый поиск по архивам сообщений',
      'В AI Studio поддерживается через инструмент Cloud SQL',
    ],
    cons: [
      'Требует управления схемой/миграциями и отдельного WebSocket-сервера для real-time событий',
    ],
    recommendedFor: 'Крупные проекты, строгие политики безопасности, сложная аналитика.',
  },
  {
    id: 'redis_mongo_supabase',
    title: 'Гибрид: Supabase / MongoDB + Redis Pub/Sub',
    badge: 'Высокие нагрузки',
    badgeColor: '#9C27B0',
    description:
      'Сочетание оперативной памяти (Redis) для мгновенной доставки сообщений, онлайн-статусов и сессий с документоориентированной БД (MongoDB / Supabase Postgres) для хранения истории.',
    features: [
      'Redis Pub/Sub для горизонтального масштабирования нескольких серверов',
      'Хранение активных сессий пользователей в RAM',
      'Асинхронная запись сообщений пачками (batch writing)',
    ],
    pros: [
      'Экстремально высокая пропускная способность при миллионах активных пользователей',
    ],
    cons: [
      'Сложнее архитектура и дороже инфраструктура',
    ],
    recommendedFor: 'Крупные публичные каналы с сотнями тысяч подписчиков и чаты с высокой частотой сообщений.',
  },
];






