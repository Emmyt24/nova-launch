import { ErrorHandler } from '../../utils/errors';
import type { AppError } from '../../types';
import { ErrorCode } from '../../types';
import { Button } from './Button';

interface HandledErrorAlertProps {
    error: unknown;
    title?: string;
    className?: string;
    onRecoveryAction?: () => void;
    recoveryActionLabel?: string;
}

function toError(input: unknown): Error {
    if (input instanceof Error) {
        return input;
    }

    if (
        typeof input === 'object' &&
        input !== null &&
        'message' in input &&
        typeof (input as AppError).message === 'string'
    ) {
        const appError = input as AppError;
        return new Error(appError.details ? `${appError.message}: ${appError.details}` : appError.message);
    }

    if (typeof input === 'string') {
        return new Error(input);
    }

    return new Error('An unknown error occurred');
}

function isPauseError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
        const appError = error as AppError;
        if (appError.code === ErrorCode.CONTRACT_ERROR) {
            const message = appError.message?.toLowerCase() || '';
            const details = appError.details?.toLowerCase() || '';
            return message.includes('paused') || details.includes('paused');
        }
    }
    return false;
}

export function HandledErrorAlert({
    error,
    title = 'Something went wrong',
    className = '',
    onRecoveryAction,
    recoveryActionLabel = 'Try Recovery',
}: HandledErrorAlertProps) {
    const normalizedError = toError(error);
    const handled = ErrorHandler.toHandledError(normalizedError);
    const isPaused = isPauseError(error);

    // Custom styling and messaging for pause errors
    if (isPaused) {
        return (
            <div className={`rounded-lg border border-orange-200 bg-orange-50 p-4 ${className}`} role="alert">
                <div className="flex items-start">
                    <div className="flex-shrink-0">
                        <svg className="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <div className="ml-3 flex-1">
                        <h4 className="font-medium text-orange-800">Protocol Maintenance</h4>
                        <p className="mt-2 text-sm text-orange-700">{handled.message}</p>
                        <p className="mt-2 text-sm text-orange-700">
                            <span className="font-medium">What to do:</span> The protocol is temporarily paused for maintenance. 
                            Please wait a few minutes and try again, or contact support if the issue persists.
                        </p>
                        {onRecoveryAction && (
                            <Button className="mt-3" variant="outline" onClick={onRecoveryAction}>
                                Check Status Again
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`rounded-lg border border-red-200 bg-red-50 p-4 ${className}`} role="alert">
            <h4 className="font-medium text-red-800">{title}</h4>
            <p className="mt-2 text-sm text-red-700">{handled.message}</p>
            <p className="mt-2 text-sm text-red-700">
                <span className="font-medium">Suggested recovery:</span> {handled.recoverySuggestion}
            </p>
            {onRecoveryAction ? (
                <Button className="mt-3" variant="danger" onClick={onRecoveryAction}>
                    {recoveryActionLabel}
                </Button>
            ) : null}
        </div>
    );
}