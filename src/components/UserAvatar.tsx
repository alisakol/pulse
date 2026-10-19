import React from 'react';

interface UserAvatarProps {
  displayName: string;
  avatarColor?: string;
  avatarUrl?: string;
  sizeClass?: string;
  textClass?: string;
  className?: string;
}

/**
 * Универсальный круглый аватар пользователя Pulse:
 * отображает загруженное фото (avatarUrl) либо инициалы на выбранном цвете (avatarColor).
 */
export const UserAvatar: React.FC<UserAvatarProps> = ({
  displayName,
  avatarColor = '#5288C1',
  avatarUrl,
  sizeClass = 'w-10 h-10',
  textClass = 'text-sm',
  className = '',
}) => {
  const initials = (displayName || 'U').trim().slice(0, 2).toUpperCase();

  if (avatarUrl && avatarUrl.startsWith('data:image/')) {
    return (
      <div
        className={`${sizeClass} rounded-full overflow-hidden shrink-0 bg-[#242F3D] flex items-center justify-center ${className}`}
      >
        <img
          src={avatarUrl}
          alt={displayName}
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      className={`${sizeClass} ${textClass} rounded-full flex items-center justify-center font-bold text-white shrink-0 select-none ${className}`}
      style={{ backgroundColor: avatarColor || '#5288C1' }}
    >
      {initials}
    </div>
  );
};

/**
 * Сжатие и центрированная квадратная обрезка (192x192) выбранного файла изображения
 * с помощью HTML5 Canvas для быстрой передачи и надежного хранения.
 */
export function processAvatarImageFile(
  file: File
): Promise<{ dataUrl?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve({ error: 'Пожалуйста, выберите файл изображения (JPG, PNG, WebP или GIF)' });
      return;
    }

    if (file.size > 12 * 1024 * 1024) {
      resolve({ error: 'Файл слишком большой. Максимальный размер — 12 МБ' });
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      resolve({ error: 'Не удалось прочитать выбранный файл' });
    };
    reader.onload = () => {
      const resultStr = typeof reader.result === 'string' ? reader.result : '';
      if (!resultStr) {
        resolve({ error: 'Пустой файл изображения' });
        return;
      }

      const img = new Image();
      img.onerror = () => {
        resolve({ error: 'Не удалось обработать изображение' });
      };
      img.onload = () => {
        try {
          const targetSize = 192;
          const canvas = document.createElement('canvas');
          canvas.width = targetSize;
          canvas.height = targetSize;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve({ dataUrl: resultStr });
            return;
          }

          // Центрированная квадратная обрезка (object-cover)
          const minSide = Math.min(img.width, img.height);
          const sx = Math.max(0, (img.width - minSide) / 2);
          const sy = Math.max(0, (img.height - minSide) / 2);

          ctx.drawImage(
            img,
            sx,
            sy,
            minSide,
            minSide,
            0,
            0,
            targetSize,
            targetSize
          );

          const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.86);
          resolve({ dataUrl: compressedDataUrl });
        } catch {
          resolve({ dataUrl: resultStr });
        }
      };
      img.src = resultStr;
    };
    reader.readAsDataURL(file);
  });
}
