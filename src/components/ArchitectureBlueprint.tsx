import React, { useState } from 'react';
import { Copy, Check, FileCode, Layers } from 'lucide-react';
import { ARCHITECTURE_STEPS, type BlueprintStep } from '../data/architectureGuide';

interface ArchitectureBlueprintProps {
  activeStepId: string;
  onSelectStep: (stepId: string) => void;
}

/**
 * Пошаговое архитектурное руководство (Шаги 1–4) с исходным кодом,
 * схемами БД (Mongoose & PostgreSQL), кодом сервера Socket.io и хуком WebRTC.
 */
export const ArchitectureBlueprint: React.FC<ArchitectureBlueprintProps> = ({
  activeStepId,
  onSelectStep,
}) => {
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  const currentStep: BlueprintStep =
    ARCHITECTURE_STEPS.find((s) => s.id === activeStepId) || ARCHITECTURE_STEPS[0];

  const handleCopyCode = (filename: string, code: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code);
      setCopiedFile(filename);
      setTimeout(() => setCopiedFile(null), 2000);
    }
  };

  return (
    <div className="space-y-6">
      {/* Навигация по 4 шагам архитектуры */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {ARCHITECTURE_STEPS.map((step) => {
          const isActive = step.id === currentStep.id;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onSelectStep(step.id)}
              className={`p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                isActive
                  ? 'bg-indigo-600/15 border-indigo-500 text-white'
                  : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between text-xs font-mono text-indigo-400 mb-1">
                <span>ШАГ {step.stepNumber}</span>
                <Layers className="w-3.5 h-3.5" />
              </div>
              <p className="text-sm font-semibold text-slate-100 line-clamp-2">
                {step.title.replace(/^\d+\.\s*/, '')}
              </p>
            </button>
          );
        })}
      </div>

      {/* Детальное описание выбранного шага */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-5">
          <h2 className="text-xl font-bold text-white">{currentStep.title}</h2>
          <p className="text-sm text-indigo-300 font-medium">{currentStep.subtitle}</p>
          <p className="text-sm text-slate-300 leading-relaxed pt-1">{currentStep.summary}</p>

          <ul className="pt-3 space-y-1.5 text-xs text-slate-300">
            {currentStep.highlights.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-indigo-400 font-bold">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Блоки кода для текущего шага */}
        <div className="space-y-6">
          {currentStep.files.map((file) => {
            const isCopied = copiedFile === file.filename;
            return (
              <div
                key={file.filename}
                className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4 text-indigo-400 shrink-0" />
                    <span className="text-xs font-mono font-semibold text-slate-200">
                      {file.filename}
                    </span>
                    <span className="text-xs text-slate-400 hidden sm:inline">
                      — {file.description}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCopyCode(file.filename, file.code)}
                    className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-md border border-slate-700 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {isCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Скопировано
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Копировать код
                      </>
                    )}
                  </button>
                </div>

                <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
                  <code>{file.code}</code>
                </pre>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
