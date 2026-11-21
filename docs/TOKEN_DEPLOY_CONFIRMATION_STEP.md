# Add Confirmation Step Showing Full Summary Before Token Deployment

**Issue:** [#2168](https://github.com/Emmyt24/nova-launch/issues/2168)  
**Area:** Frontend — token deployment wizard  
**Status:** Open

---

## Problem

<!-- Note: The repository does not contain a docker-compose.yml file, so healthcheck-related changes are out of scope for this documentation. -->


The token deployment wizard (`TokenDeployForm`) moves directly from the metadata input
step to triggering `handleDeploy()` without presenting the user a full summary of what
they are about to deploy. A user can submit a deployment without reviewing the token name,
symbol, supply, admin wallet, fees, or network in a single consolidated view.

### Current wizard flow

```
template → basic → [inline review in TokenDeployForm] → deploy()
```

The inline review step in `TokenDeployForm.tsx` shows wallet status, optional metadata
fields, and a fee display, but it does **not** render the dedicated `ReviewStep` component
that already exists in the codebase. The `ReviewStep` component is complete and accurate
but is bypassed by the current form logic.

---

## What Already Exists

### `ReviewStep` component

**File:** `src/components/TokenDeployForm/ReviewStep.tsx`

A fully-implemented summary component that renders:

| Section | Contents |
|---|---|
| **Token Details card** | Name, symbol, decimals, initial supply, admin wallet. Each field has an "Edit Details" back-link (`onEdit(0)`). |
| **Metadata card** | Token image preview and description, shown only when `metadata.includeMetadata` is true. "Edit Metadata" back-link (`onEdit(1)`). |
| **Fee Breakdown card** | Base deployment fee (7 XLM) + optional metadata fee (3 XLM), summed to a total. |
| **Balance check** | Green/red indicator comparing wallet balance against total fee. Shows "Insufficient funds" with the exact shortfall. |
| **Total cost banner** | Gradient banner calling out the final XLM amount before the confirm button. |
| **Action row** | Back button + "Confirm Deployment" primary button. The confirm button is disabled when `hasSufficientBalance` is false. |

Props signature:

```ts
interface ReviewStepProps {
    basicInfo: BasicInfoData;
    metadata: MetadataData;
    walletBalance?: string;
    onConfirm: () => void;
    onEdit: (step: number) => void;
    onBack: () => void;
    isDeploying?: boolean;
}
```

### `ConfirmDialog` component

**File:** `src/components/UI/ConfirmDialog.tsx`

A modal overlay that can be layered on top of `ReviewStep` as a final "are you sure?"
gate before the transaction is submitted. Supports:

- `action: 'deploy'` — renders a deploy-specific icon in the dialog header
- `fees: FeeItem[]` — itemised fee list with auto-summed total
- `consequences: string[]` — yellow warning block for irreversibility notes
- `requireExplicitConfirm` — gates the confirm button behind a checkbox
- Keyboard shortcuts: `Enter` to confirm, `Esc` to cancel
- `isProcessing` loading state while the transaction is in flight

### `ProgressIndicator` component

**File:** `src/components/TokenDeployForm/ProgressIndicator.tsx`

A step-indicator nav that renders completed / active / upcoming step states with connector
lines. Currently present in the codebase but not rendered by `TokenDeployForm.tsx`.

---

## Required Changes

### Updated wizard flow

```
template → basic → review (ReviewStep) → [ConfirmDialog modal] → deploy()
```

The form needs one new step value and the inline review block in `TokenDeployForm.tsx`
needs to be replaced with `ReviewStep`.

### 1. Add the `'review'` step to the form type

`TokenDeployForm.tsx` already defines `type FormStep = 'template' | 'basic' | 'review'`.
The value `'review'` exists but is handled by the inline block rather than the
`ReviewStep` component. Introduce a separate confirmation step:

```ts
// src/components/TokenDeployForm/TokenDeployForm.tsx

type FormStep = 'template' | 'basic' | 'review' | 'confirm';
```

Alternatively, keep the existing `'review'` name but route it to `ReviewStep` and use a
local `showConfirmDialog` boolean to control the modal.

### 2. Wire `ReviewStep` into the form

Replace the existing inline review block (the `return` at the bottom of
`TokenDeployForm.tsx` that is not guarded by a `step ===` check) with a proper
conditional that renders `ReviewStep`:

```tsx
// src/components/TokenDeployForm/TokenDeployForm.tsx

import { ReviewStep } from './ReviewStep';
// ...

if (step === 'review') {
    return (
        <ReviewStep
            basicInfo={basicInfo!}
            metadata={{
                includeMetadata: hasMetadataInput,
                description: metadataDescription,
                image: metadataImage,
            }}
            walletBalance={wallet.balance}
            onConfirm={() => setShowConfirmDialog(true)}
            onEdit={(stepIndex) => setStep(stepIndex === 0 ? 'basic' : 'basic')}
            onBack={() => setStep('basic')}
            isDeploying={isDeploying}
        />
    );
}
```

`basicInfo` is already held in component state; ensure it is non-null before reaching
this step (the existing `handleBasicNext` guard already does this).

### 3. Add the `ConfirmDialog` modal

Add a `showConfirmDialog` boolean to the form state and render `ConfirmDialog` over the
review step:

```tsx
// src/components/TokenDeployForm/TokenDeployForm.tsx

import { ConfirmDialog } from '../UI/ConfirmDialog';
// ...

const [showConfirmDialog, setShowConfirmDialog] = useState(false);

// In the JSX, outside the step conditionals:
<ConfirmDialog
    isOpen={showConfirmDialog}
    onClose={() => setShowConfirmDialog(false)}
    onConfirm={handleDeploy}
    title="Deploy Token"
    message={`You are about to deploy "${basicInfo?.name}" (${basicInfo?.symbol}) to ${wallet.network}. This action cannot be undone.`}
    action="deploy"
    fees={[
        { label: 'Base deployment fee', amount: `${feeBreakdown.baseFee} XLM` },
        ...(hasMetadataInput
            ? [{ label: 'Metadata fee', amount: `${feeBreakdown.metadataFee} XLM` }]
            : []),
    ]}
    consequences={[
        'Token deployment on Stellar is irreversible.',
        'The admin wallet cannot be changed after deployment.',
    ]}
    confirmText="Deploy Token"
    confirmButtonVariant="primary"
    isProcessing={isDeploying}
/>
```

### 4. Render `ProgressIndicator`

Add the progress indicator above the form step so the user always knows where they are:

```tsx
// src/components/TokenDeployForm/TokenDeployForm.tsx

import { ProgressIndicator } from './ProgressIndicator';

const STEPS = ['Template', 'Token Details', 'Review & Confirm'];
const stepIndex = { template: 0, basic: 1, review: 2, confirm: 2 };

// In the render, before the step conditionals:
<ProgressIndicator
    steps={STEPS}
    currentStep={stepIndex[step]}
/>
```

### 5. Advance to `'review'` after `BasicInfoStep`

`handleBasicNext` currently sets `step` to `'review'` but the form then falls through to
the inline block. After wiring `ReviewStep`, this handler is already correct:

```ts
const handleBasicNext = (data: BasicInfoData) => {
    setBasicInfo(data);
    setStep('review');   // ← already present, now routes to ReviewStep
    setResult(null);
    setLocalError(null);
    reset();
};
```

---

## Data Flow Summary

```
BasicInfoStep.onNext(data)
    → setBasicInfo(data)
    → setStep('review')

ReviewStep.onConfirm()
    → setShowConfirmDialog(true)

ConfirmDialog.onConfirm()
    → handleDeploy()          // submits the Stellar transaction
    → setShowConfirmDialog(false) on success/error

ReviewStep.onEdit(stepIndex)
    → setStep('basic')        // navigate back to edit fields

ReviewStep.onBack()
    → setStep('basic')
```

---

## Fee Calculations

`feeBreakdown` is already computed in `TokenDeployForm.tsx` via the `getDeploymentFeeBreakdown`
helper and the `useFactoryFees` hook. Pass it directly to both `ReviewStep` and `ConfirmDialog`
rather than hardcoding values.

| Fee | Source | Default |
|---|---|---|
| Base deployment fee | `useFactoryFees().baseFee` | 7 XLM |
| Metadata fee | `useFactoryFees().metadataFee` | 3 XLM |
| Total | `feeBreakdown.totalFee` | 7 or 10 XLM |

When `useFactoryFees` returns a fallback value (`isFallback === true`), display a notice
in `ReviewStep` indicating the fee estimate may not be current.

---

## Accessibility Notes

- `ConfirmDialog` sets `role="dialog"`, `aria-modal="true"`, and wires `aria-labelledby`
  and `aria-describedby` to the heading and message paragraph. No extra ARIA is needed on
  the `ReviewStep` wrapper.
- When the dialog opens, focus should move to the first interactive element inside it.
  `ConfirmDialog` handles this internally via the `useEffect` on `isOpen`.
- The "Confirm Deployment" button in `ReviewStep` must remain `disabled` (not just visually
  styled) when `hasSufficientBalance` is false, so keyboard and switch-access users cannot
  accidentally submit.
- `Enter` to confirm and `Esc` to cancel are already implemented in `ConfirmDialog`.

---

## Related Files

- `src/components/TokenDeployForm/TokenDeployForm.tsx` — wizard orchestration; needs wiring
- `src/components/TokenDeployForm/ReviewStep.tsx` — full summary UI; exists, not yet used
- `src/components/TokenDeployForm/BasicInfoStep.tsx` — step 2 of wizard
- `src/components/TokenDeployForm/ProgressIndicator.tsx` — step indicator; exists, not rendered
- `src/components/UI/ConfirmDialog.tsx` — final confirmation modal
- `src/hooks/useFactoryFees.ts` — live fee data with fallback flag
- `src/utils/formatting.ts` — `formatXLM`, `truncateAddress`, `formatNumber`
