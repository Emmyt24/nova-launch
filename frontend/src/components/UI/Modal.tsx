import React, { useEffect, useRef } from 'react';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** When true the header bar (title + close button) is not rendered. */
    hideHeader?: boolean;
}

export function Modal({
    isOpen,
    onClose,
    title,
    children,
    footer,
    size = 'md',
    hideHeader = false,
}: ModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = 'unset';
        }

        return () => {
            document.body.style.overflow = 'unset';
        };
    }, [isOpen]);

    // Store the element that opened the modal; restore focus on close.
    useEffect(() => {
        if (isOpen) {
            triggerRef.current = document.activeElement as HTMLElement;
            dialogRef.current?.focus();
        } else {
            triggerRef.current?.focus();
            triggerRef.current = null;
        }
    }, [isOpen]);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen, onClose]);

    // Focus trap: Tab / Shift+Tab cycle stays within the dialog.
    useEffect(() => {
        if (!isOpen) return;

        const handleFocusTrap = (e: KeyboardEvent) => {
            if (e.key !== 'Tab' || !dialogRef.current) return;
            const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
            );
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey) {
                if (document.activeElement === first || document.activeElement === dialogRef.current) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        document.addEventListener('keydown', handleFocusTrap);
        return () => document.removeEventListener('keydown', handleFocusTrap);
    }, [isOpen]);

    if (!isOpen) return null;

    const sizeStyles = {
        sm: 'max-w-md',
        md: 'max-w-lg',
        lg: 'max-w-2xl',
        xl: 'max-w-4xl',
    };

    return (
        <div
            ref={dialogRef}
            tabIndex={-1}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
        >
            <div
                className={`relative bg-white rounded-lg shadow-xl w-full ${sizeStyles[size]} max-h-[90vh] overflow-hidden flex flex-col`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header — hidden when hideHeader is true */}
                {!hideHeader && (
                    <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                        <h2 id="modal-title" className="text-xl font-semibold text-gray-900">
                            {title}
                        </h2>
                        <button
                            onClick={onClose}
                            className="text-gray-400 hover:text-gray-600 transition-colors"
                            aria-label="Close modal"
                        >
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>
                )}

                {/* Content */}
                <div className="px-6 py-4 overflow-y-auto flex-1">{children}</div>

                {/* Footer */}
                {footer && (
                    <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}
