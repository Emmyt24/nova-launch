import { useMemo, useState } from 'react';
import type { DeploymentResult, TokenDeployParams, WalletState } from '../../types';
import { useTokenDeploy } from '../../hooks/useTokenDeploy';
import { useFactoryState } from '../../hooks/useFactoryState';
import { formatXLM, truncateAddress } from '../../utils/formatting';
import { BasicInfoStep, type BasicInfoData } from './BasicInfoStep';
import { FeeDisplay } from './FeeDisplay';
import { Button, ProgressBar, LoadingButton } from '../UI';
import { analytics } from '../../services/analytics';
import { Input } from '../UI/Input';

interface TokenDeployFormProps {
    wallet: WalletState;
    onConnectWallet: () => Promise<void>;
    isConnectingWallet: boolean;
}

type FormStep = 'basic' | 'review';

export function TokenDeployForm({
    wallet,
    onConnectWallet,
    isConnectingWallet,
}: TokenDeployFormProps) {
    const [step, setStep] = useState<FormStep>('basic');
    const [basicInfo, setBasicInfo] = useState<BasicInfoData | null>(null);
    const [metadataDescription, setMetadataDescription] = useState('');
    const [metadataImage, setMetadataImage] = useState<File | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);
    const [result, setResult] = useState<DeploymentResult | null>(null);

    const { deploy, reset, status, statusMessage, isDeploying, error, getFeeBreakdown } =
        useTokenDeploy(wallet.network);
    
    const { isPaused, loading: pauseLoading, error: pauseError, refresh: refreshPauseState } = 
        useFactoryState({ network: wallet.network, pollingInterval: 30000 });

    const hasMetadataInput = Boolean(metadataDescription.trim() || metadataImage);
    const feeBreakdown = useMemo(
        () => getFeeBreakdown(hasMetadataInput),
        [getFeeBreakdown, hasMetadataInput]
    );

    const handleBasicNext = (data: BasicInfoData) => {
        setBasicInfo(data);
        setStep('review');
        setResult(null);
        setLocalError(null);
        reset();
    };

    const handleDeploy = async () => {
        if (!basicInfo) {
            return;
        }

        if (!wallet.connected || !wallet.address) {
            setLocalError('Connect your wallet before deploying.');
            return;
        }

        if (wallet.address !== basicInfo.adminWallet) {
            setLocalError('Admin wallet must match the connected wallet address.');
            return;
        }

        if (hasMetadataInput && (!metadataImage || !metadataDescription.trim())) {
            setLocalError('Provide both metadata image and description, or leave both empty.');
            return;
        }

        setLocalError(null);

        const params: TokenDeployParams = {
            ...basicInfo,
            metadata: hasMetadataInput
                ? {
                    image: metadataImage as File,
                    description: metadataDescription.trim(),
                }
                : undefined,
        };

        try {
            try {
                analytics.track('deploy_button_click', { network: wallet.network });
            } catch {}

            const deployment = await deploy(params);
            setResult(deployment);
        } catch {
            setResult(null);
        }
    };

    const handleRetry = async () => {
        reset();
        try {
            analytics.track('deploy_retry', { network: wallet.network });
        } catch {}
        await handleDeploy();
    };

    const resetForm = () => {
        setStep('basic');
        setBasicInfo(null);
        setMetadataDescription('');
        setMetadataImage(null);
        setLocalError(null);
        setResult(null);
        reset();
        try {
            analytics.track('deploy_another_reset');
        } catch {}
    };

    if (result && status === 'success') {
        return (
            <div className="space-y-6" data-testid="deployment-success">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                    <h3 className="text-lg font-semibold text-green-800">Token Deployed</h3>
                    <p className="mt-2 text-sm text-green-700">
                        Deployment completed successfully on {wallet.network}.
                    </p>
                </div>

                <div className="space-y-3 rounded-lg border border-gray-200 p-4">
                    <div>
                        <p className="text-xs uppercase tracking-wide text-gray-500">Token Address</p>
                        <p className="break-all text-sm font-medium text-gray-900">{result.tokenAddress}</p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-gray-500">Transaction Hash</p>
                        <p className="break-all text-sm text-gray-900">{result.transactionHash}</p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-gray-500">Total Fee</p>
                        <p className="text-sm text-gray-900">{formatXLM(feeBreakdown.totalFee)} XLM</p>
                    </div>
                </div>

                <Button onClick={resetForm} className="w-full">
                    Deploy Another Token
                </Button>
            </div>
        );
    }

    if (step === 'basic') {
        return (
            <div data-tutorial="token-form">
                <BasicInfoStep
                    onNext={handleBasicNext}
                    initialData={
                        wallet.address
                            ? {
                                name: basicInfo?.name || '',
                                symbol: basicInfo?.symbol || '',
                                decimals: basicInfo?.decimals ?? 7,
                                initialSupply: basicInfo?.initialSupply || '',
                                adminWallet: basicInfo?.adminWallet || wallet.address,
                            }
                            : basicInfo || undefined
                    }
                />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <h3 className="text-base font-semibold text-gray-900">Review & Deploy</h3>
                <p className="mt-2 text-sm text-gray-600">
                    Wallet:{' '}
                    {wallet.connected && wallet.address
                        ? `${truncateAddress(wallet.address)} (${wallet.network})`
                        : 'Not connected'}
                </p>
            </div>

            {isPaused && !pauseLoading && (
                <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
                    <div className="flex items-start">
                        <div className="flex-shrink-0">
                            <svg className="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                            </svg>
                        </div>
                        <div className="ml-3 flex-1">
                            <h3 className="text-sm font-medium text-orange-800">Protocol Maintenance</h3>
                            <p className="mt-2 text-sm text-orange-700">
                                The factory contract on <span className="font-semibold">{wallet.network}</span> is currently paused for maintenance. 
                                Token deployment and admin actions are temporarily disabled.
                            </p>
                            <p className="mt-2 text-sm text-orange-700">
                                Please check back later or contact support for more information.
                            </p>
                            <button
                                onClick={() => void refreshPauseState()}
                                className="mt-3 text-sm font-medium text-orange-800 hover:text-orange-900 underline"
                            >
                                Check Status Again
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {pauseError && !pauseLoading && (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                    <p className="text-sm text-yellow-800">
                        Unable to verify protocol status. You may proceed, but deployment might fail if the protocol is paused.
                    </p>
                    <button
                        onClick={() => void refreshPauseState()}
                        className="mt-2 text-sm font-medium text-yellow-800 hover:text-yellow-900 underline"
                    >
                        Retry Status Check
                    </button>
                </div>
            )}

            {!wallet.connected ? (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                    <p className="text-sm text-yellow-800">Connect your wallet to continue deployment.</p>
                    <Button
                        className="mt-3"
                        onClick={() => void onConnectWallet()}
                        loading={isConnectingWallet}
                    >
                        Connect Wallet
                    </Button>
                </div>
            ) : null}

            <div className="space-y-4 rounded-lg border border-gray-200 p-4">
                <h4 className="font-medium text-gray-900">Optional Metadata</h4>
                <Input
                    value={metadataDescription}
                    onChange={(event) => {
                        const v = event.target.value;
                        setMetadataDescription(v);
                        try {
                            if (v.trim()) analytics.track('metadata_description_added', { length: v.length });
                        } catch {}
                    }}
                    label="Description"
                    placeholder="Describe your token"
                    maxLength={500}
                />
                <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Token Image</label>
                    <input
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/svg+xml"
                        onChange={(event) => {
                            const file = event.target.files?.[0] ?? null;
                            setMetadataImage(file);
                            try {
                                if (file) analytics.track('metadata_image_added', { size: file.size, type: file.type });
                            } catch {}
                        }}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-500">PNG, JPG, SVG up to 5MB.</p>
                </div>
            </div>

            <FeeDisplay feeBreakdown={feeBreakdown} hasMetadata={hasMetadataInput} />

            {status === 'error' && error ? (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
                    <h3 className="font-semibold text-red-800 mb-2">Deployment Failed</h3>
                    <p className="text-red-700 mb-3">{typeof error === 'string' ? error : error.message || 'An error occurred during deployment'}</p>
                    <button
                        onClick={() => void handleRetry()}
                        className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                    >
                        Retry Deployment
                    </button>
                </div>
            ) : null}

            {localError ? (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
                    {typeof localError === 'string' ? localError : 'An error occurred'}
                </div>
            ) : null}

            {isDeploying ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
                    <p className="text-sm font-medium text-blue-800">{statusMessage}</p>
                    <ProgressBar
                        progress={status === 'uploading' ? 30 : status === 'deploying' ? 70 : 100}
                        label={status === 'uploading' ? 'Uploading metadata...' : 'Deploying token...'}
                        showPercentage={true}
                        variant="default"
                        size="md"
                    />
                </div>
            ) : null}

            <div className="flex gap-3">
                <Button 
                    variant="outline" 
                    onClick={() => setStep('basic')} 
                    className="w-full"
                    disabled={isDeploying}
                >
                    Back
                </Button>
                <LoadingButton
                    onClick={() => void handleDeploy()}
                    loading={isDeploying}
                    loadingText={status === 'uploading' ? 'Uploading...' : 'Deploying...'}
                    className="w-full"
                    disabled={!wallet.connected || isPaused || pauseLoading}
                    data-tutorial="deploy-button"
                    title={isPaused ? 'Protocol is paused for maintenance' : undefined}
                >
                    {isPaused ? 'Protocol Paused' : 'Deploy Token'}
                </LoadingButton>
            </div>
        </div>
    );
}
