import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import i18n from '../../i18n/config';
import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';
import { PageLoader } from '../../components/UI/PageLoader';

describe('PageLoader i18n', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('renders the English loading message', async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    render(<PageLoader />);
    expect(screen.getByTestId('page-loader-message')).toHaveTextContent(en.common.loading);
  });

  it('renders the loading message translated for a non-English locale', async () => {
    await act(async () => {
      await i18n.changeLanguage('es');
    });
    render(<PageLoader />);
    const message = screen.getByTestId('page-loader-message');
    expect(message).toHaveTextContent(es.common.loading);
    expect(message).not.toHaveTextContent(en.common.loading);
  });
});
