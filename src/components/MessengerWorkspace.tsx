import React, { useState } from 'react';
import {
  Send,
  Phone,
  Video,
  Search,
  Users,
  Share2,
  Check,
  CheckCheck,
  ArrowLeft,
  Mic,
  Camera,
  Plus,
  Megaphone,
  Info,
  Eye,
  Sparkles,
} from 'lucide-react';
import {
  formatMessagePreview,
  formatRoomMembersLabel,
  canUserPostInRoom,
  canUserAdministerRoom,
  filterVisibleContactsAndRooms,
  type UserProfile,
  type ChatMessage,
  type ChatRoom,
} from '../utils/messengerLogic';
import { UserAvatar } from './UserAvatar';
import {
  VoiceMessagePlayer,
  VideoCirclePlayer,
  MediaNoteRecorder,
  MessageReadStatus,
  type RecordedMediaPayload,
} from './MediaMessages';
import {
  CreateRoomModal,
  RoomInfoModal,
  type RoomAdminUpdatePayload,
} from './RoomModals';

interface MessengerWorkspaceProps {
  currentUser: UserProfile;
  contacts: UserProfile[];
  rooms?: ChatRoom[];
  summaries: Record<string, { lastMessage: ChatMessage; unreadCount: number }>;
  selectedContact: UserProfile | null;
  onSelectContact: (contact: UserProfile) => void;
  messages: ChatMessage[];
  onSendMessage: (text: string, media?: RecordedMediaPayload) => void;
  onStartCall: (contact: UserProfile, mediaType: 'audio' | 'video') => void;
  typingUserIds: Set<string>;
  onTypingChange: (isTyping: boolean) => void;
  activeTab: 'chats' | 'contacts';
  mobileChatOpen: boolean;
  onBackToMobileList: () => void;
  hasActiveCall?: boolean;
  onCreateRoom?: (payload: {
    type: 'group' | 'channel';
    title: string;
    handle: string;
    description: string;
    avatarColor: string;
    avatarUrl?: string;
    memberIds: string[];
    isPublic: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  onJoinOrLeaveRoom?: (roomId: string, action: 'join' | 'leave') => Promise<void>;
  onUpdateRoomMembers?: (roomId: string, memberIds: string[]) => Promise<void>;
  onUpdateRoom?: (
    roomId: string,
    updates: RoomAdminUpdatePayload
  ) => Promise<{ ok: boolean; error?: string }>;
  onDeleteRoom?: (roomId: string) => Promise<void>;
}

type ChatFilterType = 'all' | 'direct' | 'group' | 'channel';

/**
 * Основное окно мессенджера Pulse в фирменной стилистике Telegram:
 * Поддерживает личные диалоги, групповые чаты и каналы.
 */
export const MessengerWorkspace: React.FC<MessengerWorkspaceProps> = ({
  currentUser,
  contacts,
  rooms = [],
  summaries,
  selectedContact,
  onSelectContact,
  messages,
  onSendMessage,
  onStartCall,
  typingUserIds,
  onTypingChange,
  activeTab,
  mobileChatOpen,
  onBackToMobileList,
  onCreateRoom,
  onJoinOrLeaveRoom,
  onUpdateRoomMembers,
  onUpdateRoom,
  onDeleteRoom,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [chatFilter, setChatFilter] = useState<ChatFilterType>('all');
  const [draftText, setDraftText] = useState('');
  const [recordingMode, setRecordingMode] = useState<'voice' | 'video_note' | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [createModalType, setCreateModalType] = useState<'group' | 'channel' | null>(null);
  const [isRoomInfoOpen, setIsRoomInfoOpen] = useState(false);
  const messagesListRef = React.useRef<HTMLDivElement | null>(null);

  const otherEntities = contacts.filter((c) => c.id !== currentUser.id);

  // Сбрасываем режим записи и окно инфо при смене чата
  React.useEffect(() => {
    setRecordingMode(null);
    setIsRoomInfoOpen(false);
  }, [selectedContact?.id]);

  // Автопрокрутка к последнему сообщению при открытии чата или отправке сообщения
  React.useEffect(() => {
    if (messagesListRef.current) {
      messagesListRef.current.scrollTop = messagesListRef.current.scrollHeight;
    }
  }, [messages.length, selectedContact?.id, mobileChatOpen]);

  // Находим комнату, если выбран групповой чат или канал
  const activeRoom: ChatRoom | null = React.useMemo(() => {
    if (!selectedContact) return null;
    const found = rooms.find((r) => r.id === selectedContact.id);
    if (found) return found;
    if (selectedContact.kind === 'group' || selectedContact.kind === 'channel') {
      return {
        id: selectedContact.id,
        type: selectedContact.kind,
        title: selectedContact.displayName,
        handle: selectedContact.username,
        description: selectedContact.description || selectedContact.role || '',
        avatarColor: selectedContact.avatarColor,
        avatarUrl: selectedContact.avatarUrl,
        ownerId: selectedContact.ownerId || currentUser.id,
        adminIds: selectedContact.adminIds || [selectedContact.ownerId || currentUser.id],
        memberIds: selectedContact.memberIds || [currentUser.id],
        isPublic: selectedContact.isPublic ?? true,
        createdAt: selectedContact.lastSeen || new Date().toISOString(),
      };
    }
    return null;
  }, [selectedContact, rooms, currentUser.id]);

  const isGroup = activeRoom?.type === 'group' || selectedContact?.kind === 'group';
  const isChannel = activeRoom?.type === 'channel' || selectedContact?.kind === 'channel';
  const isRoom = isGroup || isChannel;
  const canPost = activeRoom ? canUserPostInRoom(activeRoom, currentUser.id) : true;
  const canAdministerRoom = activeRoom
    ? canUserAdministerRoom(activeRoom, currentUser.id)
    : false;
  const isSubscribed = activeRoom ? activeRoom.memberIds.includes(currentUser.id) : true;

  // Сортируем диалоги, группы и каналы по времени последнего сообщения
  const sortedContacts = [...otherEntities].sort((a, b) => {
    const lastA = summaries[a.id]?.lastMessage?.createdAt;
    const lastB = summaries[b.id]?.lastMessage?.createdAt;
    if (lastA && lastB) {
      return new Date(lastB).getTime() - new Date(lastA).getTime();
    }
    if (lastA) return -1;
    if (lastB) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  const filteredContacts = filterVisibleContactsAndRooms({
    contacts: sortedContacts,
    currentUserId: currentUser.id,
    summaries,
    searchQuery,
    activeTab,
    filterKind: chatFilter,
    selectedContactId: selectedContact?.id,
  });

  const resolveSenderProfile = (senderId: string, msg?: ChatMessage): UserProfile => {
    if (senderId === currentUser.id) return currentUser;
    const found = contacts.find((u) => u.id === senderId);
    if (found) return found;
    return {
      id: senderId,
      username: senderId.slice(0, 8),
      displayName: msg?.senderName || 'Участник Pulse',
      avatarColor: msg?.senderAvatarColor || '#5288C1',
      avatarUrl: msg?.senderAvatarUrl,
      role: 'В сети Pulse',
      online: false,
      lastSeen: msg?.createdAt || new Date().toISOString(),
    };
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftText.trim() || !selectedContact || !canPost) return;
    onSendMessage(draftText.trim());
    setDraftText('');
    onTypingChange(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setDraftText(val);
    onTypingChange(val.trim().length > 0);
  };

  const handleCopyInviteLink = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(window.location.origin);
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 2000);
    }
  };

  const showMobileChat = Boolean(mobileChatOpen && selectedContact);

  return (
    <div
      className={`grid grid-cols-1 lg:grid-cols-12 bg-[#17212B] lg:border border-[#101921] lg:rounded-xl overflow-hidden ${
        showMobileChat ? 'h-[100dvh]' : 'h-[calc(100dvh-56px)]'
      } lg:h-[calc(100dvh-88px)] lg:min-h-[680px] shadow-2xl`}
    >
      {/* Левая колонка: Список чатов, групп и каналов (#17212B) */}
      <aside
        className={`${
          showMobileChat ? 'hidden lg:flex' : 'flex'
        } lg:col-span-4 border-r border-[#101921] flex-col bg-[#17212B] h-full overflow-hidden`}
      >
        {/* Поиск + Кнопки создания группы и канала */}
        <div className="p-3 border-b border-[#101921] space-y-2.5 shrink-0">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-[#6C7883] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Поиск"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск участников по имени или @username"
                className="w-full pl-9 pr-3 py-2 bg-[#242F3D] rounded-full text-xs text-white placeholder-[#6C7883] focus:outline-none focus:ring-1 focus:ring-[#5288C1]"
              />
            </div>

            {onCreateRoom && (
              <button
                type="button"
                onClick={() => setCreateModalType('group')}
                aria-label="Создать группу или канал"
                title="Создать групповой чат или канал"
                className="h-8 px-3 rounded-full bg-[#2B5278] hover:bg-[#34628E] text-white text-xs font-semibold inline-flex items-center gap-1 transition-colors cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Создать</span>
              </button>
            )}
          </div>

          {/* Быстрые вкладки фильтрации и кнопки создания (в разделе Чаты) */}
          {activeTab !== 'contacts' && (
            <div className="flex items-center justify-between gap-1 overflow-x-auto no-scrollbar">
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: 'all', label: 'Все' },
                    { id: 'direct', label: 'Личные' },
                    { id: 'group', label: 'Группы' },
                    { id: 'channel', label: 'Каналы' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setChatFilter(tab.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      chatFilter === tab.id
                        ? 'bg-[#2B5278] text-white'
                        : 'bg-[#242F3D]/60 text-[#7F91A4] hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {onCreateRoom && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setCreateModalType('group')}
                    aria-label="Новая группа"
                    title="Создать групповой чат"
                    className="p-1.5 rounded-lg bg-[#242F3D]/80 hover:bg-[#2C394A] text-[#57D188] transition-colors cursor-pointer"
                  >
                    <Users className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateModalType('channel')}
                    aria-label="Новый канал"
                    title="Создать канал"
                    className="p-1.5 rounded-lg bg-[#242F3D]/80 hover:bg-[#2C394A] text-[#B388FF] transition-colors cursor-pointer"
                  >
                    <Megaphone className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Список диалогов, групп и каналов */}
        <div className="flex-1 overflow-y-auto">
          {filteredContacts.length === 0 ? (
            <div className="p-8 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-[#242F3D] flex items-center justify-center mx-auto text-[#64B5EF]">
                {chatFilter === 'channel' ? (
                  <Megaphone className="w-6 h-6 text-[#B388FF]" />
                ) : (
                  <Users className="w-6 h-6" />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-white">
                  {searchQuery
                    ? 'Ничего не найдено'
                    : activeTab === 'contacts'
                      ? 'Поиск участников Pulse'
                      : chatFilter === 'group'
                        ? 'Групповых чатов пока нет'
                        : chatFilter === 'channel'
                          ? 'Каналов пока нет'
                          : 'Активных чатов пока нет'}
                </p>
                <p className="text-xs text-[#7F91A4] leading-relaxed">
                  {searchQuery
                    ? 'Попробуйте ввести другое имя или @username.'
                    : activeTab === 'contacts'
                      ? 'Введите имя или @username в строку поиска выше, чтобы найти людей и начать общение.'
                      : chatFilter === 'group'
                        ? 'Общие чаты видны только создателю и приглашенным участникам.'
                        : chatFilter === 'channel'
                          ? 'Каналы видны только создателю и приглашенным подписчикам.'
                          : 'Введите имя или @username в поиск выше, чтобы найти собеседника, или создайте закрытую группу / канал.'}
                </p>
              </div>
              {!searchQuery && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {onCreateRoom && (
                    <>
                      <button
                        type="button"
                        onClick={() => setCreateModalType('group')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#2B5278] hover:bg-[#34628E] text-white text-xs font-medium rounded-full transition-colors cursor-pointer"
                      >
                        <Users className="w-3.5 h-3.5 text-[#57D188]" />
                        <span>Создать группу</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setCreateModalType('channel')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#242F3D] hover:bg-[#2C394A] text-white text-xs font-medium rounded-full transition-colors cursor-pointer"
                      >
                        <Megaphone className="w-3.5 h-3.5 text-[#B388FF]" />
                        <span>Создать канал</span>
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={handleCopyInviteLink}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#242F3D] hover:bg-[#2C394A] text-[#7F91A4] hover:text-white text-xs font-medium rounded-full transition-colors cursor-pointer"
                  >
                    {copiedInvite ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-300" />
                        <span>Ссылка скопирована</span>
                      </>
                    ) : (
                      <>
                        <Share2 className="w-3.5 h-3.5" />
                        <span>Пригласить</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          ) : (
            filteredContacts.map((contact) => {
              const isSelected = selectedContact?.id === contact.id;
              const summary = summaries[contact.id];
              const lastMsg = summary?.lastMessage;
              const lastTimeStr = lastMsg
                ? new Date(lastMsg.createdAt).toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '';

              const itemIsGroup = contact.kind === 'group';
              const itemIsChannel = contact.kind === 'channel';
              const memberCount = contact.memberIds?.length || 1;

              let previewPrefix = '';
              if (lastMsg) {
                if (lastMsg.senderId === currentUser.id) {
                  previewPrefix = itemIsChannel ? '' : 'Вы: ';
                } else if (itemIsGroup) {
                  const s = resolveSenderProfile(lastMsg.senderId, lastMsg);
                  previewPrefix = `${s.displayName.split(' ')[0]}: `;
                }
              }

              return (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => onSelectContact(contact)}
                  className={`w-full px-3.5 py-3 flex items-center gap-3 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'lg:bg-[#2B5278] bg-[#17212B] active:bg-[#202B36] text-white'
                      : 'hover:bg-[#202B36] text-[#F5F5F5]'
                  }`}
                >
                  <UserAvatar
                    displayName={contact.displayName}
                    avatarColor={contact.avatarColor}
                    avatarUrl={contact.avatarUrl}
                    sizeClass="w-12 h-12"
                    textClass="text-sm"
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {itemIsChannel && (
                          <Megaphone
                            className={`w-3.5 h-3.5 shrink-0 ${
                              isSelected ? 'text-white' : 'text-[#B388FF]'
                            }`}
                          />
                        )}
                        {itemIsGroup && (
                          <Users
                            className={`w-3.5 h-3.5 shrink-0 ${
                              isSelected ? 'text-white' : 'text-[#57D188]'
                            }`}
                          />
                        )}
                        <span className="text-sm font-semibold truncate">
                          {contact.displayName}
                        </span>
                      </div>
                      <span
                        className={`text-[11px] font-mono tabular-nums whitespace-nowrap shrink-0 ${
                          isSelected
                            ? 'lg:text-[#D3E5F6] text-[#64B5EF]'
                            : itemIsGroup || itemIsChannel
                              ? 'text-[#7F91A4]'
                              : contact.online
                                ? 'text-[#64B5EF]'
                                : 'text-[#6C7883]'
                        }`}
                      >
                        {lastTimeStr ||
                          (itemIsChannel
                            ? formatRoomMembersLabel('channel', memberCount)
                            : itemIsGroup
                              ? formatRoomMembersLabel('group', memberCount)
                              : contact.online
                                ? 'в сети'
                                : 'был(а) недавно')}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p
                        className={`text-xs truncate flex items-center gap-1 min-w-0 ${
                          isSelected
                            ? 'lg:text-[#D3E5F6] text-[#7F91A4]'
                            : summary?.unreadCount
                              ? 'text-white font-medium'
                              : 'text-[#7F91A4]'
                        }`}
                      >
                        {activeTab !== 'contacts' &&
                          lastMsg &&
                          lastMsg.senderId === currentUser.id &&
                          !itemIsChannel && (
                            <MessageReadStatus
                              status={lastMsg.status}
                              className="w-3.5 h-3.5"
                            />
                          )}
                        <span className="truncate">
                          {activeTab === 'contacts'
                            ? `@${contact.username} · ${contact.role}`
                            : lastMsg
                              ? `${previewPrefix}${formatMessagePreview(lastMsg)}`
                              : itemIsChannel
                                ? `Канал · @${contact.username}`
                                : itemIsGroup
                                  ? `Группа · ${formatRoomMembersLabel('group', memberCount)}`
                                  : `@${contact.username} · ${contact.role}`}
                        </span>
                      </p>
                      {Boolean(summary?.unreadCount && summary.unreadCount > 0) && (
                        <span
                          aria-label={`Непрочитанных сообщений: ${summary?.unreadCount}`}
                          className="min-w-5 h-5 px-1.5 rounded-full bg-[#5288C1] text-white text-[11px] font-bold font-mono tabular-nums flex items-center justify-center shrink-0"
                        >
                          {summary?.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Правая колонка: Холст чата, группы или канала (#0E1621) */}
      <section
        className={`${
          showMobileChat ? 'flex' : 'hidden lg:flex'
        } lg:col-span-8 flex-col bg-[#0E1621] h-full overflow-hidden`}
      >
        {selectedContact ? (
          <>
            {/* Шапка чата / группы / канала (#17212B) */}
            <div className="h-14 px-3 sm:px-5 border-b border-[#101921] flex items-center justify-between gap-2 bg-[#17212B] shrink-0">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={onBackToMobileList}
                  aria-label="Назад к списку чатов"
                  className="lg:hidden w-10 h-10 -ml-1 flex items-center justify-center rounded-full text-[#7F91A4] hover:text-white hover:bg-[#242F3D] transition-colors cursor-pointer shrink-0"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>

                <div
                  onClick={() => {
                    if (isRoom) setIsRoomInfoOpen(true);
                  }}
                  className={`flex items-center gap-2 sm:gap-3 min-w-0 flex-1 ${
                    isRoom ? 'cursor-pointer hover:opacity-90 transition-opacity' : ''
                  }`}
                >
                  <UserAvatar
                    displayName={selectedContact.displayName}
                    avatarColor={selectedContact.avatarColor}
                    avatarUrl={selectedContact.avatarUrl}
                    sizeClass="w-9 h-9 sm:w-10 sm:h-10"
                    textClass="text-xs sm:text-sm"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {isChannel && <Megaphone className="w-3.5 h-3.5 text-[#B388FF] shrink-0" />}
                      {isGroup && <Users className="w-3.5 h-3.5 text-[#57D188] shrink-0" />}
                      <h2 className="text-sm font-semibold text-white truncate leading-tight">
                        {selectedContact.displayName}
                      </h2>
                      {isChannel && (
                        <span className="px-1.5 py-0.5 rounded bg-[#8E57C2]/25 text-[#B388FF] text-[10px] font-bold uppercase tracking-wider shrink-0">
                          Канал
                        </span>
                      )}
                      {isGroup && (
                        <span className="px-1.5 py-0.5 rounded bg-[#3E9F65]/25 text-[#57D188] text-[10px] font-bold uppercase tracking-wider shrink-0">
                          Группа
                        </span>
                      )}
                    </div>

                    <p className="text-[11px] sm:text-xs flex items-center gap-1.5 truncate leading-tight mt-0.5">
                      {typingUserIds.has(selectedContact.id) ? (
                        <span className="text-[#64B5EF]">печатает...</span>
                      ) : isRoom && activeRoom ? (
                        <>
                          <span className="text-[#64B5EF]">
                            {formatRoomMembersLabel(
                              activeRoom.type,
                              activeRoom.memberIds.length
                            )}
                          </span>
                          <span className="text-[#6C7883] hidden sm:inline" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-[#7F91A4] truncate hidden sm:inline">
                            @{activeRoom.handle}
                          </span>
                        </>
                      ) : (
                        <>
                          <span
                            className={
                              selectedContact.online ? 'text-[#64B5EF]' : 'text-[#7F91A4]'
                            }
                          >
                            {selectedContact.online ? 'в сети' : 'был(а) недавно'}
                          </span>
                          <span className="text-[#6C7883] hidden sm:inline" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-[#7F91A4] truncate hidden sm:inline">
                            @{selectedContact.username}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* Действия в правой части шапки */}
              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                {isRoom && activeRoom ? (
                  <>
                    {!isSubscribed && onJoinOrLeaveRoom && (
                      <button
                        type="button"
                        onClick={() => onJoinOrLeaveRoom(activeRoom.id, 'join')}
                        className="px-3 py-1.5 bg-[#5288C1] hover:bg-[#467AB0] text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                      >
                        {isChannel ? 'Подписаться' : 'Вступить'}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setIsRoomInfoOpen(true)}
                      aria-label={
                        canAdministerRoom
                          ? 'Управление'
                          : isChannel
                            ? 'О канале'
                            : 'Участники группы'
                      }
                      title={
                        canAdministerRoom
                          ? 'Администрирование: аватар, настройки и приглашение людей'
                          : isChannel
                            ? 'Информация о канале и подписчиках'
                            : 'Участники группы'
                      }
                      className="w-10 h-10 sm:w-auto sm:h-auto sm:px-3.5 sm:py-2 flex items-center justify-center gap-1.5 text-[#64B5EF] hover:text-white sm:text-[#F5F5F5] bg-[#242F3D] hover:bg-[#2C394A] text-xs font-medium rounded-full sm:rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <Info className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[#64B5EF]" />
                      <span className="hidden sm:inline">
                        {canAdministerRoom
                          ? 'Управление'
                          : isChannel
                            ? 'О канале'
                            : 'Участники'}
                      </span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onStartCall(selectedContact, 'audio')}
                      aria-label="Позвонить"
                      title="Аудиозвонок"
                      className="w-10 h-10 sm:w-auto sm:h-auto sm:px-3.5 sm:py-2 flex items-center justify-center gap-2 text-[#64B5EF] hover:text-white sm:text-[#F5F5F5] bg-[#242F3D] hover:bg-[#2C394A] text-xs font-medium rounded-full sm:rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <Phone className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[#64B5EF]" />
                      <span className="hidden sm:inline">Позвонить</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onStartCall(selectedContact, 'video')}
                      aria-label="Видеозвонок"
                      title="Видеозвонок"
                      className="w-10 h-10 sm:w-auto sm:h-auto sm:px-3.5 sm:py-2 flex items-center justify-center gap-2 text-white bg-[#5288C1] hover:bg-[#467AB0] text-xs font-semibold rounded-full sm:rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <Video className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                      <span className="hidden sm:inline">Видеозвонок</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Лента сообщений (#0E1621) */}
            <div
              ref={messagesListRef}
              className="flex-1 px-3 sm:px-5 py-3 sm:py-4 overflow-y-auto space-y-2.5"
            >
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-12">
                  <div className="px-4 py-1.5 rounded-full bg-[#182533] text-xs text-[#7F91A4] mb-2">
                    {isChannel
                      ? 'В канале пока нет публикаций'
                      : isGroup
                        ? 'Групповой чат создан'
                        : 'Сообщений пока нет'}
                  </div>
                  <p className="text-xs text-[#6C7883] max-w-xs">
                    {isChannel
                      ? canPost
                        ? `Опубликуйте первый пост, голосовое или видеокружок в канале «${selectedContact.displayName}».`
                        : `Вы открыли канал «${selectedContact.displayName}». Здесь появятся новые публикации автора.`
                      : isGroup
                        ? `Напишите первое сообщение, отправьте голосовое или кружок участникам группы «${selectedContact.displayName}».`
                        : `Напишите сообщение, запишите голосовое или видеокружок для ${selectedContact.displayName}.`}
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isMine = msg.senderId === currentUser.id;
                  const senderProfile = resolveSenderProfile(msg.senderId, msg);
                  const timeStr = new Date(msg.createdAt).toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  // Круглое видеосообщение («кружок»)
                  if (msg.attachmentType === 'video_note') {
                    return (
                      <div key={msg.id} className="space-y-1">
                        {isGroup && !isMine && (
                          <div className="flex items-center gap-1.5 pl-1">
                            <span
                              className="text-[11px] font-semibold"
                              style={{ color: senderProfile.avatarColor || '#64B5EF' }}
                            >
                              {senderProfile.displayName}
                            </span>
                          </div>
                        )}
                        <VideoCirclePlayer
                          message={msg}
                          isMine={isMine && !isChannel}
                          timeStr={timeStr}
                          senderName={
                            isChannel
                              ? selectedContact.displayName
                              : senderProfile.displayName
                          }
                          senderColor={
                            isChannel
                              ? selectedContact.avatarColor
                              : senderProfile.avatarColor
                          }
                          senderAvatarUrl={
                            isChannel
                              ? selectedContact.avatarUrl
                              : senderProfile.avatarUrl
                          }
                        />
                      </div>
                    );
                  }

                  // Оформление публикации в канале (широкая карточка с просмотрами)
                  if (isChannel) {
                    const views =
                      msg.viewsCount || activeRoom?.memberIds.length || 1;
                    return (
                      <div key={msg.id} className="flex flex-col items-start">
                        <div className="w-full max-w-xl rounded-2xl px-4 py-3 bg-[#182533] border border-[#232E3C] text-[#F5F5F5] shadow-sm space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-[#B388FF] flex items-center gap-1.5">
                              <Megaphone className="w-3.5 h-3.5" />
                              <span>{selectedContact.displayName}</span>
                            </span>
                            <span className="text-[11px] text-[#7F91A4]">
                              {senderProfile.displayName}
                            </span>
                          </div>

                          {msg.attachmentType === 'voice' ? (
                            <VoiceMessagePlayer
                              message={msg}
                              isMine={false}
                              timeStr={timeStr}
                            />
                          ) : (
                            <p className="text-sm leading-relaxed break-words text-white">
                              {msg.text}
                            </p>
                          )}

                          <div className="flex items-center justify-end gap-3 pt-1 text-[11px] font-mono tabular-nums text-[#6C7883]">
                            <span className="inline-flex items-center gap-1">
                              <Eye className="w-3.5 h-3.5" />
                              <span>{views}</span>
                            </span>
                            <span>{timeStr}</span>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Обычное сообщение в личном или групповом чате
                  return (
                    <div
                      key={msg.id}
                      className={`flex items-end gap-2 ${
                        isMine ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      {isGroup && !isMine && (
                        <UserAvatar
                          displayName={senderProfile.displayName}
                          avatarColor={senderProfile.avatarColor}
                          avatarUrl={senderProfile.avatarUrl}
                          sizeClass="w-7 h-7"
                          textClass="text-[10px]"
                        />
                      )}

                      <div
                        className={`max-w-[85%] sm:max-w-lg rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm ${
                          isMine
                            ? 'bg-[#2B5278] text-white rounded-br-sm'
                            : 'bg-[#182533] text-[#F5F5F5] rounded-bl-sm'
                        }`}
                      >
                        {isGroup && !isMine && (
                          <div
                            className="text-xs font-semibold mb-0.5 truncate"
                            style={{ color: senderProfile.avatarColor || '#64B5EF' }}
                          >
                            {senderProfile.displayName}
                          </div>
                        )}

                        {msg.attachmentType === 'voice' ? (
                          <VoiceMessagePlayer
                            message={msg}
                            isMine={isMine}
                            timeStr={timeStr}
                          />
                        ) : (
                          <div className="flex flex-wrap items-end gap-x-2.5 gap-y-1">
                            <span className="break-words">{msg.text}</span>
                            <span
                              className={`inline-flex items-center gap-1 text-[11px] font-mono tabular-nums ml-auto select-none ${
                                isMine ? 'text-[#76A8D8]' : 'text-[#6C7883]'
                              }`}
                            >
                              <span>{timeStr}</span>
                              {isMine && <MessageReadStatus status={msg.status} />}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Нижняя панель: для подписчиков канала (не админов) — панель подписки, для остальных — ввод и запись */}
            {isChannel && !canPost ? (
              <div className="px-4 py-3 border-t border-[#101921] bg-[#17212B] flex items-center justify-between gap-3 shrink-0">
                {!isSubscribed && onJoinOrLeaveRoom && activeRoom ? (
                  <button
                    type="button"
                    onClick={() => onJoinOrLeaveRoom(activeRoom.id, 'join')}
                    className="w-full py-2.5 bg-[#5288C1] hover:bg-[#467AB0] text-white text-xs sm:text-sm font-semibold rounded-full transition-colors cursor-pointer flex items-center justify-center gap-2"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>Подписаться на канал</span>
                  </button>
                ) : (
                  <div className="w-full flex items-center justify-between gap-3 text-xs text-[#7F91A4]">
                    <span>
                      Вы подписаны на канал · Публиковать записи могут только администраторы
                    </span>
                    {onJoinOrLeaveRoom && activeRoom && (
                      <button
                        type="button"
                        onClick={() => onJoinOrLeaveRoom(activeRoom.id, 'leave')}
                        className="px-3 py-1.5 bg-[#242F3D] hover:bg-[#2C394A] text-[#F5F5F5] rounded-lg transition-colors cursor-pointer shrink-0"
                      >
                        Отписаться
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : recordingMode ? (
              <MediaNoteRecorder
                mode={recordingMode}
                currentUser={currentUser}
                onCancel={() => setRecordingMode(null)}
                onSendMedia={(mediaPayload) => {
                  onSendMessage('', mediaPayload);
                  setRecordingMode(null);
                }}
              />
            ) : (
              <form
                onSubmit={handleFormSubmit}
                className="px-2 sm:px-4 py-2.5 border-t border-[#101921] bg-[#17212B] flex items-center gap-1.5 sm:gap-2 shrink-0"
              >
                <input
                  type="text"
                  aria-label="Написать сообщение"
                  value={draftText}
                  onChange={handleInputChange}
                  placeholder={
                    isChannel
                      ? 'Опубликовать запись в канале...'
                      : isGroup
                        ? 'Сообщение в группу...'
                        : 'Сообщение'
                  }
                  className="flex-1 min-w-0 px-3.5 sm:px-4 py-2.5 bg-[#242F3D] rounded-full text-sm text-white placeholder-[#6C7883] focus:outline-none focus:ring-1 focus:ring-[#5288C1]"
                />

                {/* Кнопка записи голосового сообщения */}
                <button
                  type="button"
                  onClick={() => setRecordingMode('voice')}
                  aria-label="Записать голосовое сообщение"
                  title="Записать голосовое сообщение"
                  className="w-10 h-10 sm:w-auto sm:h-10 sm:px-3.5 flex items-center justify-center gap-1.5 bg-[#242F3D] hover:bg-[#2C394A] text-[#64B5EF] hover:text-white text-xs font-medium rounded-full transition-colors cursor-pointer shrink-0"
                >
                  <Mic className="w-4 h-4 shrink-0" />
                  <span className="hidden xl:inline">Голосовое</span>
                </button>

                {/* Кнопка записи видеокружка */}
                <button
                  type="button"
                  onClick={() => setRecordingMode('video_note')}
                  aria-label="Записать кружок"
                  title="Записать видеокружок"
                  className="w-10 h-10 sm:w-auto sm:h-10 sm:px-3.5 flex items-center justify-center gap-1.5 bg-[#242F3D] hover:bg-[#2C394A] text-[#64B5EF] hover:text-white text-xs font-medium rounded-full transition-colors cursor-pointer shrink-0"
                >
                  <Camera className="w-4 h-4 shrink-0" />
                  <span className="hidden xl:inline">Кружок</span>
                </button>

                <button
                  type="submit"
                  disabled={!draftText.trim()}
                  aria-label="Отправить"
                  className="w-10 h-10 sm:w-auto sm:h-10 sm:px-4 flex items-center justify-center gap-1.5 bg-[#5288C1] hover:bg-[#467AB0] disabled:opacity-40 text-white text-xs sm:text-sm font-semibold rounded-full transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Send className="w-4 h-4 shrink-0" />
                  <span className="hidden sm:inline">
                    {isChannel ? 'Опубликовать' : 'Отправить'}
                  </span>
                </button>
              </form>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="px-4 py-1.5 rounded-full bg-[#182533] text-xs font-medium text-[#F5F5F5]">
              Выберите чат, группу или канал, чтобы начать общение
            </div>
          </div>
        )}
      </section>

      {/* Модальное окно создания группового чата или канала */}
      {onCreateRoom && (
        <CreateRoomModal
          isOpen={createModalType !== null}
          initialType={createModalType || 'group'}
          currentUser={currentUser}
          contacts={contacts}
          onClose={() => setCreateModalType(null)}
          onCreateRoom={onCreateRoom}
        />
      )}

      {/* Модальное окно информации и управления группой / каналом */}
      {activeRoom && (
        <RoomInfoModal
          isOpen={isRoomInfoOpen}
          room={activeRoom}
          currentUser={currentUser}
          contacts={contacts}
          onClose={() => setIsRoomInfoOpen(false)}
          onJoinOrLeave={async (roomId, action) => {
            if (onJoinOrLeaveRoom) {
              await onJoinOrLeaveRoom(roomId, action);
            }
          }}
          onUpdateMembers={async (roomId, memberIds) => {
            if (onUpdateRoomMembers) {
              await onUpdateRoomMembers(roomId, memberIds);
            }
          }}
          onUpdateRoom={onUpdateRoom}
          onDeleteRoom={async (roomId) => {
            if (onDeleteRoom) {
              await onDeleteRoom(roomId);
            }
          }}
        />
      )}
    </div>
  );
};
