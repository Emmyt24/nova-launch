/**
 * Accessibility tests — Modal focus trapping and restoration
 *
 * Verifies that Modal:
 *   • moves focus into the dialog when it opens
 *   • traps Tab / Shift+Tab within the dialog while it is open
 *   • restores focus to the trigger element when it closes (via Escape or button)
 *   • has correct ARIA roles and attributes
 *   • produces zero axe-core violations
 */

import React, { useRef, useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { Modal } from '../../../components/UI/Modal';

expect.extend(toHaveNoViolations);

// ── Helper: a realistic host component ────────────────────────────────────────

function ModalHost({
  initialOpen = false,
  extraContent,
}: {
  initialOpen?: boolean;
  extraContent?: React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        Open modal
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Test Modal">
        <button>First focusable</button>
        {extraContent}
        <button>Last focusable</button>
      </Modal>
    </>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Modal — focus trapping and restoration', () => {
  describe('ARIA roles and attributes', () => {
    it('has role="dialog"', () => {
      render(<ModalHost initialOpen />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('has aria-modal="true"', () => {
      const { container } = render(<ModalHost initialOpen />);
      expect(container.querySelector('[aria-modal="true"]')).toBeInTheDocument();
    });

    it('has aria-labelledby pointing to the modal title', () => {
      const { container } = render(<ModalHost initialOpen />);
      const dialog = container.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute('aria-labelledby')).toBe('modal-title');
    });

    it('title element has the matching id', () => {
      const { container } = render(<ModalHost initialOpen />);
      expect(container.querySelector('#modal-title')).toBeInTheDocument();
    });

    it('close button has an accessible label', () => {
      render(<ModalHost initialOpen />);
      expect(screen.getByLabelText('Close modal')).toBeInTheDocument();
    });
  });

  describe('Focus moves into the modal on open', () => {
    it('dialog container receives focus when the modal opens', async () => {
      render(<ModalHost />);
      const trigger = screen.getByText('Open modal');
      trigger.focus();

      act(() => {
        fireEvent.click(trigger);
      });

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveFocus();
      });
    });
  });

  describe('Focus trap — Tab stays within the dialog', () => {
    it('Tab from the last focusable element wraps to the first', () => {
      const { container } = render(<ModalHost initialOpen />);
      const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled])'
      );
      const last = focusable[focusable.length - 1];

      last.focus();
      expect(last).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });

      // After the trap fires, focus should be on the first focusable element.
      expect(focusable[0]).toHaveFocus();
    });

    it('Shift+Tab from the first focusable element wraps to the last', () => {
      const { container } = render(<ModalHost initialOpen />);
      const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      first.focus();
      expect(first).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

      expect(last).toHaveFocus();
    });
  });

  describe('Keyboard dismissal and focus restoration', () => {
    it('Escape closes the modal', async () => {
      render(<ModalHost initialOpen />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('restores focus to the trigger after Escape', async () => {
      render(<ModalHost />);
      const trigger = screen.getByText('Open modal');
      trigger.focus();

      act(() => { fireEvent.click(trigger); });
      await waitFor(() => screen.getByRole('dialog'));

      act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });

      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    });

    it('restores focus to the trigger after the close button is clicked', async () => {
      render(<ModalHost />);
      const trigger = screen.getByText('Open modal');
      trigger.focus();

      act(() => { fireEvent.click(trigger); });
      await waitFor(() => screen.getByRole('dialog'));

      act(() => { fireEvent.click(screen.getByLabelText('Close modal')); });

      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    });
  });

  describe('Accessibility audit (jest-axe)', () => {
    it('has no axe violations when open', async () => {
      const { container } = render(<ModalHost initialOpen />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('has no axe violations when closed', async () => {
      const { container } = render(<ModalHost initialOpen={false} />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});
