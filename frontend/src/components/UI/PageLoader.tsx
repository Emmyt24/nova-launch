import { useTranslation } from 'react-i18next';
import { Spinner } from './Spinner';

/**
 * Full-page Suspense fallback shown while lazy-loaded pages are fetched.
 * The screen-reader message is translated via the `common.loading` key.
 */
export function PageLoader() {
    const { t } = useTranslation();
    return (
        <div
            className="flex items-center justify-center min-h-screen bg-gray-50"
            role="status"
            aria-label="Loading page"
            data-testid="page-loader"
        >
            <Spinner size="lg" />
            <span className="sr-only" data-testid="page-loader-message">
                {t('common.loading')}
            </span>
        </div>
    );
}
