import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocFromServer,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import {
  normalizeUsername,
  type UserProfile,
  type ChatRoom,
  type ChatMessage,
} from './utils/messengerLogic';

// 1. Инициализация Firebase приложения
export const app = initializeApp(firebaseConfig);

// 2. Инициализация Cloud Firestore с обязательным firestoreDatabaseId
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// 3. Инициализация Firebase Authentication
export const auth = getAuth(app);

// 4. Проверка подключения к Firestore при старте
async function testFirestoreConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('[Firebase] Клиент находится в оффлайн-режиме.');
    }
  }
}
testFirestoreConnection();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Очищает объект от undefined значений, которые запрещены в Firestore SDK.
 */
export function sanitizeForFirestore<T extends Record<string, any>>(obj: T): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = sanitizeForFirestore(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Регистрация нового пользователя с почтой, уникальным никнеймом (@username), именем и паролем.
 */
export async function registerWithEmailAndNickname(payload: {
  email: string;
  username: string;
  displayName: string;
  password: string;
  avatarColor?: string;
  avatarUrl?: string;
  bio?: string;
}): Promise<UserProfile> {
  const cleanUsername = normalizeUsername(payload.username);
  const cleanEmail = payload.email.trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Укажите корректный адрес электронной почты');
  }

  // 1. Проверяем, свободен ли никнейм
  const usernameDocRef = doc(db, 'usernames', cleanUsername);
  let existingUsernameDoc;
  try {
    existingUsernameDoc = await getDoc(usernameDocRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `usernames/${cleanUsername}`);
  }

  if (existingUsernameDoc && existingUsernameDoc.exists()) {
    throw new Error(`Никнейм @${cleanUsername} уже занят. Пожалуйста, выберите другой никнейм.`);
  }

  // 2. Создаем аккаунт в Firebase Auth
  const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, payload.password);
  const user = userCredential.user;

  // 3. Обновляем display name и фото
  await updateProfile(user, {
    displayName: payload.displayName.trim(),
    photoURL: payload.avatarUrl || undefined,
  });

  const nowIso = new Date().toISOString();
  const profile: UserProfile = {
    id: user.uid,
    username: cleanUsername,
    displayName: payload.displayName.trim(),
    avatarColor: payload.avatarColor || '#5288C1',
    avatarUrl: payload.avatarUrl || undefined,
    role: payload.bio?.trim() || 'В сети Pulse',
    online: true,
    lastSeen: nowIso,
  };

  // 4. Сохраняем профиль пользователя в Firestore
  try {
    await setDoc(
      doc(db, 'users', user.uid),
      sanitizeForFirestore({
        ...profile,
        email: cleanEmail,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
  }

  // 5. Записываем уникальный индекс никнейма для быстрого входа
  try {
    await setDoc(
      usernameDocRef,
      sanitizeForFirestore({
        uid: user.uid,
        email: cleanEmail,
        createdAt: nowIso,
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `usernames/${cleanUsername}`);
  }

  return profile;
}

/**
 * Вход в Pulse по никнейму (@username) или по email с паролем.
 */
export async function loginWithNicknameOrEmail(
  loginIdentifier: string,
  password: string
): Promise<UserProfile> {
  const cleanInput = loginIdentifier.trim();
  if (!cleanInput) {
    throw new Error('Введите никнейм или email');
  }

  let resolvedEmail = cleanInput.toLowerCase();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanInput);

  // Если введен никнейм, находим привязанный email в коллекции usernames
  if (!isEmail) {
    const cleanUsername = normalizeUsername(cleanInput);
    try {
      const usernameSnap = await getDoc(doc(db, 'usernames', cleanUsername));
      if (!usernameSnap.exists()) {
        throw new Error(`Аккаунт с никнеймом @${cleanUsername} не найден. Проверьте логин или зарегистрируйтесь.`);
      }
      const data = usernameSnap.data();
      if (!data?.email) {
        throw new Error('Не удалось определить email для этого никнейма');
      }
      resolvedEmail = data.email;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Аккаунт с никнеймом')) {
        throw err;
      }
      handleFirestoreError(err, OperationType.GET, `usernames/${cleanUsername}`);
    }
  }

  // Аутентификация в Firebase Auth
  const userCredential = await signInWithEmailAndPassword(auth, resolvedEmail, password);
  const user = userCredential.user;

  // Загружаем профиль из Firestore
  try {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (userSnap.exists()) {
      const data = userSnap.data() as UserProfile;
      return {
        id: user.uid,
        username: data.username || normalizeUsername(user.email?.split('@')[0] || user.uid.slice(0, 8)),
        displayName: data.displayName || user.displayName || 'Пользователь Pulse',
        avatarColor: data.avatarColor || '#5288C1',
        avatarUrl: data.avatarUrl || user.photoURL || undefined,
        role: data.role || 'В сети Pulse',
        online: true,
        lastSeen: new Date().toISOString(),
      };
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
  }

  // Фоллбэк, если документ профиля еще не существует
  return {
    id: user.uid,
    username: normalizeUsername(user.email?.split('@')[0] || user.uid.slice(0, 8)),
    displayName: user.displayName || 'Пользователь Pulse',
    avatarColor: '#5288C1',
    avatarUrl: user.photoURL || undefined,
    role: 'В сети Pulse',
    online: true,
    lastSeen: new Date().toISOString(),
  };
}

/**
 * Сброс пароля по никнейму или email (отправляет ссылку на почту).
 */
export async function resetPasswordForUser(
  identifier: string
): Promise<{ resolvedEmail: string }> {
  const cleanInput = identifier.trim();
  if (!cleanInput) {
    throw new Error('Укажите никнейм (@username) или адрес почты');
  }

  let resolvedEmail = cleanInput.toLowerCase();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanInput);

  if (!isEmail) {
    const cleanUsername = normalizeUsername(cleanInput);
    const usernameSnap = await getDoc(doc(db, 'usernames', cleanUsername));
    if (!usernameSnap.exists()) {
      throw new Error(`Аккаунт с никнеймом @${cleanUsername} не найден.`);
    }
    resolvedEmail = usernameSnap.data()?.email;
  }

  await sendPasswordResetEmail(auth, resolvedEmail);
  return { resolvedEmail };
}

/**
 * Синхронизация профиля пользователя в Firestore
 */
export async function updateUserProfileInFirestore(
  userId: string,
  updates: Partial<UserProfile>
): Promise<void> {
  if (!auth.currentUser) return;
  try {
    await updateDoc(
      doc(db, 'users', userId),
      sanitizeForFirestore({
        ...updates,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${userId}`);
  }
}

/**
 * Сохранение / обновление группы или канала в Firestore
 */
export async function saveRoomToFirestore(room: ChatRoom): Promise<void> {
  if (!auth.currentUser) return;
  try {
    await setDoc(doc(db, 'rooms', room.id), sanitizeForFirestore(room), { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `rooms/${room.id}`);
  }
}

/**
 * Подписка на группы и каналы в Firestore
 */
export function subscribeToRooms(
  onUpdate: (rooms: ChatRoom[]) => void
): () => void {
  if (!auth.currentUser) return () => {};
  try {
    const q = collection(db, 'rooms');
    return onSnapshot(
      q,
      (snapshot) => {
        const rooms: ChatRoom[] = [];
        snapshot.forEach((d) => {
          rooms.push(d.data() as ChatRoom);
        });
        onUpdate(rooms);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'rooms');
      }
    );
  } catch (err) {
    console.warn('[Firebase] Ошибка подписки на комнаты:', err);
    return () => {};
  }
}

/**
 * Сохранение сообщения в Firestore
 */
export async function saveMessageToFirestore(message: ChatMessage): Promise<void> {
  if (!auth.currentUser) return;
  try {
    await setDoc(doc(db, 'messages', message.id), sanitizeForFirestore(message), { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `messages/${message.id}`);
  }
}

/**
 * Подписка на сообщения чата в Firestore
 */
export function subscribeToConversationMessages(
  conversationId: string,
  onUpdate: (messages: ChatMessage[]) => void
): () => void {
  if (!auth.currentUser || !conversationId) return () => {};
  try {
    const q = query(
      collection(db, 'messages'),
      where('conversationId', '==', conversationId)
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const msgs: ChatMessage[] = [];
        snapshot.forEach((d) => {
          msgs.push(d.data() as ChatMessage);
        });
        msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        onUpdate(msgs);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `messages?conversationId=${conversationId}`);
      }
    );
  } catch (err) {
    console.warn('[Firebase] Ошибка подписки на сообщения:', err);
    return () => {};
  }
}

