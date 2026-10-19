import React, { useState, useRef, useEffect } from 'react';
import {
  Users,
  Megaphone,
  X,
  Camera,
  Check,
  UserPlus,
  UserMinus,
  Trash2,
  Shield,
  Lock,
  Search,
  Save,
} from 'lucide-react';
import {
  validateRoomCreation,
  formatRoomMembersLabel,
  generateRoomHandle,
  canUserAdministerRoom,
  searchUsersToInvite,
  type UserProfile,
  type ChatRoom,
} from '../utils/messengerLogic';
import { UserAvatar, processAvatarImageFile } from './UserAvatar';

const ROOM_AVATAR_COLORS = [
  '#3E9F65',
  '#8E57C2',
  '#5288C1',
  '#D97724',
  '#D84B6B',
  '#2F9FA8',
];

export interface RoomAdminUpdatePayload {
  title?: string;
  description?: string;
  avatarColor?: string;
  avatarUrl?: string;
  memberIds?: string[];
  adminIds?: string[];
}

interface CreateRoomModalProps {
  isOpen: boolean;
  initialType?: 'group' | 'channel';
  currentUser: UserProfile;
  contacts: UserProfile[];
  onClose: () => void;
  onCreateRoom: (payload: {
    type: 'group' | 'channel';
    title: string;
    handle: string;
    description: string;
    avatarColor: string;
    avatarUrl?: string;
    memberIds: string[];
    isPublic: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Модальное окно создания группового чата или канала.
 * Общие чаты доступны только создателю и приглашенным участникам.
 * Найти людей для приглашения можно через строку поиска.
 */
export const CreateRoomModal: React.FC<CreateRoomModalProps> = ({
  isOpen,
  initialType = 'group',
  currentUser,
  contacts,
  onClose,
  onCreateRoom,
}) => {
  const [roomType, setRoomType] = useState<'group' | 'channel'>(initialType);
  const [title, setTitle] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [avatarColor, setAvatarColor] = useState(
    initialType === 'channel' ? '#8E57C2' : '#3E9F65'
  );
  const [avatarUrl, setAvatarUrl] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [inviteSearchQuery, setInviteSearchQuery] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setRoomType(initialType);
      setTitle('');
      setHandle('');
      setDescription('');
      setAvatarColor(initialType === 'channel' ? '#8E57C2' : '#3E9F65');
      setAvatarUrl('');
      setSelectedMemberIds(new Set());
      setInviteSearchQuery('');
      setError('');
      setIsSubmitting(false);
    }
  }, [isOpen, initialType]);

  if (!isOpen) return null;

  const directContacts = contacts.filter(
    (c) => c.id !== currentUser.id && (!c.kind || c.kind === 'direct')
  );

  const selectedProfiles = directContacts.filter((c) => selectedMemberIds.has(c.id));
  const searchResults = searchUsersToInvite(
    directContacts,
    currentUser.id,
    Array.from(selectedMemberIds),
    inviteSearchQuery
  );

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    const result = await processAvatarImageFile(file);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.dataUrl) {
      setAvatarUrl(result.dataUrl);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const validation = validateRoomCreation({
      type: roomType,
      title,
      handle,
      description,
    });

    if (!validation.valid) {
      setError(validation.error || 'Проверьте заполнение полей');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await onCreateRoom({
        type: validation.roomType,
        title: validation.sanitizedTitle,
        handle: validation.sanitizedHandle,
        description: validation.sanitizedDescription,
        avatarColor,
        avatarUrl: avatarUrl || undefined,
        memberIds: [currentUser.id, ...Array.from(selectedMemberIds)],
        isPublic: false,
      });

      if (!res.ok) {
        setError(res.error || 'Не удалось создать комнату');
        setIsSubmitting(false);
        return;
      }
      onClose();
    } catch {
      setError('Ошибка сети при создании');
      setIsSubmitting(false);
    }
  };

  const autoHandlePreview =
    handle.trim().replace(/^@+/, '') ||
    (title.trim().length >= 2 ? generateRoomHandle(title, roomType) : '');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={roomType === 'channel' ? 'Создать канал' : 'Создать групповой чат'}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg bg-[#17212B] border border-[#242F3D] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]">
        {/* Шапка модального окна */}
        <div className="px-5 py-4 border-b border-[#101921] flex items-center justify-between gap-3 bg-[#17212B] shrink-0">
          <div className="flex items-center gap-2.5">
            {roomType === 'channel' ? (
              <div className="w-9 h-9 rounded-full bg-[#8E57C2]/20 text-[#B388FF] flex items-center justify-center">
                <Megaphone className="w-4 h-4" />
              </div>
            ) : (
              <div className="w-9 h-9 rounded-full bg-[#3E9F65]/20 text-[#57D188] flex items-center justify-center">
                <Users className="w-4 h-4" />
              </div>
            )}
            <div>
              <h2 className="text-sm sm:text-base font-bold text-white">
                {roomType === 'channel' ? 'Новый закрытый канал' : 'Новый групповой чат'}
              </h2>
              <p className="text-[11px] text-[#7F91A4]">
                Доступен только создателю и приглашенным участникам
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть окно создания"
            className="w-8 h-8 rounded-full flex items-center justify-center text-[#7F91A4] hover:text-white hover:bg-[#242F3D] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Форма создания */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* Переключатель типа: Групповой чат / Канал */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-[#0E1621] rounded-xl border border-[#232E3C]">
            <button
              type="button"
              onClick={() => {
                setRoomType('group');
                setAvatarColor('#3E9F65');
                setError('');
              }}
              className={`py-2.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                roomType === 'group'
                  ? 'bg-[#2B5278] text-white shadow-xs'
                  : 'text-[#7F91A4] hover:text-white'
              }`}
            >
              <Users className="w-4 h-4" />
              <span>Групповой чат</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setRoomType('channel');
                setAvatarColor('#8E57C2');
                setError('');
              }}
              className={`py-2.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                roomType === 'channel'
                  ? 'bg-[#2B5278] text-white shadow-xs'
                  : 'text-[#7F91A4] hover:text-white'
              }`}
            >
              <Megaphone className="w-4 h-4" />
              <span>Канал</span>
            </button>
          </div>

          {/* Аватар + Название */}
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                aria-label="Загрузить аватар группы или канала"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Загрузить фото аватара"
                className="relative group rounded-full focus:outline-none focus:ring-2 focus:ring-[#64B5EF] cursor-pointer"
              >
                <UserAvatar
                  displayName={title.trim() || (roomType === 'channel' ? 'К' : 'Г')}
                  avatarColor={avatarColor}
                  avatarUrl={avatarUrl}
                  sizeClass="w-16 h-16"
                  textClass="text-lg"
                />
                <span className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-[#5288C1] border-2 border-[#17212B] flex items-center justify-center text-white">
                  <Camera className="w-3 h-3" />
                </span>
              </button>
            </div>

            <div className="flex-1 min-w-0 space-y-2">
              <div>
                <label
                  htmlFor="room-title-input"
                  className="block text-xs font-medium text-[#7F91A4] mb-1"
                >
                  {roomType === 'channel' ? 'Название канала' : 'Название группы'}
                </label>
                <input
                  id="room-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    roomType === 'channel'
                      ? 'Например: Новости Pulse'
                      : 'Например: Команда разработки'
                  }
                  className="w-full px-3.5 py-2 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
                />
              </div>

              {/* Цвета аватара + кнопка загрузки фото */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  {ROOM_AVATAR_COLORS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setAvatarColor(hex)}
                      aria-label={`Цвет аватара ${hex}`}
                      className={`w-5 h-5 rounded-full transition-transform cursor-pointer ${
                        avatarColor === hex
                          ? 'ring-2 ring-white scale-110'
                          : 'opacity-80 hover:opacity-100'
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-[11px] font-medium text-[#64B5EF] hover:underline cursor-pointer"
                >
                  {avatarUrl ? 'Изменить аватар' : 'Загрузить аватар'}
                </button>
                {avatarUrl && (
                  <button
                    type="button"
                    onClick={() => setAvatarUrl('')}
                    className="text-[11px] text-rose-300 hover:underline cursor-pointer"
                  >
                    Удалить
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Короткая ссылка (@handle) и Описание */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="room-handle-input"
                className="block text-xs font-medium text-[#7F91A4] mb-1"
              >
                Короткий адрес (@handle)
              </label>
              <input
                id="room-handle-input"
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder={autoHandlePreview ? `@${autoHandlePreview}` : '@pulse_room'}
                className="w-full px-3.5 py-2 bg-[#242F3D] border border-[#2B3848] rounded-xl text-xs text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
              />
            </div>

            <div>
              <label
                htmlFor="room-desc-input"
                className="block text-xs font-medium text-[#7F91A4] mb-1"
              >
                Описание (необязательно)
              </label>
              <input
                id="room-desc-input"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  roomType === 'channel'
                    ? 'О чем этот канал...'
                    : 'Тема обсуждения группы...'
                }
                className="w-full px-3.5 py-2 bg-[#242F3D] border border-[#2B3848] rounded-xl text-xs text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
              />
            </div>
          </div>

          {/* Поиск и приглашение участников (участники видны только по поиску) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#7F91A4]">
                {roomType === 'channel'
                  ? `Пригласить подписчиков (${selectedMemberIds.size} выбрано)`
                  : `Пригласить участников (${selectedMemberIds.size} выбрано)`}
              </span>
            </div>

            {/* Выбранные участники */}
            {selectedProfiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {selectedProfiles.map((u) => (
                  <span
                    key={u.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#2B5278] text-white text-xs font-medium"
                  >
                    <span>{u.displayName}</span>
                    <button
                      type="button"
                      onClick={() => toggleMember(u.id)}
                      aria-label={`Убрать ${u.displayName}`}
                      className="text-[#D3E5F6] hover:text-white cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Строка поиска участников для приглашения */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#6C7883] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                aria-label="Поиск людей для приглашения"
                value={inviteSearchQuery}
                onChange={(e) => setInviteSearchQuery(e.target.value)}
                placeholder="Найти участников по имени или @username..."
                className="w-full pl-9 pr-3.5 py-2 bg-[#0E1621] border border-[#232E3C] rounded-xl text-xs text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
              />
            </div>

            {!inviteSearchQuery.trim() ? (
              <div className="p-3 bg-[#0E1621] border border-[#232E3C] rounded-xl text-xs text-[#7F91A4]">
                Введите имя или <span className="text-[#64B5EF]">@username</span> выше, чтобы найти и пригласить людей. Чат будет виден только вам и приглашенным участникам.
              </div>
            ) : searchResults.length === 0 ? (
              <div className="p-3 bg-[#0E1621] border border-[#232E3C] rounded-xl text-xs text-[#7F91A4]">
                Участники по запросу «{inviteSearchQuery}» не найдены
              </div>
            ) : (
              <div className="max-h-36 overflow-y-auto divide-y divide-[#17212B] bg-[#0E1621] border border-[#232E3C] rounded-xl">
                {searchResults.map((contact) => (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-[#17212B]/70 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <UserAvatar
                        displayName={contact.displayName}
                        avatarColor={contact.avatarColor}
                        avatarUrl={contact.avatarUrl}
                        sizeClass="w-8 h-8"
                        textClass="text-xs"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">
                          {contact.displayName}
                        </p>
                        <p className="text-[11px] text-[#7F91A4] truncate">
                          @{contact.username}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      aria-label={`Пригласить ${contact.displayName}`}
                      onClick={() => {
                        toggleMember(contact.id);
                        setInviteSearchQuery('');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#2B5278] hover:bg-[#34628E] text-white text-[11px] font-medium rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      <UserPlus className="w-3 h-3" />
                      <span>Пригласить</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="p-2.5 bg-rose-950/60 border border-rose-800/80 rounded-xl text-xs text-rose-200"
            >
              {error}
            </div>
          )}

          {/* Кнопки действий */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-[#242F3D] hover:bg-[#2C394A] text-xs font-medium text-[#F5F5F5] rounded-xl transition-colors cursor-pointer"
            >
              Отмена
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-1.5 px-5 py-2 bg-[#5288C1] hover:bg-[#467AB0] disabled:opacity-50 text-xs font-semibold text-white rounded-xl transition-colors cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>
                {roomType === 'channel' ? 'Создать канал' : 'Создать группу'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface RoomInfoModalProps {
  isOpen: boolean;
  room: ChatRoom | null;
  currentUser: UserProfile;
  contacts: UserProfile[];
  onClose: () => void;
  onJoinOrLeave: (roomId: string, action: 'join' | 'leave') => Promise<void>;
  onUpdateMembers: (roomId: string, memberIds: string[]) => Promise<void>;
  onUpdateRoom?: (
    roomId: string,
    updates: RoomAdminUpdatePayload
  ) => Promise<{ ok: boolean; error?: string }>;
  onDeleteRoom: (roomId: string) => Promise<void>;
}

/**
 * Модальное окно информации и администрирования группового чата или канала:
 * - Загрузка и смена аватара группы/канала
 * - Редактирование названия и описания
 * - Поиск пользователей по имени / @username и приглашение в группу/канал
 * - Назначение и снятие администраторов, исключение участников
 */
export const RoomInfoModal: React.FC<RoomInfoModalProps> = ({
  isOpen,
  room,
  currentUser,
  contacts,
  onClose,
  onJoinOrLeave,
  onUpdateMembers,
  onUpdateRoom,
  onDeleteRoom,
}) => {
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editColor, setEditColor] = useState('#3E9F65');
  const [inviteQuery, setInviteQuery] = useState('');
  const [adminError, setAdminError] = useState('');
  const [adminSavedMsg, setAdminSavedMsg] = useState('');
  const roomAvatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen && room) {
      setEditTitle(room.title);
      setEditDescription(room.description || '');
      setEditColor(room.avatarColor || (room.type === 'channel' ? '#8E57C2' : '#3E9F65'));
      setInviteQuery('');
      setAdminError('');
      setAdminSavedMsg('');
    }
  }, [isOpen, room?.id, room?.title, room?.description, room?.avatarColor, room?.type]);

  if (!isOpen || !room) return null;

  const isOwner = room.ownerId === currentUser.id;
  const isAdmin = canUserAdministerRoom(room, currentUser.id);
  const isMember = room.memberIds.includes(currentUser.id);

  const directUsers = contacts.filter((u) => !u.kind || u.kind === 'direct');
  const memberProfiles = room.memberIds.map((uid) => {
    if (uid === currentUser.id) return currentUser;
    return (
      directUsers.find((u) => u.id === uid) || {
        id: uid,
        username: uid.slice(0, 8),
        displayName: 'Участник Pulse',
        avatarColor: '#5288C1',
        role: 'В сети Pulse',
        online: false,
        lastSeen: room.createdAt,
      }
    );
  });

  // Поиск пользователей для приглашения (только при непустом запросе)
  const inviteCandidates = searchUsersToInvite(
    directUsers,
    currentUser.id,
    room.memberIds,
    inviteQuery
  );

  const showSavedFeedback = (msg: string) => {
    setAdminSavedMsg(msg);
    setTimeout(() => setAdminSavedMsg(''), 2200);
  };

  const handleRoomAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onUpdateRoom) return;
    setAdminError('');
    const result = await processAvatarImageFile(file);
    if (result.error) {
      setAdminError(result.error);
      return;
    }
    if (result.dataUrl) {
      const res = await onUpdateRoom(room.id, { avatarUrl: result.dataUrl });
      if (!res.ok) {
        setAdminError(res.error || 'Не удалось обновить аватар');
      } else {
        showSavedFeedback('Аватар успешно обновлен');
      }
    }
  };

  const handleRemoveRoomAvatar = async () => {
    if (!onUpdateRoom) return;
    setAdminError('');
    const res = await onUpdateRoom(room.id, { avatarUrl: '' });
    if (res.ok) {
      showSavedFeedback('Фото аватара удалено');
    }
  };

  const handleSaveRoomDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onUpdateRoom) return;
    setAdminError('');
    if (editTitle.trim().length < 2) {
      setAdminError('Название должно содержать минимум 2 символа');
      return;
    }
    const res = await onUpdateRoom(room.id, {
      title: editTitle.trim(),
      description: editDescription.trim(),
      avatarColor: editColor,
    });
    if (!res.ok) {
      setAdminError(res.error || 'Не удалось сохранить настройки');
    } else {
      showSavedFeedback('Настройки сохранены');
    }
  };

  const handleInviteUser = async (userId: string) => {
    setAdminError('');
    const nextMembers = Array.from(new Set([...room.memberIds, userId]));
    if (onUpdateRoom) {
      const res = await onUpdateRoom(room.id, { memberIds: nextMembers });
      if (res.ok) {
        setInviteQuery('');
        showSavedFeedback('Участник приглашен');
      } else {
        setAdminError(res.error || 'Не удалось пригласить участника');
      }
    } else {
      await onUpdateMembers(room.id, nextMembers);
      setInviteQuery('');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (userId === room.ownerId) return;
    const nextMembers = room.memberIds.filter((id) => id !== userId);
    if (onUpdateRoom) {
      await onUpdateRoom(room.id, { memberIds: nextMembers });
    } else {
      await onUpdateMembers(room.id, nextMembers);
    }
  };

  const handleToggleAdminRole = async (userId: string) => {
    if (!onUpdateRoom || userId === room.ownerId) return;
    const currentlyAdmin = room.adminIds.includes(userId);
    const nextAdmins = currentlyAdmin
      ? room.adminIds.filter((id) => id !== userId)
      : Array.from(new Set([...room.adminIds, userId]));
    const res = await onUpdateRoom(room.id, { adminIds: nextAdmins });
    if (res.ok) {
      showSavedFeedback(
        currentlyAdmin ? 'Права администратора сняты' : 'Назначен администратором'
      );
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={room.type === 'channel' ? 'Информация о канале' : 'Информация о группе'}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg bg-[#17212B] border border-[#242F3D] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]">
        {/* Шапка */}
        <div className="px-5 py-4 border-b border-[#101921] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            {room.type === 'channel' ? (
              <Megaphone className="w-4 h-4 text-[#B388FF]" />
            ) : (
              <Users className="w-4 h-4 text-[#57D188]" />
            )}
            <h2 className="text-sm font-bold text-white">
              {isAdmin
                ? room.type === 'channel'
                  ? 'Управление каналом'
                  : 'Управление группой'
                : room.type === 'channel'
                  ? 'О канале'
                  : 'О групповом чате'}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть информацию"
            className="w-8 h-8 rounded-full flex items-center justify-center text-[#7F91A4] hover:text-white hover:bg-[#242F3D] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* Карточка комнаты + загрузка аватара для админов */}
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              {isAdmin && (
                <input
                  ref={roomAvatarInputRef}
                  type="file"
                  accept="image/*"
                  aria-label="Загрузить новый аватар комнаты"
                  onChange={handleRoomAvatarUpload}
                  className="hidden"
                />
              )}
              <button
                type="button"
                disabled={!isAdmin}
                onClick={() => {
                  if (isAdmin) roomAvatarInputRef.current?.click();
                }}
                title={isAdmin ? 'Нажмите, чтобы загрузить аватар' : room.title}
                className={`relative rounded-full focus:outline-none ${
                  isAdmin ? 'cursor-pointer group focus:ring-2 focus:ring-[#64B5EF]' : ''
                }`}
              >
                <UserAvatar
                  displayName={room.title}
                  avatarColor={room.avatarColor}
                  avatarUrl={room.avatarUrl}
                  sizeClass="w-16 h-16"
                  textClass="text-lg"
                />
                {isAdmin && (
                  <span className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-[#5288C1] border-2 border-[#17212B] flex items-center justify-center text-white shadow">
                    <Camera className="w-3 h-3" />
                  </span>
                )}
              </button>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white truncate">{room.title}</h3>
                <span className="px-2 py-0.5 rounded-md bg-[#242F3D] text-[10px] font-semibold uppercase tracking-wider text-[#64B5EF] shrink-0">
                  {room.type === 'channel' ? 'Канал' : 'Группа'}
                </span>
              </div>
              <p className="text-xs text-[#64B5EF] flex items-center gap-1 mt-0.5">
                <Lock className="w-3 h-3" />
                <span>@{room.handle}</span>
                <span>·</span>
                <span>{formatRoomMembersLabel(room.type, room.memberIds.length)}</span>
              </p>
              {room.description && !isAdmin && (
                <p className="text-xs text-[#7F91A4] mt-1.5 leading-relaxed">
                  {room.description}
                </p>
              )}

              {isAdmin && (
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => roomAvatarInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2B5278] hover:bg-[#34628E] text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5 text-[#64B5EF]" />
                    <span>{room.avatarUrl ? 'Изменить аватар' : 'Загрузить аватар'}</span>
                  </button>
                  {room.avatarUrl && (
                    <button
                      type="button"
                      onClick={handleRemoveRoomAvatar}
                      className="px-2.5 py-1.5 bg-[#242F3D] hover:bg-rose-950/60 text-xs text-[#7F91A4] hover:text-rose-300 rounded-lg transition-colors cursor-pointer"
                    >
                      Удалить фото
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {adminError && (
            <div
              role="alert"
              className="p-2.5 bg-rose-950/60 border border-rose-800/80 rounded-xl text-xs text-rose-200"
            >
              {adminError}
            </div>
          )}

          {adminSavedMsg && (
            <div
              role="status"
              className="p-2.5 bg-emerald-950/60 border border-emerald-800/80 rounded-xl text-xs text-emerald-200"
            >
              {adminSavedMsg}
            </div>
          )}

          {/* Панель редактирования названия, описания и цвета аватара (для создателя и администраторов) */}
          {isAdmin && onUpdateRoom && (
            <form
              onSubmit={handleSaveRoomDetails}
              className="p-3.5 bg-[#0E1621] border border-[#232E3C] rounded-xl space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#64B5EF] uppercase tracking-wider">
                  Настройки {room.type === 'channel' ? 'канала' : 'группы'}
                </span>
                <div className="flex items-center gap-1">
                  {ROOM_AVATAR_COLORS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setEditColor(hex)}
                      aria-label={`Цвет ${hex}`}
                      className={`w-4 h-4 rounded-full cursor-pointer ${
                        editColor === hex ? 'ring-2 ring-white scale-110' : 'opacity-75'
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label
                    htmlFor="admin-room-title"
                    className="block text-[11px] text-[#7F91A4] mb-1"
                  >
                    Название
                  </label>
                  <input
                    id="admin-room-title"
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full px-3 py-1.5 bg-[#17212B] border border-[#2B3848] rounded-lg text-xs text-white focus:outline-none focus:border-[#5288C1]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="admin-room-desc"
                    className="block text-[11px] text-[#7F91A4] mb-1"
                  >
                    Описание
                  </label>
                  <input
                    id="admin-room-desc"
                    type="text"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Описание..."
                    className="w-full px-3 py-1.5 bg-[#17212B] border border-[#2B3848] rounded-lg text-xs text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#5288C1] hover:bg-[#467AB0] text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Сохранить изменения</span>
                </button>
              </div>
            </form>
          )}

          {/* Приглашение новых участников по поиску (для создателя и администраторов) */}
          {isAdmin && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-[#7F91A4] uppercase tracking-wider">
                Пригласить людей по поиску
              </h4>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#6C7883] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  aria-label="Найти пользователя для приглашения"
                  value={inviteQuery}
                  onChange={(e) => setInviteQuery(e.target.value)}
                  placeholder="Введите имя или @username для приглашения..."
                  className="w-full pl-9 pr-3.5 py-2 bg-[#0E1621] border border-[#232E3C] rounded-xl text-xs text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1]"
                />
              </div>

              {inviteQuery.trim() && (
                <div className="divide-y divide-[#17212B] bg-[#0E1621] border border-[#232E3C] rounded-xl max-h-36 overflow-y-auto">
                  {inviteCandidates.length === 0 ? (
                    <div className="p-3 text-xs text-[#7F91A4]">
                      Пользователи по запросу «{inviteQuery}» не найдены
                    </div>
                  ) : (
                    inviteCandidates.map((user) => (
                      <div
                        key={user.id}
                        className="px-3 py-2 flex items-center justify-between gap-2"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <UserAvatar
                            displayName={user.displayName}
                            avatarColor={user.avatarColor}
                            avatarUrl={user.avatarUrl}
                            sizeClass="w-7 h-7"
                            textClass="text-[11px]"
                          />
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-white truncate">
                              {user.displayName}
                            </p>
                            <p className="text-[10px] text-[#7F91A4] truncate">
                              @{user.username}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label={`Пригласить ${user.displayName}`}
                          onClick={() => handleInviteUser(user.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#2B5278] hover:bg-[#34628E] text-white text-[11px] font-medium rounded-lg transition-colors cursor-pointer shrink-0"
                        >
                          <UserPlus className="w-3 h-3" />
                          <span>Пригласить</span>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* Кнопка выхода для приглашенных участников (не владельцев) */}
          {!isOwner && isMember && (
            <div>
              <button
                type="button"
                onClick={() => onJoinOrLeave(room.id, 'leave')}
                className="w-full py-2.5 px-4 bg-[#242F3D] hover:bg-rose-950/60 text-xs font-semibold text-[#F5F5F5] hover:text-rose-200 rounded-xl transition-colors cursor-pointer"
              >
                {room.type === 'channel' ? 'Отписаться от канала' : 'Покинуть группу'}
              </button>
            </div>
          )}

          {/* Список участников / подписчиков и управление правами администратора */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-[#7F91A4] uppercase tracking-wider">
              {room.type === 'channel'
                ? `Подписчики и администраторы (${memberProfiles.length})`
                : `Участники группы (${memberProfiles.length})`}
            </h4>
            <div className="divide-y divide-[#17212B] bg-[#0E1621] border border-[#232E3C] rounded-xl max-h-48 overflow-y-auto">
              {memberProfiles.map((member) => {
                const isMemberOwner = member.id === room.ownerId;
                const isMemberAdmin = room.adminIds.includes(member.id);
                return (
                  <div
                    key={member.id}
                    className="px-3 py-2.5 flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <UserAvatar
                        displayName={member.displayName}
                        avatarColor={member.avatarColor}
                        avatarUrl={member.avatarUrl}
                        sizeClass="w-8 h-8"
                        textClass="text-xs"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">
                          {member.displayName}
                          {member.id === currentUser.id ? ' (Вы)' : ''}
                        </p>
                        <p className="text-[11px] text-[#7F91A4] truncate">
                          @{member.username}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isMemberOwner ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#2B5278]/60 text-[10px] font-medium text-[#64B5EF]">
                          <Shield className="w-3 h-3" />
                          Создатель
                        </span>
                      ) : isMemberAdmin ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#8E57C2]/30 text-[10px] font-medium text-[#B388FF]">
                          <Shield className="w-3 h-3" />
                          Админ
                        </span>
                      ) : null}

                      {isAdmin && !isMemberOwner && onUpdateRoom && (
                        <button
                          type="button"
                          onClick={() => handleToggleAdminRole(member.id)}
                          title={
                            isMemberAdmin
                              ? 'Снять права администратора'
                              : 'Назначить администратором'
                          }
                          className="px-2 py-1 rounded-lg bg-[#242F3D] hover:bg-[#2C394A] text-[10px] font-medium text-[#64B5EF] transition-colors cursor-pointer"
                        >
                          {isMemberAdmin ? 'Снять админа' : 'Сделать админом'}
                        </button>
                      )}

                      {isAdmin && !isMemberOwner && member.id !== currentUser.id && (
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(member.id)}
                          aria-label={`Исключить ${member.displayName}`}
                          title="Исключить"
                          className="p-1.5 rounded-lg text-[#7F91A4] hover:text-rose-300 hover:bg-rose-950/50 transition-colors cursor-pointer"
                        >
                          <UserMinus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Удаление группы / канала создателем */}
          {isOwner && (
            <div className="pt-2 border-t border-[#101921] flex justify-between items-center">
              <button
                type="button"
                onClick={async () => {
                  await onDeleteRoom(room.id);
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#242F3D] hover:bg-rose-950/60 text-xs font-medium text-[#7F91A4] hover:text-rose-300 rounded-xl transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>
                  {room.type === 'channel' ? 'Удалить канал' : 'Удалить группу'}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
