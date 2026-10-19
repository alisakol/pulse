import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getConversationId,
  isRoomId,
  getMessageTargetId,
  appendMessageIdempotent,
  validateCredentials,
  transitionCallState,
  formatCallDuration,
  validateAvatarDataUrl,
  validatePasswordReset,
  computeUpdatedUnreadCount,
  buildNotificationPayload,
  validateMediaAttachment,
  normalizeMediaDataUrl,
  formatMessagePreview,
  normalizeWaveform,
  validateRoomCreation,
  canUserAccessRoom,
  canUserAdministerRoom,
  canUserPostInRoom,
  formatRoomMembersLabel,
  roomToContactProfile,
  filterVisibleContactsAndRooms,
  searchUsersToInvite,
  getMessageReadStatusMeta,
  markConversationMessagesAsRead,
  applyReadReceiptToMessages,
  normalizeUsername,
  validatePasswordStrength,
  STORAGE_BACKEND_OPTIONS,
  type ChatMessage,
  type ChatRoom,
  type UserProfile,
} from './messengerLogic.ts';

test('getConversationId возвращает одинаковый ID независимо от порядка участников', () => {
  const id1 = getConversationId('user_alex', 'user_elena');
  const id2 = getConversationId('user_elena', 'user_alex');
  assert.equal(id1, id2);
  assert.equal(id1, 'conv_user_alex_user_elena');

  // Для групповых чатов и каналов возвращает ID комнаты напрямую
  assert.equal(getConversationId('user_alex', 'group_1001'), 'group_1001');
  assert.equal(getConversationId('channel_news', 'user_alex'), 'channel_news');
  assert.equal(isRoomId('group_1001'), true);
  assert.equal(isRoomId('channel_news'), true);
  assert.equal(isRoomId('user_alex'), false);
});

test('appendMessageIdempotent предотвращает дублирование сообщений при повторной доставке', () => {
  const msg1: ChatMessage = {
    id: 'msg_101',
    conversationId: 'conv_a_b',
    senderId: 'a',
    recipientId: 'b',
    text: 'Привет! Как слышно?',
    createdAt: '2026-10-18T10:00:00.000Z',
    status: 'sent',
  };

  const list1 = appendMessageIdempotent([], msg1);
  assert.equal(list1.length, 1);

  // Повторное событие с тем же ID, но обновленным статусом
  const list2 = appendMessageIdempotent(list1, { ...msg1, status: 'read' });
  assert.equal(list2.length, 1);
  assert.equal(list2[0].status, 'read');

  // Пустой или битый кружок без mediaUrl игнорируется
  const brokenCircle: ChatMessage = {
    id: 'msg_broken_circle',
    conversationId: 'conv_a_b',
    senderId: 'a',
    recipientId: 'b',
    text: '📹 Видеокружок (00:05)',
    createdAt: '2026-10-18T10:01:00.000Z',
    status: 'sent',
    attachmentType: 'video_note',
    mediaUrl: undefined,
  };
  const list3 = appendMessageIdempotent(list2, brokenCircle);
  assert.equal(list3.length, 1);
});

test('normalizeUsername удаляет символ @, обрезает пробелы и приводит к нижнему регистру', () => {
  assert.equal(normalizeUsername('  @Alex_Ivanov  '), 'alex_ivanov');
  assert.equal(normalizeUsername('@@user_pulse'), 'user_pulse');
  assert.equal(normalizeUsername('Maria'), 'maria');
});

test('validatePasswordStrength оценивает длину и сложность пароля', () => {
  assert.equal(validatePasswordStrength('').score, 0);
  assert.equal(validatePasswordStrength('123').score, 1);
  assert.equal(validatePasswordStrength('password123').score, 2);
  assert.equal(validatePasswordStrength('P@ssw0rd2026!').score, 3);
});

test('validateCredentials корректно проверяет логин, пароль, совпадение подтверждения и нормализует логин с @', () => {
  assert.equal(validateCredentials('ab', '123456').valid, false);
  assert.equal(validateCredentials('@alex_dev', '123').valid, false);
  assert.equal(validateCredentials('alex_dev', 'secret123', true, 'А').valid, false);
  assert.equal(validateCredentials('@alex_dev', 'secret123', true, 'Алексей', 'mismatch').valid, false);
  const okResult = validateCredentials('@alex_dev', 'secret123', true, 'Алексей', 'secret123');
  assert.equal(okResult.valid, true);
  assert.equal(okResult.normalizedUsername, 'alex_dev');
});

test('STORAGE_BACKEND_OPTIONS содержит архитектурные варианты хранения с текущим Pulse Server WAL', () => {
  assert.equal(STORAGE_BACKEND_OPTIONS.length >= 4, true);
  const current = STORAGE_BACKEND_OPTIONS.find((opt) => opt.isCurrentActive);
  assert.equal(Boolean(current), true);
  assert.equal(current?.id, 'pulse_server_wal');
  assert.equal(Boolean(STORAGE_BACKEND_OPTIONS.find((opt) => opt.id === 'firebase_firestore')), true);
  assert.equal(Boolean(STORAGE_BACKEND_OPTIONS.find((opt) => opt.id === 'postgresql_cloudsql')), true);
});

test('transitionCallState управляет жизненным циклом WebRTC вызова', () => {
  let state = transitionCallState('idle', 'START_OUTGOING');
  assert.equal(state, 'calling');
  state = transitionCallState(state, 'ACCEPT');
  assert.equal(state, 'connected');
  state = transitionCallState(state, 'HANGUP');
  assert.equal(state, 'idle');
});

test('formatCallDuration форматирует секунды в MM:SS', () => {
  assert.equal(formatCallDuration(0), '00:00');
  assert.equal(formatCallDuration(65), '01:05');
  assert.equal(formatCallDuration(600), '10:00');
});

test('validateAvatarDataUrl проверяет корректность base64 Data URL аватара', () => {
  assert.equal(validateAvatarDataUrl('').valid, true);
  assert.equal(
    validateAvatarDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=').valid,
    true
  );
  assert.equal(validateAvatarDataUrl('javascript:alert(1)').valid, false);
});

test('validatePasswordReset проверяет новый пароль и совпадение подтверждения', () => {
  assert.equal(validatePasswordReset('ab', 'newpass123', 'newpass123').valid, false);
  assert.equal(validatePasswordReset('alex_dev', '12345', '12345').valid, false);
  assert.equal(validatePasswordReset('alex_dev', 'newpass123', 'mismatch99').valid, false);
  assert.equal(validatePasswordReset('alex_dev', 'newpass123', 'newpass123').valid, true);
});

test('computeUpdatedUnreadCount увеличивает счетчик непрочитанных для фоновых чатов', () => {
  assert.equal(computeUpdatedUnreadCount(2, false, false), 2);
  assert.equal(computeUpdatedUnreadCount(2, true, true), 0);
  assert.equal(computeUpdatedUnreadCount(0, true, false), 1);
  assert.equal(computeUpdatedUnreadCount(3, true, false), 4);
});

test('buildNotificationPayload формирует заголовки для сообщения и звонка', () => {
  const msgNotif = buildNotificationPayload('message', 'Елена Смирнова', 'Привет, ты на связи?');
  assert.equal(msgNotif.title, 'Новое сообщение от Елена Смирнова');
  assert.equal(msgNotif.body, 'Привет, ты на связи?');

  const callNotif = buildNotificationPayload('call', 'Елена Смирнова', 'video');
  assert.equal(callNotif.title, 'Входящий видеозвонок');
  assert.equal(callNotif.body, 'Елена Смирнова вызывает вас в Pulse');
});

test('validateMediaAttachment и normalizeMediaDataUrl поддерживают видеокружки с кодеками через запятую (codecs=vp8,opus)', () => {
  assert.equal(validateMediaAttachment('voice', '', 3).valid, false);
  assert.equal(
    validateMediaAttachment('voice', 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA', 5).valid,
    true
  );
  assert.equal(
    validateMediaAttachment('video_note', 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC', 4).valid,
    true
  );

  // Реальный Data URL от MediaRecorder с видео + аудио (содержит запятую в codecs=vp8,opus)
  const multiCodecWebm = 'data:video/webm;codecs=vp8,opus;base64,GkXfo59ChoEBQveBAULygQRC';
  const checkWebm = validateMediaAttachment('video_note', multiCodecWebm, 6);
  assert.equal(checkWebm.valid, true);
  assert.equal(checkWebm.sanitizedUrl, 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC');
  assert.equal(checkWebm.durationSec, 6);

  // Реальный Data URL от Safari / iOS MediaRecorder (video/mp4 с двумя кодеками через запятую)
  const multiCodecMp4 = 'data:video/mp4;codecs="avc1.42E01E, mp4a.40.2";base64,AAAAIGZ0eXBpc29t';
  const checkMp4 = validateMediaAttachment('video_note', multiCodecMp4, 4);
  assert.equal(checkMp4.valid, true);
  assert.equal(checkMp4.sanitizedUrl, 'data:video/mp4;base64,AAAAIGZ0eXBpc29t');

  assert.equal(
    normalizeMediaDataUrl(multiCodecWebm, 'video_note'),
    'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC'
  );

  assert.equal(
    validateMediaAttachment('video_note', 'data:audio/wav;base64,UklGRiQAAABXQVZF', 4).valid,
    false
  );

  assert.equal(
    formatMessagePreview({ text: '', attachmentType: 'voice', mediaDuration: 7 }),
    '🎤 Голосовое сообщение (00:07)'
  );
  assert.equal(
    formatMessagePreview({ text: '', attachmentType: 'video_note', mediaDuration: 12 }),
    '📹 Видеокружок (00:12)'
  );
});

test('normalizeWaveform возвращает массив столбиков фиксированной длины в диапазоне 15..100', () => {
  const wave = normalizeWaveform([0, 30, 80, 120], 16);
  assert.equal(wave.length, 16);
  assert.equal(wave.every((v) => v >= 15 && v <= 100), true);
});

test('validateRoomCreation, canUserPostInRoom и roomToContactProfile корректно работают с группами и каналами', () => {
  assert.equal(validateRoomCreation({ type: 'group', title: 'А' }).valid, false);

  const validGroup = validateRoomCreation({
    type: 'group',
    title: 'Команда разработки',
    description: 'Обсуждение релизов',
  });
  assert.equal(validGroup.valid, true);
  assert.equal(validGroup.roomType, 'group');
  assert.equal(validGroup.sanitizedHandle, 'komanda_razrabotki');

  const validChannel = validateRoomCreation({
    type: 'channel',
    title: 'Новости Pulse',
    handle: '@pulse_news',
  });
  assert.equal(validChannel.valid, true);
  assert.equal(validChannel.roomType, 'channel');
  assert.equal(validChannel.sanitizedHandle, 'pulse_news');

  const sampleChannel: ChatRoom = {
    id: 'channel_1',
    type: 'channel',
    title: 'Новости Pulse',
    handle: 'pulse_news',
    description: 'Официальный канал обновлений',
    avatarColor: '#8E57C2',
    ownerId: 'user_owner',
    adminIds: ['user_owner', 'user_admin'],
    memberIds: ['user_owner', 'user_admin', 'user_reader'],
    isPublic: true,
    createdAt: '2026-10-19T10:00:00.000Z',
  };

  assert.equal(canUserPostInRoom(sampleChannel, 'user_owner'), true);
  assert.equal(canUserPostInRoom(sampleChannel, 'user_admin'), true);
  assert.equal(canUserPostInRoom(sampleChannel, 'user_reader'), false);

  const sampleGroup: ChatRoom = {
    ...sampleChannel,
    id: 'group_1',
    type: 'group',
  };
  assert.equal(canUserPostInRoom(sampleGroup, 'user_reader'), true);

  assert.equal(formatRoomMembersLabel('group', 1), '1 участник');
  assert.equal(formatRoomMembersLabel('group', 3), '3 участника');
  assert.equal(formatRoomMembersLabel('group', 5), '5 участников');
  assert.equal(formatRoomMembersLabel('channel', 1), '1 подписчик');
  assert.equal(formatRoomMembersLabel('channel', 2), '2 подписчика');
  assert.equal(formatRoomMembersLabel('channel', 10), '10 подписчиков');

  const profile = roomToContactProfile(sampleChannel);
  assert.equal(profile.id, 'channel_1');
  assert.equal(profile.kind, 'channel');
  assert.equal(profile.displayName, 'Новости Pulse');

  assert.equal(
    getMessageTargetId(
      { senderId: 'user_owner', recipientId: 'channel_1', conversationId: 'channel_1' },
      'user_reader'
    ),
    'channel_1'
  );
});

test('getMessageReadStatusMeta и markConversationMessagesAsRead управляют галочками доставки и прочтения', () => {
  const deliveredMeta = getMessageReadStatusMeta('delivered');
  assert.equal(deliveredMeta.isRead, false);
  assert.equal(deliveredMeta.checkmarksCount, 1);
  assert.equal(deliveredMeta.label, 'Доставлено на сервер');

  const readMeta = getMessageReadStatusMeta('read');
  assert.equal(readMeta.isRead, true);
  assert.equal(readMeta.checkmarksCount, 2);
  assert.equal(readMeta.label, 'Прочитано собеседником');

  const convMessages: ChatMessage[] = [
    {
      id: 'm1',
      conversationId: 'conv_a_b',
      senderId: 'user_a',
      recipientId: 'user_b',
      text: 'Привет!',
      createdAt: '2026-10-19T10:00:00.000Z',
      status: 'delivered',
    },
    {
      id: 'm2',
      conversationId: 'conv_a_b',
      senderId: 'user_b',
      recipientId: 'user_a',
      text: 'На связи',
      createdAt: '2026-10-19T10:01:00.000Z',
      status: 'delivered',
    },
  ];

  // Если user_a сам открывает чат, его собственное сообщение m1 остается 'delivered' (1 галочка), а m2 от user_b становится 'read'
  const readByA = markConversationMessagesAsRead(convMessages, 'user_a');
  assert.deepEqual(readByA.changedIds, ['m2']);
  assert.equal(readByA.updated[0].status, 'delivered');
  assert.equal(readByA.updated[1].status, 'read');

  // Когда собеседник user_b открывает чат, сообщение m1 от user_a становится 'read' (2 галочки)
  const readByB = markConversationMessagesAsRead(convMessages, 'user_b');
  assert.deepEqual(readByB.changedIds, ['m1']);
  assert.equal(readByB.updated[0].status, 'read');

  const applied = applyReadReceiptToMessages(convMessages, ['m1'], 'conv_a_b');
  assert.equal(applied[0].status, 'read');
  assert.equal(applied[1].status, 'delivered');
});

test('canUserAccessRoom, filterVisibleContactsAndRooms и searchUsersToInvite скрывают неприглашенные чаты и показывают участников только по поиску', () => {
  const privateGroup: ChatRoom = {
    id: 'group_secret',
    type: 'group',
    title: 'Закрытый штаб',
    handle: 'secret_hq',
    description: 'Только для приглашенных',
    avatarColor: '#3E9F65',
    ownerId: 'user_creator',
    adminIds: ['user_creator', 'user_admin'],
    memberIds: ['user_creator', 'user_admin', 'user_invited'],
    isPublic: false,
    createdAt: '2026-10-19T10:00:00.000Z',
  };

  assert.equal(canUserAccessRoom(privateGroup, 'user_creator'), true);
  assert.equal(canUserAccessRoom(privateGroup, 'user_invited'), true);
  assert.equal(canUserAccessRoom(privateGroup, 'user_outsider'), false);

  assert.equal(canUserAdministerRoom(privateGroup, 'user_creator'), true);
  assert.equal(canUserAdministerRoom(privateGroup, 'user_admin'), true);
  assert.equal(canUserAdministerRoom(privateGroup, 'user_invited'), false);

  const contactsList: UserProfile[] = [
    roomToContactProfile(privateGroup),
    {
      id: 'user_invited',
      username: 'elena_design',
      displayName: 'Елена Соколова',
      avatarColor: '#5288C1',
      role: 'Дизайнер',
      online: true,
      lastSeen: '2026-10-19T10:00:00.000Z',
    },
    {
      id: 'user_outsider',
      username: 'maxim_dev',
      displayName: 'Максим Волков',
      avatarColor: '#D97724',
      role: 'Инженер',
      online: false,
      lastSeen: '2026-10-19T10:00:00.000Z',
    },
  ];

  // 1. Для постороннего пользователя (user_outsider) без переписки и без поиска список пуст (ни чужих групп, ни других участников сразу не видно)
  const outsiderDefaultView = filterVisibleContactsAndRooms({
    contacts: contactsList,
    currentUserId: 'user_outsider',
    summaries: {},
    searchQuery: '',
    activeTab: 'chats',
    filterKind: 'all',
  });
  assert.equal(outsiderDefaultView.length, 0);

  // 2. Посторонний пользователь ищет участника по имени или @username — находит Елену, но закрытая группа все равно скрыта
  const outsiderSearchView = filterVisibleContactsAndRooms({
    contacts: contactsList,
    currentUserId: 'user_outsider',
    summaries: {},
    searchQuery: 'elena',
    activeTab: 'chats',
    filterKind: 'all',
  });
  assert.equal(outsiderSearchView.length, 1);
  assert.equal(outsiderSearchView[0].id, 'user_invited');

  // 3. Приглашенный участник (user_invited) сразу видит группу «Закрытый штаб», в которую он приглашен
  const invitedDefaultView = filterVisibleContactsAndRooms({
    contacts: contactsList,
    currentUserId: 'user_invited',
    summaries: {},
    searchQuery: '',
    activeTab: 'chats',
    filterKind: 'all',
  });
  assert.equal(invitedDefaultView.length, 1);
  assert.equal(invitedDefaultView[0].id, 'group_secret');

  // 4. Поиск пользователей для приглашения в группу/канал: пустой запрос ничего не выводит, запрос по @username находит кандидата
  assert.equal(
    searchUsersToInvite(contactsList, 'user_creator', privateGroup.memberIds, '').length,
    0
  );
  const foundToInvite = searchUsersToInvite(
    contactsList,
    'user_creator',
    privateGroup.memberIds,
    'maxim'
  );
  assert.equal(foundToInvite.length, 1);
  assert.equal(foundToInvite[0].id, 'user_outsider');
});

