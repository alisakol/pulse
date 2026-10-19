import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  UserPlus,
  LogIn,
  Trash2,
  CheckCircle2,
  Camera,
  X,
  KeyRound,
  Eye,
  EyeOff,
  ShieldCheck,
  Smartphone,
  Sparkles,
  ArrowRight,
  Info,
  Mail,
  Cloud,
} from 'lucide-react';
import {
  validateCredentials,
  validatePasswordReset,
  normalizeUsername,
  validatePasswordStrength,
  type UserProfile,
} from '../utils/messengerLogic';
import { UserAvatar, processAvatarImageFile } from './UserAvatar';
import {
  auth,
  registerWithEmailAndNickname,
  loginWithNicknameOrEmail,
  resetPasswordForUser,
} from '../firebase';

export interface SavedSessionEntry {
  user: UserProfile;
  token: string;
  savedAt: string;
}

interface AuthScreenProps {
  savedSessions: SavedSessionEntry[];
  onAuthSuccess: (user: UserProfile, token: string, rememberSession: boolean) => void;
  onRemoveSavedSession: (userId: string) => void;
}

/**
 * Отрефакторенный экран авторизации и регистрации мессенджера Pulse
 * на базе Google Cloud Firebase (Auth + Firestore):
 * - Регистрация: обязательное указание Email, уникального никнейма (@username), имени и пароля
 * - Вход: возможен как по никнейму (@username), так и по email с паролем
 * - Восстановление: сброс по никнейму или почте с отправкой ссылки
 * - Показ/скрытие пароля (Eye / EyeOff)
 * - Надежное хэширование и синхронизация между всеми устройствами
 */
export const AuthScreen: React.FC<AuthScreenProps> = ({
  savedSessions,
  onAuthSuccess,
  onRemoveSavedSession,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>(
    savedSessions.length > 0 ? 'login' : 'register'
  );
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  // Видимость паролей
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Обратная связь
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Расчет надежности пароля при вводе
  const passwordStrength = validatePasswordStrength(password);
  const passwordsMatch =
    confirmPassword.length > 0 && password === confirmPassword;

  // Очистка сообщений при смене вкладки
  const handleSwitchMode = (newMode: 'login' | 'register' | 'reset') => {
    setMode(newMode);
    setError('');
    setSuccessMsg('');
  };

  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
    setSuccessMsg('');

    const cleanUser = normalizeUsername(username);

    // 1. Режим: Сброс пароля
    if (mode === 'reset') {
      if (!username.trim()) {
        setError('Укажите ваш никнейм (@username) или адрес почты');
        return;
      }

      setLoading(true);
      try {
        // Пробуем отправить сброс через Firebase
        try {
          const { resolvedEmail } = await resetPasswordForUser(username);
          setSuccessMsg(`Ссылка для восстановления пароля отправлена на почту ${resolvedEmail}!`);
          setLoading(false);
          return;
        } catch (fbErr: any) {
          const msg = fbErr?.message || '';
          if (msg.includes('не найден')) {
            setError(msg);
            setLoading(false);
            return;
          }
        }

        // Локальный сброс пароля (фоллбэк)
        const resetValidation = validatePasswordReset(cleanUser, password, confirmPassword);
        if (!resetValidation.valid) {
          setError(resetValidation.error || 'Проверьте правильность заполнения полей');
          setLoading(false);
          return;
        }

        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: cleanUser,
            newPassword: password,
            confirmPassword,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Не удалось сбросить пароль');
          setLoading(false);
          return;
        }

        setSuccessMsg('Пароль успешно обновлен! Выполняется вход в Pulse...');
        setTimeout(() => {
          onAuthSuccess(data.user, data.token, rememberMe);
        }, 500);
      } catch {
        setError('Ошибка соединения с сервисом авторизации.');
      } finally {
        setLoading(false);
      }
      return;
    }

    // 2. Валидация общих полей
    const validation = validateCredentials(
      cleanUser,
      password,
      mode === 'register',
      displayName,
      mode === 'register' ? confirmPassword : undefined
    );

    if (!validation.valid) {
      setError(validation.error || 'Проверьте правильность заполнения полей');
      return;
    }

    // При регистрации обязательна валидная почта
    if (mode === 'register') {
      const cleanEmail = email.trim().toLowerCase();
      if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
        setError('Укажите корректный адрес электронной почты (например: user@mail.com)');
        return;
      }
    }

    setLoading(true);

    // 3. Регистрация через Firebase Cloud Auth + синхронизация с сервером
    if (mode === 'register') {
      try {
        let registeredUser: UserProfile | null = null;
        let idToken = '';

        try {
          registeredUser = await registerWithEmailAndNickname({
            email,
            username: cleanUser,
            displayName,
            password,
            avatarUrl,
            bio,
          });
          idToken = (await auth.currentUser?.getIdToken()) || `fb_${registeredUser.id}`;
        } catch (fbErr: any) {
          const errMsg = fbErr?.message || '';
          if (errMsg.includes('email-already-in-use')) {
            setError('Этот адрес электронной почты уже зарегистрирован. Пожалуйста, войдите в аккаунт.');
            setLoading(false);
            return;
          }
          if (errMsg.includes('Никнейм')) {
            setError(errMsg);
            setLoading(false);
            return;
          }
          console.warn('Firebase registration fallback to server sync:', fbErr);
        }

        // Синхронизируем с локальным бэкендом (для сокетов и WebRTC)
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: registeredUser?.id,
            email: email.trim().toLowerCase(),
            username: cleanUser,
            password,
            displayName: displayName.trim(),
            bio: bio.trim(),
            avatarUrl,
          }),
        });

        const data = await res.json();
        if (!res.ok && !registeredUser) {
          setError(data.error || 'Не удалось выполнить регистрацию');
          setLoading(false);
          return;
        }

        const finalUser = registeredUser || data.user;
        const finalToken = idToken || data.token;
        onAuthSuccess(finalUser, finalToken, rememberMe);
      } catch {
        setError('Ошибка соединения с сервисом авторизации.');
      } finally {
        setLoading(false);
      }
      return;
    }

    // 4. Вход по никнейму (@username) или Email через Firebase Auth
    if (mode === 'login') {
      try {
        let loggedUser: UserProfile | null = null;
        let idToken = '';

        try {
          loggedUser = await loginWithNicknameOrEmail(username, password);
          idToken = (await auth.currentUser?.getIdToken()) || `fb_${loggedUser.id}`;
        } catch (fbErr: any) {
          const errMsg = fbErr?.message || '';
          if (errMsg.includes('wrong-password') || errMsg.includes('invalid-credential')) {
            setError('Неверный пароль. Проверьте правильность ввода.');
            setLoading(false);
            return;
          }
          if (errMsg.includes('Аккаунт с никнеймом') || errMsg.includes('user-not-found')) {
            setError(errMsg || 'Аккаунт не найден.');
            setLoading(false);
            return;
          }
          console.warn('Firebase login fallback to server sync:', fbErr);
        }

        // Синхронизируем сессию с бэкендом
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: loggedUser?.username || cleanUser,
            password,
          }),
        });

        const data = await res.json();
        if (!res.ok && !loggedUser) {
          setError(data.error || 'Не удалось выполнить вход');
          setLoading(false);
          return;
        }

        const finalUser = loggedUser || data.user;
        const finalToken = idToken || data.token;
        onAuthSuccess(finalUser, finalToken, rememberMe);
      } catch {
        setError('Ошибка соединения с сервером Pulse.');
      } finally {
        setLoading(false);
      }
    }
  };

  const handleResumeSavedSession = async (entry: SavedSessionEntry) => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/me', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${entry.token}`,
        },
        body: JSON.stringify({
          token: entry.token,
          user: entry.user,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        onAuthSuccess(data.user || entry.user, data.token || entry.token, true);
      } else {
        onAuthSuccess(entry.user, entry.token, true);
      }
    } catch {
      onAuthSuccess(entry.user, entry.token, true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0E1621] text-[#F5F5F5] flex flex-col justify-center items-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-md bg-[#17212B] border border-[#232E3C] rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
        {/* Логотип Pulse и слоган */}
        <div className="text-center space-y-2">
          <div className="w-16 h-16 rounded-full bg-[#5288C1] flex items-center justify-center mx-auto text-white shadow-lg shadow-[#5288C1]/20">
            <Send className="w-7 h-7 -ml-0.5 mt-0.5" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white pt-1">Pulse</h1>
          <p className="text-xs text-[#7F91A4] leading-relaxed max-w-xs mx-auto">
            Облачный мессенджер с авторизацией по почте, паролю и никнейму
          </p>
        </div>

        {/* Быстрый вход в сохраненные аккаунты на этом устройстве */}
        {savedSessions.length > 0 && (
          <div className="space-y-2.5 pt-1 border-b border-[#232E3C] pb-4">
            <div className="flex items-center justify-between text-xs text-[#7F91A4]">
              <span className="flex items-center gap-1.5 font-medium">
                <Smartphone className="w-3.5 h-3.5 text-[#64B5EF]" />
                Сохраненные аккаунты на устройстве
              </span>
              <span className="text-[11px] text-[#6C7883]">{savedSessions.length}</span>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto pr-0.5">
              {savedSessions.map((entry) => (
                <div
                  key={entry.user.id}
                  className="flex items-center justify-between gap-2 p-2.5 bg-[#0E1621] hover:bg-[#121c29] border border-[#232E3C] rounded-xl transition-colors"
                >
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleResumeSavedSession(entry)}
                    className="flex-1 flex items-center gap-3 text-left min-w-0 cursor-pointer group"
                  >
                    <UserAvatar
                      displayName={entry.user.displayName}
                      avatarColor={entry.user.avatarColor}
                      avatarUrl={entry.user.avatarUrl}
                      sizeClass="w-10 h-10 shrink-0"
                      textClass="text-sm"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white truncate group-hover:text-[#64B5EF] transition-colors">
                        {entry.user.displayName}
                      </p>
                      <p className="text-xs text-[#7F91A4] truncate">
                        @{entry.user.username}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#7F91A4] group-hover:text-white group-hover:translate-x-0.5 transition-all shrink-0 mr-1" />
                  </button>

                  <button
                    type="button"
                    onClick={() => onRemoveSavedSession(entry.user.id)}
                    aria-label={`Удалить сохраненный аккаунт ${entry.user.displayName}`}
                    title="Забыть аккаунт на этом устройстве"
                    className="p-2 text-[#7F91A4] hover:text-rose-400 rounded-lg hover:bg-[#17212B] transition-colors cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Переключатель режимов: Вход / Регистрация / Сброс пароля */}
        <div className="grid grid-cols-3 gap-1 p-1 bg-[#0E1621] border border-[#232E3C] rounded-xl">
          <button
            type="button"
            onClick={() => handleSwitchMode('login')}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              mode === 'login'
                ? 'bg-[#2B5278] text-white shadow-sm'
                : 'text-[#7F91A4] hover:text-white'
            }`}
          >
            Войти
          </button>
          <button
            type="button"
            onClick={() => handleSwitchMode('register')}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              mode === 'register'
                ? 'bg-[#2B5278] text-white shadow-sm'
                : 'text-[#7F91A4] hover:text-white'
            }`}
          >
            Создать аккаунт
          </button>
          <button
            type="button"
            onClick={() => handleSwitchMode('reset')}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              mode === 'reset'
                ? 'bg-[#2B5278] text-white shadow-sm'
                : 'text-[#7F91A4] hover:text-white'
            }`}
          >
            Сброс пароля
          </button>
        </div>

        {/* Форма авторизации и регистрации */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div className="flex items-center gap-3.5 p-3 bg-[#0E1621] border border-[#232E3C] rounded-xl">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Нажмите, чтобы выбрать фото профиля"
                className="relative group rounded-full focus:outline-none focus:ring-2 focus:ring-[#64B5EF] cursor-pointer shrink-0"
              >
                <UserAvatar
                  displayName={displayName || username || 'P'}
                  avatarColor="#5288C1"
                  avatarUrl={avatarUrl}
                  sizeClass="w-14 h-14"
                  textClass="text-base"
                />
                <span className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-[#5288C1] border border-[#0E1621] flex items-center justify-center text-white shadow group-hover:bg-[#467AB0] transition-colors">
                  <Camera className="w-2.5 h-2.5" />
                </span>
              </button>
              <div className="flex-1 min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-white">Фото профиля (необязательно)</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    aria-label="Выбрать фото аватара"
                    onChange={handleAvatarFileChange}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#242F3D] hover:bg-[#2C394A] text-xs font-medium text-[#64B5EF] rounded-lg transition-colors cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>{avatarUrl ? 'Изменить фото' : 'Загрузить фото'}</span>
                  </button>
                  {avatarUrl && (
                    <button
                      type="button"
                      onClick={() => setAvatarUrl('')}
                      aria-label="Удалить выбранное фото"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#242F3D] hover:bg-rose-950/60 text-xs text-[#7F91A4] hover:text-rose-300 rounded-lg transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                      <span>Убрать</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {mode === 'reset' && (
            <div className="p-3 bg-[#0E1621] border border-[#232E3C] rounded-xl text-xs text-[#7F91A4] leading-relaxed flex items-start gap-2.5">
              <Info className="w-4 h-4 text-[#64B5EF] shrink-0 mt-0.5" />
              <span>
                Укажите ваш никнейм <span className="text-[#64B5EF] font-mono">@username</span> или почту для восстановления доступа. Ссылка на сброс будет отправлена на привязанный email.
              </span>
            </div>
          )}

          {/* Поле Почты (Email) — обязательное при регистрации */}
          {mode === 'register' && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="auth-email"
                  className="block text-xs font-medium text-[#7F91A4]"
                >
                  Электронная почта
                </label>
                <span className="text-[11px] text-[#64B5EF]">
                  Обязательно для восстановления
                </span>
              </div>
              <div className="relative">
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alex@example.com"
                  className="w-full pl-9 pr-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1] transition-colors"
                />
                <Mail className="w-4 h-4 text-[#7F91A4] absolute left-3 top-1/2 -translate-y-1/2" />
              </div>
            </div>
          )}

          {/* Поле Имя пользователя / Никнейм (@username) или Email */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="auth-username"
                className="block text-xs font-medium text-[#7F91A4]"
              >
                {mode === 'login'
                  ? 'Никнейм (@username) или Email'
                  : mode === 'reset'
                    ? 'Никнейм или Email аккаунта'
                    : 'Имя пользователя (Никнейм @username)'}
              </label>
              {username.trim().length > 0 && !username.includes('@') && (
                <span className="text-[11px] text-[#64B5EF] font-mono">
                  @{normalizeUsername(username)}
                </span>
              )}
            </div>
            <div className="relative">
              <input
                id="auth-username"
                type="text"
                autoComplete={mode === 'login' ? 'username' : 'off'}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={
                  mode === 'login'
                    ? 'alex_ivanov или alex@mail.com'
                    : 'Например: alex_ivanov'
                }
                className="w-full px-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1] transition-colors"
              />
            </div>
          </div>

          {/* Поля Регистрации: Имя и О себе */}
          {mode === 'register' && (
            <>
              <div>
                <label
                  htmlFor="auth-displayname"
                  className="block text-xs font-medium text-[#7F91A4] mb-1.5"
                >
                  Ваше имя и фамилия
                </label>
                <input
                  id="auth-displayname"
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Александр Иванов"
                  className="w-full px-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1] transition-colors"
                />
              </div>

              <div>
                <label
                  htmlFor="auth-bio"
                  className="block text-xs font-medium text-[#7F91A4] mb-1.5"
                >
                  О себе / статус (необязательно)
                </label>
                <input
                  id="auth-bio"
                  type="text"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="В сети Pulse"
                  className="w-full px-3.5 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1] transition-colors"
                />
              </div>
            </>
          )}

          {/* Поле Пароль с кнопкой показа/скрытия */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="auth-password"
                className="block text-xs font-medium text-[#7F91A4]"
              >
                {mode === 'reset' ? 'Новый пароль' : 'Пароль'}
              </label>
              {mode === 'login' && (
                <button
                  type="button"
                  onClick={() => handleSwitchMode('reset')}
                  className="text-xs font-medium text-[#64B5EF] hover:underline cursor-pointer"
                >
                  Забыли пароль?
                </button>
              )}
            </div>
            <div className="relative">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Минимум 6 символов"
                className="w-full pl-3.5 pr-10 py-2.5 bg-[#242F3D] border border-[#2B3848] rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none focus:border-[#5288C1] transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#7F91A4] hover:text-white transition-colors cursor-pointer"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {/* Индикатор надежности пароля при регистрации или сбросе */}
            {(mode === 'register' || mode === 'reset') && password.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#7F91A4]">Надежность пароля:</span>
                  <span style={{ color: passwordStrength.color }} className="font-medium">
                    {passwordStrength.label}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1 h-1 w-full bg-[#0E1621] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      backgroundColor:
                        passwordStrength.score >= 1 ? passwordStrength.color : '#232E3C',
                    }}
                  />
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      backgroundColor:
                        passwordStrength.score >= 2 ? passwordStrength.color : '#232E3C',
                    }}
                  />
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      backgroundColor:
                        passwordStrength.score >= 3 ? passwordStrength.color : '#232E3C',
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Подтверждение пароля при регистрации и сбросе */}
          {(mode === 'register' || mode === 'reset') && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="auth-confirm-password"
                  className="block text-xs font-medium text-[#7F91A4]"
                >
                  Подтвердите пароль
                </label>
                {confirmPassword.length > 0 && (
                  <span
                    className={`text-[11px] font-medium ${
                      passwordsMatch ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {passwordsMatch ? 'Пароли совпадают ✓' : 'Пароли не совпадают'}
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  id="auth-confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Повторите пароль"
                  className={`w-full pl-3.5 pr-10 py-2.5 bg-[#242F3D] border rounded-xl text-sm text-white placeholder-[#6C7883] focus:outline-none transition-colors ${
                    confirmPassword.length > 0
                      ? passwordsMatch
                        ? 'border-emerald-600 focus:border-emerald-500'
                        : 'border-rose-600 focus:border-rose-500'
                      : 'border-[#2B3848] focus:border-[#5288C1]'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                  aria-label={showConfirmPassword ? 'Скрыть подтверждение' : 'Показать подтверждение'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#7F91A4] hover:text-white transition-colors cursor-pointer"
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Запомнить на этом устройстве */}
          <label className="flex items-center gap-2.5 text-xs text-[#7F91A4] cursor-pointer select-none pt-0.5">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="rounded border-[#2B3848] bg-[#242F3D] text-[#5288C1] focus:ring-0 cursor-pointer"
            />
            <span>Сохранить аккаунт на этом устройстве для быстрого входа</span>
          </label>

          {/* Блок ошибок */}
          {error && (
            <div
              role="alert"
              className="p-3 bg-rose-950/70 border border-rose-800 rounded-xl text-xs text-rose-200 leading-relaxed"
            >
              {error}
            </div>
          )}

          {/* Блок успешных сообщений */}
          {successMsg && (
            <div
              role="status"
              className="p-3 bg-emerald-950/70 border border-emerald-800 rounded-xl text-xs text-emerald-200 leading-relaxed"
            >
              {successMsg}
            </div>
          )}

          {/* Основная кнопка отправки */}
          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-[#5288C1] hover:bg-[#467AB0] disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-all cursor-pointer shadow-md shadow-[#5288C1]/20"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Выполняется запрос...</span>
              </span>
            ) : mode === 'register' ? (
              <>
                <UserPlus className="w-4 h-4" />
                <span>Создать аккаунт в Pulse</span>
              </>
            ) : mode === 'login' ? (
              <>
                <LogIn className="w-4 h-4" />
                <span>Войти в Pulse</span>
              </>
            ) : (
              <>
                <KeyRound className="w-4 h-4" />
                <span>Отправить ссылку на сброс пароля</span>
              </>
            )}
          </button>

          {/* Подсказка о сохранении и синхронизации данных */}
          <div className="pt-2 border-t border-[#232E3C]/80 space-y-1.5 text-center">
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-[#7F91A4]">
              <Cloud className="w-3.5 h-3.5 text-[#FFCA28]" />
              <span>База данных и аутентификация в Google Cloud Firebase</span>
            </div>
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-[#6C7883]">
              <Sparkles className="w-3.5 h-3.5 text-[#64B5EF]" />
              <span>Вход возможен как по @username (никнейму), так и по email</span>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
