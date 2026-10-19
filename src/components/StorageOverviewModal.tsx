import React, { useState, useEffect } from 'react';
import {
  X,
  Database,
  Cloud,
  Server,
  Zap,
  CheckCircle2,
  HardDrive,
  ShieldCheck,
  RefreshCw,
  ExternalLink,
  Smartphone,
  Layers,
} from 'lucide-react';
import {
  STORAGE_BACKEND_OPTIONS,
  type StorageBackendOption,
} from '../utils/messengerLogic';

interface StorageStats {
  engine: string;
  status: string;
  dataFile: string;
  backupFile: string;
  usersCount: number;
  roomsCount: number;
  conversationsCount: number;
  messagesCount: number;
  lastSavedAt: string;
}

interface StorageOverviewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Модальное окно сравнения вариантов хранения и архитектуры синхронизации данных мессенджера Pulse:
 * - Firebase Firestore + Auth (Google Cloud Serverless)
 * - PostgreSQL / Cloud SQL (Корпоративный реляционный стандарт)
 * - Pulse Server WAL (Встроенное автономное хранилище Node.js)
 * - Redis + MongoDB / Supabase (Высоконагруженные публичные каналы)
 */
export const StorageOverviewModal: React.FC<StorageOverviewModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string>('pulse_server_wal');

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/storage-info');
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStats();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const activeOption =
    STORAGE_BACKEND_OPTIONS.find((opt) => opt.id === activeTabId) ||
    STORAGE_BACKEND_OPTIONS[0];

  const getOptionIcon = (id: string) => {
    switch (id) {
      case 'firebase_firestore':
        return <Cloud className="w-5 h-5 text-[#FFCA28]" />;
      case 'postgresql_cloudsql':
        return <Database className="w-5 h-5 text-[#5288C1]" />;
      case 'redis_mongo_supabase':
        return <Zap className="w-5 h-5 text-[#AB47BC]" />;
      default:
        return <Server className="w-5 h-5 text-[#4CAF50]" />;
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="storage-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-sm"
    >
      <div className="bg-[#17212B] border border-[#232E3C] rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-white">
        {/* Шапка модального окна */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#101921] bg-[#17212B] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-[#242F3D] flex items-center justify-center text-[#64B5EF]">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h2 id="storage-modal-title" className="text-base font-bold text-white">
                Где можно хранить данные мессенджера?
              </h2>
              <p className="text-xs text-[#7F91A4]">
                Сравнение архитектурных вариантов и статус текущего хранилища
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="p-1.5 text-[#7F91A4] hover:text-white rounded-lg hover:bg-[#242F3D] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Тело с прокруткой */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Плашка текущего состояния сервера Pulse */}
          <div className="p-4 bg-[#0E1621] border border-[#232E3C] rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-semibold text-white">
                <HardDrive className="w-4 h-4 text-[#4CAF50]" />
                Текущее серверное хранилище Pulse WAL
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-950/80 text-emerald-400 border border-emerald-800">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Синхронизация активна
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-center">
              <div className="p-2.5 bg-[#17212B] border border-[#232E3C] rounded-lg">
                <p className="text-[11px] text-[#7F91A4]">Пользователей</p>
                <p className="text-sm font-bold text-white font-mono mt-0.5">
                  {stats ? stats.usersCount : '...'}
                </p>
              </div>
              <div className="p-2.5 bg-[#17212B] border border-[#232E3C] rounded-lg">
                <p className="text-[11px] text-[#7F91A4]">Групп и каналов</p>
                <p className="text-sm font-bold text-white font-mono mt-0.5">
                  {stats ? stats.roomsCount : '...'}
                </p>
              </div>
              <div className="p-2.5 bg-[#17212B] border border-[#232E3C] rounded-lg">
                <p className="text-[11px] text-[#7F91A4]">Сообщений</p>
                <p className="text-sm font-bold text-white font-mono mt-0.5">
                  {stats ? stats.messagesCount : '...'}
                </p>
              </div>
              <div className="p-2.5 bg-[#17212B] border border-[#232E3C] rounded-lg">
                <p className="text-[11px] text-[#7F91A4]">Защита записи</p>
                <p className="text-xs font-semibold text-[#64B5EF] mt-0.5 truncate">
                  Атомарный WAL
                </p>
              </div>
            </div>

            <p className="text-[11px] text-[#7F91A4] leading-relaxed">
              Все данные аккаунтов, пароли (хэшированы bcrypt), сообщения, видеокружки и группы
              сохраняются на диске сервера в <code className="text-[#64B5EF]">.pulse-data.json</code> с
              автоматическим созданием резервной копии. При открытии с нового браузера или смартфона
              вся история подгружается мгновенно.
            </p>
          </div>

          {/* Вкладки вариантов хранения */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-[#7F91A4] uppercase tracking-wider">
              Варианты баз данных для мессенджера:
            </h3>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 bg-[#0E1621] border border-[#232E3C] rounded-xl">
              {STORAGE_BACKEND_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setActiveTabId(opt.id)}
                  className={`flex flex-col items-center justify-center p-2.5 rounded-lg text-center transition-all cursor-pointer ${
                    activeTabId === opt.id
                      ? 'bg-[#2B5278] text-white shadow-md'
                      : 'text-[#7F91A4] hover:text-white hover:bg-[#17212B]'
                  }`}
                >
                  <div className="mb-1.5">{getOptionIcon(opt.id)}</div>
                  <span className="text-xs font-semibold truncate w-full">
                    {opt.id === 'pulse_server_wal'
                      ? 'Pulse WAL'
                      : opt.id === 'firebase_firestore'
                        ? 'Firebase'
                        : opt.id === 'postgresql_cloudsql'
                          ? 'PostgreSQL'
                          : 'Supabase / Redis'}
                  </span>
                </button>
              ))}
            </div>

            {/* Карточка детального описания выбранного варианта */}
            <div className="p-4 bg-[#0E1621] border border-[#232E3C] rounded-xl space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#232E3C] pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-[#17212B] flex items-center justify-center shrink-0">
                    {getOptionIcon(activeOption.id)}
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white">{activeOption.title}</h4>
                    <p className="text-[11px] text-[#7F91A4]">{activeOption.recommendedFor}</p>
                  </div>
                </div>

                <span
                  style={{
                    borderColor: activeOption.badgeColor,
                    color: activeOption.badgeColor,
                  }}
                  className="px-2.5 py-1 rounded-full text-xs font-medium border bg-black/30 whitespace-nowrap"
                >
                  {activeOption.badge}
                </span>
              </div>

              <p className="text-xs text-[#C5D1DE] leading-relaxed">
                {activeOption.description}
              </p>

              {/* Возможности */}
              <div className="space-y-1.5">
                <h5 className="text-[11px] font-semibold text-[#7F91A4] uppercase tracking-wider">
                  Ключевые возможности:
                </h5>
                <ul className="space-y-1 text-xs text-white">
                  {activeOption.features.map((feat, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#4CAF50] shrink-0 mt-0.5" />
                      <span>{feat}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Плюсы и минусы */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="p-3 bg-[#17212B]/70 border border-[#232E3C] rounded-lg space-y-1.5">
                  <span className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Преимущества:
                  </span>
                  <ul className="space-y-1 text-[11px] text-[#C5D1DE]">
                    {activeOption.pros.map((p, idx) => (
                      <li key={idx}>• {p}</li>
                    ))}
                  </ul>
                </div>

                <div className="p-3 bg-[#17212B]/70 border border-[#232E3C] rounded-lg space-y-1.5">
                  <span className="text-[11px] font-semibold text-amber-400 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Особенности / нюансы:
                  </span>
                  <ul className="space-y-1 text-[11px] text-[#C5D1DE]">
                    {activeOption.cons.map((c, idx) => (
                      <li key={idx}>• {c}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Футер */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[#101921] bg-[#17212B] shrink-0">
          <button
            type="button"
            onClick={fetchStats}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs text-[#7F91A4] hover:text-white transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Обновить статус</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-[#5288C1] hover:bg-[#467AB0] text-white text-xs font-semibold rounded-xl transition-colors cursor-pointer"
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
};
